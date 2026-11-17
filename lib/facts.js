/**
 * facts.jsonl 存储层：加载 / 内存索引 / 原子写 / 进程内串行队列 / 合并去重 / 容量淘汰 / 压缩。
 *
 * 约束（SPEC §7、memory-algo §1/§3.5/§3.8）：
 * - 全量重写，不追加半行；tmp + fsync + rename；
 * - 同一进程所有写走一条 Promise 队列，capture 并发 100 次也只有一条链；
 * - 归档只打 validTo，不物理删；compact 时每个 key 只留最近 1 条历史；
 * - 读到坏行跳过并告警，不整体失败；主文件缺失时用 .bak 恢复。
 *
 * @module dsh-pet-persona/lib/facts
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { sensitiveReason } from './sensitive.js'
import { clampNumber, clampText, dice, factHash, normKey, normValue, tokensOf, ulid } from './util.js'

/** 当前 schema 版本。 */
export const SCHEMA_VERSION = 1

/** 合法的事实类型。 */
export const FACT_TYPES = new Set(['identity', 'preference', 'routine', 'relation', 'event', 'boundary'])

/** 未知 type 的回落。 */
export const DEFAULT_TYPE = 'event'

const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 3_000
const COMPACT_FILE_BYTES = 4 * 1024 * 1024

/** 序列化字段顺序：固定下来便于 diff 与人工阅读。 */
const FIELD_ORDER = [
  'v', 'id', 'petId', 'type', 'key', 'value', 'quote', 'importance', 'pinned',
  'createdAt', 'validTo', 'hits', 'lastHitAt', 'supersedes', 'hash', 'lastMentionAt',
]

/**
 * @param {string} file
 * @param {number} pid
 * @param {number} seq
 * @returns {string}
 */
const tmpName = (file, pid, seq) => `${file}.tmp-${pid}-${seq}`

/**
 * 把内部行还原成落盘对象（剥掉 `_` 开头的计算字段）。
 * @param {Record<string, any>} row
 * @returns {Record<string, any>}
 */
export function serializeFact(row) {
  const out = {}
  for (const key of FIELD_ORDER) {
    if (row[key] !== undefined && !key.startsWith('_')) out[key] = row[key]
  }
  return out
}

/**
 * 事实对象的默认字段（新增与加载补全共用）。
 * @param {Partial<Record<string, any>>} patch
 * @returns {Record<string, any>}
 */
function baseFact(patch) {
  const nowIso = new Date().toISOString()
  return {
    v: SCHEMA_VERSION,
    id: patch.id ?? ulid(),
    petId: patch.petId ?? 'default',
    type: FACT_TYPES.has(patch.type) ? patch.type : DEFAULT_TYPE,
    key: String(patch.key ?? ''),
    value: String(patch.value ?? ''),
    quote: String(patch.quote ?? ''),
    importance: clampNumber(Number(patch.importance ?? 3), 1, 5),
    pinned: patch.pinned === true,
    createdAt: patch.createdAt ?? nowIso,
    validTo: patch.validTo ?? null,
    hits: Number.isFinite(Number(patch.hits)) ? Math.max(0, Math.floor(Number(patch.hits))) : 0,
    lastHitAt: patch.lastHitAt ?? null,
    supersedes: patch.supersedes ?? null,
    hash: String(patch.hash ?? ''),
    ...(patch.lastMentionAt ? { lastMentionAt: patch.lastMentionAt } : {}),
  }
}

/**
 * 计算 keepScore：importance 0.6 + 新鲜度 0.4（淘汰用，越小越先归档）。
 * @param {Record<string, any>} fact
 * @param {number} nowMs
 * @returns {number}
 */
function keepScore(fact, nowMs) {
  const imp = clampNumber(Number(fact.importance) / 5, 0, 1)
  const created = Date.parse(fact.createdAt)
  const ageDays = Number.isFinite(created) ? Math.max(0, (nowMs - created) / 86_400_000) : 0
  const fresh = fact.pinned || fact.type === 'identity' ? 1 : 0.5 ** (ageDays / 30)
  return imp * 0.6 + fresh * 0.4
}

