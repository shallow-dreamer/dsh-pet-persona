import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { normalizeConfig } from '../lib/config.js'
import { readPersona, stripJsonc, parseJsonc } from '../lib/persona.js'
import {
  createApiHandler,
  mergeSettingsBody,
  publicConfig,
  readSettings,
  tailActivity,
  writeSettings,
} from '../lib/ui.js'

function tempHome() {
  const home = mkdtempSync(join(tmpdir(), 'persona-ui-'))
  mkdirSync(join(home, 'pet-persona'), { recursive: true })
  return home
}

const FACT = {
  v: 1,
  id: 'f_1',
  petId: 'main',
  type: 'identity',
  key: '主人.称呼',
  value: '阿岚',
  quote: '我叫阿岚',
  importance: 5,
  pinned: true,
  createdAt: '2026-11-01T00:00:00.000Z',
  hits: 2,
  hash: 'abcd',
}

test('stripJsonc 去注释但保留字符串里的 // 与 /* */', () => {
  const text = `{
    // 行注释
    "a": "http://x/*y*/z", /* 块注释 */
    "b": "ok\\"//"
  }`
  const out = stripJsonc(text)
  assert.equal(out.includes('行注释'), false)
  assert.equal(out.includes('块注释'), false)
  assert.equal(out.includes('http://x/*y*/z'), true)
  assert.deepEqual(JSON.parse(out), { a: 'http://x/*y*/z', b: 'ok"//' })
  assert.equal(parseJsonc('{ bad'), null)
})

test('readPersona 优先用户层 whisperPrompt，并合并宠物名', () => {
  const home = tempHome()
  const dataDir = join(home, 'pet-persona')
  mkdirSync(join(home, 'dsh-pet'), { recursive: true })
  writeFileSync(
    join(home, 'dsh-pet', 'main-config.jsonc'),
    `{ "pets": [ { "id": "main", "name": "小鲸鱼", "whisperPrompt": "你是窗台的小鲸鱼，说话短。" } ] }`,
    'utf8',
  )
  const persona = readPersona({ dataDir, env: {} })
  assert.equal(persona.available, true)
  assert.equal(persona.text, '你是窗台的小鲸鱼，说话短。')
  assert.equal(persona.petName, '小鲸鱼')
  assert.equal(persona.source, 'pet')
  rmSync(home, { recursive: true, force: true })
})

test('readPersona 没有用户层时回落 dsh-pet 默认配置', () => {
  const home = tempHome()
  const dataDir = join(home, 'pet-persona')
  const defaults = join(home, 'default.jsonc')
  writeFileSync(defaults, `{ "pets": [ { "id": "main", "name": "猫猫", "whisperPrompt": "你是猫猫。" } ] }`, 'utf8')
  const persona = readPersona({ dataDir, env: { DSH_PET_DEFAULT_CONFIG: defaults } })
  assert.equal(persona.available, true)
  assert.equal(persona.text, '你是猫猫。')
  assert.equal(persona.petName, '猫猫')
  assert.equal(persona.source, 'default')
  rmSync(home, { recursive: true, force: true })
})

test('readPersona 读不到时 available=false 且不抛错', () => {
  const home = tempHome()
  const persona = readPersona({ dataDir: join(home, 'pet-persona'), env: { DSH_PET_DEFAULT_CONFIG: join(home, 'nope.jsonc') } })
  assert.equal(persona.available, false)
  assert.equal(persona.source, 'none')
  rmSync(home, { recursive: true, force: true })
})

test('mergeSettingsBody 只接受白名单并夹取范围', () => {
  const current = normalizeConfig({})
  const next = mergeSettingsBody(current, {
    budgetChars: 99999,
    learnEveryTurns: 0,
    idleLearnMs: 1,
    maxFacts: 3,
    autoLearn: false,
    model: '  deepseek-chat ',
    provider: 'deepseek',
    enabled: false,
    debugRecallThrow: true,
    evil: 1,
  })
  assert.equal(next.budgetChars, 8000)
  assert.equal(next.learnEveryTurns, 1)
  assert.equal(next.idleLearnMs, 5000)
  assert.equal(next.maxFacts, 20)
  assert.equal(next.autoLearn, false)
  assert.equal(next.model, 'deepseek-chat')
  assert.equal(next.provider, 'deepseek')
  assert.equal(next.enabled, true, 'enabled 是插件开关，不允许从设置页关掉')
  assert.equal(next.debugRecallThrow, false)
})

