import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createAgency, parseDue } from '../lib/agency.js'

function setup(options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'persona-agency-'))
  const agency = createAgency({ dir, now: () => 1_700_000_000_000, ...options })
  agency.initSync()
  return { dir, agency }
}

test('允许后回调 onExecuted（写回自我记忆）', () => {
  let seen = null
  const { dir, agency } = setup({ onExecuted: (proposal) => { seen = proposal } })
  const got = agency.observe({ petId: 'main', userText: '记一下：买牛奶', replyText: '好' })
  assert.equal(agency.decide(got.proposal.id, 'approve').ok, true)
  assert.equal(seen?.id, got.proposal.id)
  assert.equal(seen?.kind, 'note')
  rmSync(dir, { recursive: true, force: true })
})

test('首次初始化建目录和空 proposals', () => {
  const { dir, agency } = setup()
  assert.ok(existsSync(join(dir, 'agency')))
  assert.ok(existsSync(join(dir, 'agency', 'notes')))
  assert.equal(agency.stats().pending, 0)
  assert.deepEqual(agency.list(), [])
  rmSync(dir, { recursive: true, force: true })
})

test('「记一下」生成待确认提议，允许后写文件，撤销后删除', () => {
  const { dir, agency } = setup()
  const got = agency.observe({ petId: 'main', userText: '记一下：买牛奶', replyText: '好' })
  assert.equal(got.ok, true)
  assert.equal(agency.stats().pending, 1)
  const id = got.proposal.id
  const decided = agency.decide(id, 'approve')
  assert.equal(decided.ok, true)
  const file = decided.proposal.undo.file
  assert.ok(existsSync(file))
  assert.match(readFileSync(file, 'utf8'), /买牛奶/)
  const undone = agency.undo(id)
  assert.equal(undone.ok, true)
  assert.equal(existsSync(file), false)
  assert.equal(agency.stats().undone, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('拒绝后不落盘，状态 rejected', () => {
  const { dir, agency } = setup()
  const got = agency.observe({ petId: 'main', userText: '备注：周五交报告' })
  assert.equal(got.ok, true)
  const decided = agency.decide(got.proposal.id, 'reject')
  assert.equal(decided.proposal.status, 'rejected')
  assert.equal(agency.stats().done, 0)
  assert.equal(agency.stats().rejected, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('「提醒我」写入 reminders.jsonl，撤销写入 cancelled', () => {
  const { dir, agency } = setup()
  const got = agency.observe({ petId: 'main', userText: '提醒我：晚上九点吃药' })
  assert.equal(got.ok, true)
  const decided = agency.decide(got.proposal.id, 'approve')
  const file = join(dir, 'agency', 'reminders.jsonl')
  assert.ok(existsSync(file))
  assert.match(readFileSync(file, 'utf8'), /晚上九点吃药/)
  assert.equal(agency.undo(got.proposal.id).ok, true)
  assert.match(readFileSync(file, 'utf8'), /cancelled/)
  rmSync(dir, { recursive: true, force: true })
})

test('敏感内容不生成提议', () => {
  const { dir, agency } = setup()
  const got = agency.observe({ petId: 'main', userText: '记一下：我的密码是 abc12345' })
  assert.equal(got.ok, false)
  assert.equal(agency.stats().pending, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('10 分钟内同一请求只生成一条', () => {
  const { dir, agency } = setup()
  const first = agency.observe({ petId: 'main', userText: '记一下：买猫粮' })
  const second = agency.observe({ petId: 'main', userText: '记一下：买猫粮' })
  assert.equal(first.ok, true)
  assert.equal(second.ok, false)
  assert.equal(second.reason, 'duplicate')
  assert.equal(agency.stats().pending, 1)
  rmSync(dir, { recursive: true, force: true })
})

test('待确认数量超过上限时拒绝新提议', () => {
  const { dir, agency } = setup({ maxPending: 2 })
  assert.equal(agency.observe({ petId: 'main', userText: '记一下：一' }).ok, true)
  assert.equal(agency.observe({ petId: 'main', userText: '记一下：二' }).ok, true)
  const third = agency.observe({ petId: 'main', userText: '记一下：三' })
  assert.equal(third.ok, false)
  assert.equal(third.reason, 'queue_full')
  rmSync(dir, { recursive: true, force: true })
})

test('普通闲聊不产生任何提议', () => {
  const { dir, agency } = setup()
  assert.equal(agency.observe({ petId: 'main', userText: '今天天气不错', replyText: '是呀' }).ok, false)
  assert.equal(agency.stats().pending, 0)
  rmSync(dir, { recursive: true, force: true })
})

test('路径安全：undo 拒绝 agency 目录外的文件', () => {
  const { dir, agency } = setup()
  const got = agency.observe({ petId: 'main', userText: '记一下：安全测试' })
  const decided = agency.decide(got.proposal.id, 'approve')
  decided.proposal.undo.file = join(dir, 'outside.txt')
  const undone = agency.undo(got.proposal.id)
  assert.equal(undone.ok, false)
  assert.notEqual(undone.reason, 'not_done')
  rmSync(dir, { recursive: true, force: true })
})

test('parseDue：相对时间 / 明天时间 / 认不出返回空', () => {
  const base = new Date(2026, 0, 1, 10, 0, 0, 0).getTime()
  assert.equal(parseDue('30分钟后喝水', base), new Date(base + 30 * 60000).toISOString())
  assert.equal(parseDue('明天 9:30 开会', base), new Date(2026, 0, 2, 9, 30, 0, 0).toISOString())
  assert.equal(parseDue('晚上九点吃药', base), '')
  assert.equal(parseDue('随便说点什么', base), '')
})

test('到点提醒浮出、确认后播报一次', async () => {
  let clock = new Date(2026, 0, 1, 10, 0, 0, 0).getTime()
  const spoken = []
  const dir = mkdtempSync(join(tmpdir(), 'persona-agency-'))
  const agency = createAgency({
    dir,
    now: () => clock,
    speak: async (petId, text) => { spoken.push([petId, text]) },
  })
  agency.initSync()
  const got = agency.observe({ petId: 'main', userText: '提醒我 30分钟后喝水' })
  assert.equal(got.ok, true)
  agency.decide(got.proposal.id, 'approve')
  assert.equal(agency.tick().notified, 0)

  clock += 31 * 60000
  assert.equal(agency.tick().notified, 1)
  const due = agency.list({ status: 'pending' }).find((row) => row.kind === 'reminder_due')
  assert.ok(due)
  assert.equal(due.payload.text, '30分钟后喝水')
  agency.decide(due.id, 'approve')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(spoken, [['main', '30分钟后喝水']])
  assert.ok(agency.listAudit({ limit: 20 }).some((row) => row.event === 'due'))
  rmSync(dir, { recursive: true, force: true })
})
