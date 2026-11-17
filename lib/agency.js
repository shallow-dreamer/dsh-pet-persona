/**
 * 受限自治：L1 观察 + L2 可逆动作。
 *
 * 只做三件事：
 * - 从桌宠对话里识别「记一下 / 提醒我」等明确信号，生成**待确认**提议（不写盘）；
 * - 用户确认后，写一个**新建**文件或追加一条提醒（永不覆盖、永不删除用户文件）；
 * - 记录审计，并支持撤销自己创建的内容。
 *
 * 不执行 shell、不删除用户文件、不访问工作区、不对外发送。
 *
 * @module dsh-pet-persona/lib/agency
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { sensitiveReason } from './sensitive.js'
import { ulid } from './util.js'

const NOTE_RE = /(?:记一下|记下|帮我记(?:一下)?|备注)[：:,，\s]*(.{1,200})/
const REMIND_RE = /(?:提醒我|提醒一下|别忘了提醒我)[：:,，\s]*(.{1,200})/
const DEDUPE_MS = 10 * 60 * 1000
const TICK_MS = 30 * 1000

/**
 * 从自然语言里提取提醒时间。
 *
 * 支持：
 * - `2026-11-18 09:30` / `2026/11/18 9:30`
 * - `明天 9:30` / `今天 21 点` / `9:30`
 * - `30 分钟后` / `半小时后` / `2 小时后`
 *
 * 只认明确时间；认不出返回空串，绝不猜。
 *
 * @param {string} text
 * @param {number} [base]
 * @returns {string} ISO 时间，失败为空串
 */
export function parseDue(text, base = Date.now()) {
  const raw = String(text ?? '').trim()
  if (raw === '') return ''
  const ref = new Date(base)
  const mk = (y, mo, d, h, mi) => {
    const date = new Date(y, mo - 1, d, h, mi, 0, 0)
    return Number.isNaN(date.getTime()) ? '' : date.toISOString()
  }

  const iso = /(\d{4})[-/](\d{1,2})[-/](\d{1,2})(?:[ T](\d{1,2})[:时点](\d{1,2})?)?/.exec(raw)
  if (iso) {
    return mk(Number(iso[1]), Number(iso[2]), Number(iso[3]), Number(iso[4] ?? 9), Number(iso[5] ?? 0))
  }

  const rel = /(\d+)\s*分钟(?:之)?后/.exec(raw)
  if (rel) return new Date(base + Number(rel[1]) * 60000).toISOString()
  if (/半\s*小时(?:之)?后/.test(raw)) return new Date(base + 30 * 60000).toISOString()
  const relH = /(\d+)\s*小时(?:之)?后/.exec(raw)
  if (relH) return new Date(base + Number(relH[1]) * 3600000).toISOString()

  const dayWord = /(今天|明天|后天)/.exec(raw)
  const time = /(\d{1,2})\s*[:点时]\s*(\d{1,2})?/.exec(raw)
  if (time) {
    const h = Number(time[1])
    const mi = Number(time[2] ?? 0)
    if (h > 23 || mi > 59) return ''
    const offset = dayWord ? (dayWord[1] === '明天' ? 1 : dayWord[1] === '后天' ? 2 : 0) : 0
    const date = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate() + offset, h, mi, 0, 0)
    if (!dayWord && date.getTime() <= base) date.setDate(date.getDate() + 1)
    return date.toISOString()
  }
  return ''
}

/**
 * @param {any} value
 * @returns {string}
 */
function cleanText(value) {
  return String(value ?? '')
    .replace(/[。！？!?；;，,]+$/u, '')
    .trim()
}

/**
 * @param {string} dir
 * @param {string} file
 */
function appendJsonl(dir, file, row) {
  appendFileSync(join(dir, file), `${JSON.stringify(row)}\n`, 'utf8')
}

/**
 * @param {{ dir: string, maxPending?: number, noteMaxChars?: number, self?: any, facts?: any, log?: any, now?: () => number }} options
 */
