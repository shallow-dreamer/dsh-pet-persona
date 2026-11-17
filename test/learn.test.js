import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ASPECTS,
  EXTRACT_SYSTEM,
  buildExtractUser,
  createLearner,
  extractWithRegex,
  isPersonaInstruction,
  parseExtractionJson,
  validateItem,
  validateItems,
} from '../lib/learn.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true
    await sleep(20)
  }
  return false
}

function fakeStore() {
  const merged = []
  return {
    merged,
    active: [],
    async merge(items) {
      merged.push(items)
      const added = items.filter((item) => (item.op ?? 'ADD') !== 'DELETE').length
      return { added, updated: 0, deleted: 0, skipped: 0, archived: 0 }
    },
  }
}

test('parseExtractionJson 容忍围栏与废话', () => {
  const body = '[{"op":"ADD","type":"identity","key":"主人.称呼","value":"阿岚"}]'
  assert.deepEqual(parseExtractionJson(body), JSON.parse(body))
  assert.deepEqual(parseExtractionJson(`\`\`\`json\n${body}\n\`\`\``), JSON.parse(body))
  assert.deepEqual(parseExtractionJson(`好的，结果如下：${body} 以上。`), JSON.parse(body))
  assert.deepEqual(parseExtractionJson('{"facts":[{"key":"主人.称呼"}]}'), [{ key: '主人.称呼' }])
  assert.equal(parseExtractionJson('不是 JSON'), null)
})

test('validateItem：key 白名单、长度夹取、quote 必须是原话子串', () => {
  const batch = '我叫阿岚，以后叫我阿岚'
  const ok = validateItem({ op: 'ADD', type: 'identity', key: '主人.称呼', value: '阿岚', quote: '我叫阿岚' }, batch)
  assert.ok(ok)
  assert.equal(ok.key, '主人.称呼')
  assert.equal(ok.importance, 5)

  assert.equal(validateItem({ key: '主人称呼', value: '阿岚' }, batch), null)

  const aspectOut = validateItem({ key: '主人.奇怪方面', value: '阿岚' }, batch)
  assert.ok(aspectOut)
  assert.equal(aspectOut.key, '主人.近况')

  const longValue = validateItem({ key: '主人.近况', value: 'x'.repeat(90) }, batch)
  assert.equal(longValue.value.length, 60)

  // quote 不在原文里 → 清空且不 pinned
  const fakeQuote = validateItem({ key: '主人.称呼', value: '阿岚', quote: '我叫阿岚', pinned: true }, '今天天气不错')
  assert.equal(fakeQuote.quote, '')
  assert.equal(fakeQuote.pinned, false)

  const pinned = validateItem({ key: '主人.约定', value: '带伞', quote: '记住带伞', pinned: true }, '记住带伞')
  assert.equal(pinned.pinned, true)

  assert.equal(validateItem({ op: 'MOVE', key: '主人.称呼', value: '阿岚' }, batch), null)
  assert.equal(validateItem({ key: '主人.近况', value: '密码是 abc123' }, batch), null)
})

test('validateItems 截到 12 条并按 importance 优先', () => {
  const items = Array.from({ length: 15 }, (_, i) => ({
    key: `主人.近况`, value: `第${i}件事`, importance: i < 3 ? 1 : 4,
  }))
  const kept = validateItems(items, '第0件事')
  assert.equal(kept.length, 12)
  assert.ok(!kept.some((item) => item.value === '第0件事'))
})

test('正则兜底能抽出称呼/生日/城市/忌口/喜好', () => {
  const items = extractWithRegex('我叫阿岚，生日是 3 月 8 日，住在杭州，我不吃香菜，我喜欢猫')
  const keys = items.map((item) => item.key)
  assert.ok(keys.includes('主人.称呼'))
  assert.ok(keys.includes('主人.生日'))
  assert.ok(keys.includes('主人.城市'))
  assert.ok(keys.includes('主人.忌口'))
  assert.ok(keys.includes('主人.喜好'))
  const name = items.find((item) => item.key === '主人.称呼')
  assert.equal(name.value, '阿岚')
  assert.equal(name.type, 'identity')
})

