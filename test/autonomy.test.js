import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAutonomy, inQuietHours } from '../lib/autonomy.js'
import { SelfStore } from '../lib/self.js'

function setup(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-'))
  const config = {
    agencyEnabled: true,
    autonomyLevel: 'assist',
    autonomyDailyMax: 3,
    autonomyQuietStart: '23:30',
    autonomyQuietEnd: '08:00',
    autonomyCooldownH: 6,
    autonomyIgnoreDecay: 2,
    ...overrides,
  }
  let valence = 0.8
  const said = []
  const self = {
    state: () => ({ valence, energy: 0.5 }),
    recent: () => [],
  }
  const autonomy = createAutonomy({
    dir,
    config,
    self,
    log: { info() {}, warn() {} },
    now: () => clock,
    speak: async (petId, text) => { said.push({ petId, text }) },
  })
  let clock = new Date(2026, 0, 1, 12, 0, 0).getTime()
  autonomy.initSync()
  return {
    dir, config, autonomy, said,
    setValence: (v) => { valence = v },
    at: (h, m = 0) => { clock = new Date(2026, 0, 1, h, m, 0).getTime(); return clock },
    advance: (ms) => { clock += ms; return clock },
    clock: () => clock,
    close: () => rmSync(dir, { recursive: true, force: true }),
  }
}

test('self.note 可以直接记录它自己做的事', () => {
  const dir = mkdtempSync(join(tmpdir(), 'self-note-'))
  const self = new SelfStore({ dir })
  self.initSync()
  const row = self.note({ petId: 'main', text: '帮主人记下了一条笔记。', source: 'agency' })
  assert.equal(row?.source, 'agency')
  assert.equal(row?.petId, 'main')
  assert.match(row?.text || '', /笔记/)
  const recent = self.recent('main', 5)
  assert.equal(recent[0]?.text, '帮主人记下了一条笔记。')
  rmSync(dir, { recursive: true, force: true })
})

test('inQuietHours 支持跨午夜', () => {
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m).getTime()
  assert.equal(inQuietHours(at(23, 40)), true)
  assert.equal(inQuietHours(at(2, 0)), true)
  assert.equal(inQuietHours(at(8, 0)), false)
  assert.equal(inQuietHours(at(12, 0)), false)
})

test('off 完全不动', async () => {
  const s = setup({ autonomyLevel: 'off' })
  await s.autonomy.tick(s.clock())
  assert.equal(s.said.length, 0)
  assert.equal(s.autonomy.status().level, 'off')
  s.close()
})

test('observe 只记录，不真的说话', async () => {
  const s = setup({ autonomyLevel: 'observe' })
  await s.autonomy.tick(s.clock())
  assert.equal(s.said.length, 0)
  const last = s.autonomy.decisions(1)[0]
  assert.equal(last.decision, 'observe')
  assert.equal(last.trigger, 'strong_emotion')
  s.close()
})

test('assist 强情绪说一次，冷却内不重复', async () => {
  const s = setup()
  await s.autonomy.tick(s.clock())
  assert.equal(s.said.length, 1)
  assert.match(s.said[0].text, /心情不错/)
  await s.autonomy.tick(s.advance(60 * 1000))
  assert.equal(s.said.length, 1)
  assert.equal(s.autonomy.decisions(1)[0].reason, 'cooldown')
  s.close()
})

test('静默时段没有刚聊过就跳过', async () => {
  const s = setup()
  const night = s.at(2, 0)
  await s.autonomy.tick(night)
  assert.equal(s.said.length, 0)
  assert.equal(s.autonomy.decisions(1)[0].reason, 'quiet_hours')
  s.close()
})

test('深夜刚聊过可以说一次「还不睡呀」', async () => {
  const s = setup({ autonomyDailyMax: 3 })
  s.setValence(0)
  const night = s.at(1, 0)
  s.autonomy.noteCapture({ ts: night - 5 * 60 * 1000, text: '还在吗' })
  await s.autonomy.tick(night)
  assert.equal(s.said.length, 1)
  assert.match(s.said[0].text, /还不睡/)
  await s.autonomy.tick(night + 60 * 1000)
  assert.equal(s.said.length, 1)
  s.close()
})

