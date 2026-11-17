/**
 * capture 侧：把「用户说了什么」攒成批次，抽取成结构化事实，交给 FactStore 合并。
 *
 * 设计要点（memory-algo §3）：
 * - capture 是 fire-and-forget：永远不抛错、不阻塞回复；失败只写日志；
 * - 单 inflight + dirty：抽取进行中再来的批次只置位，不并发；
 * - 无模型 / 模型失败 → 正则兜底，宁可少记也不乱记；
 * - 落盘前严格校验（key 正则、方面白名单、quote 必须是原话子串、敏感词过滤）。
 *
 * @module dsh-pet-persona/lib/learn
 */

import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { asksToRememberSecret, PASSWORD_BOUNDARY, sensitiveReason } from './sensitive.js'
import { clampNumber, clampText, factHash, normKey, normValue } from './util.js'

const BUFFER_LIMIT = 20
const MAX_ITEMS = 12
const EXTRACT_TIMEOUT_MS = 20_000
const RETRY_DELAY_MS = 2_000

/** 明确要求记住的原话标记（只影响 pinned）。 */
const PIN_MARKERS = ['记住', '别忘', '不要忘', '一定', '以后都']

/** 强信号：出现这些说法就立刻抽取，不等 N 轮。 */
const STRONG_SIGNAL = /记住|记一下|别忘|不要忘|以后都|我叫|我姓|我生日|我不吃|我忌口|叫我/

/** key 的合法形状：`主人.称呼` 这类「主体.方面」。 */
const KEY_PATTERN = /^[\u4e00-\u9fa5A-Za-z]{1,10}\.[\u4e00-\u9fa5]{2,6}$/

/** 允许的方面；未知方面归「近况」。 */
export const ASPECTS = new Set([
  '称呼', '名字', '身份', '职业', '城市', '生日', '喜好', '忌口',
  '作息', '习惯', '关系', '约定', '禁忌', '近况',
])

/** 类型缺省 importance。 */
const DEFAULT_IMPORTANCE = { identity: 5, boundary: 5, event: 4, preference: 3, routine: 3, relation: 3 }

const VALID_TYPES = new Set(['identity', 'preference', 'routine', 'relation', 'event', 'boundary'])
const VALID_OPS = new Set(['ADD', 'UPDATE', 'DELETE'])

/**
 * 人格防注入：事实里不允许出现「你是/你叫/扮演/人格/口癖」这类针对桌宠角色的指令。
 * 人格 100% 归 dsh-pet 的 whisperPrompt，记忆只补充关于主人的事实（SPEC §2.4）。
 */
export const PERSONA_PATTERN =
  /(?:你|您)(?:以后|之后|现在|其实|真的|一直|就|也|还|都|不|要)*(?:是|叫|应该|必须|不能|可以|得|要|听|学|说|做|当|装|记住|记得|忘|的(?:名字|身份|性格|设定|口癖|语气|人格))|扮演|人格|人设|口癖|语气设定|角色设定|性格设定/

/**
 * @param {unknown} value
 * @returns {boolean}
 */
export function isPersonaInstruction(value) {
  return PERSONA_PATTERN.test(String(value ?? ''))
}


