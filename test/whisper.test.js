import test from 'node:test'
import assert from 'node:assert/strict'
import { createWhisperWatch } from '../lib/whisper.js'

function fakeSelf() {
  const rows = []
  return { rows, note(input) { rows.push(input); return { id: `s_${rows.length}`, ...input } } }
}

function stateFetch(initial = {}) {
  let counter = Number(initial.counter) || 0
  let text = initial.text || ''
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    async json() {
      return { pets: { main: { say: { counter, data: { text } } } } }
    },
  })
  return {
    fetchImpl,
    set(next) { counter = next.counter; text = next.text },
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('首拉只建基线，新气泡才记一条', async () => {
  const self = fakeSelf()
  const feed = stateFetch({ counter: 1, text: '旧的一句' })
  const watch = createWhisperWatch({ self, getOrigin: () => 'http://x', fetchImpl: feed.fetchImpl, settleMs: 5 })
  await watch.poll()
  assert.equal(self.rows.length, 0)
  feed.set({ counter: 2, text: '今天风好大' })
  await watch.poll()
  await sleep(30)
  assert.equal(self.rows.length, 1)
  assert.match(self.rows[0].text, /自己嘟囔了一句：今天风好大/)
  assert.equal(self.rows[0].source, 'whisper')
  assert.equal(self.rows[0].petId, 'main')
  assert.equal(watch.status().recorded, 1)
})

test('聊天回复不记成碎碎念', async () => {
  const self = fakeSelf()
  const feed = stateFetch({ counter: 1, text: '旧' })
  const watch = createWhisperWatch({ self, getOrigin: () => 'http://x', fetchImpl: feed.fetchImpl, settleMs: 20 })
  await watch.poll()
  feed.set({ counter: 2, text: '主人好呀' })
  await watch.poll()
  watch.noteChatReply('主人好呀')
  await sleep(40)
  assert.equal(self.rows.length, 0)
})

test('本插件主动说的话不重复记', async () => {
  const self = fakeSelf()
  const feed = stateFetch({ counter: 1, text: '旧' })
  const watch = createWhisperWatch({ self, getOrigin: () => 'http://x', fetchImpl: feed.fetchImpl, settleMs: 20 })
  await watch.poll()
  feed.set({ counter: 2, text: '提醒你喝水' })
  await watch.poll()
  watch.noteSpoken('提醒你喝水')
  await sleep(40)
  assert.equal(self.rows.length, 0)
})

test('同一 counter 不重复记录', async () => {
  const self = fakeSelf()
  const feed = stateFetch({ counter: 1, text: '旧' })
  const watch = createWhisperWatch({ self, getOrigin: () => 'http://x', fetchImpl: feed.fetchImpl, settleMs: 5 })
  await watch.poll()
  feed.set({ counter: 2, text: '一句' })
  await watch.poll()
  await watch.poll()
  await sleep(30)
  assert.equal(self.rows.length, 1)
})

test('睡着时的气泡记成梦话并带上 sleeping 标记', async () => {
  const self = fakeSelf()
  let counter = 1
  let text = '旧'
  let sleeping = true
  const fetchImpl = async () => ({
    ok: true,
    status: 200,
    async json() {
      return { pets: { main: { say: { counter, data: { text } }, sleep: { data: { sleeping } } } } }
    },
  })
  const watch = createWhisperWatch({ self, getOrigin: () => 'http://x', fetchImpl, settleMs: 5 })
  await watch.poll()
  counter = 2
  text = '梦到大鱼'
  await watch.poll()
  await sleep(30)
  assert.equal(self.rows.length, 1)
  assert.equal(self.rows[0].sleeping, true)
  assert.match(self.rows[0].text, /梦话：梦到大鱼/)
  assert.equal(watch.status().sleeping, true)
})
