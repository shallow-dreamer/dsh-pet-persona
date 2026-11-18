/**
 * 桌宠的「自我记忆」：记录跨会话的经历与心情，独立于主人事实。
 *
 * 设计边界（docs/self-plan.md）：
 * - 只写 `self.jsonl`，绝不碰 `facts.jsonl`，也不参与 recall 的主人事实检索；
 * - 记录是 fire-and-forget：内存先更新，文件异步追加，失败只记日志；
 * - 心情由事件按时间衰减现算，不单独保存状态，避免状态与事件互相矛盾；
 * - P1 不注入对话，只提供展示与 API。
 *
 * @module dsh-pet-persona/lib/self
 */

import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { sensitiveReason } from './sensitive.js'
import { analyzeEmotion, blendLabel, EMOTION_LABELS } from './emotion.js'
import { clampText, ulid } from './util.js'

const SCHEMA_VERSION = 1
const HALF_LIFE_HOURS = 6
const MAX_TEXT = 80
const MAX_QUOTE = 60
const DEDUPE_MS = 10 * 60 * 1000
const COMPACT_FACTOR = 1.5

const POSITIVE = /喜欢|谢谢|可爱|好乖|乖|棒|开心|陪|摸摸|亲|辛苦|爱你|好看|厉害|聪明|不错|真好|温柔/
const NEGATIVE = /讨厌|滚|生气|烦|笨|闭嘴|不要你|坏|难过|哭|凶|吵|恶心|失望|别烦/