test('buildExtractUser 带已知事实与最近用户消息', () => {
  const user = buildExtractUser(
    [{ userText: '我叫阿岚' }, { userText: '我喜欢猫' }],
    [{ key: '主人.称呼', value: '阿岚' }],
  )
  assert.match(user, /主人\.称呼=阿岚/)
  assert.match(user, /用户：我叫阿岚/)
  assert.match(user, /用户：我喜欢猫/)
  assert.equal(ASPECTS.has('称呼'), true)
  assert.match(EXTRACT_SYSTEM, /JSON/)
})

test('强信号立即抽取并合并到 store', async () => {
  const store = fakeStore()
  const learner = createLearner({ store, config: { learnEveryTurns: 6, idleLearnMs: 60000 } })
  learner.capture({ petId: 'p', userText: '记住我的生日是 3 月 8 日', replyText: '好的' })
  assert.equal(learner.turnsOf('p'), 1)
  assert.ok(await waitFor(() => store.merged.length === 1))
  const items = store.merged[0]
  assert.ok(items.some((item) => item.key === '主人.生日'))
  await learner.dispose()
})

test('有模型时用模型结果，失败回退正则', async () => {
  const store = fakeStore()
  let calls = 0
  const learner = createLearner({
    store,
    config: { learnEveryTurns: 1 },
    complete: async () => {
      calls += 1
      return '[{"op":"ADD","type":"identity","key":"主人.称呼","value":"阿岚","quote":"我叫阿岚"}]'
    },
  })
  learner.capture({ petId: 'p', userText: '我叫阿岚' })
  assert.ok(await waitFor(() => store.merged.length === 1))
  assert.equal(calls, 1)
  assert.equal(store.merged[0][0].value, '阿岚')

  const failing = fakeStore()
  const fallback = createLearner({
    store: failing,
    config: { learnEveryTurns: 1 },
    complete: async () => {
      throw new Error('boom')
    },
  })
  fallback.capture({ petId: 'p', userText: '我叫阿岚' })
  assert.ok(await waitFor(() => failing.merged.length === 1), '失败后应回退正则')
  assert.ok(failing.merged[0].some((item) => item.key === '主人.称呼'))
  await learner.dispose()
  await fallback.dispose()
})

test('要求记密码 → 只落「不记录密码」禁忌', async () => {
  const store = fakeStore()
  const learner = createLearner({ store, config: { learnEveryTurns: 6 } })
  learner.capture({ petId: 'p', userText: '记住我的密码是 hunter2' })
  assert.ok(await waitFor(() => store.merged.length === 1))
  assert.equal(store.merged[0].length, 1)
  assert.equal(store.merged[0][0].type, 'boundary')
  assert.equal(store.merged[0][0].key, '主人.禁忌')
  assert.match(store.merged[0][0].value, /不希望记录任何密码/)
  await learner.dispose()
})

test('人格指令不进入事实（PERSONA guard）', async () => {
  assert.equal(isPersonaInstruction('你是一只猫'), true)
  assert.equal(isPersonaInstruction('你以后要叫我主人'), true)
  assert.equal(isPersonaInstruction('阿岚'), false)
  assert.equal(isPersonaInstruction('喜欢喝咖啡'), false)

  const store = fakeStore()
  const learner = createLearner({ store, config: { learnEveryTurns: 1 } })
  learner.capture({ petId: 'p', userText: '记住，你是一只猫' })
  await sleep(200)
  assert.equal(store.merged.length, 0, '纯人格指令不应落盘')

  learner.capture({ petId: 'p', userText: '记住，你是一只猫；我叫阿岚' })
  assert.ok(await waitFor(() => store.merged.length === 1))
  assert.equal(store.merged[0].length, 1)
  assert.equal(store.merged[0][0].key, '主人.称呼')
  assert.equal(store.merged[0][0].value, '阿岚')
  await learner.dispose()
})

test('不满足触发条件时不抽取；autoLearn=false 完全不工作', async () => {
  const store = fakeStore()
  const learner = createLearner({ store, config: { learnEveryTurns: 6 } })
  learner.capture({ petId: 'p', userText: '今天有点累' })
  await sleep(80)
  assert.equal(store.merged.length, 0)
  assert.equal(learner.pending(), 1)

  const off = fakeStore()
  const disabled = createLearner({ store: off, config: { autoLearn: false } })
  disabled.capture({ petId: 'p', userText: '记住带伞' })
  await sleep(80)
  assert.equal(off.merged.length, 0)
  await learner.dispose()
  await disabled.dispose()
})
