import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SelfStore } from '../lib/self.js'

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'persona-self-'))
}

async function flush(store) {
  await store.chain
  await store.dispose()
}

test('首次启动创建空 self.jsonl，且不碰 facts.jsonl', async () => {
  const dir = tempDir()
  try {
    const store = new SelfStore({ dir })
    store.initSync()
    assert.equal(existsSync(join(dir, 'self.jsonl')), true)
    assert.equal(statSync(join(dir, 'self.jsonl')).size, 0)
    assert.equal(existsSync(join(dir, 'facts.jsonl')), false)
    assert.deepEqual(store.stats().entries, 0)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('正向对话心情变好，负向变差', async () => {
  const dirGood = tempDir()
  const dirBad = tempDir()
  try {
    const now = Date.now()
    const good = new SelfStore({ dir: dirGood, now: () => now })
    good.initSync()
    good.record({ petId: 'main', userText: '谢谢你，真乖', replyText: '主人最好啦！', ts: now })
    const goodState = good.state('main')
    assert.ok(goodState.valence > 0, `valence=${goodState.valence}`)
    await flush(good)

    const bad = new SelfStore({ dir: dirBad, now: () => now })
    bad.initSync()
    bad.record({ petId: 'main', userText: '你好烦，滚', replyText: '哼。', ts: now })
    const badState = bad.state('main')
    assert.ok(badState.valence < 0, `valence=${badState.valence}`)
    await flush(bad)
  } finally {
    rmSync(dirGood, { recursive: true, force: true })
    rmSync(dirBad, { recursive: true, force: true })
  }
})

test('旧事件按半衰期衰减，不会永久决定心情', async () => {
  const dir = tempDir()
  try {
    const now = Date.now()
    const store = new SelfStore({ dir, now: () => now })
    store.initSync()
    store.record({ petId: 'main', userText: '谢谢你，真乖', replyText: '主人最好啦', ts: now - 12 * 3_600_000 })
    store.record({ petId: 'main', userText: '嗯', replyText: '嗯', ts: now })
    const state = store.state('main')
    // 12h = 2 个半衰期，旧正向事件权重 0.25；若未衰减会接近 0.5
    assert.ok(state.valence > 0 && state.valence < 0.35, `valence=${state.valence}`)
    assert.equal(state.events, 2)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('超过上限后压缩，保留最新记录', async () => {
  const dir = tempDir()
  try {
    const store = new SelfStore({ dir, maxEntries: 20 })
    store.initSync()
    for (let i = 0; i < 35; i += 1) {
      store.record({ petId: 'main', userText: `第 ${i} 次聊天`, replyText: `回复 ${i}` })
    }
    await store.compact()
    await flush(store)

    const again = new SelfStore({ dir, maxEntries: 20 })
    again.initSync()
    assert.ok(again.entries.length <= 20, `entries=${again.entries.length}`)
    assert.ok(again.entries.some((row) => row.text.includes('第 34 次')), '最新一条应保留')
    await flush(again)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('敏感内容只记泛化文本，不落原话', async () => {
  const dir = tempDir()
  try {
    const store = new SelfStore({ dir })
    store.initSync()
    store.record({ petId: 'main', userText: '我的密码是 hunter2', replyText: '好，我记住了' })
    const row = store.recent('main', 1)[0]
    assert.ok(row, '应记录一条')
    assert.equal(row.text, '和主人聊了会儿天')
    assert.equal(row.quote, '')
    assert.ok(!JSON.stringify(row).includes('hunter2'))
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('petId 隔离：一只宠物的心情不影响另一只', async () => {
  const dir = tempDir()
  try {
    const store = new SelfStore({ dir })
    store.initSync()
    store.record({ petId: 'a', userText: '谢谢你，真乖', replyText: '好开心' })
    store.record({ petId: 'b', userText: '你好烦', replyText: '哼' })
    assert.equal(store.state('a').events, 1)
    assert.equal(store.state('b').events, 1)
    assert.ok(store.state('a').valence > 0)
    assert.ok(store.state('b').valence < 0)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('10 分钟内重复同一句话只记一次', async () => {
  const dir = tempDir()
  try {
    const now = Date.now()
    const store = new SelfStore({ dir, now: () => now })
    store.initSync()
    const first = store.record({ petId: 'main', userText: '谢谢你，真乖', replyText: '好开心', ts: now })
    const second = store.record({ petId: 'main', userText: '谢谢你，真乖', replyText: '好开心', ts: now + 60_000 })
    assert.ok(first)
    assert.equal(second, null)
    assert.equal(store.recent('main', 10).length, 1)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('reset 只清指定宠物', async () => {
  const dir = tempDir()
  try {
    const store = new SelfStore({ dir })
    store.initSync()
    store.record({ petId: 'a', userText: '谢谢你', replyText: '好' })
    store.record({ petId: 'b', userText: '你好烦', replyText: '哼' })
    await store.reset('a')
    assert.equal(store.recent('a', 10).length, 0)
    assert.equal(store.recent('b', 10).length, 1)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('睡着时的梦话情绪权重按 0.35 计', async () => {
  const dir = tempDir()
  try {
    const now = Date.now()
    const store = new SelfStore({ dir, now: () => now })
    store.initSync()
    store.note({ petId: 'main', text: '梦到被追', source: 'whisper', valence: -1, energy: 0.2, importance: 5, sleeping: true })
    store.note({ petId: 'main', text: '今天真开心', source: 'whisper', valence: 1, energy: 0.8, importance: 5 })
    const state = store.state('main')
    // 醒着 +1 对 睡着的 -0.35：valence = (1 - 0.35) / 1.35 ≈ 0.481
    assert.ok(Math.abs(state.valence - 0.481) < 0.02)
    await flush(store)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