const LABELS = {
  happy: '开心',
  good: '不错',
  calm: '平静',
  low: '有点低落',
  upset: '难过',
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function normalizeEmotions(raw, valence, energy) {
  if (!Array.isArray(raw) || raw.length === 0) return fallbackEmotions(valence, energy)
  const list = raw
    .filter((item) => item && EMOTION_LABELS[item.key])
    .slice(0, 4)
    .map((item) => ({
      key: item.key,
      label: EMOTION_LABELS[item.key],
      score: clamp(Number(item.score) || 0.5, 0, 1),
    }))
  return list.length > 0 ? list : fallbackEmotions(valence, energy)
}

function fallbackEmotions(valence, energy) {
  const list = []
  if (valence >= 0.25) list.push({ key: 'joy', label: EMOTION_LABELS.joy, score: Math.min(1, valence) })
  if (valence <= -0.25) list.push({ key: 'sadness', label: EMOTION_LABELS.sadness, score: Math.min(1, -valence) })
  if (energy <= 0.35) list.push({ key: 'tiredness', label: EMOTION_LABELS.tiredness, score: 0.7 })
  if (list.length === 0) list.push({ key: 'calm', label: EMOTION_LABELS.calm, score: 0.55 })
  return list
}

/**
 * 词典情绪：只做轻量判断，不调用模型。
 * @param {string} text
 * @param {string} replyText
 */
function legacySentimentOf(text, replyText) {
  const both = `${text}\n${replyText}`
  const pos = (both.match(POSITIVE) ?? []).length
  const neg = (both.match(NEGATIVE) ?? []).length
  const raw = (pos - neg) / 3
  const valence = clamp(raw, -1, 1)
  const lengthBoost = clamp(replyText.length / 220, 0, 0.28)
  const exclaim = /[!！]/.test(replyText) ? 0.08 : 0
  const energy = clamp(0.45 + lengthBoost + exclaim, 0, 1)
  return { valence: Number(valence.toFixed(3)), energy: Number(energy.toFixed(3)) }
}

/**
 * @param {{ petId?: string, userText?: string, replyText?: string, ts?: number, kind?: string }} input
 * @param {() => number} now
 */
function normalizeRecord(input, now) {
  const petId = String(input.petId ?? 'default').trim() || 'default'
  const userText = String(input.userText ?? '').trim()
  const replyText = String(input.replyText ?? '').trim()
  const ts = Number(input.ts) || now()
  const kind = input.kind === 'feeling' || input.kind === 'thought' ? input.kind : 'event'
  return { petId, userText, replyText, ts, kind }
}

export class SelfStore {
  /**
   * @param {{ dir: string, maxEntries?: number, log?: any, now?: () => number }} options
   */
  constructor({ dir, maxEntries = 500, log = null, now = Date.now } = {}) {
    this.dir = dir
    this.file = join(dir, 'self.jsonl')
    this.tmp = join(dir, 'self.jsonl.tmp')
    this.maxEntries = Math.max(20, Math.min(5000, Number(maxEntries) || 500))
    this.log = log
    this.now = now
    /** @type {any[]} */
    this.entries = []
    /** @type {Map<string, number>} */
    this.lastByHash = new Map()
    this.loaded = false
    this.readOnly = false
    this.chain = Promise.resolve()
    this.compacting = false
  }

  initSync() {
    try {
      mkdirSync(this.dir, { recursive: true })
      if (!existsSync(this.file)) writeFileSyncEmpty(this.file)
    } catch (error) {
      this.log?.warn?.(`self_init_failed ${error?.stack ?? error}`)
    }
    this.loadSync()
    return this
  }

  loadSync() {
    if (!existsSync(this.file)) {
      this.loaded = true
      return this
    }
    try {
      const text = readFileSync(this.file, 'utf8')
      this.ingest(text)
      this.loaded = true
    } catch (error) {
      this.log?.warn?.(`self_load_failed ${error?.stack ?? error}`)
    }
    return this
  }

  /** @param {string} text */
  ingest(text) {
    const rows = []
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        const row = JSON.parse(line)
        if (!row || row.v !== SCHEMA_VERSION || typeof row.id !== 'string' || typeof row.text !== 'string') {
          this.log?.debug?.('self_bad_row')
          continue
        }
        rows.push({
          v: SCHEMA_VERSION,
          id: row.id,
          petId: String(row.petId ?? 'default'),
          kind: row.kind === 'feeling' || row.kind === 'thought' ? row.kind : 'event',
          text: clampText(String(row.text), MAX_TEXT),
          quote: clampText(String(row.quote ?? ''), MAX_QUOTE),
          valence: clamp(Number(row.valence) || 0, -1, 1),
          energy: clamp(Number(row.energy) || 0.5, 0, 1),
          emotions: normalizeEmotions(row.emotions, Number(row.valence) || 0, Number(row.energy) || 0.5),
          importance: clamp(Number(row.importance) || 2, 1, 5),
          createdAt: String(row.createdAt ?? ''),
          hash: String(row.hash ?? ''),
          source: String(row.source ?? 'chat'),
        })
      } catch {
        this.log?.debug?.('self_bad_line')
      }
    }
    this.entries = rows.slice(-this.maxEntries)
    this.lastByHash.clear()
    for (const row of this.entries) {
      if (row.hash) this.lastByHash.set(`${row.petId}|${row.hash}`, Date.parse(row.createdAt) || 0)
    }
  }

  /** 串行文件操作，保证 append 不交错。 */
  enqueue(task) {
    const next = this.chain.then(task).catch((error) => {
      this.log?.warn?.(`self_write_failed ${error?.stack ?? error}`)
    })
    this.chain = next
    return next
  }

  /**
   * 记录一次交流。同步更新内存，文件异步写；任何失败都不抛给调用方。
   * @param {{ petId?: string, userText?: string, replyText?: string, ts?: number, kind?: string }} input
   */
  record(input = {}) {
    try {
      const row = this.buildRow(input)
      if (!row) return null
      this.entries.push(row)
      if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries)
      const key = `${row.petId}|${row.hash}`
      this.lastByHash.set(key, Date.parse(row.createdAt) || this.now())
      const line = `${JSON.stringify(row)}\n`
      this.enqueue(() => appendFile(this.file, line, 'utf8'))
      if (this.entries.length > this.maxEntries * COMPACT_FACTOR) void this.compact()
      return row
    } catch (error) {
      this.log?.warn?.(`self_record_failed ${error?.stack ?? error}`)
      return null
    }
  }

  /**
   * 记录「它自己做的事」，不来自聊天原文，因此不需要 userText。
   * @param {{ petId?: string, text: string, kind?: 'event'|'feeling'|'thought', source?: string, importance?: number, valence?: number, energy?: number }} input
   */
  note(input = {}) {
    try {
      const petId = String(input.petId ?? 'default').trim() || 'default'
      const raw = clampText(input.text, MAX_TEXT)
      if (!raw) return null
      const secret = sensitiveReason(raw)
      const text = secret ? '和主人聊了会儿天' : raw
      const kind = input.kind === 'feeling' || input.kind === 'thought' ? input.kind : 'event'
      const hash = createHash('sha1').update(`${petId}\0${text}\0agency`).digest('hex').slice(0, 12)
      const key = `${petId}|${hash}`
      const last = this.lastByHash.get(key) ?? 0
      const ts = this.now()
      if (ts - last < DEDUPE_MS) return null
      const inferred = secret ? null : analyzeEmotion(text, '')
      const emotions = Array.isArray(input.emotions) && input.emotions.length > 0
        ? input.emotions
        : (inferred?.emotions || [])
      const row = {
        v: SCHEMA_VERSION,
        id: ulid('s_'),
        petId,
        kind,
        text,
        quote: '',
        valence: Math.max(-1, Math.min(1, Number(input.valence) || 0)),
        energy: Math.max(0, Math.min(1, Number(input.energy) || 0.5)),
        emotions,
        importance: Math.max(1, Math.min(5, Number(input.importance) || 3)),
        createdAt: new Date(ts).toISOString(),
        hash,
        source: String(input.source || 'agency').slice(0, 20),
      }
      this.entries.push(row)
      if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(-this.maxEntries)
      this.lastByHash.set(key, ts)
      this.enqueue(() => appendFile(this.file, `${JSON.stringify(row)}\n`, 'utf8'))
      if (this.entries.length > this.maxEntries * COMPACT_FACTOR) void this.compact()
      return row
    } catch (error) {
      this.log?.warn?.(`self_note_failed ${error?.stack ?? error}`)
      return null
    }
  }

  /** @param {{ petId?: string, userText?: string, replyText?: string, ts?: number, kind?: string }} input */
  buildRow(input) {
    const { petId, userText, replyText, ts, kind } = normalizeRecord(input, this.now)
    if (!userText && !replyText) return null
    const secret = sensitiveReason(`${userText}\n${replyText}`)
    const text = secret ? '和主人聊了会儿天' : this.summarize(userText, replyText)
    if (!text) return null
    const quote = secret ? '' : clampText(userText, MAX_QUOTE)
    const hash = createHash('sha1').update(`${petId}\0${text}\0${quote}`).digest('hex').slice(0, 12)
    const key = `${petId}|${hash}`
    const last = this.lastByHash.get(key) ?? 0
    if (ts - last < DEDUPE_MS) return null
    const mood = secret
      ? { valence: 0, energy: 0.5, emotions: [] }
      : analyzeEmotion(userText, replyText)
    return {
      v: SCHEMA_VERSION,
      id: ulid('s_'),
      petId,
      kind,
      text,
      quote,
      valence: mood.valence,
      energy: mood.energy,
      emotions: Array.isArray(mood.emotions) ? mood.emotions : [],
      importance: 2,
      createdAt: new Date(ts).toISOString(),
      hash,
      source: 'chat',
    }
  }

  /** @param {string} userText @param {string} replyText */
  summarize(userText, replyText) {
    const said = clampText(userText.replace(/\s+/g, ' ').trim(), 26)
    if (!said && !replyText) return ''
    if (!replyText) return `主人说「${said}」`
    return `陪主人聊了「${said || '一会儿'}」`
  }

  /**
   * 现算心情：最近 24h 事件按 6h 半衰期加权。
   * @param {string} [petId]
   */
  state(petId = '') {
    const nowMs = this.now()
    const wanted = petId ? String(petId) : ''
    let wSum = 0
    let vSum = 0
    let eSum = 0
    let count = 0
    let updatedAt = 0
    let emotionWeight = 0
    const emotionSum = new Map()
    for (const row of this.entries) {
      if (wanted && row.petId !== wanted) continue
      const at = Date.parse(row.createdAt) || 0
      if (!at || at > nowMs) continue
      const ageH = (nowMs - at) / 3_600_000
      if (ageH > 48) continue
      const w = 0.5 ** (ageH / HALF_LIFE_HOURS) * row.importance
      if (!Number.isFinite(w) || w <= 0) continue
      wSum += w
      vSum += w * row.valence
      eSum += w * (row.energy - 0.5)
      const emotions = row.emotions || fallbackEmotions(row.valence, row.energy)
      const nonCalm = emotions.filter((item) => item.key !== 'calm')
      if (nonCalm.length > 0) emotionWeight += w
      for (const item of nonCalm) {
        emotionSum.set(item.key, (emotionSum.get(item.key) || 0) + w * item.score)
      }
      count += 1
      if (at > updatedAt) updatedAt = at
    }
    const valence = wSum > 0 ? clamp(vSum / wSum, -1, 1) : 0
    const energy = wSum > 0 ? clamp(0.5 + eSum / wSum, 0, 1) : 0.5
    const emotions = [...emotionSum.entries()]
      .map(([key, score]) => ({ key, label: EMOTION_LABELS[key], score: emotionWeight > 0 ? clamp(score / emotionWeight, 0, 1) : 0 }))
      .filter((item) => item.label && item.score > 0.06)
      .sort((a, b) => b.score - a.score)
      .slice(0, 4)
    if (emotions.length === 0) emotions.push(...fallbackEmotions(valence, energy))
    const primary = emotions[0]
    const secondary = emotions[1] && emotions[1].score >= primary.score * 0.55 ? emotions[1] : null
    const mixText = blendLabel(primary, secondary)
    const label = primary?.label || LABELS.calm
    const energyLabel = energy >= 0.7 ? '精神' : energy <= 0.35 ? '困倦' : '一般'
    return {
      valence: Number(valence.toFixed(3)),
      energy: Number(energy.toFixed(3)),
      label,
      energyLabel,
      moodText: `${mixText} · ${energyLabel}`,
      mixText,
      emotions,
      events: count,
      updatedAt: updatedAt ? new Date(updatedAt).toISOString() : '',
    }
  }

  /**
   * 最近事件（倒序）。
   * @param {string} [petId]
   * @param {number} [limit]
   */
  recent(petId = '', limit = 50) {
    const wanted = petId ? String(petId) : ''
    return this.entries
      .filter((row) => !wanted || row.petId === wanted)
      .slice(-Math.max(1, Math.min(200, limit)))
      .reverse()
  }

  /**
   * 清空自我记忆（可按宠物）。
   * @param {string} [petId]
   */
  async reset(petId = '') {
    const wanted = petId ? String(petId) : ''
    const before = this.entries.length
    const kept = wanted ? this.entries.filter((row) => row.petId !== wanted) : []
    this.entries = kept
    this.lastByHash.clear()
    await this.rewrite()
    await this.chain
    return { removed: before - kept.length }
  }

  async compact() {
    if (this.compacting) return
    this.compacting = true
    try {
      this.entries = this.entries.slice(-this.maxEntries)
      await this.rewrite()
    } finally {
      this.compacting = false
    }
  }

  async rewrite() {
    const body = this.entries.map((row) => JSON.stringify(row)).join('\n')
    const text = body ? `${body}\n` : ''
    await this.enqueue(async () => {
      await mkdir(this.dir, { recursive: true })
      await writeFile(this.tmp, text, 'utf8')
      await rename(this.tmp, this.file)
    })
  }

  stats() {
    const byPet = {}
    for (const row of this.entries) byPet[row.petId] = (byPet[row.petId] ?? 0) + 1
    return { entries: this.entries.length, maxEntries: this.maxEntries, byPet }
  }

  async dispose() {
    await Promise.race([this.chain, new Promise((resolve) => setTimeout(resolve, 500))])
  }
}

function writeFileSyncEmpty(file) {
  // 只建空文件；用 wx 避免和异步写入抢创建。
  try {
    writeFileSync(file, '', { flag: 'wx' })
  } catch {
    /* 已存在或不可写，交给后续流程 */
  }
}
