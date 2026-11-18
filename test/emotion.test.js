import test from 'node:test'
import assert from 'node:assert/strict'
import { analyzeEmotion } from '../lib/emotion.js'
import { SelfStore } from '../lib/self.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

test('开心但累：同一句话保留两种情绪', () => {
  const emo = analyzeEmotion('今天好开心，但是有点累', '嘿嘿，那早点休息嘛')
  assert.ok(emo.emotions.some((item) => item.key === 'joy'))
  assert.ok(emo.emotions.some((item) => item.key === 'tiredness'))
  assert.match(emo.mixText, /开心/)
  assert.match(emo.mixText, /累/)
})

test('否定词不误判：不开心不是开心', () => {
  const emo = analyzeEmotion('我不开心', '')
  assert.equal(emo.scores.joy, 0)
  assert.ok(emo.scores.sadness > 0)
})

test('又气又委屈是混合情绪', () => {
  const emo = analyzeEmotion('哼，你凶我，我又气又委屈', '')
  assert.ok(emo.emotions.some((item) => item.key === 'anger'))
  assert.ok(emo.emotions.some((item) => item.key === 'sadness'))
  assert.match(emo.mixText, /气|委屈/)
})

test('亲近和开心可以同时出现', () => {
  const emo = analyzeEmotion('谢谢你，真乖，抱抱', '主人最好啦！')
  assert.ok(emo.emotions.some((item) => item.key === 'joy' || item.key === 'affection'))
  assert.ok(emo.valence > 0)
})

test('普通闲聊落到平静，不硬编情绪', () => {
  const emo = analyzeEmotion('嗯', '嗯')
  assert.equal(emo.primary, 'calm')
  assert.ok(emo.emotions.length >= 1)
})

test('SelfStore 记录混合情绪并在 state 聚合', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-emo-'))
  try {
    const store = new SelfStore({ dir })
    store.initSync()
    store.record({ petId: 'main', userText: '今天很开心，但是有点累', replyText: '那抱抱，早点睡' })
    const state = store.state('main')
    const keys = state.emotions.map((item) => item.key)
    assert.ok(keys.includes('joy'))
    assert.ok(keys.includes('tiredness'))
    assert.match(state.mixText, /开心/)
    assert.match(state.mixText, /累/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
