/**
 * 配置默认值与归一（独立成模块，供 index.js 与设置页 API 共用，避免循环依赖）。
 *
 * @module dsh-pet-persona/lib/config
 */

export const DEFAULTS = Object.freeze({
  enabled: true,
  budgetChars: 1200,
  autoLearn: true,
  learnEveryTurns: 6,
  idleLearnMs: 60_000,
  maxFacts: 500,
  model: '',
  provider: '',
  // 语音（见 docs/voice-plan.md）：默认全关，用户打开并登记声纹后才工作
  voiceEnabled: false,
  voiceWakeWord: '',
  voiceRequire: true,
  voiceThreshold: 0.8,
  voiceLanguage: 'zh',
  voiceKeepTranscript: true,
  // 情绪语音（免费版，见 docs/tts-emotion-plan.md）：默认关，打开后需在 dsh-pet 语音设置里选新 provider
  ttsEmotion: false,
  ttsEmotionIntensity: 1,
  // 自我记忆（见 docs/self-plan.md）：P1 只记录+展示；P2 注入默认关，用户手动打开
  selfEnabled: true,
  selfMaxEntries: 500,
  selfInject: false,
  selfBudget: 160,
  selfInjectMaxEvents: 3,
  selfInjectWindowH: 36,
  selfInjectQuotes: false,
  // 精力（见 docs/energy-plan.md）：默认开；数值全部可调
  energyEnabled: true,
  energyStart: 100,
  energyDrainPerHour: 6,
  energyRecoverPerHour: 36,
  energySleepAt: 20,
  energyWakeAt: 100,
  energyWakePenalty: 5,
  energyWorkEnabled: true,
  energyWorkDrainPerHour: 18,
  energyThinkDrainPerHour: 12,
  energyWaitDrainPerHour: 4,
  energyResultDrainPerHour: 9,
  agencyEnabled: true,
  agencyMaxPending: 20,
  agencyNoteMaxChars: 200,
  // L3-A 主动观察（见 docs/agency-l3-plan.md）：默认只观察，不主动说话
  autonomyLevel: 'observe',
  autonomyDailyMax: 3,
  autonomyQuietStart: '23:30',
  autonomyQuietEnd: '08:00',
  autonomyCooldownH: 6,
  autonomyIgnoreDecay: 2,
})

/**
 * 配置归一：所有数值夹到合理区间，坏值回落默认，绝不让配置把插件打挂。
 * @param {Record<string, any>} raw
 */
