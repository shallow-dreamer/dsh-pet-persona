import assert from 'node:assert/strict'
import test from 'node:test'
import { HEADER_LINES, LABELS, createRecall } from '../lib/recall.js'
import { buildSynonymIndex, charLength, tokensOf } from '../lib/util.js'

const NOW = Date.now()

function fact(patch) {
  const row = {
    id: patch.id ?? `f_${Math.random().toString(16).slice(2)}`,
    petId: patch.petId ?? 'p',
    type: patch.type ?? 'preference',
    key: patch.key ?? '主人.喜好',
    value: patch.value ?? '喜欢猫',
    quote: patch.quote ?? '',
    importance: patch.importance ?? 3,
    pinned: patch.pinned ?? false,
    createdAt: patch.createdAt ?? new Date(NOW).toISOString(),
    validTo: patch.validTo ?? null,
    hits: patch.hits ?? 0,
    ...patch,
  }
  row._nk = row.key
  row._tokens = tokensOf(row.value)
  row._createdMs = Date.parse(row.createdAt)
  return row
}

const engine = () => createRecall({ synonyms: buildSynonymIndex({ 称呼: ['名字', '叫我'] }) })

test('命名问句通过同义词命中 identity 事实', () => {
  const r = engine()
  const facts = [fact({ type: 'identity', key: '主人.称呼', value: '阿岚', importance: 5 })]
  const result = r.recall({ petId: 'p', system: 'BASE', history: [], userText: '你还记得我叫什么名字吗' }, facts)
  assert.ok(result.block)
  assert.equal(result.block.split('\n')[0], HEADER_LINES[0])
  assert.equal(result.block.split('\n')[1], HEADER_LINES[1])
  assert.match(result.block, /- \(称呼\) 阿岚/)
  assert.deepEqual(result.hits, [facts[0].id])
})

test('无关闲聊 / 单字查询 / 无事实都不注入', () => {
  const r = engine()
  const facts = [fact({ value: '喜欢猫', key: '主人.喜好' })]
  assert.equal(r.recall({ petId: 'p', userText: '今天天气怎么样' }, facts).block, undefined)
  assert.equal(r.recall({ petId: 'p', userText: '猫' }, facts).block, undefined)
  assert.equal(r.recall({ petId: 'p', userText: '我喜欢什么' }, []).block, undefined)
})

test('petId 隔离：别的宠物的事实不串味', () => {
  const r = engine()
  const facts = [fact({ petId: 'other', type: 'identity', key: '主人.称呼', value: '阿岚', importance: 5 })]
  const result = r.recall({ petId: 'p', userText: '我叫什么名字' }, facts)
  assert.equal(result.block, undefined)
})

test('boundary+pinned 不依赖相关度直接进预算，且最多 2 条', () => {
  const r = engine()
  const facts = [
    fact({ type: 'boundary', key: '主人.禁忌1', value: '不要提跳槽', pinned: true, importance: 5 }),
    fact({ type: 'boundary', key: '主人.禁忌2', value: '不要聊前任', pinned: true, importance: 5 }),
    fact({ type: 'boundary', key: '主人.禁忌3', value: '不要碰尾巴', pinned: true, importance: 5 }),
  ]
  const result = r.recall({ petId: 'p', userText: '今天天气怎么样' }, facts)
  assert.ok(result.block)
  assert.equal(result.hits.length, 2)
  assert.ok(result.block.includes('不要提跳槽'))
  assert.ok(result.block.includes('不要聊前任'))
  assert.ok(!result.block.includes('不要碰尾巴'))
})

test('预算：整块不超过 budgetChars，装不下就 break 不截断', () => {
  const r = engine()
  const facts = Array.from({ length: 8 }, (_, i) =>
    fact({ key: `主人.喜好${i}`, value: `喜欢${i}号很长很长的描述文本`, importance: 5 }),
  )
  const query = '我喜欢什么'
  for (const budget of [150, 220, 400, 1200]) {
    const result = r.recall({ petId: 'p', userText: query }, facts, { budgetChars: budget })
    if (result.block) {
      assert.ok(charLength(result.block) <= budget, `budget=${budget} len=${charLength(result.block)}`)
      for (const line of result.block.split('\n').slice(2)) {
        assert.ok(line.startsWith('- ('), '不能出现半截事实')
        assert.match(line, /很长很长的描述文本( ★)?$/)
      }
    }
  }
  // 预算小到 header 都放不下 → undefined
  assert.equal(r.recall({ petId: 'p', userText: query }, facts, { budgetChars: 100 }).block, undefined)
})

test('同 key 只出现一次；pinned 带 ★；LRU 命中同块', () => {
  const r = engine()
  const sameKey = [
    fact({ id: 'f1', key: '主人.喜好', value: '喜欢猫', importance: 5 }),
    fact({ id: 'f2', key: '主人.喜好', value: '喜欢狗', importance: 5 }),
  ]
  const first = r.recall({ petId: 'p', userText: '我喜欢什么' }, sameKey)
  assert.ok(first.block)
  assert.equal(first.block.split('\n').length, 3)
  const again = r.recall({ petId: 'p', userText: '我喜欢什么' }, sameKey)
  assert.equal(again.block, first.block)

  const pinned = [fact({ key: '主人.喜好', value: '喜欢猫', importance: 5, pinned: true })]
  const result = r.recall({ petId: 'p', userText: '我喜欢什么' }, pinned)
  assert.match(result.block, /喜欢猫 ★$/)
})

test('标签映射齐全', () => {
  assert.equal(LABELS.identity, '称呼')
  assert.equal(LABELS.preference, '偏好')
  assert.equal(LABELS.routine, '习惯')
  assert.equal(LABELS.relation, '关系')
  assert.equal(LABELS.event, '约定')
  assert.equal(LABELS.boundary, '禁忌')
})
