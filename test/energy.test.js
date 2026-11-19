import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ENERGY_DEFAULTS, createEnergyStore, createEnergyWatch } from '../lib/energy.js'

const HOUR = 3_600_000

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-energy-'))
  return dir
}

function fakeFetch(handler) {
  const calls = []
  const impl = async (url, options = {}) => {
    calls.push({ url, method: options.method || 'GET' })
    const result = handler(url, options)
    return {
      ok: result?.ok !== false,
      status: result?.status || 200,
      json: async () => result?.body ?? { ok: true },
    }
  }
  impl.calls = calls
  return impl
}

test('醒着按小时消耗，睡着按小时恢复', () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 100 }, now: () => at })
    assert.equal(store.level(at), 100)
    at += 10 * HOUR
    assert.equal(store.level(at), 40)
    store.setSleeping(true, at)
    at += 1 * HOUR
    assert.equal(store.level(at), 76)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('补算最多 24 小时，时钟回拨不涨也不掉', () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 50 }, now: () => at })
    at += 100 * HOUR
    assert.equal(store.level(at), 0)
    at -= 100 * HOUR
    assert.equal(store.level(at), 50)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('强行唤醒扣点、落盘能读回', () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 60 }, now: () => at })
    store.spend(5, at)
    store.save()
    assert.equal(store.level(at), 55)
    const raw = JSON.parse(readFileSync(join(dir, 'energy.json'), 'utf8'))
    assert.equal(raw.main.level, 55)
    const again = createEnergyStore({ dir, config: { start: 60 }, now: () => at })
    assert.equal(again.level(at), 55)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('同一个阈值只说一次，降档再说', async () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 69 }, now: () => at })
    const lines = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: false } } } } } }
      return { body: { ok: true } }
    })
    const watch = createEnergyWatch({
      store,
      speak: async (_petId, text) => lines.push(text),
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl,
      now: () => at,
    })
    await watch.tick()
    assert.equal(lines.length, 1)
    await watch.tick()
    assert.equal(lines.length, 1)
    store.spend(30, at)
    at += 60_000
    await watch.tick()
    assert.equal(lines.length, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('0 精力被强行唤醒会立刻回睡并说叫不醒', async () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 0 }, now: () => at })
    store.setSleeping(true, at)
    const lines = []
    let sleeps = 0
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: false } } } } } }
      if (url.includes('/sleep')) sleeps += 1
      return { body: { ok: true } }
    })
    const watch = createEnergyWatch({
      store,
      speak: async (_petId, text) => lines.push(text),
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl,
      now: () => at,
    })
    await watch.tick()
    assert.equal(sleeps, 1)
    assert.equal(store.sleeping, true)
    assert.equal(lines[0], '唔…叫不醒的…')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('低于阈值自动睡，睡满自动醒', async () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 15 }, now: () => at })
    const posts = []
    const lines = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: false } } } } } }
      posts.push(url)
      return { body: { ok: true } }
    })
    const watch = createEnergyWatch({
      store,
      speak: async (_petId, text) => lines.push(text),
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl,
      now: () => at,
    })
    await watch.tick()
    assert.equal(posts.some((u) => u.includes('/sleep')), true)
    assert.equal(store.sleeping, true)

    // 睡到满：直接把时间拨 3 小时（36/h → 15+108 → 100）
    at += 3 * HOUR
    fetchImpl.calls.length = 0
    const sleepingFetch = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: true } } } } } }
      posts.push(url)
      return { body: { ok: true } }
    })
    const wakeWatch = createEnergyWatch({
      store,
      speak: async (_petId, text) => lines.push(text),
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl: sleepingFetch,
      now: () => at,
    })
    await wakeWatch.tick()
    assert.equal(store.sleeping, false)
    assert.equal(posts.some((u) => u.includes('/wake')), true)
    assert.equal(lines.includes('睡饱了，我回来啦。'), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('默认值与文档一致', () => {
  assert.equal(ENERGY_DEFAULTS.start, 100)
  assert.equal(ENERGY_DEFAULTS.awakeDrainPerHour, 6)
  assert.equal(ENERGY_DEFAULTS.asleepRecoverPerHour, 36)
  assert.equal(ENERGY_DEFAULTS.sleepAt, 20)
  assert.equal(ENERGY_DEFAULTS.wakeAt, 100)
  assert.equal(ENERGY_DEFAULTS.wakePenalty, 5)
})

test('被外部唤醒扣 5 点，自己睡饱醒不扣', async () => {
  const dir = tempDir()
  try {
    let at = Date.parse('2026-11-20T00:00:00Z')
    const store = createEnergyStore({ dir, config: { start: 50 }, now: () => at })
    store.setSleeping(true, at)
    at += 2 * HOUR
    const lines = []
    const fetchImpl = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: false } } } } } }
      return { body: { ok: true } }
    })
    const watch = createEnergyWatch({
      store,
      speak: async (_petId, text) => lines.push(text),
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl,
      now: () => at,
    })
    await watch.tick()
    // 50 + 2h*36 = 122 → 100（clamp），醒来扣 5 → 95
    assert.equal(Math.round(store.level(at)), 95)
    assert.equal(store.sleeping, false)

    // 自动醒：睡着且满了，watch 自己唤醒，不该扣
    const dir2 = tempDir()
    let at2 = Date.parse('2026-11-20T00:00:00Z')
    const store2 = createEnergyStore({ dir: dir2, config: { start: 100 }, now: () => at2 })
    store2.setSleeping(true, at2)
    const autoFetch = fakeFetch((url) => {
      if (url.includes('/state')) return { body: { pets: { main: { sleep: { data: { sleeping: true } } } } } }
      return { body: { ok: true } }
    })
    const autoWatch = createEnergyWatch({
      store: store2,
      speak: async () => {},
      getOrigin: () => 'http://127.0.0.1:1',
      fetchImpl: autoFetch,
      now: () => at2,
    })
    await autoWatch.tick()
    assert.equal(Math.round(store2.level(at2)), 100)
    assert.equal(store2.sleeping, false)
    rmSync(dir2, { recursive: true, force: true })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
