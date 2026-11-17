import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * L3-A：主动观察。
 *
 * 只做确定性判断，不调模型、不写用户数据、不调工具。
 * - observe：只记录「本来会说什么」，不真的说；
 * - assist/auto：在硬门禁内允许气泡说一句。
 * 硬门禁：关闭 / 静默时段（除非刚聊过）/ 每日上限 / 同触发冷却 / 当日被忽略降级。
 */

export const AUTONOMY_LEVELS = ['off', 'observe', 'assist', 'auto']
export const TRIGGER_COOLDOWN_H = 6
export const IGNORE_WINDOW_MS = 30 * 60 * 1000
export const TICK_MS = 5 * 60 * 1000

function dayKey(ts) {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function minuteOfDay(ts) {
  const d = new Date(ts)
  return d.getHours() * 60 + d.getMinutes()
}

function parseClock(value, fallback) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(value ?? ''))
  return m ? Number(m[1]) * 60 + Number(m[2]) : fallback
}

export function inQuietHours(ts, start = '23:30', end = '08:00') {
  const a = parseClock(start, 23 * 60 + 30)
  const b = parseClock(end, 8 * 60)
  const t = minuteOfDay(ts)
  return a <= b ? t >= a && t < b : t >= a || t < b
}

function clampText(text, max = 40) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim()
  return Array.from(s).slice(0, max).join('')
}

function lastOf(list, n = 1) {
  return list.length <= n ? list.slice() : list.slice(list.length - n)
}

