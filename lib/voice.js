/**
 * 语音：声纹门 + 唤醒词 + 把话交给桌宠。
 *
 * 设计原则（见 docs/voice-plan.md）：
 * - 不改 dsh-pet：识别走宿主 `speechToText`，执行走 `/chat` 命令。
 * - 默认拒绝：没登记声纹就拒绝，避免电视/旁人声音消耗 token。
 * - 原声不落盘：只保存 embedding；事件日志只留短文本与分数。
 * - 任何一步失败都返回结构化原因，不抛到 HTTP 层。
 *
 * 说明：当前 embedding 是**时间域+频带能量的实验特征**，只用于打通流程，
 * 不是可依赖的生物识别。P3 会替换成 ECAPA-TDNN ONNX（接口已按可替换设计）。
 *
 * @module dsh-pet-persona/lib/voice
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readPersona } from './persona.js'

export const VOICE_EVENT_LIMIT = 500
export const VOICE_EVENT_BYTES = 128 * 1024
const MAX_AUDIO_BYTES = 3 * 1024 * 1024
const MAX_SECONDS = 12
const MIN_SECONDS = 0.25
const EMBED_DIM = 16

/** 常用中英文停用标点，唤醒词匹配前去掉。 */
const PUNCT = /[\s，。！？、,.!?;；:："'“”‘’（）()《》<>~～\-—_]/g

/** 归一化文本，便于唤醒词匹配。 */
export function normalizeSpeechText(text) {
  return String(text ?? '')
    .replace(PUNCT, '')
    .toLowerCase()
}

/**
 * 解析 PCM16 WAV；只接受单/双声道、8/16bit，统一转成单声道 Float32。
 * @param {Uint8Array|Buffer} input
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, samples:Float32Array, seconds:number}}
 */
export function parseWav(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input)
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a wav file')
  }
  let offset = 12
  let fmt = null
  let data = null
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4)
    const size = buf.readUInt32LE(offset + 4)
    const body = offset + 8
    if (body + size > buf.length) break
    if (id === 'fmt ') {
      fmt = {
        format: buf.readUInt16LE(body),
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bitsPerSample: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, body + size)
    }
    offset = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('wav missing fmt/data')
  if (fmt.format !== 1) throw new Error('wav must be pcm')
  if (fmt.channels !== 1 && fmt.channels !== 2) throw new Error('wav channels unsupported')
  if (fmt.bitsPerSample !== 16 && fmt.bitsPerSample !== 8) throw new Error('wav bits unsupported')
  const bytesPerSample = fmt.bitsPerSample / 8
  const frames = Math.floor(data.length / (bytesPerSample * fmt.channels))
  const samples = new Float32Array(frames)
  for (let i = 0; i < frames; i += 1) {
    let sum = 0
    for (let c = 0; c < fmt.channels; c += 1) {
      const at = i * fmt.channels * bytesPerSample + c * bytesPerSample
      const value = fmt.bitsPerSample === 16 ? data.readInt16LE(at) / 32768 : (data[at] - 128) / 128
      sum += value
    }
    samples[i] = sum / fmt.channels
  }
  return {
    sampleRate: fmt.sampleRate,
    channels: fmt.channels,
    bitsPerSample: fmt.bitsPerSample,
    samples,
    seconds: frames / fmt.sampleRate,
  }
}

/**
 * 线性重采样到 16k（够用；P3 换 ASR 前可换 soxr）。
 * @param {Float32Array} samples
 * @param {number} from
 * @param {number} to
 */