test('settings.json 原子写入后可读回', () => {
  const home = tempHome()
  const dir = join(home, 'pet-persona')
  writeSettings(dir, { budgetChars: 900 })
  assert.deepEqual(readSettings(dir), { budgetChars: 900 })
  writeSettings(dir, { budgetChars: 1000 })
  assert.deepEqual(readSettings(dir), { budgetChars: 1000 })
  assert.deepEqual(publicConfig(normalizeConfig({ budgetChars: 900 })), {
    enabled: true,
    budgetChars: 900,
    autoLearn: true,
    learnEveryTurns: 6,
    idleLearnMs: 60000,
    maxFacts: 500,
    model: '',
    provider: '',
    voiceEnabled: false,
    voiceWakeWord: '',
    voiceRequire: true,
    voiceThreshold: 0.8,
    voiceLanguage: 'zh',
    voiceKeepTranscript: true,
    ttsEmotion: false,
    ttsEmotionIntensity: 1,
    selfEnabled: true,
    selfMaxEntries: 500,
    selfInject: false,
    selfBudget: 160,
    selfInjectMaxEvents: 3,
    selfInjectWindowH: 36,
    selfInjectQuotes: false,
    energyEnabled: true,
    energyStart: 100,
    energyDrainPerHour: 6,
    energyRecoverPerHour: 36,
    energySleepAt: 20,
    energyWakeAt: 100,
    energyWakePenalty: 5,
    agencyEnabled: true,
    agencyMaxPending: 20,
    agencyNoteMaxChars: 200,
  })
  rmSync(home, { recursive: true, force: true })
})

test('tailActivity 只保留关键事件并倒序', () => {
  const home = tempHome()
  const dir = join(home, 'pet-persona')
  writeFileSync(
    join(dir, 'persona.log'),
    [
      '2026-11-01 10:00:00 [info] memory_registered id=dsh-pet-persona',
      '2026-11-01 10:00:01 [debug] capture_received x',
      '2026-11-01 10:00:02 [info] learn_merged added=1',
      '2026-11-01 10:00:03 [warn] persona_skip count=1',
    ].join('\n'),
    'utf8',
  )
  const lines = tailActivity(dir, 5)
  assert.equal(lines.length, 3)
  assert.match(lines[0], /persona_skip/)
  assert.match(lines[2], /memory_registered/)
  rmSync(home, { recursive: true, force: true })
})

function mockResponse() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      this.headers[key] = value
    },
    end(body) {
      this.body = body ?? ''
    },
  }
}

function setupApi() {
  const home = tempHome()
  const dir = join(home, 'pet-persona')
  const store = {
    rows: [FACT, { ...FACT, id: 'f_2', validTo: '2026-11-02T00:00:00.000Z' }],
    active: [FACT],
    stats: () => ({ rows: 2, active: 1, archived: 1, keys: 1, readOnly: false, loaded: true }),
  }
  const recallEngine = {
    recall: () => ({ block: '【长期记忆】\n以下是事实', hits: ['f_1'], elapsedMs: 2 }),
  }
  const applied = []
  const api = createApiHandler({
    config: normalizeConfig({ budgetChars: 1200 }),
    store,
    recallEngine,
    logger: { warn: () => {}, info: () => {} },
    petApi: { memory: { list: () => ({ builtin: ['native'], external: ['dsh-pet-persona'] }) } },
    dir,
    applySettings: (next) => {
      applied.push(next)
      return next
    },
  })
  return { api, dir, applied, home }
}

test('GET /overview 返回统计、provider 与配置', async () => {
  const { api, home } = setupApi()
  const res = mockResponse()
  await api.handler({ method: 'GET', url: '/pet-persona/api/overview' }, res, () => {})
  const body = JSON.parse(res.body)
  assert.equal(res.statusCode, 200)
  assert.equal(body.stats.active, 1)
  assert.deepEqual(body.provider.external, ['dsh-pet-persona'])
  assert.equal(body.config.budgetChars, 1200)
  rmSync(home, { recursive: true, force: true })
})

