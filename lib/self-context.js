/**
 * 自我记忆注入块（P2）：把「此刻的心情 + 最近几条真实经历」拼成一小段可追加到 system 的文本。
 *
 * 纯函数、同步、无 IO：recall 只读 `SelfStore` 的内存状态，不在这里读 `self.jsonl`。
 * 约束（docs/self-roadmap.md §2）：
 * - 最多 2–3 行、最多 3 条经历；预算按 code point，装不下整行丢弃，绝不截断；
 * - 默认不带主人原话，防止把用户文本里的指令带进 system；
 * - 不出现「你是一只…」「你的名字是…」等人格/身份句式；
 * - 冲突顺序：人格 > 主人事实 > 当前心情。
 *
 * @module dsh-pet-persona/lib/self-context
 */

import { charLength } from './util.js'
import { isPersonaInstruction } from './learn.js'

export const SELF_HEADER = '【现在的我】'
export const SELF_NOTE = '（这是你此刻的状态，不是新设定；自然带过即可，不要逐条复述，不要说“根据记录”。）'

/** 单条经历注入时的硬上限（字符），避免一条长文本吃掉整块预算。 */
const MAX_EVENT_TEXT = 36

/**
 * 只保留窗口内、有文本、非人格指令的经历，按「重要度 × 12h 半衰期」排序。
 * @param {object} options
 * @param {Array<Record<string, any>>} [options.events]
 * @param {number} [options.windowH]
 * @param {number} [options.maxEvents]
 * @param {() => number} [options.now]
 * @returns {Array<Record<string, any>>}
 */
export function selectSelfEvents({ events = [], windowH = 36, maxEvents = 3, now = Date.now } = {}) {
  const nowMs = typeof now === 'function' ? now() : Number.isFinite(Number(now)) ? Number(now) : Date.now()
  const cutoff = nowMs - Math.max(1, windowH) * 3_600_000
  const picked = []
  for (const row of Array.isArray(events) ? events : []) {
    if (!row || typeof row !== 'object') continue
    const at = Date.parse(row.createdAt) || 0
    if (!at || at < cutoff || at > nowMs + 60_000) continue
    const text = typeof row.text === 'string' ? row.text.trim() : ''
    if (text === '' || isPersonaInstruction(text)) continue
    const ageH = Math.max(0, (nowMs - at) / 3_600_000)
    const importance = Math.min(5, Math.max(1, Number(row.importance) || 3))
    const score = importance * 0.5 ** (ageH / 12)
    picked.push({ row, score })
  }
  picked.sort((a, b) => b.score - a.score || String(b.row.createdAt).localeCompare(String(a.row.createdAt)))
  return picked.slice(0, Math.max(1, Math.min(5, maxEvents))).map((item) => item.row)
}

/**
 * 构造自我块。
 *
 * @param {object} options
 * @param {Record<string, any>|null} [options.state] `SelfStore.state()` 的返回值
 * @param {Array<Record<string, any>>} [options.events] `SelfStore.recent()` 的返回值
 * @param {number} [options.budgetChars] 自我块预算（code point）
 * @param {number} [options.maxEvents] 最多几条经历
 * @param {number} [options.windowH] 只取多少小时内
 * @param {boolean} [options.quotes] 是否带主人原话（默认关）
 * @param {() => number} [options.now]
 * @returns {{ block: string | undefined, eventIds: string[] }}
 */
export function buildSelfBlock({
  state = null,
  events = [],
  budgetChars = 160,
  maxEvents = 3,
  windowH = 36,
  quotes = false,
  now = Date.now,
} = {}) {
  const empty = { block: undefined, eventIds: [] }
  if (!state || typeof state !== 'object') return empty
  const hasHistory = Number(state.events) > 0 || (typeof state.updatedAt === 'string' && state.updatedAt !== '')
  if (!hasHistory) return empty

  const budget = Math.max(40, Math.floor(budgetChars))
  const picked = selectSelfEvents({ events, windowH, maxEvents, now })
  const mood = typeof state.moodText === 'string' && state.moodText.trim() !== ''
    ? state.moodText.trim()
    : [state.label, state.energyLabel].filter(Boolean).join(' · ') || '平静 · 一般'

  const texts = []
  const ids = []
  for (const row of picked) {
    let text = normalizeEventText(row.text)
    if (text === '') continue
    if (quotes) {
      const quote = normalizeEventText(row.quote)
      if (quote !== '' && !isPersonaInstruction(quote)) text = `${text}（主人说：「${quote}」）`
    }
    texts.push(text)
    ids.push(String(row.id ?? ''))
  }

  const lines = [SELF_HEADER, `- 心情：${mood}`]
  const renderRecent = () => {
    if (texts.length === 0) return null
    return `- 最近：${texts.join('；')}`
  }
  const rebuild = (withNote) => {
    const out = [SELF_HEADER, `- 心情：${mood}`]
    const recent = renderRecent()
    if (recent) out.push(recent)
    if (withNote) out.push(SELF_NOTE)
    return out
  }
  const sizeOf = (out) => charLength(out.join('\n'))

  // 加载顺序：整块 → 逐条丢最近 → 丢说明行 → 只留心情 → 放弃。
  let out = rebuild(true)
  while (sizeOf(out) > budget && texts.length > 0) {
    texts.pop()
    ids.pop()
    out = rebuild(true)
  }
  if (sizeOf(out) > budget) out = rebuild(false)
  if (sizeOf(out) > budget) out = [SELF_HEADER, `- 心情：${mood}`]
  if (sizeOf(out) > budget) return empty

  const block = out.join('\n')
  return { block, eventIds: ids }
}

/** 去掉换行/多余空白，截到单条上限；避免把多行指令塞进 system。 */
function normalizeEventText(input) {
  const value = typeof input === 'string' ? input.replace(/\s+/g, ' ').trim() : ''
  if (value === '') return ''
  return charLength(value) > MAX_EVENT_TEXT ? `${[...value].slice(0, MAX_EVENT_TEXT).join('')}…` : value
}