export function resampleLinear(samples, from, to = 16000) {
  if (!Number.isFinite(from) || from <= 0 || from === to) return samples
  const ratio = from / to
  const length = Math.max(1, Math.floor(samples.length / ratio))
  const out = new Float32Array(length)
  for (let i = 0; i < length; i += 1) {
    const at = i * ratio
    const i0 = Math.floor(at)
    const i1 = Math.min(samples.length - 1, i0 + 1)
    const t = at - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return out
}

/** 解码 base64 / data URL。 */
export function decodeAudio(input) {
  if (typeof input !== 'string' || input.trim() === '') throw new Error('audio required')
  const raw = input.includes(',') ? input.slice(input.indexOf(',') + 1) : input
  const buf = Buffer.from(raw, 'base64')
  if (buf.length === 0) throw new Error('audio empty')
  if (buf.length > MAX_AUDIO_BYTES) throw new Error('audio too large')
  return buf
}

/** 分帧。 */
function framesOf(samples, frameSize, hop) {
  const out = []
  for (let at = 0; at + frameSize <= samples.length; at += hop) {
    out.push(samples.subarray(at, at + frameSize))
  }
  return out
}

function mean(values) {
  return values.length === 0 ? 0 : values.reduce((a, b) => a + b, 0) / values.length
}

function std(values, avg) {
  if (values.length === 0) return 0
  return Math.sqrt(mean(values.map((v) => (v - avg) ** 2)))
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)))]
}

/** 8 个固定频点的 Goertzel 能量（100–3000Hz）。 */
const BANDS = [100, 200, 350, 550, 800, 1200, 1800, 2600]

function bandEnergy(frame, sampleRate, freq) {
  const w = (2 * Math.PI * freq) / sampleRate
  const coeff = 2 * Math.cos(w)
  let s0 = 0
  let s1 = 0
  let s2 = 0
  for (let i = 0; i < frame.length; i += 1) {
    s0 = frame[i] + coeff * s1 - s2
    s2 = s1
    s1 = s0
  }
  return s1 * s1 + s2 * s2 - coeff * s1 * s2
}

/**
 * 实验声纹特征（16 维，L2 归一）。同段音频自比 = 1。
 * @param {Float32Array} input
 * @param {number} sampleRate
 * @returns {Float32Array}
 */
export function extractEmbedding(input, sampleRate = 16000) {
  const samples = resampleLinear(input, sampleRate, 16000)
  const frameSize = 400 // 25ms
  const hop = 160 // 10ms
  const frames = framesOf(samples, frameSize, hop)
  const rms = []
  const zcr = []
  const bands = BANDS.map(() => [])
  const autocorr = []
  for (const frame of frames) {
    let energy = 0
    let crossings = 0
    for (let i = 0; i < frame.length; i += 1) {
      energy += frame[i] * frame[i]
      if (i > 0 && (frame[i] >= 0) !== (frame[i - 1] >= 0)) crossings += 1
    }
    const e = Math.sqrt(energy / frame.length)
    rms.push(e)
    zcr.push(crossings / frame.length)
    BANDS.forEach((freq, index) => bands[index].push(Math.log(1e-9 + bandEnergy(frame, 16000, freq))))
    // 基频自相关峰（80–400Hz）
    let best = 0
    for (let lag = 40; lag <= 200; lag += 2) {
      let acc = 0
      for (let i = lag; i < frame.length; i += 1) acc += frame[i] * frame[i - lag]
      if (acc > best) best = acc
    }
    autocorr.push(best / (energy + 1e-9))
  }
  const rmsAvg = mean(rms)
  const sorted = [...rms].sort((a, b) => a - b)
  const zAvg = mean(zcr)
  const acAvg = mean(autocorr)
  const features = [
    rmsAvg,
    std(rms, rmsAvg),
    percentile(sorted, 0.1),
    percentile(sorted, 0.9),
    zAvg,
    std(zcr, zAvg),
    acAvg,
    std(autocorr, acAvg),
    ...bands.map((values) => mean(values) / 10),
    rmsAvg > 0.001 ? 1 : 0,
  ]
  // 固定 16 维
  while (features.length < EMBED_DIM) features.push(0)
  const vector = Float32Array.from(features.slice(0, EMBED_DIM))
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm) || 1
  for (let i = 0; i < vector.length; i += 1) vector[i] /= norm
  return vector
}

