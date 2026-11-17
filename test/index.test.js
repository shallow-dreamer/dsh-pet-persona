import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply, normalizeConfig, resolveDataDir } from '../index.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(predicate, timeoutMs = 3000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await predicate()) return true
    await sleep(25)
  }
  return false
}

function fakePetApi() {
  const state = { def: null, registerCalls: 0 }
  return {
    state,
    memory: {
      register(def) {
        state.def = def
        state.registerCalls += 1
        return () => {
          if (state.def === def) state.def = null
        }
      },
      list() {
        return { builtin: ['native'], external: state.def ? [state.def.id] : [] }
      },
    },
  }
}

function fakeCtx(petApi) {
  const effects = []
  return {
    effects,
    get(key) {
      if (key === 'petApi7340') return petApi
      return undefined
    },
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    effect(fn) {
      const undo = fn()
      effects.push(undo)
      return () => undo?.()
    },
  }
}

async function withHome(fn) {
  const home = await mkdtemp(join(tmpdir(), 'persona-home-'))
  const prev = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
  }
}

async function readFacts(home) {
  try {
    const text = await readFile(join(home, 'pet-persona', 'facts.jsonl'), 'utf8')
    return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

test('配置归一：坏值回落、数值夹取、debug 钩子', () => {
  const config = normalizeConfig({ budgetChars: 99999, learnEveryTurns: 0, maxFacts: -1, enabled: false })
  assert.equal(config.enabled, false)
  assert.equal(config.budgetChars, 8000)
  assert.equal(config.learnEveryTurns, 1)
  assert.equal(config.maxFacts, 20)
  assert.equal(normalizeConfig({}).budgetChars, 1200)
  assert.equal(normalizeConfig({ debugRecallDelayMs: 800 }).debugRecallDelayMs, 800)
})

test('数据目录跟随 DSH_HOME', () => {
  assert.equal(resolveDataDir({ DSH_HOME: 'C:/dsh-home' }).replace(/\\/g, '/').endsWith('/pet-persona'), true)
  assert.match(resolveDataDir({}).replace(/\\/g, '/'), /\/\.dsh\/pet-persona$/)
})

test('注册 provider → 抽取 → 注入 system → 卸载回原生', async () => {
  await withHome(async (home) => {
    const petApi = fakePetApi()
    const ctx = fakeCtx(petApi)
    const dispose = apply(ctx, { learnEveryTurns: 6, idleLearnMs: 60000 })
    assert.equal(petApi.state.registerCalls, 1)
    assert.deepEqual(petApi.memory.list(), { builtin: ['native'], external: ['dsh-pet-persona'] })

    // 首次启动就应该有空的 facts.jsonl
    assert.equal(await readFile(join(home, 'pet-persona', 'facts.jsonl'), 'utf8'), '')

    petApi.state.def.capture({ petId: 'pet', userText: '记住：我叫阿岚，以后叫我阿岚', replyText: '好' })
    const learned = await waitFor(async () => (await readFacts(home)).some((row) => row.value === '阿岚'))
    assert.ok(learned, '强信号应触发抽取并落盘')

    const out = petApi.state.def.recall({
      petId: 'pet',
      system: '你是一只猫娘桌宠。',
      history: [],
      userText: '你还记得我叫什么名字吗',
    })
    assert.ok(out && typeof out.system === 'string')
    assert.ok(out.system.startsWith('你是一只猫娘桌宠。\n\n【长期记忆】'))
    assert.match(out.system, /- \(称呼\) 阿岚/)
    assert.ok(out.system.indexOf('【长期记忆】') > out.system.indexOf('你是一只猫娘桌宠。'))

    // 无关闲聊：不修改 system
    const idle = petApi.state.def.recall({ petId: 'pet', system: '你是桌宠。', history: [], userText: '今天天气怎么样' })
    assert.equal(idle, undefined)

    // 换宠物不串味
    const other = petApi.state.def.recall({ petId: 'other', system: '你是桌宠。', userText: '我叫什么名字' })
    assert.equal(other, undefined)

    dispose()
    dispose() // 幂等
    assert.equal(petApi.state.def, null)
    assert.deepEqual(petApi.memory.list(), { builtin: ['native'], external: [] })
  })
})

test('重启后（新进程/新 apply）仍记得事实', async () => {
  await withHome(async (home) => {
    const petApi1 = fakePetApi()
    const dispose1 = apply(fakeCtx(petApi1), {})
    petApi1.state.def.capture({ petId: 'pet', userText: '记住：我叫阿岚', replyText: '好' })
    assert.ok(await waitFor(async () => (await readFacts(home)).some((row) => row.value === '阿岚')))
    dispose1()
    await sleep(50)

    const petApi2 = fakePetApi()
    const dispose2 = apply(fakeCtx(petApi2), {})
    const out = petApi2.state.def.recall({ petId: 'pet', system: 'BASE', history: [], userText: '你还记得我叫什么名字吗' })
    assert.ok(out)
    assert.match(out.system, /阿岚/)
    dispose2()
  })
})

test('recall 抛错不影响回复（返回 undefined）', async () => {
  await withHome(async () => {
    const petApi = fakePetApi()
    const dispose = apply(fakeCtx(petApi), { debugRecallThrow: true })
    const out = petApi.state.def.recall({ petId: 'pet', system: 'BASE', userText: '我叫什么名字' })
    assert.equal(out, undefined)
    dispose()
  })
})

test('recall 超过 400ms 软截止 → undefined（同步忙等模拟）', async () => {
  await withHome(async () => {
    const petApi = fakePetApi()
    const dispose = apply(fakeCtx(petApi), { debugRecallDelayMs: 600 })
    const started = Date.now()
    const out = petApi.state.def.recall({ petId: 'pet', system: 'BASE', userText: '我叫什么名字' })
    assert.equal(out, undefined)
    assert.ok(Date.now() - started >= 590)
    dispose()
  })
})

test('enabled=false 不注册；没有 petApi 也不抛异常', async () => {
  await withHome(async () => {
    const petApi = fakePetApi()
    const dispose = apply(fakeCtx(petApi), { enabled: false })
    assert.equal(petApi.state.registerCalls, 0)
    assert.equal(typeof dispose, 'undefined')

    const ctx = fakeCtx(null)
    assert.doesNotThrow(() => apply(ctx, {}))
  })
})

test('预算生效：注入块不超过 budgetChars', async () => {
  await withHome(async (home) => {
    const petApi = fakePetApi()
    const dispose = apply(fakeCtx(petApi), { budgetChars: 160 })
    for (const name of ['阿岚', '小岚']) {
      petApi.state.def.capture({ petId: 'pet', userText: `记住：以后叫我${name}`, replyText: '好' })
    }
    await waitFor(async () => (await readFacts(home)).length >= 1)
    const out = petApi.state.def.recall({ petId: 'pet', system: 'BASE', userText: '我叫什么名字' })
    if (out) {
      const block = out.system.slice('BASE\n\n'.length)
      assert.ok([...block].length <= 160, `block=${[...block].length}`)
      assert.ok(block.includes('【长期记忆】'))
    }
    dispose()
  })
})
