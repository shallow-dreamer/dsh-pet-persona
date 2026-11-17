/**
 * recall：用户消息 + 最近历史 → 选中的长期事实 → 一段可注入的文本块。
 *
 * 硬约束（SPEC §5.1）：
 * - **同步、无 IO**：只读内存索引与预计算 token，不做任何 await/读盘；
 * - 400ms 软截止：超过就放弃本次注入并记日志（宿主 1500ms 硬超时且静默）；
 * - 任何异常向上抛给 index.js 统一记 `recall_error`，调用方必须不影响回复；
 * - 没有任何事实可注入时返回 `undefined`（而不是空串）。
 *
 * @module dsh-pet-persona/lib/recall
 */

import { buildSynonymIndex, charLength, clampNumber, tokensOf } from './util.js'

/** 类型 → 中文标签（memory-algo §3.4）。 */
export const LABELS = Object.freeze({
  identity: '称呼',
  preference: '偏好',
  routine: '习惯',
  relation: '关系',
  event: '约定',
  boundary: '禁忌',
})

/** 注入块的两行 header（逐字固定，见 SPEC §5.2）。 */
export const HEADER_LINES = Object.freeze([
  '【长期记忆】以下是你在以往对话里记下的关于主人的事实。自然地在合适的时候用，不要逐条复述，不要说“根据我的记忆”。',
  '若与上面的角色设定、宠物名字、当前时间冲突，一律以上面的设定为准；这些只是补充事实。',
])

const HEADER_TEXT = HEADER_LINES.join('\n')
const MAX_CANDIDATES = 8
const MIN_REL = 0.08
const MIN_SCORE = 0.35
const QUERY_CLIP = 2000
const HISTORY_TURNS = 4
const CACHE_LIMIT = 64
const SOFT_DEADLINE_MS = 400

/**
 * @typedef {object} RecallInput
 * @property {string} [petId]
 * @property {string} [system]
 * @property {Array<{ role?: string, content?: string }>} [history]
 * @property {string} [userText]
 */

/**
 * @typedef {object} RecallResult
 * @property {string | undefined} block 注入块；无可注入内容时 undefined
 * @property {string[]} hits 命中事实 id（用于异步累计 hits）
 * @property {number} elapsedMs
 */

/**
 * 把 history 尾部与当前用户消息拼成查询文本。
 * @param {RecallInput} input
 * @returns {string}
 */
function buildQuery(input) {
  const parts = []
  const history = Array.isArray(input.history) ? input.history : []
  for (const turn of history.slice(-HISTORY_TURNS)) {
    const content = typeof turn?.content === 'string' ? turn.content : ''
    if (content.trim() !== '') parts.push(content)
  }
  if (typeof input.userText === 'string' && input.userText.trim() !== '') parts.push(input.userText)
  return parts.join('\n').slice(0, QUERY_CLIP)
}

/**
 * 文本是否值得检索：至少 2 个字符，或含 ASCII 词。
 * @param {string} text
 * @param {string[]} tokens
 * @returns {boolean}
 */
function searchable(text, tokens) {
  if (tokens.size === 0) return false
  if (charLength(text.trim()) >= 2) return true
  for (const token of tokens) if (/[a-z0-9]/i.test(token)) return true
  return false
}

/**
 * @param {object} options
 * @param {{ syn: Map<string, string[]>, rev: Map<string, string[]> }} [options.synonyms]
 * @param {ReturnType<import('./log.js').createLogger>} [options.log]
 * @param {() => number} [options.now]
 */