export function cosine(a, b) {
  let dot = 0
  let na = 0
  let nb = 0
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

/**
 * 声纹库：`voiceprint.json` 只存 embedding 与元数据，不存原声。
 */
export class VoiceprintStore {
  constructor({ dir, log, now = () => Date.now(), threshold = 0.8 }) {
    this.dir = dir
    this.file = join(dir, 'voiceprint.json')
    this.log = log
    this.now = now
    this.threshold = threshold
    this.model = 'experimental-time-domain-v1'
    this.centroid = null
    this.samples = 0
    this.updatedAt = ''
    this.loaded = false
  }

  initSync() {
    try {
      if (!existsSync(this.file)) {
        this.loaded = true
        return this
      }
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed?.version !== 1 || parsed.model !== this.model) {
        this.log?.warn?.('voiceprint_model_mismatch ignored')
        this.loaded = true
        return this
      }
      const centroid = Array.isArray(parsed.centroid) ? parsed.centroid.map(Number) : null
      if (!centroid || centroid.length !== EMBED_DIM || centroid.some((v) => !Number.isFinite(v))) {
        this.log?.warn?.('voiceprint_corrupt ignored')
        this.loaded = true
        return this
      }
      this.centroid = Float32Array.from(centroid)
      this.samples = Number(parsed.samples) || 0
      this.updatedAt = typeof parsed.updatedAt === 'string' ? parsed.updatedAt : ''
      this.threshold = clampThreshold(parsed.threshold ?? this.threshold)
    } catch (error) {
      this.log?.warn?.(`voiceprint_load_failed ${error?.message ?? error}`)
    }
    this.loaded = true
    return this
  }

  get enrolled() {
    return this.centroid !== null
  }

  /**
   * @param {Float32Array[]} embeddings
   * @param {{threshold?:number}} options
   */
  enroll(embeddings, options = {}) {
    if (!Array.isArray(embeddings) || embeddings.length < 3) throw new Error('至少需要 3 段声纹样本')
    const vectors = embeddings.map((v) => (v instanceof Float32Array ? v : Float32Array.from(v)))
    for (const v of vectors) {
      if (v.length !== EMBED_DIM || v.some((x) => !Number.isFinite(x))) throw new Error('声纹样本格式不对')
    }
    // 一致性检查：样本之间两两相似度太低说明不是同一个人/环境差异太大
    let pairs = 0
    let sum = 0
    for (let i = 0; i < vectors.length; i += 1) {
      for (let j = i + 1; j < vectors.length; j += 1) {
        sum += cosine(vectors[i], vectors[j])
        pairs += 1
      }
    }
    const consistency = pairs === 0 ? 0 : sum / pairs
    if (consistency < 0.55) {
      const error = new Error('这几段声音差异太大，请在同样环境重录')
      error.code = 'inconsistent_samples'
      error.consistency = consistency
      throw error
    }
    const centroid = new Float32Array(EMBED_DIM)
    for (const vector of vectors) {
      for (let i = 0; i < EMBED_DIM; i += 1) centroid[i] += vector[i] / vectors.length
    }
    let norm = 0
    for (const value of centroid) norm += value * value
    norm = Math.sqrt(norm) || 1
    for (let i = 0; i < centroid.length; i += 1) centroid[i] /= norm
    this.centroid = centroid
    this.samples = vectors.length
    this.threshold = clampThreshold(options.threshold ?? this.threshold)
    this.updatedAt = new Date(this.now()).toISOString()
    this.save()
    return this.stats(consistency)
  }

  save() {
    mkdirSync(this.dir, { recursive: true })
    const file = this.file
    const tmp = `${file}.tmp-${process.pid}`
    writeFileSync(
      tmp,
      `${JSON.stringify(
        {
          version: 1,
          model: this.model,
          samples: this.samples,
          threshold: this.threshold,
          updatedAt: this.updatedAt,
          centroid: Array.from(this.centroid ?? []),
        },
        null,
        2,
      )}\n`,
      'utf8',
    )
    renameSync(tmp, file)
  }

  verify(embedding) {
    if (!this.enrolled) return { enrolled: false, match: false, score: 0, threshold: this.threshold }
    const score = cosine(this.centroid, embedding)
    return { enrolled: true, match: score >= this.threshold, score, threshold: this.threshold }
  }

  setThreshold(next) {
    this.threshold = clampThreshold(next)
    if (this.enrolled) {
      this.updatedAt = new Date(this.now()).toISOString()
      this.save()
    }
    return this.threshold
  }

  reset() {
    this.centroid = null
    this.samples = 0
    this.updatedAt = ''
    try {
      if (existsSync(this.file)) unlinkSync(this.file)
    } catch (error) {
      this.log?.warn?.(`voiceprint_reset_failed ${error?.message ?? error}`)
    }
  }

  stats(consistency = undefined) {
    return {
      enrolled: this.enrolled,
      samples: this.samples,
      threshold: this.threshold,
      updatedAt: this.updatedAt,
      model: this.model,
      ...(consistency === undefined ? {} : { consistency }),
    }
  }
}