/** 给行补上检索用的预计算字段（recall 期间零解析）。 */
function decorate(row) {
  row._nk = normKey(row.key)
  row._nv = normValue(row.value)
  row._tokens = tokensOf(row.value)
  // 老数据/手工编辑可能缺 hash：补上并回写字段（哈希是去重的唯一键）
  if (typeof row.hash !== 'string' || row.hash === '') row.hash = factHash(row._nk, row._nv)
  row._hash = row.hash
  const created = Date.parse(row.createdAt)
  row._createdMs = Number.isFinite(created) ? created : 0
  return row
}

/**
 * 从一组行建立只读视图（合并时在副本上跑，不污染当前索引）。
 * @param {Record<string, any>[]} rows
 * @returns {{ byKey: Map<string, Record<string, any>>, hashes: Set<string>, active: number }}
 */
function viewOf(rows) {
  const byKey = new Map()
  const hashes = new Set()
  let active = 0
  for (const row of rows) {
    if (row.validTo != null) continue
    active += 1
    byKey.set(normKey(row.key), row)
    hashes.add(row.hash || factHash(normKey(row.key), normValue(row.value)))
  }
  return { byKey, hashes, active }
}

/**
 * compact：活跃行全留 + 每个 key 只留最近 1 条归档。
 * @param {Record<string, any>[]} rows
 * @returns {Record<string, any>[]}
 */
export function compactRows(rows) {
  const keep = new Set()
  /** @type {Map<string, Record<string, any>>} */
  const latestArchived = new Map()
  for (const row of rows) {
    if (row.validTo == null) {
      keep.add(row.id)
      continue
    }
    const nk = normKey(row.key)
    const prev = latestArchived.get(nk)
    if (!prev || String(row.validTo) > String(prev.validTo)) latestArchived.set(nk, row)
  }
  for (const row of latestArchived.values()) keep.add(row.id)
  return rows.filter((row) => keep.has(row.id))
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref?.())

/**
 * @typedef {object} FactStoreOptions
 * @property {string} dir 数据目录
 * @property {number} [maxFacts]
 * @property {ReturnType<import('./log.js').createLogger>} [log]
 * @property {() => number} [now]
 */

export class FactStore {
  /**
   * @param {FactStoreOptions} options
   */
  constructor({ dir, maxFacts = 500, log = null, now = Date.now } = {}) {
    if (!dir) throw new Error('FactStore 需要 dir')
    this.dir = dir
    this.file = join(dir, 'facts.jsonl')
    this.bakFile = join(dir, 'facts.jsonl.bak')
    this.lockFile = join(dir, 'facts.lock')
    this.maxFacts = Math.max(20, Math.floor(maxFacts))
    this.log = log
    this.now = now

    /** @type {Record<string, any>[]} */
    this.rows = []
    /** @type {Map<string, Record<string, any>>} */
    this.byId = new Map()
    /** @type {Map<string, Record<string, any>>} */
    this.activeByKey = new Map()
    /** @type {Record<string, any>[]} */
    this.active = []
    /** @type {Set<string>} */
    this.seenHash = new Set()
    this.archivedCount = 0
    this.loaded = false
    this.readOnly = false
    this.loadError = null
    this.duplicateIds = false

    /** @type {Map<string, number>} */
    this.pendingHits = new Map()
    this.hitTimer = null
    this.seq = 0
    this.chain = Promise.resolve()
    this.disposed = false
  }

  /** 初始化目录、清理残留 tmp、必要时用 .bak 恢复并创建空文件。 */
  async init() {
    await fsp.mkdir(this.dir, { recursive: true })
    // 崩溃残留：本次进程之前留下的 tmp 一律删掉
    try {
      for (const name of await fsp.readdir(this.dir)) {
        if (name.startsWith('facts.jsonl.tmp-')) {
          await fsp.rm(join(this.dir, name), { force: true }).catch(() => {})
        }
      }
    } catch {
      /* 目录读不了：继续走 load 的降级 */
    }
    let exists = true
    try {
      await fsp.access(this.file)
    } catch {
      exists = false
    }
    if (!exists) {
      let recovered = false
      try {
        await fsp.access(this.bakFile)
        await fsp.copyFile(this.bakFile, this.file)
        recovered = true
        this.log?.warn?.('facts_restored_from_bak')
      } catch {
        /* 没有 bak */
      }
      if (!recovered) {
        await fsp.writeFile(this.file, '', { flag: 'wx' }).catch((error) => {
          if (error?.code !== 'EEXIST') throw error
        })
      }
    }
    await this.load()
    if (this.duplicateIds) await this.enqueue(() => this.writeRows(compactRows(this.rows))).catch(() => {})
  }

