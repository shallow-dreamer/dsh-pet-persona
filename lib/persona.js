/**
 * 只读人格读取：从 dsh-pet 的 JSONC 配置里取当前宠物的人设（whisperPrompt）。
 *
 * 本插件永远不写 dsh-pet 的配置。这里只做三件事：
 * - 解析 JSONC（去掉注释，保留字符串里的 // 和 /*）；
 * - 先读用户层 `$DSH_HOME/dsh-pet/main-config.jsonc`，再读 dsh-pet 包内默认配置；
 * - 合并出「实例级 whisperPrompt → 条目顶层 whisperPrompt」的生效值。
 *
 * 读不到就返回 available=false，设置页据此提示「人格只读不可用」，绝不抛错。
 *
 * @module dsh-pet-persona/lib/persona
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 插件包根目录（lib 的上一级）。 */
const PLUGIN_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 去掉 JSONC 注释，保留换行与字符串内容。
 * @param {string} text
 * @returns {string}
 */
export function stripJsonc(text) {
  const source = String(text ?? '')
  let out = ''
  let inString = false
  let escape = false
  let lineComment = false
  let blockComment = false
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (lineComment) {
      if (ch === '\n') {
        lineComment = false
        out += ch
      }
      continue
    }
    if (blockComment) {
      if (ch === '*' && next === '/') {
        blockComment = false
        i += 1
      } else if (ch === '\n') {
        out += ch
      }
      continue
    }
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
      continue
    }
    if (ch === '"') {
      inString = true
      out += ch
      continue
    }
    if (ch === '/' && next === '/') {
      lineComment = true
      i += 1
      continue
    }
    if (ch === '/' && next === '*') {
      blockComment = true
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * @param {string} text
 * @returns {any|null}
 */
export function parseJsonc(text) {
  try {
    return JSON.parse(stripJsonc(text))
  } catch {
    return null
  }
}

/**
 * 读取一个 JSONC 文件；不存在/解析失败都返回 null。
 * @param {string} file
 */
function readJsoncFile(file) {
  try {
    if (!existsSync(file)) return null
    return parseJsonc(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * 默认人格配置的候选路径（越靠前越优先）。
 * @param {{ dataDir?: string, env?: Record<string, string|undefined> }} options
 * @returns {string[]}
 */
export function defaultPersonaCandidates({ dataDir = '', env = process.env } = {}) {
  const list = []
  if (env.DSH_PET_DEFAULT_CONFIG) list.push(env.DSH_PET_DEFAULT_CONFIG)
  // 安装态：<profile>/node_modules/dsh-pet-persona → 同级 dsh-pet
  list.push(join(PLUGIN_DIR, '..', 'dsh-pet', 'assets', 'config.jsonc'))
  // 工作区开发态：E:/DSH/plugins/dsh-pet-persona → 本机 DSH_HOME
  if (dataDir) {
    const home = resolve(dataDir, '..')
    const profile = env.DSH_PROFILE || 'desktop'
    list.push(join(home, 'profiles', profile, 'node_modules', 'dsh-pet', 'assets', 'config.jsonc'))
  }
  return [...new Set(list)]
}

/**
 * @param {{ dataDir?: string, env?: Record<string, string|undefined> }} options
 */
export function readPersona({ dataDir = '', env = process.env } = {}) {
  const home = dataDir ? resolve(dataDir, '..') : ''
  const userFile = home ? join(home, 'dsh-pet', 'main-config.jsonc') : ''
  const legacyUserFile = home ? join(home, 'dsh-pet', 'main-config.json') : ''
  const defaultsFile = defaultPersonaCandidates({ dataDir, env }).find((file) => existsSync(file)) ?? ''

  const user = readJsoncFile(userFile) ?? readJsoncFile(legacyUserFile) ?? null
  const defaults = defaultsFile ? readJsoncFile(defaultsFile) : null

  const userPets = Array.isArray(user?.pets) ? user.pets : []
  const defaultPets = Array.isArray(defaults?.pets) ? defaults.pets : []
  const petFromUser = userPets[0] != null
  const pet = petFromUser ? userPets[0] : (defaultPets[0] ?? null)

  const pick = (...values) => {
    for (const value of values) {
      if (typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    return ''
  }
  const text = pick(pet?.whisperPrompt, user?.whisperPrompt, defaults?.whisperPrompt, defaultPets[0]?.whisperPrompt)
  const petName = pick(pet?.name, user?.name, defaultPets[0]?.name, '桌宠')
  const petId = pick(pet?.id, defaultPets[0]?.id, 'default')

  let updatedAt = 0
  for (const file of [userFile, defaultsFile]) {
    try {
      if (file && existsSync(file)) updatedAt = Math.max(updatedAt, statSync(file).mtimeMs)
    } catch {
      /* ignore */
    }
  }

  return {
    available: text !== '',
    text,
    petName,
    petId,
    source: text === '' ? 'none' : pet?.whisperPrompt ? (petFromUser ? 'pet' : 'default') : user?.whisperPrompt ? 'user' : 'default',
    userFile,
    defaultsFile,
    updatedAt: updatedAt > 0 ? new Date(updatedAt).toISOString() : '',
  }
}

/**
 * 只接受 `{provider,model}` 都非空的模型选择；空对象/缺字段都表示「跟随」。
 * @param {any} value
 * @returns {{provider: string, model: string} | null}
 */
export function normalizeModelSelection(value) {
  if (!value || typeof value !== 'object') return null
  const provider = typeof value.provider === 'string' ? value.provider.trim() : ''
  const model = typeof value.model === 'string' ? value.model.trim() : ''
  return provider !== '' && model !== '' ? { provider, model } : null
}

/**
 * 读 dsh-pet 当前宠物配置里的 `chatModel`（不写任何文件）。
 *
 * 解析顺序：用户层条目 → 用户层顶层 → 默认层条目 → 默认层顶层。
 * 空 `{provider:'',model:''}` 按 dsh-pet 语义表示「跟随当前对话」，继续向下找。
 *
 * @param {{ dataDir?: string, env?: Record<string, string|undefined>, petId?: string }} options
 * @returns {{ provider: string, model: string, source: 'pet'|'global'|'default-pet'|'default'|'none', petId: string }}
 */
export function readPetModel({ dataDir = '', env = process.env, petId = '' } = {}) {
  const home = dataDir ? resolve(dataDir, '..') : ''
  const userFile = home ? join(home, 'dsh-pet', 'main-config.jsonc') : ''
  const legacyUserFile = home ? join(home, 'dsh-pet', 'main-config.json') : ''
  const defaultsFile = defaultPersonaCandidates({ dataDir, env }).find((file) => existsSync(file)) ?? ''

  const user = readJsoncFile(userFile) ?? readJsoncFile(legacyUserFile) ?? null
  const defaults = defaultsFile ? readJsoncFile(defaultsFile) : null

  const userPets = Array.isArray(user?.pets) ? user.pets : []
  const defaultPets = Array.isArray(defaults?.pets) ? defaults.pets : []
  const pickPet = (pets) => {
    if (petId !== '') {
      const matched = pets.find((row) => String(row?.id ?? '') === String(petId))
      if (matched) return matched
    }
    return pets[0] ?? null
  }
  const userPet = pickPet(userPets)
  const defaultPet = pickPet(defaultPets)
  const effectivePetId = String(userPet?.id ?? defaultPet?.id ?? petId ?? 'default')

  const candidates = [
    ['pet', userPet?.chatModel],
    ['global', user?.chatModel],
    ['default-pet', defaultPet?.chatModel],
    ['default', defaults?.chatModel],
  ]
  for (const [source, value] of candidates) {
    const selected = normalizeModelSelection(value)
    if (selected) return { ...selected, source, petId: effectivePetId }
  }
  return { provider: '', model: '', source: 'none', petId: effectivePetId }
}
