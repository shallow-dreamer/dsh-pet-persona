/**
 * 免费版「情绪语音」provider：仍走 dsh-pet 内置的 Edge 在线 TTS，
 * 只是在 SSML 的 pitch / rate / volume 上按文本情绪做确定性偏移。
 *
 * 不改 dsh-pet 源码；通过 petApi7340.voice.register 注册。
 */

const PROVIDER_ID = 'pet-persona-emotion'
const PROVIDER_NAME = '桌宠情绪语音（免费版）'
const MAX_TEXT = 500
const MAX_RETRY = 1

export const VOICES = Object.freeze([
  { id: 'zh-CN-XiaoyiNeural', name: '小艺', tag: '女 · 活泼' },
  { id: 'zh-CN-XiaoxiaoNeural', name: '晓晓', tag: '女 · 温柔' },
  { id: 'zh-CN-YunxiNeural', name: '云希', tag: '男 · 阳光' },
  { id: 'zh-CN-YunjianNeural', name: '云健', tag: '男 · 沉稳' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', name: '小北', tag: '女 · 东北' },
])

export const EMOTIONS = Object.freeze(['happy', 'surprised', 'low', 'angry', 'calm'])

const RULES = [
  {
    emotion: 'happy',
    re: /[!！]|哈哈|嘿嘿|好耶|太棒|开心|喜欢|嘻嘻|好呀|棒极了|真棒/g,
    pitch: [8, 18],
    rate: [6, 15],
    volume: [0, 3],
    base: 0.55,
  },
  {
    emotion: 'surprised',
    re: /[?？]|诶|欸|咦|真的吗|不会吧|天哪|哇/g,
    pitch: [10, 20],
    rate: [4, 10],
    volume: [0, 2],
    base: 0.5,
  },
  {
    emotion: 'low',
    re: /…|～|~|呜|唉|累|难过|委屈|想哭|不开心|没力气/g,
    pitch: [-14, -6],
    rate: [-16, -8],
    volume: [-8, 0],
    base: 0.6,
  },
  {
    emotion: 'angry',
    re: /哼|讨厌|生气|不理你|过分|烦死/g,
    pitch: [4, 10],
    rate: [4, 8],
    volume: [3, 6],
    base: 0.65,
  },
]

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function scalePair(pair, strength) {
  return pair[0] + (pair[1] - pair[0]) * strength
}

/**
 * 判定文本情绪并给出 prosody 偏移。
 * 纯函数、无 IO，便于单测。
 *
 * @param {string} text
 * @param {{intensity?: number}} [options]
 * @returns {{emotion: string, strength: number, pitch: number, rate: number, volume: number}}
 */
export function scoreEmotion(text, { intensity = 1 } = {}) {
  const source = String(text ?? '')
  const strengthScale = clamp(Number(intensity) || 1, 0.5, 1.5)
  let best = null
  let hits = 0

  for (const rule of RULES) {
    const matches = source.match(rule.re)
    const count = matches ? matches.length : 0
    if (count > hits) {
      hits = count
      best = rule
    }
  }

  if (!best || hits === 0) {
    return { emotion: 'calm', strength: 0, pitch: 0, rate: 0, volume: 0 }
  }

  const strength = clamp((best.base + Math.min(0.35, (hits - 1) * 0.15)) * strengthScale, 0, 1)
  const trailingSoft = /(…|～|~)\s*$/.test(source) ? 4 : 0

  return {
    emotion: best.emotion,
    strength: Number(strength.toFixed(3)),
    pitch: Math.round(scalePair(best.pitch, strength)),
    rate: Math.round(scalePair(best.rate, strength) - trailingSoft),
    volume: Math.round(scalePair(best.volume, strength)),
  }
}

function normalizeBytes(result) {
  if (result instanceof Uint8Array) return result
  if (result instanceof ArrayBuffer) return new Uint8Array(result)
  if (ArrayBuffer.isView(result)) return new Uint8Array(result.buffer, result.byteOffset, result.byteLength)
  if (Array.isArray(result)) return Uint8Array.from(result)
  return null
}

/**
 * 创建情绪 TTS provider。
 *
 * @param {object} options
 * @param {any} options.log logger
 * @param {() => Promise<any>} [options.loadEdgeTts] 可注入，便于单测
 * @param {number} [options.intensity] 0.5–1.5
 * @param {number} [options.timeoutMs]
 */
export function createEmotionTts({ log, loadEdgeTts, intensity = 1, timeoutMs = 12000 } = {}) {
  const logger = log ?? { info() {}, warn() {}, debug() {} }
  const strength = clamp(Number(intensity) || 1, 0.5, 1.5)
  let clientPromise = null

  async function getClient() {
    if (!clientPromise) {
      const loader = loadEdgeTts
        ?? (async () => {
          const mod = await import('@andresaya/edge-tts')
          return mod.EdgeTTS ? new mod.EdgeTTS() : new mod.default()
        })
      clientPromise = Promise.resolve().then(loader).catch((error) => {
        clientPromise = null
        throw error
      })
    }
    return clientPromise
  }

  return {
    id: PROVIDER_ID,
    name: PROVIDER_NAME,
    voices: VOICES,
    format: 'mp3',
    timeoutMs,

    async synthesize(input) {
      const text = String(input?.text ?? '').trim()
      if (!text) throw new Error('empty text')
      if (text.length > MAX_TEXT) throw new Error('text too long')

      const voice = String(input?.voice ?? VOICES[0].id)
      const mood = scoreEmotion(text, { intensity: strength })
      const rate = clamp(Math.round(Number(input?.rate) || 0) + mood.rate, -50, 100)

      let lastError = null
      for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
        try {
          const tts = await getClient()
          const raw = await tts.generate(text, voice, {
            pitch: mood.pitch,
            rate,
            volume: mood.volume,
            signal: input?.signal,
            timeout: timeoutMs,
          })
          // generate() 返回 { audio, format, ... }；旧版/测试注入可能直接给字节。
          const bytes = normalizeBytes(raw?.audio ?? raw)
          if (!bytes || bytes.length === 0) throw new Error('empty audio')
          if (mood.emotion !== 'calm') {
            logger.debug?.(`tts_emotion emotion=${mood.emotion} strength=${mood.strength} pitch=${mood.pitch} rate=${rate} volume=${mood.volume}`)
          }
          return bytes
        } catch (error) {
          lastError = error
          if (input?.signal?.aborted) break
          if (attempt < MAX_RETRY) await new Promise((resolve) => setTimeout(resolve, 300))
        }
      }
      throw lastError ?? new Error('tts failed')
    },
  }
}