  /**
   * 同步版启动初始化：apply 阶段必须让首轮 recall 就能读到事实，因此读盘走同步。
   * 只做读与建空文件，写盘仍然全部异步。
   */
  initSync() {
    mkdirSync(this.dir, { recursive: true })
    try {
      for (const name of readdirSync(this.dir)) {
        if (name.startsWith('facts.jsonl.tmp-')) rmSync(join(this.dir, name), { force: true })
      }
    } catch {
      /* 忽略 */
    }
    if (!existsSync(this.file)) {
      if (existsSync(this.bakFile)) {
        copyFileSync(this.bakFile, this.file)
        this.log?.warn?.('facts_restored_from_bak')
      } else {
        try {
          writeFileSync(this.file, '', { flag: 'wx' })
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error
        }
      }
    }
    this.loadSync()
    if (this.duplicateIds) void this.enqueue(() => this.writeRows(compactRows(this.rows))).catch(() => {})
  }

  /** 读盘并重建索引；坏行跳过，`v > 1` 进只读模式。 */
  async load() {
    let text = ''
    try {
      text = await fsp.readFile(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.loadError = error
      text = ''
    }
    this.ingest(text)
  }

  /** 同步读盘（启动路径专用）。 */
  loadSync() {
    let text = ''
    try {
      text = readFileSync(this.file, 'utf8')
    } catch (error) {
      if (error?.code !== 'ENOENT') this.loadError = error
    }
    this.ingest(text)
  }

  /**
   * 逐行解析并重建索引；这一层同时被同步/异步加载复用。
   * @param {string} text
   */
  ingest(text) {
    /** @type {Record<string, any>[]} */
    const rows = []
    const seenIds = new Set()
    for (const [index, line] of String(text).split('\n').entries()) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      let parsed
      try {
        parsed = JSON.parse(trimmed)
      } catch {
        this.log?.warn?.(`facts_bad_line line=${index + 1}`)
        continue
      }
      if (!parsed || typeof parsed !== 'object') {
        this.log?.warn?.(`facts_bad_line line=${index + 1}`)
        continue
      }
      const version = Number(parsed.v)
      if (Number.isFinite(version) && version > SCHEMA_VERSION) {
        if (!this.readOnly) this.log?.warn?.('facts_schema_newer read-only')
        this.readOnly = true
      }
      if (typeof parsed.id !== 'string' || parsed.id === '' || typeof parsed.key !== 'string' || typeof parsed.value !== 'string') {
        this.log?.warn?.(`facts_bad_row line=${index + 1}`)
        continue
      }
      if (seenIds.has(parsed.id)) {
        this.duplicateIds = true
        // 同 id 后出现的覆盖先出现的（手工编辑/重复恢复）
        const at = rows.findIndex((row) => row.id === parsed.id)
        if (at >= 0) rows.splice(at, 1)
      }
      seenIds.add(parsed.id)
      rows.push(decorate(baseFact(parsed)))
    }
    this.rows = rows
    this.reindex()
    this.loaded = true
  }

  /** 重建内存索引（加载 / 每次写盘后调用）。 */
  reindex() {
    this.byId = new Map()
    this.activeByKey = new Map()
    this.active = []
    this.seenHash = new Set()
    for (const row of this.rows) {
      decorate(row)
      this.byId.set(row.id, row)
      if (row.validTo == null) {
        this.activeByKey.set(row._nk, row)
        this.active.push(row)
        this.seenHash.add(row._hash)
      }
    }
    this.archivedCount = this.rows.length - this.active.length
  }