export function createRecall({ synonyms, log = null, now = Date.now } = {}) {
  const index = synonyms ?? buildSynonymIndex({})
  /** @type {Map<string, string>} */
  const cache = new Map()

  /** 事实变更后必须调用，否则可能返回旧块。 */
  function invalidate() {
    cache.clear()
  }

  /**
   * 同步召回。
   * @param {RecallInput} input
   * @param {Record<string, any>[]} facts 活跃事实（store.active）
   * @param {{ budgetChars?: number, petId?: string, selfBlock?: string }} [options]
   * @returns {RecallResult}
   */
  function recall(input, facts, options = {}) {
    const started = now()
    const budget = Math.max(120, Math.floor(options.budgetChars ?? 1200))
    const petId = options.petId ?? input?.petId ?? 'default'
    // 自我块独立预算，已由 self-context 算好；这里只负责拼在事实块之后。
    const selfBlock = typeof options.selfBlock === 'string' && options.selfBlock.trim() !== '' ? options.selfBlock : ''
    const onlySelf = () => ({ block: selfBlock || undefined, hits: [], elapsedMs: now() - started })
    const deadline = started + SOFT_DEADLINE_MS
    const overtime = () => {
      log?.warn?.(`recall_deadline petId=${petId} elapsed=${now() - started}ms`)
      return { block: undefined, hits: [], elapsedMs: now() - started }
    }

    const query = buildQuery(input ?? {})
    const queryTokens = tokensOf(query)
    if (!searchable(query, queryTokens)) return onlySelf()

    // 同义词一跳双向展开（只扩一层，避免组合爆炸）
    const expanded = new Set(queryTokens)
    for (const token of queryTokens) {
      for (const hit of index.syn.get(token) ?? []) expanded.add(hit)
      for (const hit of index.rev.get(token) ?? []) expanded.add(hit)
    }
    const expandedList = [...expanded]
    const querySet = new Set(expandedList)

    /** @type {Array<{ fact: Record<string, any>, score: number, rel: number, forced: boolean }>} */
    const scored = []
    const seenKeys = new Set()
    const nowMs = now()

    for (const fact of Array.isArray(facts) ? facts : []) {
      if (!fact || fact.validTo != null) continue
      if ((fact.petId ?? 'default') !== petId) continue
      if (now() > deadline) return overtime()

      const factTokens = fact._tokens ?? tokensOf(fact.value ?? '')
      let shared = 0
      for (const token of factTokens) if (querySet.has(token)) shared += 1
      const union = factTokens.size + querySet.size - shared
      const sim = union <= 0 ? 0 : shared / union
      const keyTokens = tokensOf(String(fact.key ?? '').replace(/\./g, ' '))
      let keyHit = 0
      for (const token of keyTokens) {
        if (querySet.has(token)) {
          keyHit = 1
          break
        }
      }
      const rel = clampNumber(0.8 * sim + 0.2 * keyHit, 0, 1)

      const pin = fact.pinned === true ? 1 : 0
      const type = fact.type ?? 'event'
      const importance = clampNumber(Number(fact.importance ?? 3) / 5, 0, 1)
      const ageDays = Math.max(0, (nowMs - (fact._createdMs ?? nowMs)) / 86_400_000)
      const fresh = pin === 1 || type === 'identity' ? 1 : 0.5 ** (ageDays / 30)
      const score = 0.4 * rel + 0.3 * importance + 0.2 * fresh + 0.1 * pin

      const forced = type === 'boundary' && pin === 1
      if (!forced && (rel < MIN_REL || score < MIN_SCORE)) continue
      const nk = fact._nk ?? String(fact.key ?? '')
      if (seenKeys.has(nk)) continue
      seenKeys.add(nk)
      scored.push({ fact, score, rel, forced })
    }

    if (scored.length === 0) return onlySelf()

    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score
      const hitsA = Number(a.fact.hits) || 0
      const hitsB = Number(b.fact.hits) || 0
      if (hitsA !== hitsB) return hitsA - hitsB
      return (b.fact._createdMs ?? 0) - (a.fact._createdMs ?? 0)
    })
    const forced = scored.filter((item) => item.forced).slice(0, 2)
    const normal = scored.filter((item) => !item.forced)
    const chosen = [...forced, ...normal].slice(0, MAX_CANDIDATES)
    if (chosen.length === 0) return { block: undefined, hits: [], elapsedMs: now() - started }

    // 预算按 code point 计算；header 先扣；装不下就 break，绝不截断
    const headerLength = charLength(HEADER_TEXT) + 1
    if (headerLength >= budget) return onlySelf()

    const cacheKey = `${budget}|${chosen.map((item) => item.fact.id).join(',')}|${selfBlock}`
    const cached = cache.get(cacheKey)
    if (cached) {
      cache.delete(cacheKey)
      cache.set(cacheKey, cached)
      return { block: cached, hits: chosen.map((item) => item.fact.id), elapsedMs: now() - started }
    }

    const lines = []
    let used = headerLength
    for (const item of chosen) {
      if (now() > deadline) return overtime()
      const fact = item.fact
      const label = LABELS[fact.type] ?? LABELS.event
      const value = String(fact.value ?? '')
      if (value === '') continue
      const line = `- (${label}) ${value}${fact.pinned === true ? ' ★' : ''}`
      const length = charLength(line) + 1
      if (used + length > budget) break
      lines.push(line)
      used += length
    }
    if (lines.length === 0) return onlySelf()

    const factsBlock = `${HEADER_TEXT}\n${lines.join('\n')}`
    const block = selfBlock === '' ? factsBlock : `${factsBlock}\n\n${selfBlock}`
    cache.set(cacheKey, block)
    if (cache.size > CACHE_LIMIT) {
      const oldest = cache.keys().next().value
      if (oldest !== undefined) cache.delete(oldest)
    }
    log?.debug?.(`recall_hit petId=${petId} facts=${lines.length} chars=${charLength(block)}`)
    return { block, hits: chosen.map((item) => item.fact.id), elapsedMs: now() - started }
  }

  return { recall, invalidate, cacheSize: () => cache.size }
}
