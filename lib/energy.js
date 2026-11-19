/**
 * 宠物精力：0–100 的单一养成值。
 *
 * 规则（见 docs/energy-plan.md）：
 * - 醒着按时间消耗，睡着按时间恢复；60s tick，支持关机/休眠补算；
 * - 精力 ≤20 自动睡，≥100 自动醒；
 * - 0 精力「睡死」，被唤醒会立刻回睡；>0 的强行唤醒扣 5 点；
 * - 状态始终以 dsh-pet 的 pets.<id>.sleep.sleeping 为准，这里只观察和补动作。
 *
 * 纯逻辑 + 一个 watcher；文件 IO 只碰 `<dir>/energy.json`，失败不抛给宿主。
 *
 * @module dsh-pet-persona/lib/energy
 */

import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const ENERGY_DEFAULTS = {
  start: 100,
  max: 100,
  awakeDrainPerHour: 6,
  asleepRecoverPerHour: 36,
  sleepAt: 20,
  wakeAt: 100,
  tickMs: 60_000,
  maxCatchUpH: 24,
  wakePenalty: 5,
  thresholdRepeatMs: 30 * 60_000,
  thresholds: [70, 40, 20, 5],
}

const REST_LINES = {
  70: ['有点困了…我眯一会儿好不好。', '好像有点累了，让我缓一缓。'],
  40: ['真的累了，想趴一会儿。', '撑不太住了，先歇一下。'],
  20: ['不行了，我要睡了…', '眼睛快睁不开了，我先睡。'],
  5: ['眼皮好重…', '快没电了…'],
}

const NO_WAKE_LINE = '唔…叫不醒的…'
const WAKE_LINE = '睡饱了，我回来啦。'

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

function parseEntry(raw, cfg) {
  if (!raw || typeof raw !== 'object') return null
  const level = Number(raw.level)
  if (!Number.isFinite(level)) return null
  return {
    level: clamp(level, 0, cfg.max),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    sleeping: raw.sleeping === true,
    lastThreshold: Number.isFinite(Number(raw.lastThreshold)) ? Number(raw.lastThreshold) : null,
    lastSpokeAt: Number(raw.lastSpokeAt) || 0,
    lastWakeAt: Number(raw.lastWakeAt) || 0,
    sleepStartedLevel: Number.isFinite(Number(raw.sleepStartedLevel)) ? Number(raw.sleepStartedLevel) : null,
  }
}

/**
 * @param {object} input
 * @param {string} input.dir 数据目录（<DSH_HOME>/pet-persona）
 * @param {string} [input.petId]
 * @param {Partial<typeof ENERGY_DEFAULTS>} [input.config]
 * @param {object} [input.log]
 * @param {() => number} [input.now]
 */
