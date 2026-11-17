/**
 * 通用小工具：ULID 形状的 id、sha1、中文 bigram、归一化、Dice 相似度。
 *
 * 这里的函数全部是纯函数（不碰磁盘、不读时钟以外的环境），recall 侧可以直接调用。
 * @module dsh-pet-persona/lib/util
 */

import { createHash, randomBytes } from 'node:crypto'

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 生成时间有序的 id：`f_` + 10 位 Crockford base32 时间戳 + 10 位随机。
 * 时间前缀让同一秒内的记录仍可按创建顺序排，排障时肉眼也能看出先后。
 * @param {string} [prefix]
 * @returns {string}
 */
export function ulid(prefix = 'f_') {
  let ts = Date.now()
  let time = ''
  for (let i = 0; i < 10; i += 1) {
    time = CROCKFORD[ts % 32] + time
    ts = Math.floor(ts / 32)
  }
  const bytes = randomBytes(10)
  let rand = ''
  for (let i = 0; i < 10; i += 1) rand += CROCKFORD[bytes[i] % 32]
  return prefix + time + rand
}

/**
 * @param {string} text
 * @returns {string} sha1 hex
 */
export function sha1Hex(text) {
  return createHash('sha1').update(String(text), 'utf8').digest('hex')
}

/**
 * 事实去重哈希：`sha1(normKey + "\0" + normValue)` 的前 6 字节 hex（12 字符）。
 * @param {string} normKey
 * @param {string} normValue
 * @returns {string}
 */
export function factHash(normKey, normValue) {
  return sha1Hex(String(normKey) + '\u0000' + String(normValue)).slice(0, 12)
}

/**
 * NFKC 把全角字母数字标点折成半角；中文保持原样。
 * @param {unknown} value
 * @returns {string}
 */
export function toHalf(value) {
  return String(value ?? '').normalize('NFKC')
}

/**
 * key 归一：去空白、全角→半角、`·：。` 统一为 `.`、小写。
 * @param {unknown} value
 * @returns {string}
 */
export function normKey(value) {
  return toHalf(value)
    .replace(/\s+/g, '')
    .replace(/[·:：。]/g, '.')
    .replace(/\.+/g, '.')
    .replace(/^\.|\.$/g, '')
    .toLowerCase()
}

/**
 * value 归一：去空白与标点，只保留中文/字母/数字，全角→半角，小写。
 * @param {unknown} value
 * @returns {string}
 */
export function normValue(value) {
  return toHalf(value)
    .toLowerCase()
    .replace(/[^0-9a-z\u4e00-\u9fff\u3400-\u4dbf]/g, '')
}

/** 停用字：直接删除，不参与 bigram（memory-algo §2.2）。 */
export const STOP_CHARS = new Set(
  [...'的了是在我你他她它们这那有和与就都很吗呢吧啊呀哦嗯哈一个不没要会能说想到去来把被给让上下中好请帮问谁什么怎么为哪几些还又再然后因为所以但是如果'],
)

/** 停用 ASCII 词（整词丢弃，不拆字母）。 */
const STOP_WORDS = new Set(['the', 'and', 'for', 'you', 'are', 'was', '不是', '这个'])

/**
 * 中文按字符 bigram、ASCII 按整词切分，产出匹配用 token 集合（不含同义词展开）。
 *
 * @param {unknown} text
 * @returns {Set<string>}
 */
export function tokensOf(text) {
  const out = new Set()
  const source = toHalf(text).toLowerCase()
  // ASCII 词：整词匹配，不拆字母 bigram
  for (const word of source.match(/[a-z0-9][a-z0-9_-]*/g) ?? []) {
    if (word.length >= 2 && !STOP_WORDS.has(word)) out.add(word)
  }
  // 中文连续段：先剔停用字，再取相邻 bigram
  for (const run of source.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? []) {
    const chars = [...run].filter((ch) => !STOP_CHARS.has(ch))
    for (let i = 0; i + 1 < chars.length; i += 1) out.add(chars[i] + chars[i + 1])
  }
  return out
}

/**
 * Dice 系数：`2|A∩B| / (|A|+|B|)`。
 * @param {Iterable<string>} a
 * @param {Iterable<string>} b
 * @returns {number} 0–1
 */
export function dice(a, b) {
  const sa = a instanceof Set ? a : new Set(a)
  const sb = b instanceof Set ? b : new Set(b)
  if (sa.size === 0 || sb.size === 0) return 0
  let shared = 0
  for (const token of sa) if (sb.has(token)) shared += 1
  return (2 * shared) / (sa.size + sb.size)
}

/**
 * 同义词一跳展开：`expand(token) = {token} ∪ syn[token] ∪ {k | token ∈ syn[k]}`。
 *
 * @param {Set<string>} tokens
 * @param {Map<string, string[]>} syn 正向表
 * @param {Map<string, string[]>} rev 反向表（value → keys）
 * @returns {Set<string>} 新集合（不修改入参）
 */
export function expandTokens(tokens, syn, rev) {
  const out = new Set(tokens)
  for (const token of tokens) {
    for (const alt of syn.get(token) ?? []) out.add(alt)
    for (const alt of rev.get(token) ?? []) out.add(alt)
  }
  return out
}

/**
 * 把同义词表（`{key: [alts]}`）编译成正/反两个 Map，正反都只保留非空字符串。
 * @param {Record<string, string[]>} table
 * @returns {{ syn: Map<string, string[]>, rev: Map<string, string[]> }}
 */
export function buildSynonymIndex(table) {
  const syn = new Map()
  const rev = new Map()
  for (const [key, list] of Object.entries(table ?? {})) {
    const k = String(key).trim()
    if (k === '' || !Array.isArray(list)) continue
    const alts = list.map((item) => String(item).trim()).filter((item) => item !== '')
    if (alts.length === 0) continue
    syn.set(k, alts)
    for (const alt of alts) {
      const bucket = rev.get(alt)
      if (bucket) bucket.push(k)
      else rev.set(alt, [k])
    }
  }
  return { syn, rev }
}

/**
 * 按 code point 计字符数（中文与 emoji 都算 1；与预算单位一致）。
 * @param {string} text
 * @returns {number}
 */
export function charLength(text) {
  return [...String(text)].length
}

/**
 * 截断到最多 n 个 code point，不加省略号（事实半句比截断更糟，这里只用于超长兜底）。
 * @param {unknown} value
 * @param {number} n
 * @returns {string}
 */
export function clampText(value, n) {
  const chars = [...String(value ?? '')]
  return chars.length <= n ? chars.join('') : chars.slice(0, n).join('')
}

/**
 * 数值夹取。
 * @param {number} n
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function clampNumber(n, min, max) {
  const v = Number(n)
  if (!Number.isFinite(v)) return min
  return Math.min(max, Math.max(min, v))
}