export function createAgency({ dir, maxPending = 20, noteMaxChars = 200, self = null, facts = null, log = null, now = Date.now, speak = null, onExecuted = null } = {}) {
  const root = join(dir, 'agency')
  const notesDir = join(root, 'notes')
  const digestsDir = join(root, 'digests')
  const proposalsFile = join(root, 'proposals.jsonl')
  const auditFile = join(root, 'agency-audit.jsonl')
  const remindersFile = join(root, 'reminders.jsonl')

  /** @type {Map<string, any>} */
  const proposals = new Map()
  /** @type {Map<string, number>} */
  const recent = new Map()
  /** @type {Map<string, any>} */
  const reminders = new Map()
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null

  const ensureDir = () => {
    for (const target of [root, notesDir, digestsDir]) {
      if (!existsSync(target)) mkdirSync(target, { recursive: true })
    }
  }

  const audit = (event, row) => {
    try {
      appendJsonl(root, 'agency-audit.jsonl', { ts: new Date(now()).toISOString(), event, ...row })
    } catch (error) {
      log?.warn?.(`agency_audit_failed ${error?.message ?? error}`)
    }
  }

  const save = (proposal) => {
    proposals.set(proposal.id, proposal)
    try {
      appendJsonl(root, 'proposals.jsonl', proposal)
    } catch (error) {
      log?.warn?.(`agency_save_failed ${error?.message ?? error}`)
    }
  }

  const initSync = () => {
    ensureDir()
    if (existsSync(proposalsFile)) {
      try {
        for (const line of readFileSync(proposalsFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try {
            const row = JSON.parse(line)
            if (row && typeof row.id === 'string') proposals.set(row.id, row)
          } catch {
            /* 跳过坏行 */
          }
        }
      } catch (error) {
        log?.warn?.(`agency_load_failed ${error?.message ?? error}`)
      }
    }
    for (const row of proposals.values()) {
      if (row.status === 'pending') {
        const key = `${row.kind}|${row.dedupe ?? ''}`
        recent.set(key, Math.max(recent.get(key) ?? 0, Date.parse(row.createdAt) || 0))
      }
    }
    if (existsSync(remindersFile)) {
      try {
        for (const line of readFileSync(remindersFile, 'utf8').split('\n')) {
          if (line.trim() === '') continue
          try {
            const row = JSON.parse(line)
            if (!row || typeof row.id !== 'string') continue
            const prev = reminders.get(row.id) ?? { id: row.id, text: '', due: '', cancelled: false, notified: false }
            if (row.cancelled) prev.cancelled = true
            if (row.notified) prev.notified = true
            if (row.text) prev.text = row.text
            if (row.due) prev.due = row.due
            prev.petId = prev.petId ?? row.petId
            reminders.set(row.id, prev)
          } catch {
            /* 跳过坏行 */
          }
        }
      } catch (error) {
        log?.warn?.(`agency_reminders_load_failed ${error?.message ?? error}`)
      }
    }
  }

  const pendingList = () => [...proposals.values()].filter((row) => row.status === 'pending').sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))

  const stats = () => {
    const all = [...proposals.values()]
    return {
      total: all.length,
      pending: all.filter((row) => row.status === 'pending').length,
      done: all.filter((row) => row.status === 'done').length,
      failed: all.filter((row) => row.status === 'failed').length,
      undone: all.filter((row) => row.status === 'undone').length,
      rejected: all.filter((row) => row.status === 'rejected').length,
    }
  }

  const propose = ({ petId, kind, risk = 'low', title, detail, payload = {}, dedupe = '' }) => {
    const key = `${kind}|${dedupe}`
    const last = recent.get(key) ?? 0
    if (dedupe !== '' && now() - last < DEDUPE_MS) return { ok: false, reason: 'duplicate' }
    if (stats().pending >= maxPending) return { ok: false, reason: 'queue_full' }

    const proposal = {
      id: ulid('a_'),
      petId: String(petId ?? 'main'),
      kind,
      risk,
      title: String(title ?? '').slice(0, 120),
      detail: String(detail ?? '').slice(0, 500),
      payload,
      status: 'pending',
      createdAt: new Date(now()).toISOString(),
      dedupe,
    }
    save(proposal)
    if (dedupe !== '') recent.set(key, now())
    audit('propose', { id: proposal.id, kind, petId: proposal.petId, title: proposal.title, detail: proposal.detail })
    log?.debug?.(`agency_propose id=${proposal.id} kind=${kind} petId=${proposal.petId}`)
    return { ok: true, proposal }
  }

  /** L1：只观察，不写盘（initSync 建目录除外）。 */
  const observe = ({ petId = 'main', userText = '', replyText = '' } = {}) => {
    ensureDir()
    const text = String(userText ?? '').trim()
    if (text === '') return { ok: false, reason: 'empty' }
    const reason = sensitiveReason(text)
    if (reason) {
      audit('sensitive_skip', { petId, reason })
      return { ok: false, reason: 'sensitive' }
    }

    const remind = REMIND_RE.exec(text)
    if (remind) {
      const body = cleanText(remind[1]).slice(0, noteMaxChars)
      if (body === '') return { ok: false, reason: 'empty' }
      return propose({
        petId,
        kind: 'reminder',
        title: '提醒',
        detail: body,
        payload: { text: body, due: parseDue(body, now()) },
        dedupe: `reminder:${body}`,
      })
    }

    const note = NOTE_RE.exec(text)
    if (note) {
      const body = cleanText(note[1]).slice(0, noteMaxChars)
      if (body === '') return { ok: false, reason: 'empty' }
      return propose({
        petId,
        kind: 'note',
        title: '笔记',
        detail: body,
        payload: { text: body },
        dedupe: `note:${body}`,
      })
    }

    if (self) {
      try {
        const state = self.state(petId)
        const events = self.recent(petId, 8) ?? []
        const today = new Date(now()).toISOString().slice(0, 10)
        const already = [...proposals.values()].some((row) => row.kind === 'digest' && String(row.payload?.date ?? '') === today && row.status !== 'rejected')
        if (!already && events.length >= 5) {
          const body = [`今天心情：${state.moodText ?? ''}`, ...events.slice(0, 6).map((row) => `- ${row.text}`)].join('\n')
          return propose({
            petId,
            kind: 'digest',
            title: '今日摘要',
            detail: body,
            payload: { date: today, text: body },
            dedupe: `digest:${today}`,
          })
        }
      } catch (error) {
        log?.warn?.(`agency_digest_failed ${error?.message ?? error}`)
      }
    }

    if (facts) {
      try {
        const statsNow = facts.stats?.() ?? null
        if (statsNow && statsNow.archived > 100) {
          return propose({
            petId,
            kind: 'tidy',
            title: '记忆整理建议',
            detail: `归档事实已有 ${statsNow.archived} 条，可以抽空清理旧记录。`,
            payload: { archived: statsNow.archived },
            dedupe: `tidy:${todayKey()}`,
          })
        }
      } catch {
        /* ignore */
      }
    }

    return { ok: false, reason: 'no_signal' }
  }

  const todayKey = () => new Date(now()).toISOString().slice(0, 10)

  const safePath = (base, name) => {
    const target = resolve(base, name)
    const root = resolve(base)
    return target.startsWith(root + sep) ? target : ''
  }

  const execute = (proposal) => {
    ensureDir()
    if (proposal.kind === 'note') {
      const file = safePath(notesDir, `${proposal.id}.md`)
      if (file === '' || existsSync(file)) throw new Error('note target exists')
      const content = `# 笔记\n\n${proposal.payload.text}\n\n> 由桌宠提议，主人确认于 ${new Date(now()).toISOString()}\n`
      writeFileSync(file, content, { encoding: 'utf8', flag: 'wx' })
      return { result: 'note written', undo: { type: 'file', file } }
    }
    if (proposal.kind === 'digest') {
      const date = String(proposal.payload.date ?? todayKey())
      const file = safePath(digestsDir, `${date}.md`)
      if (file === '' || existsSync(file)) throw new Error('digest target exists')
      writeFileSync(file, `# ${date} 摘要\n\n${proposal.payload.text}\n`, { encoding: 'utf8', flag: 'wx' })
      return { result: 'digest written', undo: { type: 'file', file } }
    }
    if (proposal.kind === 'reminder') {
      const due = String(proposal.payload.due ?? '')
      appendJsonl(root, 'reminders.jsonl', {
        id: proposal.id,
        petId: proposal.petId,
        text: proposal.payload.text,
        due,
        createdAt: new Date(now()).toISOString(),
        cancelled: false,
      })
      reminders.set(proposal.id, {
        id: proposal.id,
        petId: proposal.petId,
        text: String(proposal.payload.text ?? ''),
        due,
        cancelled: false,
        notified: false,
      })
      return { result: due === '' ? 'reminder saved (no due)' : `reminder saved for ${due}`, undo: { type: 'reminder', id: proposal.id } }
    }
    if (proposal.kind === 'reminder_due') {
      const text = String(proposal.payload.text ?? '')
      if (typeof speak === 'function' && text !== '') {
        Promise.resolve()
          .then(() => speak(proposal.petId, text))
          .catch((error) => {
            audit('speak_fail', { id: proposal.id, error: String(error?.message ?? error) })
            log?.warn?.(`agency_speak_failed id=${proposal.id} ${error?.message ?? error}`)
          })
      }
      return { result: text === '' ? 'due reminder (empty)' : 'due reminder announced', undo: null }
    }
    if (proposal.kind === 'tidy') {
      return { result: 'suggestion only', undo: null }
    }
    throw new Error(`unsupported kind: ${proposal.kind}`)
  }

  const decide = (id, action) => {
    const proposal = proposals.get(String(id))
    if (!proposal) return { ok: false, reason: 'not_found' }
    if (proposal.status !== 'pending') return { ok: false, reason: 'not_pending' }
    if (action === 'reject') {
      proposal.status = 'rejected'
      proposal.decidedAt = new Date(now()).toISOString()
      save(proposal)
      audit('reject', { id: proposal.id, kind: proposal.kind })
      return { ok: true, proposal }
    }
    if (action !== 'approve') return { ok: false, reason: 'bad_action' }

    proposal.status = 'approved'
    proposal.decidedAt = new Date(now()).toISOString()
    save(proposal)
    audit('approve', { id: proposal.id, kind: proposal.kind })
    try {
      const { result, undo } = execute(proposal)
      proposal.status = 'done'
      proposal.result = result
      proposal.undo = undo
      proposal.executedAt = new Date(now()).toISOString()
      save(proposal)
      audit('execute', { id: proposal.id, kind: proposal.kind, result })
      log?.info?.(`agency_executed id=${proposal.id} kind=${proposal.kind}`)
      try {
        onExecuted?.(proposal)
      } catch (error) {
        log?.warn?.(`agency_on_executed_failed ${error?.message ?? error}`)
      }
    } catch (error) {
      proposal.status = 'failed'
      proposal.result = String(error?.message ?? error)
      proposal.executedAt = new Date(now()).toISOString()
      save(proposal)
      audit('fail', { id: proposal.id, kind: proposal.kind, error: proposal.result })
      log?.warn?.(`agency_execute_failed id=${proposal.id} ${proposal.result}`)
    }
    return { ok: true, proposal }
  }

  const undo = (id) => {
    const proposal = proposals.get(String(id))
    if (!proposal) return { ok: false, reason: 'not_found' }
    if (proposal.status !== 'done') return { ok: false, reason: 'not_done' }
    const info = proposal.undo ?? null
    if (!info) return { ok: false, reason: 'not_undoable' }
    try {
      if (info.type === 'file') {
        const file = String(info.file ?? '')
        const base = proposal.kind === 'digest' ? resolve(digestsDir) : resolve(notesDir)
        if (!file.startsWith(base + sep)) throw new Error('unsafe path')
        if (existsSync(file)) unlinkSync(file)
      } else if (info.type === 'reminder') {
        appendJsonl(root, 'reminders.jsonl', { id: proposal.id, cancelled: true, cancelledAt: new Date(now()).toISOString() })
      }
      proposal.status = 'undone'
      proposal.undoneAt = new Date(now()).toISOString()
      save(proposal)
      audit('undo', { id: proposal.id, kind: proposal.kind })
      return { ok: true, proposal }
    } catch (error) {
      audit('undo_fail', { id: proposal.id, error: String(error?.message ?? error) })
      return { ok: false, reason: 'undo_failed' }
    }
  }

  const list = ({ status = '' } = {}) => {
    let rows = [...proposals.values()]
    if (status !== '') rows = rows.filter((row) => row.status === status)
    return rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  }

  const listAudit = ({ limit = 80 } = {}) => {
    if (!existsSync(auditFile)) return []
    try {
      const lines = readFileSync(auditFile, 'utf8').split('\n').filter((line) => line.trim() !== '')
      return lines
        .slice(-Math.max(1, Math.min(500, Math.floor(limit))))
        .map((line) => {
          try {
            return JSON.parse(line)
          } catch {
            return null
          }
        })
        .filter(Boolean)
        .reverse()
    } catch (error) {
      log?.warn?.(`agency_audit_read_failed ${error?.message ?? error}`)
      return []
    }
  }

  /** 检查到点的提醒，生成 pending 提议；每个提醒只浮出一次。 */
  const tick = () => {
    ensureDir()
    const at = now()
    let notified = 0
    for (const reminder of reminders.values()) {
      if (reminder.cancelled || reminder.notified || !reminder.due) continue
      const due = Date.parse(reminder.due)
      if (!Number.isFinite(due) || due > at) continue
      const res = propose({
        petId: reminder.petId ?? 'main',
        kind: 'reminder_due',
        title: '提醒到点了',
        detail: reminder.text,
        payload: { reminderId: reminder.id, text: reminder.text, due: reminder.due },
        dedupe: `due:${reminder.id}`,
      })
      if (res.ok || res.reason === 'duplicate') {
        reminder.notified = true
        try {
          appendJsonl(root, 'reminders.jsonl', { id: reminder.id, notified: true, notifiedAt: new Date(now()).toISOString() })
        } catch (error) {
          log?.warn?.(`agency_reminder_mark_failed ${error?.message ?? error}`)
        }
        audit('due', { id: reminder.id, proposalId: res.proposal?.id ?? '', text: reminder.text })
        notified += 1
      }
    }
    return { ok: true, notified }
  }

  const startTicker = (ms = TICK_MS) => {
    if (ticker) return
    const interval = Math.max(5000, Math.min(300000, Math.floor(ms)))
    ticker = setInterval(() => {
      try {
        tick()
      } catch (error) {
        log?.warn?.(`agency_tick_failed ${error?.message ?? error}`)
      }
    }, interval)
    ticker.unref?.()
  }

  return {
    root,
    initSync,
    observe,
    propose,
    decide,
    undo,
    list,
    listAudit,
    tick,
    startTicker,
    stopTicker: () => {
      if (ticker) {
        clearInterval(ticker)
        ticker = null
      }
    },
    pendingList,
    stats,
    setLimits(next = {}) {
      if (Number.isFinite(next.maxPending)) maxPending = Math.max(1, Math.min(100, Math.floor(next.maxPending)))
      if (Number.isFinite(next.noteMaxChars)) noteMaxChars = Math.max(20, Math.min(500, Math.floor(next.noteMaxChars)))
    },
    dispose: () => {
      if (ticker) {
        clearInterval(ticker)
        ticker = null
      }
    },
  }
}