export function normalizeConfig(raw = {}) {
  const value = raw && typeof raw === 'object' ? raw : {}
  const int = (input, fallback, min, max) => {
    const n = Number(input)
    if (!Number.isFinite(n)) return fallback
    return Math.min(max, Math.max(min, Math.floor(n)))
  }
  const energySleepAt = clampFloat(value.energySleepAt, DEFAULTS.energySleepAt, 1, 60)
  const energyWakeAt = clampFloat(value.energyWakeAt, DEFAULTS.energyWakeAt, Math.min(100, energySleepAt + 10), 100)
  const energyDrainPerHour = clampFloat(value.energyDrainPerHour, DEFAULTS.energyDrainPerHour, 0.5, 30)
  return {
    ...DEFAULTS,
    enabled: value.enabled !== false,
    budgetChars: int(value.budgetChars, DEFAULTS.budgetChars, 120, 8_000),
    autoLearn: value.autoLearn !== false,
    learnEveryTurns: int(value.learnEveryTurns, DEFAULTS.learnEveryTurns, 1, 100),
    idleLearnMs: int(value.idleLearnMs, DEFAULTS.idleLearnMs, 5_000, 3_600_000),
    maxFacts: int(value.maxFacts, DEFAULTS.maxFacts, 20, 5_000),
    model: typeof value.model === 'string' ? value.model.trim() : '',
    provider: typeof value.provider === 'string' ? value.provider.trim() : '',
    voiceEnabled: value.voiceEnabled === true,
    // 留空 = 跟随桌宠名字（用户填了就不再自动跟随）
    voiceWakeWord: typeof value.voiceWakeWord === 'string' ? value.voiceWakeWord.trim().slice(0, 20) : '',
    // 默认必须声纹；只有用户显式关闭才放行
    voiceRequire: value.voiceRequire !== false,
    voiceThreshold: clampFloat(value.voiceThreshold, DEFAULTS.voiceThreshold, 0.5, 0.98),
    voiceLanguage: normalizeLanguage(value.voiceLanguage),
    voiceKeepTranscript: value.voiceKeepTranscript !== false,
    ttsEmotion: value.ttsEmotion === true,
    ttsEmotionIntensity: clampFloat(value.ttsEmotionIntensity, DEFAULTS.ttsEmotionIntensity, 0.5, 1.5),
    selfEnabled: value.selfEnabled !== false,
    selfMaxEntries: int(value.selfMaxEntries, DEFAULTS.selfMaxEntries, 20, 5_000),
    selfInject: value.selfInject === true,
    selfBudget: int(value.selfBudget, DEFAULTS.selfBudget, 80, 800),
    selfInjectMaxEvents: int(value.selfInjectMaxEvents, DEFAULTS.selfInjectMaxEvents, 1, 5),
    selfInjectWindowH: int(value.selfInjectWindowH, DEFAULTS.selfInjectWindowH, 6, 72),
    selfInjectQuotes: value.selfInjectQuotes === true,
    energyEnabled: value.energyEnabled !== false,
    energyStart: clampFloat(value.energyStart, DEFAULTS.energyStart, 0, 100),
    energyDrainPerHour,
    energyWorkEnabled: value.energyWorkEnabled !== false,
    energyWorkDrainPerHour: clampFloat(value.energyWorkDrainPerHour, DEFAULTS.energyWorkDrainPerHour, Math.max(energyDrainPerHour, 0.5), 60),
    energyThinkDrainPerHour: clampFloat(value.energyThinkDrainPerHour, DEFAULTS.energyThinkDrainPerHour, 0.5, 60),
    energyWaitDrainPerHour: clampFloat(value.energyWaitDrainPerHour, DEFAULTS.energyWaitDrainPerHour, 0, 30),
    energyResultDrainPerHour: clampFloat(value.energyResultDrainPerHour, DEFAULTS.energyResultDrainPerHour, 0.5, 60),
    energyRecoverPerHour: clampFloat(value.energyRecoverPerHour, DEFAULTS.energyRecoverPerHour, 1, 120),
    energySleepAt,
    energyWakeAt,
    energyWakePenalty: clampFloat(value.energyWakePenalty, DEFAULTS.energyWakePenalty, 0, 30),
    agencyEnabled: value.agencyEnabled !== false,
    agencyMaxPending: int(value.agencyMaxPending, DEFAULTS.agencyMaxPending, 1, 100),
    agencyNoteMaxChars: int(value.agencyNoteMaxChars, DEFAULTS.agencyNoteMaxChars, 20, 500),
    autonomyLevel: normalizeLevel(value.autonomyLevel),
    autonomyDailyMax: int(value.autonomyDailyMax, DEFAULTS.autonomyDailyMax, 1, 10),
    autonomyQuietStart: normalizeClock(value.autonomyQuietStart, DEFAULTS.autonomyQuietStart),
    autonomyQuietEnd: normalizeClock(value.autonomyQuietEnd, DEFAULTS.autonomyQuietEnd),
    autonomyCooldownH: int(value.autonomyCooldownH, DEFAULTS.autonomyCooldownH, 1, 24),
    autonomyIgnoreDecay: int(value.autonomyIgnoreDecay, DEFAULTS.autonomyIgnoreDecay, 1, 5),
    // 只给验收/单测用的钩子，不影响正常路径
    debugRecallDelayMs: int(value.debugRecallDelayMs, 0, 0, 5_000),
    debugRecallThrow: value.debugRecallThrow === true,
  }
}

function clampFloat(input, fallback, min, max) {
  const n = Number(input)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n * 100) / 100))
}

function normalizeLevel(input) {
  const value = typeof input === 'string' ? input.trim().toLowerCase() : ''
  return ['off', 'observe', 'assist', 'auto'].includes(value) ? value : DEFAULTS.autonomyLevel
}

function normalizeClock(input, fallback) {
  const value = typeof input === 'string' ? input.trim() : ''
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback
}

const LANGUAGE_PATTERN = /^[a-z]{2,3}(?:-[A-Za-z]{2,4})?$/

function normalizeLanguage(input) {
  const value = typeof input === 'string' ? input.trim() : ''
  return LANGUAGE_PATTERN.test(value) ? value : DEFAULTS.voiceLanguage
}