test('每日上限生效', async () => {
  const s = setup({ autonomyDailyMax: 1 })
  await s.autonomy.tick(s.clock())
  assert.equal(s.said.length, 1)
  await s.autonomy.tick(s.advance(7 * 3600 * 1000))
  assert.equal(s.said.length, 1)
  assert.equal(s.autonomy.decisions(1)[0].reason, 'daily_max')
  s.close()
})

test('被忽略两次后当天降级', async () => {
  const s = setup({ autonomyCooldownH: 1 })
  await s.autonomy.tick(s.clock())
  assert.equal(s.said.length, 1)
  // 第一次气泡没有回应
  await s.autonomy.tick(s.advance(31 * 60 * 1000))
  assert.equal(s.autonomy.status().ignoredToday, 1)
  // 换个情绪触发，再说一次
  s.setValence(-0.8)
  await s.autonomy.tick(s.advance(31 * 60 * 1000))
  assert.equal(s.said.length, 2)
  await s.autonomy.tick(s.advance(31 * 60 * 1000))
  assert.equal(s.autonomy.status().ignoredToday, 2)
  assert.equal(s.autonomy.status().degraded, true)
  await s.autonomy.tick(s.advance(60 * 1000))
  assert.equal(s.said.length, 2)
  assert.equal(s.autonomy.decisions(1)[0].reason, 'degraded_today')
  s.close()
})

test('observe/speak 决策会回调 onDecision（写入自我记忆）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-cb-'))
  const seen = []
  const nowMs = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const autonomy = createAutonomy({
    dir,
    config: { agencyEnabled: true, autonomyLevel: 'observe', autonomyDailyMax: 3, autonomyQuietStart: '23:30', autonomyQuietEnd: '08:00', autonomyCooldownH: 6, autonomyIgnoreDecay: 2 },
    self: { state: () => ({ valence: 0.8, energy: 0.5, moodText: '不错' }), recent: () => [] },
    log: { info() {}, warn() {} },
    now: () => nowMs,
    speak: async () => {},
    onDecision: (row) => seen.push(row),
  })
  autonomy.initSync()
  await autonomy.tick(nowMs)
  assert.equal(seen.length, 1)
  assert.equal(seen[0].decision, 'observe')
  assert.equal(seen[0].trigger, 'strong_emotion')
  rmSync(dir, { recursive: true, force: true })
})

test('决策日志落盘', async () => {
  const s = setup({ autonomyLevel: 'observe' })
  await s.autonomy.tick(s.clock())
  const text = readFileSync(join(s.dir, 'agency', 'decisions.jsonl'), 'utf8')
  assert.match(text, /strong_emotion/)
  const rows = text.trim().split('\n').map((line) => JSON.parse(line))
  assert.ok(rows.length >= 1)
  s.close()
})

test('主人事实里提到忙/累会触发记忆关怀', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'autonomy-care-'))
  const said = []
  const nowMs = new Date(2026, 0, 1, 12, 0, 0).getTime()
  const autonomy = createAutonomy({
    dir,
    config: { agencyEnabled: true, autonomyLevel: 'assist', autonomyDailyMax: 3, autonomyQuietStart: '23:30', autonomyQuietEnd: '08:00', autonomyCooldownH: 6, autonomyIgnoreDecay: 2 },
    self: { state: () => ({ valence: 0, energy: 0.5, moodText: '平静' }), recent: () => [] },
    facts: { active: [{ id: 'f1', value: '最近工作很忙', createdAt: new Date(nowMs).toISOString() }] },
    log: { info() {}, warn() {} },
    now: () => nowMs,
    speak: async (petId, text) => { said.push(text) },
  })
  autonomy.initSync()
  await autonomy.tick(nowMs)
  assert.equal(said.length, 1)
  assert.match(said[0], /辛苦|歇/)
  assert.equal(autonomy.decisions(1)[0].trigger, 'memory_care')
  rmSync(dir, { recursive: true, force: true })
})
