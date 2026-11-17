import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  VoiceprintStore,
  cosine,
  createVoiceService,
  decodeAudio,
  extractEmbedding,
  parseWav,
} from '../lib/voice.js'

function rng(seed) {
  let state = seed >>> 0
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0
    return state / 0xffffffff
  }
}

/** 生成单声道 16bit WAV。 */
function makeWav({ seconds = 1, freq = 220, sampleRate = 16000, amp = 0.3, noise = 0.01, seed = 1 } = {}) {
  const frames = Math.floor(seconds * sampleRate)
  const pcm = new Int16Array(frames)
  const random = rng(seed)
  for (let i = 0; i < frames; i += 1) {
    const tone = Math.sin((2 * Math.PI * freq * i) / sampleRate)
    const value = Math.max(-1, Math.min(1, tone * amp + (random() - 0.5) * noise))
    pcm[i] = Math.round(value * 32767)
  }
  const buffer = Buffer.alloc(44 + frames * 2)
  buffer.write('RIFF', 0, 'ascii')
  buffer.writeUInt32LE(36 + frames * 2, 4)
  buffer.write('WAVE', 8, 'ascii')
  buffer.write('fmt ', 12, 'ascii')
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(1, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * 2, 28)
  buffer.writeUInt16LE(2, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36, 'ascii')
  buffer.writeUInt32LE(frames * 2, 40)
  for (let i = 0; i < frames; i += 1) buffer.writeInt16LE(pcm[i], 44 + i * 2)
  return buffer
}

const toBase64 = (buffer) => buffer.toString('base64')
const tmp = () => mkdtempSync(join(tmpdir(), 'persona-voice-'))

test('parseWav 读回采样率、声道与时长', () => {
  const wav = makeWav({ seconds: 0.5, sampleRate: 16000 })
  const parsed = parseWav(wav)
  assert.equal(parsed.sampleRate, 16000)
  assert.equal(parsed.channels, 1)
  assert.equal(parsed.bitsPerSample, 16)
  assert.ok(Math.abs(parsed.seconds - 0.5) < 0.01)
  assert.equal(parsed.samples.length, 8000)
  assert.equal(decodeAudio(toBase64(wav)).length, wav.length)
})

test('embedding 自比=1，不同声音明显更低', () => {
  const a = parseWav(makeWav({ freq: 220, seconds: 1, seed: 7 }))
  const b = parseWav(makeWav({ freq: 220, seconds: 1, seed: 7 }))
  const c = parseWav(makeWav({ freq: 880, seconds: 1, amp: 0.05, noise: 0.4, seed: 99 }))
  const ea = extractEmbedding(a.samples, a.sampleRate)
  const eb = extractEmbedding(b.samples, b.sampleRate)
  const ec = extractEmbedding(c.samples, c.sampleRate)
  assert.ok(Math.abs(cosine(ea, eb) - 1) < 1e-6)
  assert.ok(cosine(ea, ec) < 0.98)
})

