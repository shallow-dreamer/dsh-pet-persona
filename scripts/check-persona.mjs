#!/usr/bin/env node
/**
 * 人格安全检查（离线、只读、不碰真实数据）：
 * 1) 注入块只有两行 header + 「- (标签) 事实」行，没有针对桌宠的角色指令；
 * 2) 宿主 system = base + "\n\n" + 块，base 逐字保留、永不被截断；
 * 3) 块头保留了「冲突时以上面的设定为准」，人格优先级不被记忆覆盖；
 * 4) 预算塞满时只丢弃事实，不截断事实、不动 base。
 *
 *   node scripts/check-persona.mjs
 */
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FactStore } from '../lib/facts.js'
import { HEADER_LINES, createRecall } from '../lib/recall.js'
import { loadSynonymIndex } from '../lib/synonyms.js'
import { charLength } from '../lib/util.js'

const noop = { debug() {}, info() {}, warn() {}, error() {}, flush() {}, dispose() {} }
const BASE = '你叫小满，是一只住在窗台的猫。说话短、爱用「喵」，不要自称助手。'
const PERSONA_WORDS = /你是|你叫|你应该|你必须|扮演|人格|人设|口癖|语气设定|角色设定|性格设定/
let failed = 0

function check(name, fn) {
  try {
    fn()
    console.log(`PASS ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL ${name}: ${error.message}`)
  }
}

const dir = await mkdtemp(join(tmpdir(), 'persona-guard-'))
const store = new FactStore({ dir, maxFacts: 500, log: noop })
store.initSync()

const facts = [
  { type: 'identity', key: '主人.称呼', value: '阿岚', quote: '我叫阿岚', importance: 5, pinned: true },
  { type: 'preference', key: '主人.喜好', value: '喜欢喝咖啡', quote: '我喜欢喝咖啡', importance: 3 },
  { type: 'routine', key: '主人.作息', value: '晚上十二点睡', quote: '我十二点睡', importance: 3 },
  { type: 'relation', key: '主人.关系', value: '阿岚是室友', quote: '阿岚是我室友', importance: 3 },
  { type: 'event', key: '主人.约定', value: '周末一起看电影', quote: '周末一起看电影', importance: 4, pinned: true },
  { type: 'boundary', key: '主人.禁忌', value: '不要提体重', quote: '别忘了我讨厌提体重', importance: 5, pinned: true },
]
await store.merge(facts, { petId: 'default' })

const engine = createRecall({ synonyms: loadSynonymIndex(noop), log: noop })
const result = engine.recall(
  { petId: 'default', system: BASE, history: [], userText: '我叫什么名字，你还记得我的喜好吗' },
  store.active,
  { budgetChars: 1200, petId: 'default' },
)

const block = result.block ?? ''
const lines = block.split('\n')
const factLines = lines.slice(2)

check('注入块以【长期记忆】开头，且只有两行 header', () => {
  assert.ok(block.startsWith('【长期记忆】'), '块头缺失')
  assert.equal(lines.length >= 3, true)
  assert.ok(block.includes(HEADER_LINES[1]), '缺少冲突优先级说明')
})

check('事实行格式固定，不含自由文本指令', () => {
  assert.ok(factLines.length > 0, '没有召回任何事实')
  for (const line of factLines) {
    assert.match(line, /^- \((称呼|偏好|习惯|关系|约定|禁忌)\) .+( ★)?$/, `非法行: ${line}`)
  }
})

check('事实行里没有针对桌宠的角色/人格指令', () => {
  for (const line of factLines) {
    assert.doesNotMatch(line, PERSONA_WORDS, `疑似人格注入: ${line}`)
  }
})

check('块头声明冲突时人格设定优先', () => {
  assert.ok(block.includes('以上面的设定为准'), '缺少优先级声明')
  assert.ok(block.includes('宠物名字'), '缺少宠物名字优先声明')
})

check('system = base + 空行 + 块，base 逐字保留', () => {
  const system = `${BASE}\n\n${block}`
  assert.ok(system.startsWith(BASE), 'base 被改写')
  assert.equal(system.slice(0, BASE.length), BASE)
  assert.ok(system.endsWith(block), '块不在尾部')
  assert.equal(system.length, BASE.length + 2 + block.length)
})

check('无关问题不注入普通事实（pinned 禁忌按设计强制注入）', () => {
  const none = engine.recall(
    { petId: 'default', system: BASE, history: [], userText: '今天天气怎么样' },
    store.active,
    { budgetChars: 1200, petId: 'default' },
  )
  if (none.block === undefined) return
  for (const line of none.block.split('\n').slice(2)) {
    assert.match(line, /^- \(禁忌\) /, `无关问题不该注入: ${line}`)
  }
})

// 预算压力：60 条都相关，只能装下一部分，但不得截断、不得动 base
const dir2 = await mkdtemp(join(tmpdir(), 'persona-guard-budget-'))
const store2 = new FactStore({ dir: dir2, maxFacts: 500, log: noop })
store2.initSync()
const many = Array.from({ length: 60 }, (_, i) => ({
  type: 'event',
  key: `主人.条目${i}`,
  value: `记忆条目${i}号`.padEnd(28, '。'),
  quote: '',
  importance: 3,
}))
await store2.merge(many, { petId: 'default' })
const tight = createRecall({ synonyms: loadSynonymIndex(noop), log: noop })
const squeezed = tight.recall(
  { petId: 'default', system: BASE, history: [], userText: '记忆条目' },
  store2.active,
  { budgetChars: 400, petId: 'default' },
)

check('预算压力下块 ≤ budget，且只断行不截断、base 完整', () => {
  assert.ok(squeezed.block, '应至少装下一条')
  assert.ok(charLength(squeezed.block) <= 400, `块 ${charLength(squeezed.block)} > 400`)
  const last = squeezed.block.split('\n').at(-1)
  assert.match(last, /^- \(约定\) 记忆条目\d+号。+( ★)?$/, `最后一行被截断: ${last}`)
  assert.ok(`${BASE}\n\n${squeezed.block}`.startsWith(BASE))
})

console.log(failed === 0 ? '\n# 人格安全检查全部通过' : `\n# ${failed} 项失败`)
if (failed > 0) process.exitCode = 1
