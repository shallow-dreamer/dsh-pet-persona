/**
 * 碎碎念观察器：轮询 dsh-pet 的 /state，把「不是聊天回复、不是我们主动说的」气泡记成自己的经历。
 *
 * dsh-pet 的碎碎念、梦话、待办提醒都写同一个 `pets.<id>.say` 叶子；聊天回复也写它。
 * 这里用两条排除规则区分：最近 60 秒内 capture 收到的 replyText、以及本插件 speak 出去的文本。
 * 其余新气泡一律视为「它自己嘟囔的一句」，延迟 2 秒再落盘，给 capture 一点时间先到。
 *
 * 只读 GET /state，不写 dsh-pet 的任何状态，也不改它的源码。
 *
 * @module dsh-pet-persona/lib/whisper
 */

const DEFAULT_INTERVAL_MS = 5000
const DEFAULT_SETTLE_MS = 2000
const RECENT_MS = 60_000
const MAX_RECENT = 20

/** 记录一条「自己说了一句」到自我记忆。失败只记日志，不影响轮询。 */
function remember(self, log, text, now) {
  if (!self || typeof self.note !== 'function') return null
  try {
    const row = self.note({
      text: `自己嘟囔了一句：${text}`,
      kind: 'thought',
      source: 'whisper',
      importance: 2,
      valence: 0,
      energy: 0.5,
    })
    if (row) log?.info?.(`whisper_recorded chars=${Array.from(text).length}`)
    return row
  } catch (error) {
    log?.warn?.(`whisper_record_failed ${error?.message ?? error}`)
    return null
  }
}

/**
 * @param {object} input
 * @param {string} [input.petId]
 * @param {object} input.self SelfStore
 * @param {object} [input.log]
 * @param {() => number} [input.now]
 * @param {() => string|undefined} input.getOrigin 返回当前 DSH web 的 origin
 * @param {typeof fetch} [input.fetchImpl]
 * @param {number} [input.intervalMs]
 * @param {number} [input.settleMs]
 */
export function createWhisperWatch({
  petId = 'main',
  self,
  log,
  now = Date.now,
  getOrigin,
  fetchImpl = globalThis.fetch,
  intervalMs = DEFAULT_INTERVAL_MS,
  settleMs = DEFAULT_SETTLE_MS,
} = {}) {
  let timer = null
  let busy = false
  let disposed = false
  let baseline = -1
  let recorded = 0
  let lastText = ''
  let lastError = ''
  /** @type {Array<{text: string, at: number}>} */
  const recentChat = []
  const recentSpoken = []
  const pending = new Set()

  function pushRecent(list, text) {
    if (!text) return
    list.push({ text: String(text), at: now() })
    while (list.length > MAX_RECENT) list.shift()
  }

  function isRecent(list, text) {
    const at = now()
    return list.some((item) => item.text === text && at - item.at < RECENT_MS)
  }

  function noteChatReply(text) {
    pushRecent(recentChat, text)
  }

  function noteSpoken(text) {
    pushRecent(recentSpoken, text)
  }

  function schedule(text, counter) {
    if (pending.has(counter)) return
    pending.add(counter)
    const handle = setTimeout(() => {
      pending.delete(counter)
      if (disposed) return
      if (isRecent(recentChat, text) || isRecent(recentSpoken, text)) {
        log?.debug?.('whisper_skip reason=chat_or_spoken')
        return
      }
      const row = remember(self, log, text, now)
      if (row) {
        recorded += 1
        lastText = text
      }
    }, Math.max(0, settleMs))
    if (typeof handle.unref === 'function') handle.unref()
  }

  async function poll() {
    if (busy || disposed) return
    busy = true
    try {
      const origin = getOrigin?.()
      if (!origin) return
      const response = await fetchImpl(`${origin}/dsh-pet-7340/state`, {
        signal: AbortSignal.timeout(3000),
        headers: { accept: 'application/json' },
      })
      if (!response.ok) {
        lastError = `http_${response.status}`
        return
      }
      const body = await response.json()
      const leaf = body?.pets?.[petId]?.say
      const counter = Number(leaf?.counter) || 0
      if (counter <= baseline) return
      const first = baseline < 0
      baseline = counter
      if (first) return
      const text = String(leaf?.data?.text ?? '').trim()
      if (!text) return
      schedule(text, counter)
      lastError = ''
    } catch (error) {
      lastError = error?.message ?? String(error)
      log?.debug?.(`whisper_watch_error ${lastError}`)
    } finally {
      busy = false
    }
  }

  function tick() {
    if (disposed) return
    void poll()
  }

  function start() {
    if (timer || disposed) return
    void poll()
    timer = setInterval(tick, Math.max(1000, intervalMs))
    if (typeof timer.unref === 'function') timer.unref()
  }

  function stop() {
    disposed = true
    if (timer) clearInterval(timer)
    timer = null
  }

  function status() {
    return { petId, baseline, recorded, lastText, lastError, running: Boolean(timer) }
  }

  return { start, stop, poll, noteChatReply, noteSpoken, status }
}