test('VoiceprintStore：至少 3 段、落盘、验证与重置', () => {
  const dir = tmp()
  try {
    const store = new VoiceprintStore({ dir, threshold: 0.7 })
    const vector = extractEmbedding(parseWav(makeWav()).samples, 16000)
    assert.throws(() => store.enroll([vector, vector]), /至少需要 3 段/)
    const stats = store.enroll([vector, vector, vector])
    assert.equal(stats.enrolled, true)
    assert.equal(stats.samples, 3)
    assert.ok(store.verify(vector).match)
    assert.equal(store.verify(new Float32Array(16)).match, false)

    const again = new VoiceprintStore({ dir, threshold: 0.7 }).initSync()
    assert.equal(again.enrolled, true)
    assert.ok(again.verify(vector).match)

    again.reset()
    assert.equal(again.enrolled, false)
    assert.equal(existsSync(join(dir, 'voiceprint.json')), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未登记声纹时直接拒绝，不调用 ASR', async () => {
  const dir = tmp()
  const calls = []
  let asrCalls = 0
  const config = {
    voiceEnabled: true, voiceRequire: true, voiceThreshold: 0.7,
    voiceWakeWord: '小鲸鱼', voiceLanguage: 'zh', voiceKeepTranscript: true,
  }
  try {
    const service = createVoiceService({
      config, dir,
      services: {
        agents: { roots: () => [{ id: 'agent-1' }] },
        commands: { execute: async (agent, line) => { calls.push({ agent, line }); return { result: { kind: 'success', text: '喵' } } } },
        speechToText: {
          resolve: () => ({}),
          transcribe: async () => { asrCalls += 1; return { text: '小鲸鱼 你好' } },
        },
      },
      log: { info() {}, warn() {}, debug() {}, error() {} },
    })
    const wav = toBase64(makeWav())
    const result = await service.utterance({ audio: wav, mode: 'wake' })
    assert.equal(result.accepted, false)
    assert.equal(result.reason, 'not_enrolled')
    assert.equal(asrCalls, 0)
    assert.equal(calls.length, 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('登记后：唤醒词、push 模式与拒绝路径', async () => {
  const dir = tmp()
  const calls = []
  const config = {
    voiceEnabled: true, voiceRequire: true, voiceThreshold: 0.7,
    voiceWakeWord: '小鲸鱼', voiceLanguage: 'zh', voiceKeepTranscript: true,
  }
  let replyText = '小鲸鱼 今天天气怎么样'
  try {
    const service = createVoiceService({
      config, dir,
      services: {
        agents: { roots: () => [{ id: 'agent-1' }] },
        commands: { execute: async (agent, line) => { calls.push({ agent, line }); return { result: { kind: 'success', text: '喵' } } } },
        speechToText: {
          resolve: () => ({}),
          transcribe: async () => ({ text: replyText }),
        },
      },
      log: { info() {}, warn() {}, debug() {}, error() {} },
    })
    const wav = toBase64(makeWav())
    await service.enroll({ samples: [wav, wav, wav] })

    const ok = await service.utterance({ audio: wav, mode: 'wake' })
    assert.equal(ok.accepted, true)
    assert.equal(calls.at(-1).line, '/chat 今天天气怎么样')

    replyText = '今天天气不错'
    const noWake = await service.utterance({ audio: wav, mode: 'wake' })
    assert.equal(noWake.accepted, false)
    assert.equal(noWake.reason, 'no_wake')

    const push = await service.utterance({ audio: wav, mode: 'push' })
    assert.equal(push.accepted, true)
    assert.equal(calls.at(-1).line, '/chat 今天天气不错')

    const silent = toBase64(makeWav({ amp: 0, noise: 0 }))
    const mismatch = await service.utterance({ audio: silent, mode: 'push' })
    assert.equal(mismatch.accepted, false)
    assert.equal(mismatch.reason, 'speaker_mismatch')

    config.voiceEnabled = false
    const disabled = await service.utterance({ audio: wav, mode: 'push' })
    assert.equal(disabled.reason, 'voice_disabled')

    assert.equal(existsSync(join(dir, 'voice-events.jsonl')), true)
    const lines = readFileSync(join(dir, 'voice-events.jsonl'), 'utf8').trim().split('\n')
    assert.ok(lines.length >= 4)
    assert.match(lines[0], /"reason":"ok"/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('声纹不一致的样本会被拒绝登记', () => {
  const dir = tmp()
  try {
    const store = new VoiceprintStore({ dir })
    const a = extractEmbedding(parseWav(makeWav({ freq: 200, amp: 0.3, noise: 0.02 })).samples, 16000)
    const b = extractEmbedding(parseWav(makeWav({ amp: 0, noise: 0 })).samples, 16000)
    assert.throws(() => store.enroll([a, b, b]), (error) => error.code === 'inconsistent_samples')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