export function createEnergyStore({ dir, petId = 'main', config = {}, log, now = Date.now }) {
  const cfg = { ...ENERGY_DEFAULTS, ...config }
  const file = join(dir, 'energy.json')

  function fresh() {
    return {
      level: clamp(cfg.start, 0, cfg.max),
      updatedAt: new Date(now()).toISOString(),
      sleeping: false,
      lastThreshold: null,
      lastSpokeAt: 0,
      lastWakeAt: 0,
      sleepStartedLevel: null,
    }
  }

  function read() {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      const entry = parseEntry(raw?.[petId], cfg)
      if (entry) return entry
    } catch (error) {
      if (error?.code !== 'ENOENT') log?.warn?.(`energy_read_failed ${error?.message ?? error}`)
    }
    return fresh()
  }

  let entry = read()

  function levelAt(at = now()) {
    const from = Date.parse(entry.updatedAt)
    if (!Number.isFinite(from)) return clamp(entry.level, 0, cfg.max)
    const dtH = clamp((at - from) / 3_600_000, 0, cfg.maxCatchUpH)
    const rate = entry.sleeping ? cfg.asleepRecoverPerHour : -cfg.awakeDrainPerHour
    return clamp(entry.level + rate * dtH, 0, cfg.max)
  }

  /** 把 entry 的时间推进到 at（按当前 sleeping 折算），不落盘。 */
  function advance(at = now()) {
    entry.level = levelAt(at)
    entry.updatedAt = new Date(at).toISOString()
  }

  function save() {
    try {
      const payload = {}
      try {
        const prev = JSON.parse(readFileSync(file, 'utf8'))
        if (prev && typeof prev === 'object') Object.assign(payload, prev)
      } catch {
        /* 文件不存在或坏了：只写当前宠物 */
      }
      payload[petId] = { ...entry, level: Math.round(entry.level * 10) / 10 }
      const tmp = `${file}.tmp`
      writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
      renameSync(tmp, file)
    } catch (error) {
      log?.warn?.(`energy_write_failed ${error?.message ?? error}`)
    }
  }

  return {
    file,
    config: cfg,
    get sleeping() {
      return entry.sleeping
    },
    get lastThreshold() {
      return entry.lastThreshold
    },
    get lastSpokeAt() {
      return entry.lastSpokeAt
    },
    get lastWakeAt() {
      return entry.lastWakeAt
    },
    get sleepStartedLevel() {
      return entry.sleepStartedLevel
    },
    level: (at = now()) => levelAt(at),
    advance,
    /** 用 dsh-pet 的真实状态校准；返回是否发生变化。 */
    setSleeping(sleeping, at = now()) {
      const next = sleeping === true
      if (next === entry.sleeping) {
        advance(at)
        return false
      }
      advance(at)
      if (next) entry.sleepStartedLevel = entry.level
      else entry.sleepStartedLevel = null
      entry.sleeping = next
      return true
    },
    spend(points, at = now()) {
      advance(at)
      entry.level = clamp(entry.level - Math.max(0, Number(points) || 0), 0, cfg.max)
    },
    markSpoke(threshold, at = now()) {
      entry.lastThreshold = threshold
      entry.lastSpokeAt = at
    },
    markWake(at = now()) {
      entry.lastWakeAt = at
    },
    resetThreshold() {
      entry.lastThreshold = null
    },
    noteManualWake(at = now()) {
      entry.lastWakeAt = at
    },
    save,
    status(at = now()) {
      return {
        level: Math.round(levelAt(at) * 10) / 10,
        sleeping: entry.sleeping,
        updatedAt: entry.updatedAt,
        drainPerHour: cfg.awakeDrainPerHour,
        recoverPerHour: cfg.asleepRecoverPerHour,
        sleepAt: cfg.sleepAt,
        wakeAt: cfg.wakeAt,
      }
    },
  }
}

async function postJson(fetchImpl, url, body) {
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(3000),
  })
  const json = await res.json().catch(() => ({}))
  return { ok: res.ok && json?.ok !== false, code: json?.code || (res.ok ? '' : `http_${res.status}`), raw: json }
}

/**
 * @param {object} input
 * @param {ReturnType<typeof createEnergyStore>} input.store
 * @param {string} [input.petId]
 * @param {() => string} input.getOrigin
 * @param {(petId: string, text: string) => Promise<any>} [input.speak] 走宿主的 broadcast，顺便标记「不是碎碎念」
 * @param {object} [input.log]
 * @param {() => number} [input.now]
 * @param {typeof fetch} [input.fetchImpl]
 * @param {number} [input.tickMs]
 */
