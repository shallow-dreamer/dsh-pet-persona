import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { FactStore, compactRows, serializeFact } from '../lib/facts.js'

async function newStore(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'persona-facts-'))
  const store = new FactStore({ dir, ...options })
  await store.init()
  return { dir, store }
}

test('首次启动创建空的 facts.jsonl', async () => {
  const { store } = await newStore()
  const text = await readFile(store.file, 'utf8')
  assert.equal(text, '')
  assert.deepEqual(store.stats(), { rows: 0, active: 0, archived: 0, keys: 0, readOnly: false, loaded: true })
  await store.dispose()
})

test('ADD 落盘 schema 完整，重载后仍在', async () => {
  const { dir, store } = await newStore()
  const stats = await store.merge(
    [{ type: 'identity', key: '主人.称呼', value: '阿岚', quote: '我叫阿岚', importance: 5 }],
    { petId: 'pet-a' },
  )
  assert.deepEqual(stats, { added: 1, updated: 0, deleted: 0, skipped: 0, archived: 0 })

  const raw = await readFile(store.file, 'utf8')
  const row = JSON.parse(raw.trim())
  assert.equal(row.v, 1)
  assert.equal(row.petId, 'pet-a')
  assert.equal(row.type, 'identity')
  assert.equal(row.key, '主人.称呼')
  assert.equal(row.value, '阿岚')
  assert.equal(row.quote, '我叫阿岚')
  assert.equal(row.validTo, null)
  assert.equal(row.hits, 0)
  assert.equal(row.hash.length, 12)
  assert.match(row.createdAt, /^\d{4}-\d{2}-\d{2}T/)

  const reloaded = new FactStore({ dir })
  await reloaded.init()
  assert.equal(reloaded.active.length, 1)
  assert.equal(reloaded.active[0].value, '阿岚')
  assert.equal(reloaded.active[0].hash, row.hash)
  await reloaded.dispose()
  await store.dispose()
})

test('相同 hash 不重复落盘，只更新 lastMentionAt', async () => {
  const { store } = await newStore()
  const item = { type: 'identity', key: '主人.称呼', value: '阿岚', importance: 5 }
  await store.merge([item])
  const stats = await store.merge([item])
  assert.equal(stats.added, 0)
  assert.equal(stats.skipped, 1)
  assert.equal(store.rows.length, 1)
  assert.ok(store.active[0].lastMentionAt)
  await store.dispose()
})

test('同 key 新值走 UPDATE：旧行打 validTo + supersedes', async () => {
  const { store } = await newStore()
  await store.merge([{ type: 'identity', key: '主人.称呼', value: '阿岚', importance: 5 }])
  const oldId = store.active[0].id
  const stats = await store.merge([{ type: 'identity', key: '主人.称呼', value: '阿岚小姐', importance: 5 }])
  assert.equal(stats.updated, 1)
  assert.equal(store.rows.length, 2)
  assert.equal(store.active.length, 1)
  const archived = store.rows.find((row) => row.id === oldId)
  assert.ok(archived.validTo)
  assert.equal(store.active[0].supersedes, oldId)
  await store.dispose()
})

test('DELETE 只打 validTo，不物理删除', async () => {
  const { store } = await newStore()
  await store.merge([{ type: 'preference', key: '主人.喜好', value: '喜欢猫', importance: 3 }])
  const stats = await store.merge([{ op: 'DELETE', key: '主人.喜好' }])
  assert.equal(stats.deleted, 1)
  assert.equal(store.active.length, 0)
  assert.equal(store.rows.length, 1)
  assert.ok(store.rows[0].validTo)
  await store.dispose()
})

test('敏感值在存储层也会被拦掉', async () => {
  const { store } = await newStore()
  const stats = await store.merge([{ type: 'identity', key: '主人.近况', value: '密码是 abc12345' }])
  assert.equal(stats.added, 0)
  assert.equal(stats.skipped, 1)
  assert.equal(store.rows.length, 0)
  await store.dispose()
})

test('活跃超过 maxFacts 时按 keepScore 归档，pinned 保留', async () => {
  const { store } = await newStore({ maxFacts: 20 })
  await store.merge([{ type: 'event', key: '主人.约定', value: '别忘了带伞', importance: 1, pinned: true }])
  const items = []
  for (let i = 0; i < 24; i += 1) {
    items.push({ type: 'preference', key: `主人.喜好${i}`, value: `喜欢第${i}种东西`, importance: 3 })
  }
  const stats = await store.merge(items)
  assert.ok(stats.archived >= 4)
  assert.ok(store.active.length <= 20)
  assert.ok(store.active.some((row) => row.pinned === true && row.value === '别忘了带伞'))
  // 落盘行数 = 活跃 + 归档
  assert.equal(store.rows.length, store.active.length + store.archivedCount)
  await store.dispose()
})

test('并发 merge 自动串行，文件始终是完整行', async () => {
  const { store } = await newStore()
  await Promise.all(
    Array.from({ length: 15 }, (_, i) =>
      store.merge([{ type: 'preference', key: `主人.喜好${i}`, value: `喜欢${i}号`, importance: 3 }]),
    ),
  )
  const text = await readFile(store.file, 'utf8')
  const lines = text.trim().split('\n')
  assert.equal(lines.length, 15)
  for (const line of lines) JSON.parse(line)
  assert.equal(store.active.length, 15)
  await store.dispose()
})

test('坏行跳过，v>1 进只读且不写盘', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'persona-bad-'))
  const good = JSON.stringify({
    v: 1, id: 'f_1', petId: 'p', type: 'identity', key: '主人.称呼', value: '阿岚',
    quote: '', importance: 5, pinned: false, createdAt: new Date().toISOString(), validTo: null, hits: 0,
  })
  await writeFile(join(dir, 'facts.jsonl'), `not json\n${good}\n`, 'utf8')
  const store = new FactStore({ dir })
  await store.init()
  assert.equal(store.active.length, 1)

  const dir2 = await mkdtemp(join(tmpdir(), 'persona-v2-'))
  const v2 = JSON.stringify({ ...JSON.parse(good), id: 'f_2', v: 2 })
  await writeFile(join(dir2, 'facts.jsonl'), `${v2}\n`, 'utf8')
  const store2 = new FactStore({ dir: dir2 })
  await store2.init()
  assert.equal(store2.readOnly, true)
  const before = await readFile(store2.file, 'utf8')
  const stats = await store2.merge([{ type: 'identity', key: '主人.称呼', value: '别人' }])
  assert.equal(stats.readOnly, true)
  assert.equal(await readFile(store2.file, 'utf8'), before)
  await store.dispose()
  await store2.dispose()
})

test('compact 保留全部活跃 + 每 key 最近一条归档', () => {
  const now = new Date().toISOString()
  const rows = [
    { v: 1, id: 'a1', petId: 'p', type: 'identity', key: '主人.称呼', value: '一', validTo: '2026-01-01T00:00:00Z', createdAt: now },
    { v: 1, id: 'a2', petId: 'p', type: 'identity', key: '主人.称呼', value: '二', validTo: '2026-02-01T00:00:00Z', createdAt: now },
    { v: 1, id: 'a3', petId: 'p', type: 'identity', key: '主人.称呼', value: '三', validTo: null, createdAt: now },
    { v: 1, id: 'b1', petId: 'p', type: 'preference', key: '主人.喜好', value: '猫', validTo: null, createdAt: now },
  ]
  const kept = compactRows(rows).map((row) => row.id)
  assert.deepEqual(kept.sort(), ['a2', 'a3', 'b1'])
  assert.equal(serializeFact(rows[0])._nk, undefined)
})
