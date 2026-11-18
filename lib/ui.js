/**
 * 设置页的后端：只读诊断 + 少量可写配置（budgetChars / autoLearn / ...）。
 *
 * 挂在 `webServer` 的 `/pet-persona/api` 前缀下，只接受本机同源请求。
 * 所有读接口都不修改事实；`/preview` 只模拟一次 recall，不记 hit。
 *
 * @module dsh-pet-persona/lib/ui
 */

import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { normalizeConfig } from './config.js'
import { serializeFact } from './facts.js'
import { readPersona, readPetModel } from './persona.js'
import { buildSelfBlock } from './self-context.js'

const MAX_BODY_BYTES = 256 * 1024
const ACTIVITY_TAIL_BYTES = 256 * 1024

/** 设置页可写字段：白名单之外的 body 一律忽略。 */
const EDITABLE = [
  'budgetChars', 'autoLearn', 'learnEveryTurns', 'idleLearnMs', 'maxFacts', 'model', 'provider',
  'voiceEnabled', 'voiceWakeWord', 'voiceRequire', 'voiceThreshold', 'voiceLanguage', 'voiceKeepTranscript', 'ttsEmotion', 'ttsEmotionIntensity',
  'selfEnabled', 'selfMaxEntries', 'selfInject', 'selfBudget',
  'selfInjectMaxEvents', 'selfInjectWindowH', 'selfInjectQuotes',
  'agencyEnabled', 'agencyMaxPending', 'agencyNoteMaxChars',
]

/**
 * @param {import('node:http').ServerResponse} res
 * @param {number} status
 * @param {any} payload
 */
export function json(res, status, payload) {
  let body = ''
  try {
    body = JSON.stringify(payload)
  } catch {
    body = JSON.stringify({ ok: false, error: 'response not serializable' })
  }
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<any>}
 */
export function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    /** @type {Buffer[]} */
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim()
      if (raw === '') return resolve({})
      try {
        const parsed = JSON.parse(raw)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        reject(new Error('invalid json body'))
      }
    })
    req.on('error', reject)
  })
}

