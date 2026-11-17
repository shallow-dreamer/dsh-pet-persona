/**
 * 敏感信息过滤（落盘前最后一道）：命中即拒绝写入，只记原因，不落原文。
 *
 * 规则来自 docs/memory-algo.md §3.6。这里只做「判定」，不做日志与落盘 —— 调用方负责。
 * @module dsh-pet-persona/lib/sensitive
 */

const RULES = [
  { reason: 'credential-word', re: /密码|口令|passwd|password/i },
  { reason: 'credential-word', re: /token|api[_-]?key|secret|私钥|助记词/i },
  { reason: 'code-word', re: /验证码|短信码/ },
  { reason: 'long-number', re: /\d{15,19}/ },
  { reason: 'phone', re: /\d{3}-\d{4}-\d{4}/ },
  { reason: 'key-prefix', re: /sk-[A-Za-z0-9]{16,}/ },
]

/**
 * 判断一段文本是否像敏感信息。
 *
 * @param {unknown} text
 * @returns {string | null} 命中返回原因（写日志用），未命中返回 null
 */
export function sensitiveReason(text) {
  const value = String(text ?? '')
  if (value === '') return null
  for (const rule of RULES) {
    if (rule.re.test(value)) return rule.reason
  }
  return null
}

/**
 * 只要任一字段命中就算敏感（value / quote / 原话）。
 *
 * @param {...unknown} texts
 * @returns {{ reason: string, field: number } | null}
 */
export function sensitiveIn(...texts) {
  for (let i = 0; i < texts.length; i += 1) {
    const reason = sensitiveReason(texts[i])
    if (reason) return { reason, field: i }
  }
  return null
}

/** 用户明确要求记住密码类信息时，改记一条「不记录密码」的禁忌。 */
export const PASSWORD_BOUNDARY = {
  type: 'boundary',
  key: '主人.禁忌',
  value: '主人不希望记录任何密码类信息',
  importance: 5,
}

/**
 * 显式「记住密码」检测：`记住/记下/帮我记` 与凭据词同句出现。
 * @param {unknown} text
 * @returns {boolean}
 */
export function asksToRememberSecret(text) {
  const value = String(text ?? '')
  if (!/记(住|下|一下|着)|帮.*记/.test(value)) return false
  return /密码|口令|passwd|password|token|api[_-]?key|secret|私钥|助记词/i.test(value)
}