export function createAutonomy({ dir, config, self, facts = null, agency, log, now = Date.now, speak = null, onDecision = null }) {
  const root = join(dir, 'agency')
  const file = join(root, 'decisions.jsonl')
  let timer = null
  let stopped = false
  let today = ''
  let spokenToday = 0
  let ignoredToday = 0
  let degraded = false
  let nightSpoken = false
  const lastSpokenAt = new Map()
  const captures = []
  let pending = null
  let lastDecision = null

  function resetDay(ts) {
    const key = dayKey(ts)
    if (key === today) return
    today = key
    spokenToday = 0
    ignoredToday = 0
    degraded = false
    nightSpoken = false
  }

  function initSync() {
    if (!existsSync(root)) mkdirSync(root, { recursive: true })
    if (!existsSync(file)) appendFileSync(file, '')
    resetDay(now())
  }

  function append(entry) {
    const row = { ts: new Date(entry.ts ?? now()).toISOString(), ...entry }
    try {
      appendFileSync(file, `${JSON.stringify(row)}\n`)
    } catch (error) {
      log?.warn?.(`autonomy_audit_failed ${error?.message ?? error}`)
    }
    lastDecision = row
    return row
  }

  function noteCapture(input = {}) {
    const ts = Number(input.ts) || now()
    captures.push({ ts, text: clampText(input.text, 80) })
    while (captures.length > 40) captures.shift()
    if (pending && ts > pending.ts) pending = null
  }

  function recentCapture(ts, windowMs) {
    return captures.some((c) => ts - c.ts <= windowMs)
  }

  function cooldownLeft(trigger, ts) {
    const last = lastSpokenAt.get(trigger)
    if (!last) return 0
    const ms = Number(config.autonomyCooldownH ?? TRIGGER_COOLDOWN_H) * 3600 * 1000
    return Math.max(0, last + ms - ts)
  }

  function stateOf(petId) {
    try {
      return self?.state?.(petId) ?? null
    } catch {
      return null
    }
  }

  function recentEvents(petId) {
    try {
      return self?.recent?.(petId, 20) ?? []
    } catch {
      return []
    }
  }

  /** 返回候选列表（按优先级）。 */
  function candidates(petId, ts) {
    const state = stateOf(petId)
    const events = recentEvents(petId)
    const list = []
    const valence = Number(state?.valence ?? 0)
    if (valence <= -0.35 || valence >= 0.5) {
      const happy = valence > 0
      list.push({
        trigger: 'strong_emotion',
        text: happy ? '感觉你今天心情不错。' : '看起来有点累，要不要先歇一会儿？',
        evidence: lastOf(events, 3).map((e) => e.id).filter(Boolean),
        reason: `valence=${valence.toFixed(2)}`,
      })
    }
    const hour = new Date(ts).getHours()
    // 记忆驱动：主人事实里明确提到累/忙/熬夜时，才轻轻问一句；不引用原话。
    try {
      const rows = Array.isArray(facts?.active) ? facts.active : []
      const care = rows.find((row) => {
        if (!row || row.validTo) return false
        const value = String(row.value ?? '')
        if (!/累|忙|加班|熬夜|压力|辛苦/.test(value)) return false
        const seen = Date.parse(row.lastMentionAt || row.createdAt || '')
        return !Number.isFinite(seen) || ts - seen <= 7 * 24 * 3600 * 1000
      })
      if (care) {
        list.push({
          trigger: 'memory_care',
          text: /熬夜|睡/.test(String(care.value)) ? '记得早点休息。' : '最近辛苦啦，记得歇一会儿。',
          evidence: [care.id].filter(Boolean),
          reason: '主人事实里提到累/忙',
        })
      }
    } catch {
      /* 记忆不可用不影响其它触发 */
    }
    if (hour >= 0 && hour < 3 && !nightSpoken && recentCapture(ts, 30 * 60 * 1000)) {
      list.push({
        trigger: 'late_night',
        text: '还不睡呀？',
        evidence: [],
        reason: '深夜仍在互动',
      })
    }
    if (captures.length >= 2) {
      const first = captures[0]
      const last = captures[captures.length - 1]
      const tired = recentEvents(petId).some((e) => /累|困|疲惫|加班|好忙/.test(String(e.text ?? '')))
      if (ts - first.ts >= 2 * 3600 * 1000 && ts - last.ts <= 30 * 60 * 1000 && tired) {
        list.push({
          trigger: 'long_work',
          text: '要不要歇会儿？',
          evidence: lastOf(recentEvents(petId), 3).map((e) => e.id).filter(Boolean),
          reason: '连续活跃 ≥2h 且有累信号',
        })
      }
    }
    return list
  }

  async function say(petId, text) {
    if (typeof speak !== 'function') throw new Error('speak unavailable')
    return speak(petId, text)
  }

  /** 一次判定；返回本次记录。可注入 now。 */
  async function tick(at = now(), petId = 'main') {
    resetDay(at)
    const level = String(config.autonomyLevel ?? 'observe')
    if (stopped || level === 'off') {
      return append({ decision: 'skip', reason: 'level=off', trigger: null, level })
    }
    // 被忽略：气泡 30min 内没有新 capture
    if (pending && at - pending.ts > IGNORE_WINDOW_MS) {
      ignoredToday += 1
      log?.info?.(`autonomy_ignored trigger=${pending.trigger} ignored=${ignoredToday}`)
      pending = null
      const limit = Number(config.autonomyIgnoreDecay ?? 2)
      if (ignoredToday >= limit && !degraded) {
        degraded = true
        append({ decision: 'degraded', reason: `ignored=${ignoredToday}`, trigger: null, level })
      }
    }
    if (degraded) {
      return append({ decision: 'skip', reason: 'degraded_today', trigger: null, level })
    }
    if (spokenToday >= Number(config.autonomyDailyMax ?? 3)) {
      return append({ decision: 'skip', reason: 'daily_max', trigger: null, level })
    }
    const quiet = inQuietHours(at, config.autonomyQuietStart, config.autonomyQuietEnd)
    const justTalked = recentCapture(at, 10 * 60 * 1000)
    if (quiet && !justTalked) {
      return append({ decision: 'skip', reason: 'quiet_hours', trigger: null, level })
    }
    const list = candidates(petId, at)
    if (!list.length) {
      return append({ decision: 'skip', reason: 'no_trigger', trigger: null, level })
    }
    const pick = list[0]
    if (cooldownLeft(pick.trigger, at) > 0) {
      return append({ decision: 'skip', reason: 'cooldown', trigger: pick.trigger, level })
    }
    if (level === 'observe') {
      lastSpokenAt.set(pick.trigger, at)
      if (pick.trigger === 'late_night') nightSpoken = true
      const row = append({
        decision: 'observe',
        trigger: pick.trigger,
        reason: 'observe_only',
        text: pick.text,
        evidence: pick.evidence,
        mood: stateOf(petId)?.moodText || '',
        level,
      })
      try {
        onDecision?.(row)
      } catch (error) {
        log?.warn?.(`autonomy_on_decision_failed ${error?.message ?? error}`)
      }
      return row
    }
    // assist / auto（L3-A 只到 assist；auto 用于 L3-B 预留）
    lastSpokenAt.set(pick.trigger, at)
    spokenToday += 1
    if (pick.trigger === 'late_night') nightSpoken = true
    const row = append({
      decision: 'speak',
      trigger: pick.trigger,
      reason: pick.reason,
      text: pick.text,
      evidence: pick.evidence,
      mood: stateOf(petId)?.moodText || '',
      level,
    })
    try {
      onDecision?.(row)
    } catch (error) {
      log?.warn?.(`autonomy_on_decision_failed ${error?.message ?? error}`)
    }
    pending = { ts: at, trigger: pick.trigger }
    try {
      await say('main', pick.text)
      log?.info?.(`autonomy_spoken trigger=${pick.trigger} text=${pick.text}`)
    } catch (error) {
      log?.warn?.(`autonomy_speak_failed ${error?.message ?? error}`)
    }
    return { ok: true, trigger: pick.trigger }
  }

  function start(ms = TICK_MS) {
    stop()
    stopped = false
    timer = setInterval(() => {
      tick().catch((error) => log?.warn?.(`autonomy_tick_failed ${error?.message ?? error}`))
    }, ms)
    timer.unref?.()
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
  }

  function decisions(limit = 30) {
    try {
      const text = readFileSync(file, 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(200, Number(limit) || 30)))
      return lines.map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      }).filter(Boolean).reverse()
    } catch {
      return []
    }
  }

  function status() {
    const level = String(config.autonomyLevel ?? 'observe')
    return {
      level,
      levels: AUTONOMY_LEVELS,
      dailyMax: Number(config.autonomyDailyMax ?? 3),
      spokenToday,
      ignoredToday,
      degraded,
      quiet: { start: config.autonomyQuietStart, end: config.autonomyQuietEnd },
      cooldownH: Number(config.autonomyCooldownH ?? TRIGGER_COOLDOWN_H),
      quietNow: inQuietHours(now(), config.autonomyQuietStart, config.autonomyQuietEnd),
      decisions: decisions(30),
      last: lastDecision,
    }
  }

  function dispose() {
    stopped = true
    stop()
  }

  return { initSync, noteCapture, tick, start, stop, status, decisions, dispose, get pending() { return pending } }
}
