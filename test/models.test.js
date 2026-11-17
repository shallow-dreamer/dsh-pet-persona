import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createModelCatalog } from '../lib/models.js'
import { normalizeModelSelection, readPetModel } from '../lib/persona.js'
import { createLlmComplete } from '../lib/llm.js'

function makeHome({ userKey = 'chatModel', userValue = null, defaultsValue = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'persona-model-'))
  const dataDir = join(home, 'pet-persona')
  mkdirSync(dataDir, { recursive: true })
  const userFile = join(home, 'dsh-pet', 'main-config.jsonc')
  mkdirSync(join(home, 'dsh-pet'), { recursive: true })
  const user = {
    pets: [{ id: 'main', name: '小鲸鱼', ...(userValue ? { [userKey]: userValue } : {}) }],
    ...(userKey === 'top' ? { chatModel: userValue } : {}),
  }
  writeFileSync(userFile, JSON.stringify(user), 'utf8')
  const defaultsFile = join(home, 'defaults.jsonc')
  writeFileSync(defaultsFile, JSON.stringify(defaultsValue ?? { pets: [{ id: 'main', name: '小鲸鱼' }] }), 'utf8')
  return { home, dataDir, defaultsFile }
}

test('normalizeModelSelection 只接受 provider/model 都非空', () => {
  assert.deepEqual(normalizeModelSelection({ provider: ' p ', model: ' m ' }), { provider: 'p', model: 'm' })
  assert.equal(normalizeModelSelection({ provider: 'p', model: '' }), null)
  assert.equal(normalizeModelSelection({ provider: '', model: 'm' }), null)
  assert.equal(normalizeModelSelection(null), null)
})

test('readPetModel：条目级 chatModel 优先', () => {
  const { dataDir, defaultsFile } = makeHome({ userValue: { provider: 'deepseek', model: 'deepseek-chat' } })
  const result = readPetModel({ dataDir, env: { DSH_PET_DEFAULT_CONFIG: defaultsFile } })
  assert.equal(result.provider, 'deepseek')
  assert.equal(result.model, 'deepseek-chat')
  assert.equal(result.source, 'pet')
  rmSync(join(dataDir, '..'), { recursive: true, force: true })
})

test('readPetModel：空对象继续下探到顶层用户配置', () => {
  const { dataDir, defaultsFile } = makeHome()
  const userFile = join(dataDir, '..', 'dsh-pet', 'main-config.jsonc')
  writeFileSync(userFile, JSON.stringify({ pets: [{ id: 'main', chatModel: { provider: '', model: '' } }], chatModel: { provider: 'p', model: 'm' } }), 'utf8')
  const result = readPetModel({ dataDir, env: { DSH_PET_DEFAULT_CONFIG: defaultsFile } })
  assert.equal(result.source, 'global')
  assert.equal(result.provider, 'p')
  rmSync(join(dataDir, '..'), { recursive: true, force: true })
})

test('readPetModel：全空返回 none', () => {
  const { dataDir, defaultsFile } = makeHome()
  const result = readPetModel({ dataDir, env: { DSH_PET_DEFAULT_CONFIG: defaultsFile } })
  assert.equal(result.provider, '')
  assert.equal(result.source, 'none')
  rmSync(join(dataDir, '..'), { recursive: true, force: true })
})

test('createModelCatalog：聚合 provider/model，单 provider 失败不影响其它', async () => {
  const calls = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          listProviders: async () => [
            { id: 'a', name: 'A' },
            { id: 'b', name: 'B' },
          ],
          listModels: async (id) => {
            calls.push(id)
            if (id === 'b') throw new Error('boom')
            return [{ provider: 'a', id: 'a-1', name: 'A1' }]
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'a', model: 'a-1' }) }
      return null
    },
  }
  const catalog = createModelCatalog({ ctx, log: null })
  const listed = await catalog.list()
  assert.equal(listed.providers.length, 2)
  assert.equal(listed.models.length, 1)
  assert.deepEqual(listed.defaultSelection, { provider: 'a', model: 'a-1' })
  assert.deepEqual(calls, ['a', 'b'])
  const cached = await catalog.list()
  assert.equal(cached, listed)
})

test('createModelCatalog：没有 llm 服务时返回空列表和 error', async () => {
  const catalog = createModelCatalog({ ctx: { get: () => null } })
  const listed = await catalog.list()
  assert.deepEqual(listed.providers, [])
  assert.deepEqual(listed.models, [])
  assert.match(listed.error, /llm service unavailable/)
})

test('createLlmComplete：配置优先于 dsh-pet，dsh-pet 优先于宿主默认', async () => {
  const seen = []
  const ctx = {
    get(name) {
      if (name === 'llm') {
        return {
          stream: async function* (options) {
            seen.push({ provider: options.provider, model: options.model })
            yield { content: [{ type: 'text', text: 'ok' }] }
          },
        }
      }
      if (name === 'agentDefaultModel') return { currentSelection: () => ({ provider: 'host', model: 'host-1' }) }
      return null
    },
  }
  const complete = createLlmComplete(ctx, { model: 'cfg', provider: 'cfg-p' }, null, {
    resolveFollow: () => ({ provider: 'pet-p', model: 'pet-m', source: 'pet' }),
  })
  assert.equal(await complete({ system: 's', user: 'u' }), 'ok')
  assert.deepEqual(seen[0], { provider: 'cfg-p', model: 'cfg' })
})