test('GET /facts 默认过滤归档，archived=1 时带回', async () => {
  const { api, home } = setupApi()
  const res = mockResponse()
  await api.handler({ method: 'GET', url: '/pet-persona/api/facts' }, res, () => {})
  assert.equal(JSON.parse(res.body).facts.length, 1)

  const res2 = mockResponse()
  await api.handler({ method: 'GET', url: '/pet-persona/api/facts?archived=1' }, res2, () => {})
  const facts = JSON.parse(res2.body).facts
  assert.equal(facts.length, 2)
  assert.equal(facts[0].status, 'active')
  assert.equal(facts[1].status, 'archived')
  rmSync(home, { recursive: true, force: true })
})

test('POST /preview 返回 base + 空行 + 记忆块，且不写盘', async () => {
  const { api, home } = setupApi()
  const req = Readable.from([Buffer.from(JSON.stringify({ query: '我是谁？', system: 'BASE' }))])
  req.method = 'POST'
  req.url = '/pet-persona/api/preview'
  const res = mockResponse()
  await api.handler(req, res, () => {})
  const body = JSON.parse(res.body)
  assert.equal(body.ok, true)
  assert.equal(body.system, 'BASE\n\n【长期记忆】\n以下是事实')
  assert.equal(body.hits.length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('POST /settings 走 applySettings 并返回归一后的配置', async () => {
  const { api, applied, home } = setupApi()
  const req = Readable.from([Buffer.from(JSON.stringify({ budgetChars: 2000, learnEveryTurns: 3 }))])
  req.method = 'POST'
  req.url = '/pet-persona/api/settings'
  const res = mockResponse()
  await api.handler(req, res, () => {})
  const body = JSON.parse(res.body)
  assert.equal(body.config.budgetChars, 2000)
  assert.equal(body.config.learnEveryTurns, 3)
  assert.equal(applied.length, 1)
  rmSync(home, { recursive: true, force: true })
})

test('API 非本前缀交给 next，坏 JSON 返回 500 而不是崩宿主', async () => {
  const { api, home } = setupApi()
  let called = false
  await api.handler({ method: 'GET', url: '/other' }, mockResponse(), () => {
    called = true
  })
  assert.equal(called, true)

  const req = Readable.from([Buffer.from('{bad')])
  req.method = 'POST'
  req.url = '/pet-persona/api/settings'
  const res = mockResponse()
  await api.handler(req, res, () => {})
  assert.equal(res.statusCode, 500)
  rmSync(home, { recursive: true, force: true })
})

function voiceApi(voice) {
  const home = tempHome()
  const dir = join(home, 'pet-persona')
  const api = createApiHandler({
    config: normalizeConfig({}),
    store: { rows: [], active: [], stats: () => ({}) },
    recallEngine: { recall: () => undefined },
    logger: { warn: () => {}, info: () => {} },
    petApi: null,
    dir,
    applySettings: (next) => next,
    voice,
  })
  return { api, home }
}

test('GET /voice/status 与 POST /voice/utterance 转发到语音服务', async () => {
  const calls = []
  const voice = {
    status: () => ({ enabled: true, enrolled: true, wakeWord: '小鲸鱼' }),
    events: (limit) => [{ accepted: true, limit }],
    enroll: async () => ({ samples: 3 }),
    verify: async () => ({ match: true }),
    utterance: async (body) => {
      calls.push(body)
      return { accepted: true, text: '嗨' }
    },
    reset: async () => ({ ok: true }),
  }
  const { api, home } = voiceApi(voice)
  const res = mockResponse()
  await api.handler({ method: 'GET', url: '/pet-persona/api/voice/status' }, res, () => {})
  assert.equal(res.statusCode, 200)
  assert.match(res.body, /小鲸鱼/)

  const req = Readable.from([Buffer.from(JSON.stringify({ audio: 'AAAA', mode: 'push' }))])
  req.method = 'POST'
  req.url = '/pet-persona/api/voice/utterance'
  const res2 = mockResponse()
  await api.handler(req, res2, () => {})
  assert.equal(res2.statusCode, 200)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].mode, 'push')
  rmSync(home, { recursive: true, force: true })
})

test('没有语音服务时 /voice 路由返回 503 而不是崩宿主', async () => {
  const { api, home } = voiceApi(null)
  const res = mockResponse()
  await api.handler({ method: 'GET', url: '/pet-persona/api/voice/status' }, res, () => {})
  assert.equal(res.statusCode, 503)
  rmSync(home, { recursive: true, force: true })
})