  /**
   * 串行队列：所有写操作共用一条链。
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  enqueue(fn) {
    const run = this.chain.then(fn, fn)
    this.chain = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  /**
   * 合并一批抽取结果（已通过 learn 侧校验，这里再做一次敏感兜底）。
   *
   * @param {Array<{op?: string, type?: string, key: string, value?: string, quote?: string, importance?: number, pinned?: boolean}>} items
   * @param {{ petId?: string }} [meta]
   * @returns {Promise<{ added: number, updated: number, deleted: number, skipped: number, archived: number, readOnly?: boolean }>}
   */
  merge(items, meta = {}) {
    return this.enqueue(async () => {
      const stats = { added: 0, updated: 0, deleted: 0, skipped: 0, archived: 0 }
      if (this.readOnly) return { ...stats, readOnly: true }
      const rows = this.rows.map((row) => ({ ...row }))
      const view = viewOf(rows)
      const ts = new Date(this.now()).toISOString()
      const petId = meta.petId || 'default'

      for (const item of items ?? []) {
        const op = String(item?.op ?? 'ADD').toUpperCase()
        const key = typeof item?.key === 'string' ? item.key : ''
        if (key === '') {
          stats.skipped += 1
          continue
        }
        const nk = normKey(key)
        if (op === 'DELETE') {
          const old = view.byKey.get(nk)
          if (old) {
            old.validTo = ts
            view.byKey.delete(nk)
            stats.deleted += 1
          } else {
            stats.skipped += 1
          }
          continue
        }

        const value = clampText(item?.value ?? '', 60)
        if (value === '') {
          stats.skipped += 1
          continue
        }
        const reason = sensitiveReason(value) || sensitiveReason(item?.quote ?? '')
        if (reason) {
          this.log?.warn?.(`sensitive_skip key=${key} reason=${reason}`)
          stats.skipped += 1
          continue
        }
        const nv = normValue(value)
        const hash = factHash(nk, nv)
        const old = view.byKey.get(nk)

        if (view.hashes.has(hash)) {
          if (old && old.hash === hash) old.lastMentionAt = ts
          stats.skipped += 1
          continue
        }
        const isSame = old ? dice(old._tokens ?? tokensOf(old.value), tokensOf(value)) >= 0.85 : false
        if (old && op !== 'UPDATE' && isSame) {
          old.lastMentionAt = ts
          stats.skipped += 1
          continue
        }
        if (old) {
          old.validTo = ts
          view.byKey.delete(nk)
          view.hashes.delete(old.hash)
        }
        const fact = decorate(
          baseFact({
            petId,
            type: item?.type,
            key,
            value,
            quote: clampText(item?.quote ?? '', 80),
            importance: item?.importance,
            pinned: item?.pinned === true,
            createdAt: ts,
            supersedes: old ? old.id : null,
            hash,
          }),
        )
        rows.push(fact)
        view.byKey.set(nk, fact)
        view.hashes.add(hash)
        if (old) stats.updated += 1
        else stats.added += 1
      }

      // 容量淘汰：pinned 永不淘汰；按 keepScore 升序归档
      const activeRows = rows.filter((row) => row.validTo == null)
      if (activeRows.length > this.maxFacts) {
        const excess = activeRows.length - this.maxFacts
        const candidates = activeRows
          .filter((row) => row.pinned !== true)
          .sort((a, b) => keepScore(a, this.now()) - keepScore(b, this.now()))
        for (let i = 0; i < excess && i < candidates.length; i += 1) {
          candidates[i].validTo = candidates[i].validTo ?? ts
          stats.archived += 1
        }
      }

      let next = rows
      const bytes = Buffer.byteLength(rows.map(serializeFact).map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
      if (bytes > COMPACT_FILE_BYTES) {
        next = compactRows(rows)
        this.log?.info?.(`facts_compact bytes=${bytes} rows=${rows.length}->${next.length}`)
      }
      await this.writeRows(next)
      this.rows = next
      this.reindex()
      return stats
    })
  }

  /**
   * 显式删除（CLI / 测试用）：打 validTo 归档。
   * @param {string} id
   */
  remove(id) {
    return this.enqueue(async () => {
      if (this.readOnly) return false
      const rows = this.rows.map((row) => ({ ...row }))
      const row = rows.find((item) => item.id === id && item.validTo == null)
      if (!row) return false
      row.validTo = new Date(this.now()).toISOString()
      await this.writeRows(rows)
      this.rows = rows
      this.reindex()
      return true
    })
  }

  /**
   * 记录命中（异步累加，允许丢失）：只进内存，5s 后统一落盘。
   * @param {string} id
   */
  recordHit(id) {
    if (this.readOnly || this.disposed) return
    const row = this.byId.get(id)
    if (!row || row.validTo != null) return
    this.pendingHits.set(id, (this.pendingHits.get(id) ?? 0) + 1)
    if (this.hitTimer) return
    this.hitTimer = setTimeout(() => {
      this.hitTimer = null
      void this.flushHits()
    }, 5_000)
    this.hitTimer.unref?.()
  }

  /** 把累积的 hits 写回磁盘。 */
  flushHits() {
    if (this.pendingHits.size === 0) return Promise.resolve()
    const hits = new Map(this.pendingHits)
    this.pendingHits.clear()
    return this.enqueue(async () => {
      if (this.readOnly) return
      const rows = this.rows.map((row) => ({ ...row }))
      const ts = new Date(this.now()).toISOString()
      const byId = new Map(rows.map((row) => [row.id, row]))
      for (const [id, n] of hits) {
        const row = byId.get(id)
        if (!row || row.validTo != null) continue
        row.hits = (Number(row.hits) || 0) + n
        row.lastHitAt = ts
      }
      await this.writeRows(rows)
      this.rows = rows
      this.reindex()
    }).catch((error) => this.log?.warn?.(`facts_hits_write_failed ${error?.message ?? error}`))
  }

  /**
   * 原子写：锁 → 留底 .bak → tmp 写入 + fsync → rename。
   * @param {Record<string, any>[]} rows
   */
  async writeRows(rows) {
    await this.withLock(async () => {
      try {
        await fsp.copyFile(this.file, this.bakFile)
      } catch {
        /* 首次写没有旧文件 */
      }
      const body = rows.length === 0 ? '' : rows.map((row) => JSON.stringify(serializeFact(row))).join('\n') + '\n'
      const tmp = tmpName(this.file, process.pid, (this.seq += 1))
      const handle = await fsp.open(tmp, 'w')
      try {
        await handle.writeFile(body, 'utf8')
        await handle.sync()
      } finally {
        await handle.close()
      }
      try {
        await fsp.rename(tmp, this.file)
      } catch (error) {
        // Windows 上目标被短暂占用时会 EPERM/EBUSY：删 tmp 后重试一次
        await fsp.rm(tmp, { force: true }).catch(() => {})
        if (error?.code !== 'EPERM' && error?.code !== 'EBUSY') throw error
        await delay(50)
        const retryTmp = tmpName(this.file, process.pid, (this.seq += 1))
        await fsp.writeFile(retryTmp, body, 'utf8')
        await fsp.rename(retryTmp, this.file)
      }
    })
  }

  /**
   * 写锁（O_EXCL；陈旧锁 30s 清理；最多等 3s）。
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async withLock(fn) {
    const started = Date.now()
    /** @type {import('node:fs/promises').FileHandle | undefined} */
    let handle
    while (!handle) {
      try {
        handle = await fsp.open(this.lockFile, 'wx')
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error
        try {
          const info = await fsp.stat(this.lockFile)
          if (Date.now() - info.mtimeMs > LOCK_STALE_MS) {
            await fsp.rm(this.lockFile, { force: true })
            continue
          }
        } catch {
          /* 锁刚被释放 */
        }
        if (Date.now() - started > LOCK_WAIT_MS) throw new Error('facts.lock busy')
        await delay(50)
      }
    }
    try {
      await handle.writeFile(`${process.pid} ${this.now()}`, 'utf8')
      return await fn()
    } finally {
      await handle.close().catch(() => {})
      await fsp.rm(this.lockFile, { force: true }).catch(() => {})
    }
  }

  /** 退出前收尾：刷新 hits、等队列排空。 */
  async dispose() {
    this.disposed = true
    if (this.hitTimer) clearTimeout(this.hitTimer)
    this.hitTimer = null
    await this.flushHits().catch(() => {})
    await this.chain.catch(() => {})
  }

  /** 诊断快照（测试与日志用）。 */
  stats() {
    return {
      rows: this.rows.length,
      active: this.active.length,
      archived: this.archivedCount,
      keys: this.activeByKey.size,
      readOnly: this.readOnly,
      loaded: this.loaded,
    }
  }
}

export { keepScore }