/** @param {string} file */
function readJsonFile(file) {
  try {
    if (!existsSync(file)) return {}
    const parsed = JSON.parse(readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

/**
 * 读用户层设置（`<data>/settings.json`）。坏文件视为空，不让页面 500。
 * @param {string} dir
 */
export function readSettings(dir) {
  return readJsonFile(join(dir, 'settings.json'))
}

/**
 * 原子写入设置。
 * @param {string} dir
 * @param {Record<string, any>} patch
 */
export function writeSettings(dir, patch) {
  const file = join(dir, 'settings.json')
  const tmp = `${file}.tmp-${process.pid}`
  mkdirSync(dir, { recursive: true })
  writeFileSync(tmp, `${JSON.stringify(patch, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
  return patch
}

/**
 * 设置页展示用的配置（不含 enabled 之外的内部钩子）。
 * @param {Record<string, any>} config
 */
export function publicConfig(config) {
  return {
    enabled: config.enabled !== false,
    budgetChars: config.budgetChars,
    autoLearn: config.autoLearn !== false,
    learnEveryTurns: config.learnEveryTurns,
    idleLearnMs: config.idleLearnMs,
    maxFacts: config.maxFacts,
    model: config.model || '',
    provider: config.provider || '',
    voiceEnabled: config.voiceEnabled === true,
    voiceWakeWord: config.voiceWakeWord || '',
    voiceRequire: config.voiceRequire !== false,
    voiceThreshold: config.voiceThreshold,
    voiceLanguage: config.voiceLanguage || 'zh',
    voiceKeepTranscript: config.voiceKeepTranscript !== false,
    ttsEmotion: config.ttsEmotion === true,
    ttsEmotionIntensity: config.ttsEmotionIntensity,
    selfEnabled: config.selfEnabled !== false,
    selfMaxEntries: config.selfMaxEntries,
    selfInject: config.selfInject === true,
    selfBudget: config.selfBudget,
    selfInjectMaxEvents: config.selfInjectMaxEvents,
    selfInjectWindowH: config.selfInjectWindowH,
    selfInjectQuotes: config.selfInjectQuotes === true,
    agencyEnabled: config.agencyEnabled !== false,
    agencyMaxPending: config.agencyMaxPending,
    agencyNoteMaxChars: config.agencyNoteMaxChars,
  }
}

/**
 * 从设置白名单里挑出合法值，返回合并后的完整配置。
 * @param {Record<string, any>} current
 * @param {Record<string, any>} body
 */
export function mergeSettingsBody(current, body = {}) {
  const patch = {}
  for (const key of EDITABLE) {
    if (body == null || !(key in body)) continue
    patch[key] = body[key]
  }
  return normalizeConfig({ ...current, ...patch })
}

/** 事实的展示模型。 */
function factView(row) {
  const out = serializeFact(row)
  out.status = row.validTo ? 'archived' : 'active'
  return out
}

/**
 * 读取日志尾部的「最近活动」。
 * @param {string} dir
 * @param {number} limit
 */
export function tailActivity(dir, limit = 12) {
  const file = join(dir, 'persona.log')
  try {
    if (!existsSync(file)) return []
    const size = statSync(file).size
    const start = Math.max(0, size - ACTIVITY_TAIL_BYTES)
    const fd = readFileSync(file)
    const text = fd.subarray(start).toString('utf8')
    const lines = text.split(/\r?\n/).filter((line) => /\b(learn_merged|learn_empty|persona_skip|recall_ok|recall_deadline|settings_saved|memory_registered)\b/.test(line))
    return lines.slice(-limit).reverse()
  } catch {
    return []
  }
}

/** 从活动行里挑出人格防注入记录。 */
function guardEvents(dir, limit = 6) {
  return tailActivity(dir, 200)
    .filter((line) => line.includes('persona_skip'))
    .slice(0, limit)
}

/**
 * @param {object} options
 * @param {Record<string, any>} options.config 可变配置（保存后原地更新）
 * @param {any} options.store FactStore
 * @param {any} options.recallEngine
 * @param {any} options.logger
 * @param {any} options.petApi
 * @param {string} options.dir
 * @param {(next: Record<string, any>) => Record<string, any>} options.applySettings
 */
export function createApiHandler({ config, store, recallEngine, logger, petApi, dir, applySettings, voice = null, self = null, models = null, agency = null, autonomy = null, whisperWatch = null }) {
  /** 最近一次轮询 dsh-pet /state 得到的在场状态；未轮询过返回 null。 */
  const presenceInfo = () => {
    const info = whisperWatch?.status?.()
    if (!info || info.sleeping == null || !info.checkedAt) return null
    return { sleeping: info.sleeping === true, petId: info.petId, checkedAt: new Date(info.checkedAt).toISOString() }
  }

  const API_PREFIX = '/pet-persona/api'

  const voiceView = () => {
    try {
      return voice?.status?.() ?? null
    } catch (error) {
      logger?.warn?.(`voice_status_failed ${error?.message ?? error}`)
      return null
    }
  }

  /** 当前会注入的自我块（只读内存，不写盘）。 */
  const selfBlockFor = (petId = '') => {
    if (!self) return { block: undefined, eventIds: [] }
    return buildSelfBlock({
      state: self.state(petId),
      events: self.recent(petId, 24),
      budgetChars: config.selfBudget,
      maxEvents: config.selfInjectMaxEvents,
      windowH: config.selfInjectWindowH,
      quotes: config.selfInjectQuotes,
    })
  }

  /** 自我记忆摘要；失败只返回空，不影响主人事实。 */
  const selfView = (petId = '') => {
    if (!self) return null
    try {
      const built = selfBlockFor(petId)
      return {
        enabled: config.selfEnabled !== false,
        inject: config.selfInject === true,
        stats: self.stats(),
        mood: self.state(petId),
        previewBlock: built.block ?? '',
        previewEvents: built.eventIds,
      }
    } catch (error) {
      logger?.warn?.(`self_view_failed ${error?.message ?? error}`)
      return null
    }
  }

  const overview = () => {
    const stats = store.stats()
    const active = store.active ?? []
    let provider = { builtin: ['native'], external: [] }
    try {
      const listed = petApi?.memory?.list?.()
      if (listed) provider = listed
    } catch {
      /* 只是展示 */
    }
    const persona = readPersona({ dataDir: dir })
    const petModel = readPetModel({ dataDir: dir, petId: persona.petId || '' })
    const lastAt = active.reduce((max, row) => {
      const ts = Date.parse(row.lastMentionAt || row.createdAt || '') || 0
      return Math.max(max, ts)
    }, 0)
    return {
      ok: true,
      config: publicConfig(config),
      stats: {
        active: stats.active,
        archived: stats.archived,
        total: stats.rows,
        pinned: active.filter((row) => row.pinned === true).length,
        keys: stats.keys,
        readOnly: stats.readOnly === true,
      },
      provider,
      persona: {
        available: persona.available,
        petName: persona.petName,
        petId: persona.petId,
        chars: persona.text.length,
        source: persona.source,
      },
      lastUpdatedAt: lastAt > 0 ? new Date(lastAt).toISOString() : '',
      model: {
        configured: {
          provider: String(config.provider || ''),
          model: String(config.model || ''),
        },
        follow: petModel.provider !== '' ? petModel : null,
      },
      voice: voiceView(),
      self: selfView(persona.petId || 'default'),
      whisper: (() => {
        try {
          return whisperWatch?.status?.() ?? null
        } catch {
          return null
        }
      })(),
      agency: agency ? { ...agency.stats(), enabled: config.agencyEnabled === true } : null,
      autonomy: autonomy ? autonomy.status() : null,
      dataDir: dir,
    }
  }

  const handler = async (req, res, next) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (!url.pathname.startsWith(API_PREFIX)) {
      if (typeof next === 'function') return next()
      return json(res, 404, { ok: false, error: 'not found' })
    }
    if (req.method === 'OPTIONS') {
      res.statusCode = 204
      return res.end()
    }
    const route = url.pathname.slice(API_PREFIX.length) || '/'
    try {
      if (req.method === 'GET' && route === '/overview') {
        return json(res, 200, overview())
      }
      if (req.method === 'GET' && route === '/models') {
        if (!models) return json(res, 503, { ok: false, error: '模型目录未初始化' })
        const refresh = url.searchParams.get('refresh') === '1'
        const listed = await models.list({ refresh })
        return json(res, 200, { ok: true, ...listed })
      }
      if (req.method === 'GET' && route === '/facts') {
        const includeArchived = url.searchParams.get('archived') === '1'
        const facts = (store.rows ?? [])
          .filter((row) => includeArchived || !row.validTo)
          .map(factView)
          .sort((a, b) => {
            if ((a.status === 'active') !== (b.status === 'active')) return a.status === 'active' ? -1 : 1
            return String(b.createdAt).localeCompare(String(a.createdAt))
          })
        return json(res, 200, { ok: true, facts, stats: overview().stats })
      }
      if (req.method === 'GET' && route === '/persona') {
        const persona = readPersona({ dataDir: dir })
        const guard = guardEvents(dir)
        return json(res, 200, {
          ok: true,
          persona,
          guard,
        })
      }
      if (req.method === 'GET' && route === '/activity') {
        const lines = tailActivity(dir, 20)
        return json(res, 200, { ok: true, lines })
      }
      if (req.method === 'GET' && route === '/settings') {
        return json(res, 200, { ok: true, config: publicConfig(config) })
      }
      if (req.method === 'POST' && route === '/settings') {
        const body = await readBody(req)
        const next = mergeSettingsBody(config, body)
        const applied = applySettings(next)
        return json(res, 200, { ok: true, config: publicConfig(applied) })
      }
      if (req.method === 'POST' && route === '/preview') {
        const body = await readBody(req)
        const query = String(body.query ?? '').trim().slice(0, 500)
        if (query === '') return json(res, 400, { ok: false, error: 'query 不能为空' })
        const persona = readPersona({ dataDir: dir })
        const base = typeof body.system === 'string' && body.system.trim() !== '' ? body.system : persona.text
        const petId = persona.petId || 'default'
        let selfBlock = ''
        try {
          selfBlock = selfBlockFor(petId).block ?? ''
        } catch (error) {
          logger?.warn?.(`self_preview_failed ${error?.message ?? error}`)
        }
        const result = recallEngine.recall(
          { petId, system: base, history: [], userText: query },
          store.active ?? [],
          { budgetChars: config.budgetChars, petId, selfBlock },
        )
        const block = typeof result.block === 'string' ? result.block : ''
        const system = block === '' ? base : base === '' ? block : `${base}\n\n${block}`
        return json(res, 200, {
          ok: true,
          query,
          block,
          selfBlock,
          system,
          hits: result.hits ?? [],
          elapsedMs: result.elapsedMs ?? 0,
          budgetChars: config.budgetChars,
          selfBudget: config.selfBudget,
        })
      }
      if (route === '/agency' && req.method === 'GET') {
        if (!agency) return json(res, 503, { ok: false, error: '自主行为未初始化' })
        const status = String(url.searchParams.get('status') || '')
        return json(res, 200, {
          ok: true,
          enabled: config.agencyEnabled === true,
          proposals: agency.list({ status }),
          stats: agency.stats(),
          audit: agency.listAudit({ limit: 40 }),
        })
      }
      if (route === '/agency/audit' && req.method === 'GET') {
        if (!agency) return json(res, 503, { ok: false, error: '自主行为未初始化' })
        const limit = Number(url.searchParams.get('limit') || 60)
        return json(res, 200, { ok: true, audit: agency.listAudit({ limit }) })
      }
      if (route === '/agency/autonomy' && req.method === 'GET') {
        if (!autonomy) return json(res, 503, { ok: false, error: '主动观察未初始化' })
        return json(res, 200, { ok: true, autonomy: autonomy.status() })
      }
      if (route === '/agency/autonomy' && req.method === 'POST') {
        if (!autonomy) return json(res, 503, { ok: false, error: '主动观察未初始化' })
        const body = await readBody(req)
        const level = String(body.level || '').trim().toLowerCase()
        if (!['off', 'observe', 'assist', 'auto'].includes(level)) {
          return json(res, 400, { ok: false, error: 'level 不合法' })
        }
        applySettings({ ...config, autonomyLevel: level })
        return json(res, 200, { ok: true, autonomy: autonomy.status() })
      }
      if (route === '/agency/decide' && req.method === 'POST') {
        if (!agency) return json(res, 503, { ok: false, error: '自主行为未初始化' })
        if (config.agencyEnabled !== true) return json(res, 403, { ok: false, error: '自主行为已关闭' })
        const body = await readBody(req)
        const id = String(body.id || '')
        const action = String(body.action || '')
        if (id === '' || !['approve', 'reject'].includes(action)) {
          return json(res, 400, { ok: false, error: 'id/action 不合法' })
        }
        const decided = agency.decide(id, action)
        return json(res, decided.ok ? 200 : 400, decided)
      }
      if (route === '/agency/undo' && req.method === 'POST') {
        if (!agency) return json(res, 503, { ok: false, error: '自主行为未初始化' })
        const body = await readBody(req)
        const undone = agency.undo(String(body.id || ''))
        return json(res, undone.ok ? 200 : 400, undone)
      }
      if (route === '/self' && req.method === 'GET') {
        if (!self) return json(res, 503, { ok: false, error: '自我记忆未初始化' })
        const petId = String(url.searchParams.get('pet') || readPersona({ dataDir: dir }).petId || 'default')
        const limit = Number(url.searchParams.get('limit') || 50)
        return json(res, 200, { ok: true, state: self.state(petId), events: self.recent(petId, limit), stats: self.stats(), presence: presenceInfo() })
      }
      if (route === '/self/state' && req.method === 'GET') {
        if (!self) return json(res, 503, { ok: false, error: '自我记忆未初始化' })
        const petId = String(url.searchParams.get('pet') || readPersona({ dataDir: dir }).petId || 'default')
        const state = self.state(petId)
        const built = selfBlockFor(petId)
        return json(res, 200, {
          ok: true,
          state,
          presence: presenceInfo(),
          inject: config.selfInject === true,
          previewBlock: built.block ?? '',
          previewEvents: built.eventIds,
          budget: config.selfBudget,
        })
      }
      if (route === '/self/preview' && req.method === 'POST') {
        if (!self) return json(res, 503, { ok: false, error: '自我记忆未初始化' })
        const body = await readBody(req)
        const persona = readPersona({ dataDir: dir })
        const petId = persona.petId || 'default'
        const base = typeof body.system === 'string' && body.system.trim() !== '' ? body.system : persona.text
        const query = String(body.query ?? '').trim().slice(0, 500) || '你好'
        const built = selfBlockFor(petId)
        const result = recallEngine.recall(
          { petId, system: base, history: [], userText: query },
          store.active ?? [],
          { budgetChars: config.budgetChars, petId, selfBlock: built.block },
        )
        const block = typeof result.block === 'string' ? result.block : ''
        const system = block === '' ? base : base === '' ? block : `${base}\n\n${block}`
        return json(res, 200, {
          ok: true,
          query,
          selfBlock: built.block ?? '',
          selfEvents: built.eventIds,
          block,
          system,
          hits: result.hits ?? [],
          budgetChars: config.budgetChars,
          selfBudget: config.selfBudget,
        })
      }
      if (route === '/self/reset' && req.method === 'POST') {
        if (!self) return json(res, 503, { ok: false, error: '自我记忆未初始化' })
        const body = await readBody(req)
        const petId = String(body.pet || '').trim()
        return json(res, 200, { ok: true, ...(await self.reset(petId)) })
      }
      if (route === '/voice/status' && req.method === 'GET') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        return json(res, 200, { ok: true, voice: voiceView() })
      }
      if (route === '/voice/events' && req.method === 'GET') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        const limit = Number(url.searchParams.get('limit') || 20)
        return json(res, 200, { ok: true, events: voice.events(limit) })
      }
      if (route === '/voice/enroll' && req.method === 'POST') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        const body = await readBody(req, 4 * 1024 * 1024)
        try {
          return json(res, 200, { ok: true, ...(await voice.enroll(body)) })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error), code: error?.code ?? '' })
        }
      }
      if (route === '/voice/verify' && req.method === 'POST') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        const body = await readBody(req, 4 * 1024 * 1024)
        try {
          return json(res, 200, { ok: true, ...(await voice.verify(body)) })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (route === '/voice/utterance' && req.method === 'POST') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        const body = await readBody(req, 4 * 1024 * 1024)
        try {
          return json(res, 200, { ok: true, ...(await voice.utterance(body)) })
        } catch (error) {
          return json(res, 400, { ok: false, error: String(error?.message ?? error) })
        }
      }
      if (route === '/voice/reset' && req.method === 'POST') {
        if (!voice) return json(res, 503, { ok: false, error: '语音服务未初始化' })
        return json(res, 200, { ok: true, ...(await voice.reset()) })
      }
      return json(res, 404, { ok: false, error: 'not found' })
    } catch (error) {
      try {
        logger?.warn?.(`api_error ${req.method} ${route} ${error?.stack ?? error}`)
      } catch {
        /* ignore */
      }
      return json(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  }
  return { handler, overview }
}