export function createEnergyWatch({
  store,
  petId = 'main',
  getOrigin,
  speak,
  log,
  now = Date.now,
  fetchImpl = globalThis.fetch,
  tickMs = ENERGY_DEFAULTS.tickMs,
} = {}) {
  const cfg = store.config
  let timer = null
  let disposed = false
  let busy = false
  let lockedLogged = false
  let animLogged = false
  let lastError = ''
  let lastTickAt = 0

  function pickLine(threshold) {
    const pool = REST_LINES[threshold] || REST_LINES[5]
    return pool[Math.floor(Math.random() * pool.length)]
  }

  async function say(text) {
    if (typeof speak !== 'function') return
    try {
      await speak(petId, text)
    } catch (error) {
      log?.warn?.(`energy_say_failed ${error?.message ?? error}`)
    }
  }

  async function callSleep() {
    const origin = getOrigin?.()
    if (!origin) return false
    try {
      const result = await postJson(fetchImpl, `${origin}/dsh-pet-7340/sleep?pet=${encodeURIComponent(petId)}`)
      if (!result.ok) {
        if (result.code === 'locked' && !lockedLogged) {
          lockedLogged = true
          log?.warn?.('energy_sleep_locked')
          await say('被占用着，睡不着…')
        } else if (result.code === 'no-sleep-animations' && !animLogged) {
          animLogged = true
          log?.warn?.('energy_sleep_no_animations')
        } else {
          log?.warn?.(`energy_sleep_failed code=${result.code}`)
        }
        return false
      }
      return true
    } catch (error) {
      log?.warn?.(`energy_sleep_error ${error?.message ?? error}`)
      return false
    }
  }

  async function callWake() {
    const origin = getOrigin?.()
    if (!origin) return false
    try {
      const result = await postJson(fetchImpl, `${origin}/dsh-pet-7340/wake?pet=${encodeURIComponent(petId)}`)
      if (!result.ok) {
        log?.warn?.(`energy_wake_failed code=${result.code}`)
        return false
      }
      return true
    } catch (error) {
      log?.warn?.(`energy_wake_error ${error?.message ?? error}`)
      return false
    }
  }

  async function readSleeping() {
    const origin = getOrigin?.()
    if (!origin) return null
    try {
      const res = await fetchImpl(`${origin}/dsh-pet-7340/state`, { signal: AbortSignal.timeout(3000) })
      if (!res.ok) throw new Error(`http_${res.status}`)
      const body = await res.json()
      const leaf = body?.pets?.[petId]?.sleep
      return leaf?.data?.sleeping === true
    } catch (error) {
      const message = String(error?.message ?? error)
      if (message !== lastError) log?.warn?.(`energy_state_failed ${message}`)
      lastError = message
      return null
    }
  }

  async function tick() {
    if (busy || disposed) return
    busy = true
    lastTickAt = now()
    try {
      const actual = await readSleeping()
      if (actual === null) {
        store.save()
        return
      }
      let sleptThisTick = false
      const previous = store.sleeping
      if (actual !== previous) {
        store.setSleeping(actual, now())
        if (previous === true && actual === false) {
          const level = store.level(now())
          if (level <= 0) {
            const cooled = now() - (store.lastWakeAt || 0)
            if (cooled > 60_000) {
              log?.warn?.('energy_zero_wake_rejected')
              const slept = await callSleep()
              if (slept) {
                store.setSleeping(true, now())
                store.markWake(now())
                sleptThisTick = true
                await say(NO_WAKE_LINE)
              }
            }
          } else {
            store.spend(cfg.wakePenalty, now())
            log?.info?.(`energy_manual_wake_penalty=${cfg.wakePenalty} level=${store.level(now()).toFixed(1)}`)
          }
        }
      }

      const level = store.level(now())
      if (actual) {
        const sleptBelow = store.sleepStartedLevel === null || store.sleepStartedLevel < cfg.wakeAt
        if (level >= cfg.wakeAt && cfg.wakeAt <= cfg.max && sleptBelow) {
          const woke = await callWake()
          if (woke) {
            store.setSleeping(false, now())
            store.resetThreshold()
            await say(WAKE_LINE)
            log?.info?.(`energy_auto_wake level=${level.toFixed(1)}`)
          }
        }
      } else {
        if (level > 75) store.resetThreshold()
        for (const threshold of cfg.thresholds) {
          if (level > threshold) continue
          const last = store.lastThreshold
          if (last !== null && last !== undefined && last <= threshold) continue
          store.markSpoke(threshold, now())
          await say(pickLine(threshold))
          break
        }
        if (!sleptThisTick && level <= cfg.sleepAt) {
          const slept = await callSleep()
          if (slept) {
            store.setSleeping(true, now())
            log?.info?.(`energy_auto_sleep level=${level.toFixed(1)}`)
          }
        }
      }
      store.save()
    } finally {
      busy = false
    }
  }

  function start() {
    if (timer || disposed) return
    tick().catch((error) => log?.warn?.(`energy_tick_failed ${error?.message ?? error}`))
    timer = setInterval(() => {
      tick().catch((error) => log?.warn?.(`energy_tick_failed ${error?.message ?? error}`))
    }, tickMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
    save()
  }

  function save() {
    store.save()
  }

  function status() {
    return { ...store.status(now()), lastTickAt }
  }

  return { start, stop, tick, status }
}
