import test from 'node:test'
import assert from 'node:assert/strict'

import { buildSelfBlock, selectSelfEvents, SELF_HEADER, SELF_NOTE } from '../lib/self-context.js'
import { createRecall } from '../lib/recall.js'
import { buildSynonymIndex } from '../lib/util.js'

const NOW = Date.parse('2026-11-15T12:00:00.000Z')
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600_000).toISOString()

const state = { moodText: '开心 · 精神', valence: 0.62, energy: 0.7, label: '开心', events: 4, updatedAt: iso(1) }

const events = [
  { id: 'a', petId: 'p1', kind: 'event', text: '主人夸我今天很乖', quote: '真乖', valence: 0.8, energy: 0.7, importance: 3, createdAt: iso(1) },
  { id: 'b', petId: 'p1', kind: 'event', text: '陪主人加班到很晚', quote: '', valence: -0.2, energy: 0.2, importance: 2, createdAt: iso(3) },
  { id: 'c', petId: 'p1', kind: 'event', text: '吃了一块小饼干', quote: '', valence: 0.3, energy: 0.6, importance: 1, createdAt: iso(40) },
  { id: 'd', petId: 'p1', kind: 'thought', text: '你以后要叫我主人', quote: '', valence: 0, energy: 0.5, importance: 5, createdAt: iso(2) },
]

test('没有状态或不曾有经历时不注入；有历史但没有窗口内经历时只留心情', () => {
  assert.equal(buildSelfBlock({ state: null, events, now: NOW }).block, undefined)
  const noHistory = buildSelfBlock({ state: { moodText: '平静 · 一般', events: 0, updatedAt: '' }, events: [], now: NOW })
  assert.equal(noHistory.block, undefined)
  const moodOnly = buildSelfBlock({ state, events: [], now: NOW })
  assert.ok(moodOnly.block.includes('心情：开心 · 精神'))
  assert.ok(!moodOnly.block.includes('最近：'))
})

test('生成【现在的我】：心情 + 最近 + 说明，默认不带原话', () => {
  const built = buildSelfBlock({ state, events, now: NOW })
  assert.ok(built.block)
  assert.ok(built.block.startsWith(SELF_HEADER))
  assert.ok(built.block.includes('心情：开心 · 精神'))
  assert.ok(built.block.includes('最近：'))
  assert.ok(built.block.includes('主人夸我今天很乖'))
  assert.ok(built.block.includes(SELF_NOTE))
  assert.ok(!built.block.includes('真乖'), '默认不应带 quote')
  assert.equal(built.eventIds.length, 2, '40h 的旧事件应被 36h 窗口排除，人格句应被过滤')
})

test('显式开启 quotes 才带主人口头原话', () => {
  const built = buildSelfBlock({ state, events, quotes: true, now: NOW })
  assert.ok(built.block.includes('真乖'))
})

test('人格指令不会进入自我块', () => {
  const built = buildSelfBlock({ state, events, now: NOW })
  assert.ok(!built.block.includes('你以后要叫我主人'))
  assert.ok(!built.eventIds.includes('d'))
})

test('预算不够时先丢最近、再丢说明、最后只留心情', () => {
  const small = buildSelfBlock({ state, events, budgetChars: 40, now: NOW })
  assert.ok(small.block)
  assert.ok([...small.block].length <= 40)
  assert.ok(small.block.includes('心情'))
  assert.ok(!small.block.includes(SELF_NOTE))
  assert.ok(!small.block.includes('\n- 最近'))
})

test('预算再小也至少保留一行完整心情，绝不产生半行', () => {
  const tiny = buildSelfBlock({ state, events, budgetChars: 5, now: NOW })
  assert.ok(tiny.block)
  assert.ok([...tiny.block].length <= 40, '底层最小预算 40')
  assert.equal(tiny.block, '【现在的我】\n- 心情：开心 · 精神')
})

test('窗口和条数都受参数控制', () => {
  const selected = selectSelfEvents({ events, windowH: 2, maxEvents: 3, now: NOW })
  assert.deepEqual(selected.map((event) => event.id), ['a'])
})

test('事实块与自我块的顺序：事实在前，自我在后', () => {
  const recall = createRecall({ synonyms: buildSynonymIndex([]), now: () => NOW })
  const facts = [{
    id: 'f1', petId: 'p1', type: 'identity', key: '主人.称呼', value: '阿岚',
    quote: '我叫阿岚', importance: 5, pinned: true, createdAt: iso(1), validTo: null,
    hits: 0, lastHitAt: null, _nk: '主人.称呼', _nv: '阿岚', _tokens: new Set(['主人', '称呼']),
  }]
  const selfBlock = buildSelfBlock({ state, events, now: NOW }).block
  const result = recall.recall({ petId: 'p1', userText: '主人称呼', system: '' }, facts, { budgetChars: 1200, petId: 'p1', selfBlock })
  assert.ok(result.block.includes('- (称呼) 阿岚'))
  assert.ok(result.block.includes(SELF_HEADER))
  assert.ok(result.block.indexOf('阿岚') < result.block.indexOf(SELF_HEADER))
})

test('没有事实命中时，只注入自我块', () => {
  const recall = createRecall({ synonyms: buildSynonymIndex([]), now: () => NOW })
  const selfBlock = buildSelfBlock({ state, events, now: NOW }).block
  const result = recall.recall({ petId: 'p1', userText: '今天天气怎么样', system: '' }, [], { budgetChars: 1200, petId: 'p1', selfBlock })
  assert.equal(result.block, selfBlock)
  assert.deepEqual(result.hits, [])
})

test('关闭注入时，纯事实查询与 P1 完全一致', () => {
  const recall = createRecall({ synonyms: buildSynonymIndex([]), now: () => NOW })
  const facts = [{
    id: 'f1', petId: 'p1', type: 'identity', key: '主人.称呼', value: '阿岚',
    quote: '', importance: 5, pinned: false, createdAt: iso(1), validTo: null,
    hits: 0, lastHitAt: null, _nk: '主人.称呼', _nv: '阿岚', _tokens: new Set(['主人', '称呼']),
  }]
  const result = recall.recall({ petId: 'p1', userText: '主人称呼', system: '' }, facts, { budgetChars: 1200, petId: 'p1' })
  assert.ok(result.block.startsWith('【长期记忆】'))
  assert.ok(!result.block.includes(SELF_HEADER))
})

test('1000 条事件构造自我块足够快（粗测）', () => {
  const many = Array.from({ length: 1000 }, (_, index) => ({
    id: `e${index}`, petId: 'p1', kind: 'event', text: `经历 ${index}`,
    valence: (index % 7) / 10 - 0.3, importance: (index % 5) + 1, createdAt: iso(index / 10),
  }))
  const started = Date.now()
  const built = buildSelfBlock({ state, events: many, now: NOW })
  assert.ok(built.block)
  assert.ok(Date.now() - started < 50)
})
