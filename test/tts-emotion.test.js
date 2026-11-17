import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmotionTts, scoreEmotion, VOICES } from '../lib/tts-emotion.js'

test('开心文本给出正向音高与语速偏移', () => {
  const mood = scoreEmotion('好耶！太棒了！')
  assert.equal(mood.emotion, 'happy')
  assert.ok(mood.pitch > 0)
  assert.ok(mood.rate > 0)
  assert.ok(mood.strength > 0)
})

test('低落文本给出负向音高与语速偏移', () => {
  const mood = scoreEmotion('唉…好累')
  assert.equal(mood.emotion, 'low')
  assert.ok(mood.pitch < 0)
  assert.ok(mood.rate < 0)
})

test('生气文本提高音量', () => {
  const mood = scoreEmotion('哼，不理你了')
  assert.equal(mood.emotion, 'angry')
  assert.ok(mood.volume > 0)
})

test('平静文本完全不加偏移', () => {
  const mood = scoreEmotion('今天天气不错')
  assert.deepEqual(mood, { emotion: 'calm', strength: 0, pitch: 0, rate: 0, volume: 0 })
})

test('强度参数会放大偏移并夹在 0.5–1.5', () => {
  const weak = scoreEmotion('好耶！', { intensity: 0.1 })
  const strong = scoreEmotion('好耶！', { intensity: 9 })
  assert.ok(strong.pitch >= weak.pitch)
  assert.ok(strong.rate >= weak.rate)
})

test('provider 形状合法且音色表非空', () => {
  const provider = createEmotionTts({ loadEdgeTts: async () => ({ generate: async () => new Uint8Array([1]) }) })
  assert.equal(provider.id, 'pet-persona-emotion')
  assert.equal(provider.format, 'mp3')
  assert.ok(provider.voices.length >= 3)
  assert.ok(provider.voices.every((voice) => voice.id && voice.name))
  assert.equal(typeof provider.synthesize, 'function')
  assert.ok(VOICES.length >= 3)
})

test('synthesize 把情绪偏移传给 edge 并返回字节', async () => {
  let captured = null
  const provider = createEmotionTts({
    loadEdgeTts: async () => ({
      generate: async (text, voice, options) => {
        captured = { text, voice, options }
        return Buffer.from([1, 2, 3])
      },
    }),
  })
  const bytes = await provider.synthesize({ text: '好耶！', voice: 'zh-CN-XiaoyiNeural', rate: 5 })
  assert.ok(bytes instanceof Uint8Array)
  assert.deepEqual(Array.from(bytes), [1, 2, 3])
  assert.equal(captured.text, '好耶！')
  assert.equal(captured.voice, 'zh-CN-XiaoyiNeural')
  assert.ok(captured.options.pitch > 0)
  assert.ok(captured.options.rate > 5)
  assert.ok(captured.options.rate <= 100)
})

test('edge 失败时抛错而不是返回空字节', async () => {
  const provider = createEmotionTts({
    loadEdgeTts: async () => ({ generate: async () => { throw new Error('network down') } }),
  })
  await assert.rejects(
    () => provider.synthesize({ text: '测试', voice: 'zh-CN-XiaoyiNeural', rate: 0 }),
    /network down/,
  )
})

test('空音频按失败处理', async () => {
  const provider = createEmotionTts({
    loadEdgeTts: async () => ({ generate: async () => new Uint8Array(0) }),
  })
  await assert.rejects(() => provider.synthesize({ text: '测试', rate: 0 }), /empty audio/)
})