/** 抽取器 system prompt（SPEC §3.3，固定文本）。 */
export const EXTRACT_SYSTEM = `你是长期记忆抽取器。从用户的话里抽取值得长期记住的关于主人的事实。
只输出 JSON，格式：{"facts":[{"op":"ADD","type":"identity","key":"主人.称呼","value":"阿岚","importance":5,"pinned":false,"quote":"我叫阿岚"}]}
规则：
- op 只能是 ADD / UPDATE / DELETE；不确定就 ADD
- type 只能是 identity|preference|routine|relation|event|boundary
- key 形如「主人.<方面>」，方面只能是：称呼、名字、身份、职业、城市、生日、喜好、忌口、作息、习惯、关系、约定、禁忌、近况
- value 不超过 60 字，一条只写一个事实，用陈述句；value 不要带「主人说」这类转述
- quote 必须是用户原话里的连续片段（不超过 80 字），没有就填空串
- 不要记录密码、口令、密钥、验证码、证件号、银行卡号；用户要求记密码时输出 {"op":"ADD","type":"boundary","key":"主人.禁忌","value":"主人不希望记录任何密码类信息","importance":5}
- 只有用户明确说「记住 / 别忘 / 以后都」时 pinned 才为 true
- 没有值得记的就输出 {"facts":[]}`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * 把模型输出解析成数组：容忍 ```json 围栏、前后废话、单个对象。
 * @param {string} raw
 * @returns {any[] | null}
 */
export function parseExtractionJson(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const attempts = []
  const trimmed = raw.trim()
  attempts.push(trimmed)
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced) attempts.push(fenced[1].trim())
  for (const text of attempts) {
    try {
      const parsed = JSON.parse(text)
      if (Array.isArray(parsed)) return parsed
      if (parsed && Array.isArray(parsed.facts)) return parsed.facts
      if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') return [parsed]
    } catch {
      /* 继续尝试切片 */
    }
  }
  // 前后有废话：优先截取最外层数组，其次对象
  const source = attempts[attempts.length - 1]
  for (const [open, close] of [['[', ']'], ['{', '}']]) {
    const start = source.indexOf(open)
    const end = source.lastIndexOf(close)
    if (start < 0 || end <= start) continue
    try {
      const parsed = JSON.parse(source.slice(start, end + 1))
      if (Array.isArray(parsed)) return parsed
      if (parsed && Array.isArray(parsed.facts)) return parsed.facts
      if (parsed && typeof parsed === 'object' && typeof parsed.key === 'string') return [parsed]
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * 校验并规范化一条抽取结果。
 * @param {any} raw
 * @param {string} batchText 本批用户原话（quote 子串校验用）
 * @returns {Record<string, any> | null}
 */
export function validateItem(raw, batchText) {
  if (!raw || typeof raw !== 'object') return null
  const op = String(raw.op ?? 'ADD').toUpperCase()
  if (!VALID_OPS.has(op)) return null

  const key = normKey(raw.key ?? '')
  if (!KEY_PATTERN.test(key)) return null
  const [prefix, aspect] = key.split('.')
  const safeAspect = ASPECTS.has(aspect) ? aspect : '近况'
  const safeKey = `${prefix}.${safeAspect}`

  if (op === 'DELETE') return { op, type: 'event', key: safeKey, value: '', quote: '', importance: 4, pinned: false }

  const value = clampText(String(raw.value ?? '').trim(), 60)
  if (value === '') return null
  if (sensitiveReason(value)) return null

  const type = VALID_TYPES.has(raw.type) ? raw.type : 'event'
  const importance = clampNumber(Number(raw.importance ?? DEFAULT_IMPORTANCE[type] ?? 3), 1, 5)

  let quote = clampText(String(raw.quote ?? '').trim(), 80)
  if (quote !== '' && !String(batchText).includes(quote)) quote = ''
  const pinned = quote !== '' && PIN_MARKERS.some((marker) => String(batchText).includes(marker))

  return { op, type, key: safeKey, value, quote, importance, pinned }
}

/**
 * 校验整批输出：去重、超过 12 条时按 importance 取前 12。
 * @param {any[]} list
 * @param {string} batchText
 * @returns {Record<string, any>[]}
 */
export function validateItems(list, batchText) {
  if (!Array.isArray(list)) return []
  const out = []
  const seen = new Set()
  for (const raw of list) {
    const item = validateItem(raw, batchText)
    if (!item) continue
    const hash = factHash(normKey(item.key), normValue(item.value))
    if (seen.has(hash)) continue
    seen.add(hash)
    out.push(item)
    if (out.length >= MAX_ITEMS * 4) break
  }
  if (out.length <= MAX_ITEMS) return out
  return out.sort((a, b) => (Number(b.importance) || 0) - (Number(a.importance) || 0)).slice(0, MAX_ITEMS)
}

/**
 * 无模型 / 模型失败时的正则兜底：只覆盖最明确的自述句式。
 * @param {string} text
 * @returns {Record<string, any>[]}
 */
export function extractWithRegex(text) {
  const source = String(text ?? '')
  /** @type {Record<string, any>[]} */
  const items = []
  const add = (type, key, value, quote, importance = DEFAULT_IMPORTANCE[type] ?? 3) => {
    if (!value) return
    items.push({ op: 'ADD', type, key, value: clampText(value, 60), quote: clampText(quote, 80), importance, pinned: false })
  }

  const name = source.match(/(?:我叫|叫我|我的名字是|我名字叫)([\u4e00-\u9fa5A-Za-z0-9·]{1,8})/)
  if (name) add('identity', '主人.称呼', name[1], name[0], 5)
  const birthday = source.match(/(?:我生日是|我生日|生日是)\s*([0-9]{4}\s*[-/.年]\s*[0-9]{1,2}\s*[-/.月]\s*[0-9]{1,2}\s*日?|[0-9]{1,2}\s*月\s*[0-9]{1,2}\s*日)/)
  if (birthday) add('identity', '主人.生日', birthday[1].replace(/\s+/g, ''), birthday[0], 5)
  if (/住在/.test(source)) {
    const city = source.match(/住在([\u4e00-\u9fa5]{2,8}?)(?:市|，|。|,|\s|$)/)
    if (city) add('identity', '主人.城市', city[1], city[0], 4)
  }
  const dislike = source.match(/(?:我不吃|我忌口|我不能吃)([\u4e00-\u9fa5]{1,12})/)
  if (dislike) add('boundary', '主人.忌口', `不吃${dislike[1]}`, dislike[0], 5)
  const like = source.match(/(?:我喜欢|我爱|我超喜欢)([\u4e00-\u9fa5A-Za-z0-9]{1,16})/)
  if (like) add('preference', '主人.喜好', `喜欢${like[1]}`, like[0], 3)
  const remember = source.match(/(?:记住|别忘|不要忘|以后都)([^。！？\n]{1,40})/)
  if (remember) {
    items.push({
      op: 'ADD', type: 'event', key: '主人.约定', value: clampText(remember[1], 60),
      quote: clampText(remember[0], 80), importance: 4, pinned: true,
    })
  }
  return validateItems(items, source)
}

/**
 * 生成批次文本（只取 user 侧，避免把模型自己的话记成主人的事实）。
 * @param {Array<{ userText?: string }>} batch
 * @returns {string}
 */
function batchTextOf(batch) {
  return batch.map((turn) => String(turn.userText ?? '').trim()).filter((text) => text !== '').join('\n')
}

/**
 * 构造送给抽取模型的消息。
 * @param {Array<{ userText?: string }>} batch
 * @param {Record<string, any>[]} existing
 * @returns {string}
 */
export function buildExtractUser(batch, existing = []) {
  const known = existing
    .slice(0, 40)
    .map((fact) => `${fact.key}=${fact.value}`)
    .join('\n')
  const dialogue = batch
    .map((turn) => `用户：${String(turn.userText ?? '').trim()}`)
    .filter((line) => line !== '用户：')
    .join('\n')
  return `已知事实：\n${known || '（无）'}\n\n最近用户消息：\n${dialogue.slice(-1500)}\n\n只返回 JSON。`
}

/**
 * @typedef {object} LearnerOptions
 * @property {{ merge: Function, active: Record<string, any>[], stats: Function }} store
 * @property {Record<string, any>} config
 * @property {ReturnType<import('./log.js').createLogger>} [log]
 * @property {(input: { system: string, user: string, signal: AbortSignal }) => Promise<string>} [complete]
 * @property {(stats: { added: number, updated: number, deleted: number, skipped: number }, items: any[]) => void} [onMerged]
 * @property {string} [dir]
 * @property {() => number} [now]
 */
export function createLearner({ store, config = {}, log = null, complete = null, onMerged = null, dir = null, now = Date.now } = {}) {
  const queueFile = dir ? join(dir, 'learn-queue.jsonl') : null
  /** @type {Array<{ userText: string, replyText: string, ts: number, petId: string }>} */
  let buffer = []
  /** @type {Map<string, number>} */
  const turns = new Map()
  let inflight = false
  let dirty = false
  let idleTimer = null
  let disposed = false

  // 设置页可即时修改这几项：每次用到时重新读，而不是 apply 时固化。
  const everyTurns = () => Math.max(1, Number(config.learnEveryTurns) || 6)
  const idleMs = () => Math.max(5_000, Number(config.idleLearnMs) || 60_000)
  const autoLearnOn = () => config.autoLearn !== false

  /** 队列文件只用于崩溃后排查，允许丢。 */
  function appendQueue(turn) {
    if (!queueFile) return
    const line = JSON.stringify({ petId: turn.petId, ts: new Date(turn.ts).toISOString(), userText: clampText(turn.userText, 500) })
    void appendFile(queueFile, `${line}\n`, 'utf8').catch(() => {})
  }

  function clearIdle() {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  function scheduleIdle() {
    clearIdle()
    idleTimer = setTimeout(() => {
      idleTimer = null
      if (buffer.length >= 2) void run('idle')
    }, idleMs())
    idleTimer.unref?.()
  }

  async function callModel(batch, existing) {
    if (typeof complete !== 'function') return null
    const user = buildExtractUser(batch, existing)
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), EXTRACT_TIMEOUT_MS)
      try {
        const raw = await complete({ system: EXTRACT_SYSTEM, user, signal: controller.signal })
        if (!raw || String(raw).trim() === '') return null
        const parsed = parseExtractionJson(raw)
        if (parsed) return parsed
        log?.warn?.('learn_parse_failed')
      } catch (error) {
        log?.warn?.(`learn_llm_failed attempt=${attempt} ${error?.name ?? ''} ${error?.message ?? error}`)
      } finally {
        clearTimeout(timer)
      }
      if (attempt === 0) await delay(RETRY_DELAY_MS)
    }
    return null
  }

  /**
   * 执行一次抽取。
   * @param {string} reason
   */
  async function run(reason) {
    if (disposed || !autoLearnOn()) return
    if (inflight) {
      dirty = true
      return
    }
    if (buffer.length === 0) return
    inflight = true
    clearIdle()
    const petId = buffer[buffer.length - 1]?.petId ?? 'default'
    const batch = buffer.slice(-BUFFER_LIMIT)
    log?.info?.(`learn_start reason=${reason} petId=${petId} batch=${batch.length}`)
    try {
      const batchText = batchTextOf(batch)
      if (batchText.trim() === '') return
      let items = []
      if (asksToRememberSecret(batchText)) {
        items = [{ op: 'ADD', ...PASSWORD_BOUNDARY }]
      } else {
        const existing = (store.active ?? []).filter((fact) => (fact.petId ?? 'default') === petId)
        const raw = await callModel(batch, existing)
        if (raw) items = validateItems(raw, batchText)
        if (items.length === 0) items = extractWithRegex(batchText)
      }
      if (items.length > 0) {
        const before = items.length
        items = items.filter((item) => !isPersonaInstruction(item.value))
        if (items.length < before) log?.warn?.(`persona_skip count=${before - items.length}`)
      }
      if (items.length > 0) {
        const stats = await store.merge(items, { petId })
        log?.info?.(`learn_merged reason=${reason} added=${stats.added} updated=${stats.updated} skipped=${stats.skipped} archived=${stats.archived}`)
        onMerged?.(stats, items)
      } else {
        log?.debug?.(`learn_empty reason=${reason} batch=${batch.length}`)
      }
      // 成功处理（含空结果）后丢弃已消费的批次
      buffer = buffer.slice(batch.length)
      if (queueFile) await writeFile(queueFile, '', 'utf8').catch(() => {})
    } catch (error) {
      log?.warn?.(`learn_error ${error?.stack ?? error}`)
    } finally {
      inflight = false
      if (dirty) {
        dirty = false
        if (buffer.length > 0) setTimeout(() => void run('dirty'), 0).unref?.()
      } else if (buffer.length > 0) {
        scheduleIdle()
      }
    }
  }

  /**
   * 宿主每轮调用；内部只做内存操作 + 一次 fire-and-forget 落队列，立即返回。
   * @param {{ petId?: string, userText?: string, replyText?: string, ts?: number }} input
   */
  function capture(input = {}) {
    if (disposed || !autoLearnOn()) return
    try {
      const petId = String(input.petId ?? 'default')
      const userText = String(input.userText ?? '').trim()
      if (userText === '') return
      const turn = { petId, userText, replyText: String(input.replyText ?? ''), ts: Number(input.ts) || now() }
      buffer.push(turn)
      if (buffer.length > BUFFER_LIMIT) buffer = buffer.slice(-BUFFER_LIMIT)
      appendQueue(turn)
      const count = (turns.get(petId) ?? 0) + 1
      turns.set(petId, count)
      log?.debug?.(`capture_received petId=${petId} len=${userText.length} pending=${buffer.length} turn=${count}`)
      scheduleIdle()
      const every = everyTurns()
      if (count % every === 0 || STRONG_SIGNAL.test(userText) || buffer.length >= BUFFER_LIMIT) {
        void run(count % every === 0 ? 'turns' : 'signal')
      }
    } catch (error) {
      log?.warn?.(`capture_error ${error?.stack ?? error}`)
    }
  }

  /** 清空（插件禁用 / 单测）：最多等 1s，绝不挂住宿主卸载。 */
  async function dispose() {
    disposed = true
    clearIdle()
    for (let i = 0; i < 20 && inflight; i += 1) await delay(50)
  }

  return {
    capture,
    run,
    dispose,
    pending: () => buffer.length,
    turnsOf: (petId) => turns.get(petId) ?? 0,
  }
}