function clampThreshold(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0.8
  return Math.min(0.98, Math.max(0.5, Math.round(n * 100) / 100))
}

/** 读一条事件文本的安全截断。 */
function trimText(text, max = 120) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  return value.length > max ? `${value.slice(0, max)}…` : value
}

/**
 * @param {object} options
 * @param {any} options.ctx
 * @param {Record<string, any>} options.config 可变配置对象
 * @param {string} options.dir
 * @param {any} options.log
 * @param {() => number} [options.now]
 * @param {any} [options.services] 测试注入口：{speechToText, commands, agents, persona}
 * @param {VoiceprintStore} [options.store]
 */
export function createVoiceService({ ctx, config, dir, log, now = () => Date.now(), services = null, store = null }) {
  const voiceStore = store ?? new VoiceprintStore({ dir, log, now, threshold: config.voiceThreshold })
  if (!store) voiceStore.initSync()

  const eventFile = join(dir, 'voice-events.jsonl')
  const events = []
  const getService = (name) => {
    if (services && name in services) return services[name]
    try {
      return ctx?.get?.(name, false) ?? null
    } catch {
      return null
    }
  }

  // 唤醒词优先用设置里显式填的；否则跟随桌宠名字（用户改过就不再自动变）
  let personaCache = { at: 0, name: '' }
  const petName = () => {
    if (services?.persona?.petName) return services.persona.petName
    if (now() - personaCache.at < 5000) return personaCache.name
    try {
      const persona = readPersona({ dataDir: dir })
      personaCache = { at: now(), name: persona.petName || '' }
      return personaCache.name
    } catch {
      return ''
    }
  }
  const wakeWord = () => String(config.voiceWakeWord || petName() || '小鲸鱼').trim()

  const loadEvents = () => {
    try {
      if (!existsSync(eventFile)) return
      const text = readFileSync(eventFile, 'utf8')
      const lines = text.split(/\r?\n/).filter(Boolean).slice(-VOICE_EVENT_LIMIT)
      for (const line of lines) {
        try {
          events.push(JSON.parse(line))
        } catch {
          /* 坏行跳过 */
        }
      }
    } catch {
      /* 读不到就空 */
    }
  }
  loadEvents()

  const record = (event) => {
    const row = {
      ts: new Date(now()).toISOString(),
      accepted: event.accepted === true,
      reason: event.reason ?? '',
      mode: event.mode ?? '',
      score: typeof event.score === 'number' ? Math.round(event.score * 1000) / 1000 : undefined,
      chars: typeof event.chars === 'number' ? event.chars : 0,
      text: config.voiceKeepTranscript === false ? '' : trimText(event.text),
      ms: typeof event.ms === 'number' ? Math.round(event.ms) : 0,
    }
    events.push(row)
    if (events.length > VOICE_EVENT_LIMIT) events.splice(0, events.length - VOICE_EVENT_LIMIT)
    try {
      mkdirSync(dir, { recursive: true })
      appendFileSync(eventFile, `${JSON.stringify(row)}\n`, 'utf8')
      if (existsSync(eventFile) && statSync(eventFile).size > VOICE_EVENT_BYTES) {
        const tail = events.slice(-200).map((e) => JSON.stringify(e)).join('\n')
        writeFileSync(eventFile, `${tail}\n`, 'utf8')
      }
    } catch (error) {
      log?.warn?.(`voice_event_write_failed ${error?.message ?? error}`)
    }
    return row
  }

  const effectiveWake = () => wakeWord()
  const stripWake = (text) => {
    const word = normalizeSpeechText(effectiveWake())
    const normalized = normalizeSpeechText(text)
    if (word === '' || !normalized.includes(word)) return { hit: false, text: String(text ?? '').trim() }
    // 按原文删掉第一次出现的唤醒词（连同前后标点）
    const escaped = effectiveWake().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const stripped = String(text).replace(new RegExp(escaped, 'i'), ' ').replace(PUNCT, ' ').replace(/\s+/g, ' ').trim()
    return { hit: true, text: stripped }
  }

  const resolveAgent = () => {
    const agents = getService('agents')
    try {
      const roots = agents?.roots?.() ?? []
      if (roots.length > 0) return roots[roots.length - 1]
      const list = agents?.list?.() ?? []
      return list[list.length - 1] ?? null
    } catch {
      return null
    }
  }

  const transcribe = async (wavBuffer, language, signal) => {
    const speech = getService('speechToText')
    if (!speech || typeof speech.resolve !== 'function' || typeof speech.transcribe !== 'function') {
      const error = new Error('宿主没有可用的语音识别')
      error.code = 'asr_unavailable'
      throw error
    }
    const spec = speech.resolve({ audio: new Uint8Array(wavBuffer), language: language || 'zh' })
    const transcript = await speech.transcribe(spec, signal)
    return transcript?.text ? String(transcript.text) : ''
  }

  const status = () => {
    const speech = getService('speechToText')
    const commands = getService('commands')
    const agents = getService('agents')
    let agentCount = 0
    try {
      agentCount = agents?.list?.()?.length ?? 0
    } catch {
      agentCount = 0
    }
    return {
      enabled: config.voiceEnabled === true,
      wakeWord: effectiveWake(),
      requireVoiceprint: config.voiceRequire !== false,
      threshold: voiceStore.threshold,
      language: config.voiceLanguage || 'zh',
      keepTranscript: config.voiceKeepTranscript !== false,
      enrolled: voiceStore.enrolled,
      samples: voiceStore.samples,
      updatedAt: voiceStore.updatedAt,
      model: voiceStore.model,
      ready: {
        speech: typeof speech?.transcribe === 'function',
        commands: typeof commands?.execute === 'function',
        agent: agentCount > 0,
      },
      lastEvent: events[events.length - 1] ?? null,
      eventCount: events.length,
    }
  }

  const enroll = async ({ samples, threshold }) => {
    if (!Array.isArray(samples)) throw new Error('samples 必须是数组')
    if (samples.length < 3) throw new Error('至少录 3 段')
    if (samples.length > 8) throw new Error('最多 8 段')
    const embeddings = []
    for (const raw of samples) {
      const wav = decodeAudio(raw)
      const parsed = parseWav(wav)
      const seconds = parsed.samples.length / parsed.sampleRate
      if (seconds < MIN_SECONDS) throw new Error(`每段至少 ${MIN_SECONDS}s`)
      if (seconds > MAX_SECONDS) throw new Error(`每段最多 ${MAX_SECONDS}s`)
      embeddings.push(extractEmbedding(parsed.samples, parsed.sampleRate))
    }
    const stats = voiceStore.enroll(embeddings, { threshold: threshold ?? config.voiceThreshold })
    log?.info?.(`voice_enrolled samples=${stats.samples} threshold=${stats.threshold}`)
    return { ok: true, ...stats }
  }

  const verify = async ({ audio }) => {
    if (!voiceStore.enrolled) return { enrolled: false, match: false, score: 0, threshold: voiceStore.threshold }
    const wav = decodeAudio(audio)
    const parsed = parseWav(wav)
    const result = voiceStore.verify(extractEmbedding(parsed.samples, parsed.sampleRate))
    log?.info?.(`voice_verify match=${result.match ? 1 : 0} score=${result.score.toFixed(3)}`)
    return result
  }

  const utterance = async ({ audio, mode = 'wake', language }) => {
    const started = now()
    const base = { mode }
    if (config.voiceEnabled !== true) {
      record({ ...base, accepted: false, reason: 'voice_disabled' })
      return { accepted: false, reason: 'voice_disabled' }
    }
    let parsed
    let wav = null
    try {
      wav = decodeAudio(audio)
      parsed = parseWav(wav)
    } catch (error) {
      record({ ...base, accepted: false, reason: 'bad_audio' })
      return { accepted: false, reason: 'bad_audio', error: String(error?.message ?? error) }
    }
    const seconds = parsed.samples.length / parsed.sampleRate
    if (seconds < MIN_SECONDS) {
      record({ ...base, accepted: false, reason: 'too_short' })
      return { accepted: false, reason: 'too_short' }
    }
    if (seconds > MAX_SECONDS) {
      record({ ...base, accepted: false, reason: 'too_long' })
      return { accepted: false, reason: 'too_long' }
    }

    if (config.voiceRequire !== false) {
      if (!voiceStore.enrolled) {
        record({ ...base, accepted: false, reason: 'not_enrolled' })
        return { accepted: false, reason: 'not_enrolled' }
      }
      const check = voiceStore.verify(extractEmbedding(parsed.samples, parsed.sampleRate))
      if (!check.match) {
        record({ ...base, accepted: false, reason: 'speaker_mismatch', score: check.score })
        return { accepted: false, reason: 'speaker_mismatch', score: check.score }
      }
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    if (typeof timer.unref === 'function') timer.unref()
    let text = ''
    try {
      text = (await transcribe(wav, language || config.voiceLanguage || 'zh', controller.signal)).trim()
    } catch (error) {
      clearTimeout(timer)
      const reason = error?.name === 'AbortError' ? 'asr_timeout' : error?.code === 'asr_unavailable' ? 'asr_unavailable' : 'asr_failed'
      log?.warn?.(`voice_asr_failed ${reason} ${error?.message ?? error}`)
      record({ ...base, accepted: false, reason })
      return { accepted: false, reason }
    }
    clearTimeout(timer)
    if (text === '') {
      record({ ...base, accepted: false, reason: 'empty' })
      return { accepted: false, reason: 'empty' }
    }

    let commandText = text
    if (mode !== 'push') {
      const stripped = stripWake(text)
      if (!stripped.hit) {
        record({ ...base, accepted: false, reason: 'no_wake', text })
        return { accepted: false, reason: 'no_wake', text }
      }
      if (stripped.text === '') {
        record({ ...base, accepted: false, reason: 'wake_only', text })
        return { accepted: false, reason: 'wake_only', text }
      }
      commandText = stripped.text
    }

    const agent = resolveAgent()
    const commands = getService('commands')
    if (!agent || typeof commands?.execute !== 'function') {
      record({ ...base, accepted: false, reason: 'no_agent', text: commandText })
      return { accepted: false, reason: 'no_agent', text: commandText, wakeWord: effectiveWake() }
    }
    try {
      const execution = await commands.execute(agent, `/chat ${commandText}`, [], controller.signal)
      if (!execution) {
        record({ ...base, accepted: false, reason: 'command_failed', text: commandText })
        return { accepted: false, reason: 'command_failed', text: commandText }
      }
      // 不同版本的 execute 返回 {result} 或直接返回结果；只把明确的失败当失败
      const result = execution.result ?? execution
      if (result?.kind && result.kind !== 'success') {
        record({ ...base, accepted: false, reason: 'command_failed', text: commandText })
        return { accepted: false, reason: 'command_failed', text: commandText, detail: result?.text ?? '' }
      }
      const event = record({
        ...base,
        accepted: true,
        reason: 'ok',
        text: commandText,
        chars: commandText.length,
        ms: now() - started,
      })
      log?.info?.(`voice_accepted mode=${mode} chars=${commandText.length} ms=${event.ms}`)
      return { accepted: true, reason: 'ok', text: commandText, reply: result?.text ?? '', event }
    } catch (error) {
      log?.warn?.(`voice_command_failed ${error?.message ?? error}`)
      record({ ...base, accepted: false, reason: 'command_failed', text: commandText })
      return { accepted: false, reason: 'command_failed', text: commandText }
    }
  }

  return {
    store: voiceStore,
    status,
    enroll,
    verify,
    utterance,
    events: (limit = 20) => events.slice(-Math.max(1, Math.min(200, limit))).reverse(),
    reset: () => {
      voiceStore.reset()
      log?.info?.('voice_enrolled_reset')
      return { ok: true }
    },
    wakeWord: effectiveWake,
    setThreshold: (value) => voiceStore.setThreshold(value),
    dispose: () => {
      // 不在这里写盘：没有登记过就不应该生成空声纹文件
    },
  }
}
