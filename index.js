/**
 * dsh-pet-persona · 桌宠长期事实记忆
 *
 * 只做两件事：
 * 1. 通过 `petApi7340.memory.register` 注册一个第三方记忆 provider：对话前把相关事实
 *    拼进 system（base + "\n\n" + 【长期记忆】块），对话后把这一轮收进队列并异步抽取；
 * 2. 事实全部落在 `<DSH_HOME>/pet-persona/facts.jsonl`，按 key 去重、按 validTo 归档。
 *
 * 边界（见 SPEC）：不改 dsh-pet；注入块不含人格指令；recall 同步且无 IO；任何失败都降级为
 * 「不修改内容」，绝不拖住回复。
 *
 * @module dsh-pet-persona
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { normalizeConfig } from './lib/config.js'
import { FactStore } from './lib/facts.js'
import { createLearner } from './lib/learn.js'
import { isPersonaInstruction } from './lib/learn.js'
import { createLlmComplete } from './lib/llm.js'
import { createLogger } from './lib/log.js'
import { createModelCatalog } from './lib/models.js'
import { readPetModel } from './lib/persona.js'
import { createRecall } from './lib/recall.js'
import { buildSelfBlock } from './lib/self-context.js'
import { SelfStore } from './lib/self.js'
import { createAgency } from './lib/agency.js'
import { createAutonomy } from './lib/autonomy.js'
import { loadSynonymIndex } from './lib/synonyms.js'
import { createApiHandler, readSettings, writeSettings } from './lib/ui.js'
import { createVoiceService } from './lib/voice.js'
import { createEmotionTts } from './lib/tts-emotion.js'
import { createWhisperWatch } from './lib/whisper.js'
import { createEnergyStore, createEnergyWatch } from './lib/energy.js'

export const name = 'dsh-pet-persona'
export const inject = ['petApi7340']

// 保持旧的导出路径可用（单测/脚本从 index.js 导入过）
export { normalizeConfig } from './lib/config.js'

/** 数据目录：规范要求 `<DSH_HOME>/pet-persona/`；没有 DSH_HOME 时退回 `~/.dsh`。 */
export function resolveDataDir(env = process.env) {
  const base = env.DSH_HOME && String(env.DSH_HOME).trim() !== '' ? String(env.DSH_HOME) : join(homedir(), '.dsh')
  return join(base, 'pet-persona')
}

/**
 * @param {any} ctx
 * @returns {any}
 */
function resolvePetApi(ctx) {
  try {
    return ctx?.get?.('petApi7340', false) ?? ctx?.petApi7340 ?? null
  } catch {
    return null
  }
}

/**
 * @param {any} ctx Cordis 上下文
 * @param {Record<string, any>} rawConfig 插件配置（cordis.patch.yml）
 * @returns {(() => void) | undefined} 顶层 disposer（与 ctx.effect 的 disposer 二选一，幂等）
 */
export function apply(ctx, rawConfig = {}) {
  const dir = resolveDataDir()
  // 设置页保存过的值优先于 cordis 配置；读失败就退回 rawConfig。
  const stored = readSettings(dir)
  const config = normalizeConfig({ ...(rawConfig && typeof rawConfig === 'object' ? rawConfig : {}), ...stored })
  if (!config.enabled) {
    try {
      ctx?.logger?.info?.('[dsh-pet-persona] enabled=false，未注册记忆 provider')
    } catch {
      /* 日志失败不影响卸载 */
    }
    return undefined
  }

  const logger = createLogger({
    dir,
    sink: (level, msg) => {
      try {
        ctx?.logger?.[level]?.(`[dsh-pet-persona] ${msg}`)
      } catch {
        /* ignore */
      }
    },
  })

  const synonyms = loadSynonymIndex(logger)
  const recallEngine = createRecall({ synonyms, log: logger })
  const store = new FactStore({ dir, maxFacts: config.maxFacts, log: logger })
  // 启动必须同步读完：apply 返回后宿主随时可能发起第一轮 recall
  try {
    store.initSync()
    logger.info(`facts_loaded dir=${dir} ${JSON.stringify(store.stats())}`)
  } catch (error) {
    logger.error(`facts_init_failed ${error?.stack ?? error}`)
  }

  // 自我记忆：独立文件、独立失败域；初始化失败只关这一层，不影响主人事实。
  /** @type {any} */
  let self = null
  try {
    self = new SelfStore({ dir, maxEntries: config.selfMaxEntries, log: logger })
    self.initSync()
    logger.info(`self_loaded ${JSON.stringify(self.stats())} enabled=${config.selfEnabled ? 1 : 0}`)
  } catch (error) {
    logger.warn(`self_init_failed ${error?.stack ?? error}`)
    self = null
  }

  // 碎碎念观察：只读 dsh-pet /state，把非聊天回复的新气泡记进自我记忆。
  // 与 speak 共用 webServer origin；dsh-pet 不在时 getOrigin 为空，轮询自己会跳过。
  let whisperWatch = null
  try {
    if (self && config.selfEnabled) {
      whisperWatch = createWhisperWatch({
        petId: 'main',
        self,
        log: logger,
        getOrigin: () => {
          const service = ctx?.get?.('webServer', false) ?? null
          return typeof service?.getOrigin === 'function' ? service.getOrigin() : ''
        },
      })
      whisperWatch.start()
      logger.info('whisper_watch_started petId=main')
    }
  } catch (error) {
    logger.warn(`whisper_watch_failed ${error?.message ?? error}`)
    whisperWatch = null
  }

  const speak = async (petId, text) => {
    const service = ctx?.get?.('webServer', false) ?? null
    const origin = typeof service?.getOrigin === 'function' ? service.getOrigin() : ''
    if (!origin) throw new Error('web origin unavailable')
    const res = await fetch(`${origin}/dsh-pet-7340/broadcast?pet=${encodeURIComponent(String(petId ?? 'main'))}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: String(text ?? ''), duration: 8000 }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) throw new Error(`broadcast failed: ${body?.reason ?? res.status}`)
    whisperWatch?.noteSpoken(String(text ?? ''))
    return body
  }

  // 精力：独立文件与定时器；dsh-pet 不可达时只跳过本 tick。
  /** @type {any} */
  let energy = null
  try {
    if (config.energyEnabled) {
      const energyStore = createEnergyStore({
        dir,
        petId: 'main',
        log: logger,
        config: {
          start: config.energyStart,
          awakeDrainPerHour: config.energyDrainPerHour,
          asleepRecoverPerHour: config.energyRecoverPerHour,
          sleepAt: config.energySleepAt,
          wakeAt: config.energyWakeAt,
          wakePenalty: config.energyWakePenalty,
          workEnabled: config.energyWorkEnabled !== false,
          workDrainPerHour: config.energyWorkDrainPerHour,
          thinkDrainPerHour: config.energyThinkDrainPerHour,
          waitDrainPerHour: config.energyWaitDrainPerHour,
          resultDrainPerHour: config.energyResultDrainPerHour,
        },
      })
      energy = createEnergyWatch({
        store: energyStore,
        petId: 'main',
        log: logger,
        speak: (petId, text) => speak(petId, text),
        getOrigin: () => {
          const service = ctx?.get?.('webServer', false) ?? null
          return typeof service?.getOrigin === 'function' ? service.getOrigin() : ''
        },
      })
      energy.start()
      logger.info(`energy_loaded ${JSON.stringify(energy.status())}`)
    }
  } catch (error) {
    logger.warn(`energy_init_failed ${error?.message ?? error}`)
    energy = null
  }

  let agency = null
  try {
    agency = createAgency({
      dir,
      maxPending: config.agencyMaxPending,
      noteMaxChars: config.agencyNoteMaxChars,
      self,
      facts: store,
      log: logger,
      speak,
      onExecuted: (proposal) => {
        if (!self || !config.selfEnabled) return
        const texts = {
          note: '帮主人记下了一条笔记。',
          reminder: '帮主人记下了一个提醒。',
          digest: '整理了一段今天的心情。',
          reminder_due: '提醒到点了，我告诉了主人。',
          tidy: '提醒主人可以整理一下记忆了。',
        }
        self.note({
          petId: proposal?.petId || 'main',
          text: texts[proposal?.kind] || '帮主人做了一件小事。',
          source: 'agency',
          importance: 3,
        })
        recallEngine.invalidate()
      },
    })
    agency.initSync()
    if (config.agencyEnabled) agency.startTicker(30000)
    logger.info(`agency_loaded ${JSON.stringify(agency.stats())} enabled=${config.agencyEnabled ? 1 : 0}`)
  } catch (error) {
    logger.warn(`agency_init_failed ${error?.stack ?? error}`)
    agency = null
  }

  // L3-A 主动观察：独立于 agency；异常只降级，不影响记忆。
  /** @type {any} */
  let autonomy = null
  try {
    autonomy = createAutonomy({
      dir, config, self, facts: store, agency, log: logger, speak,
      onDecision: (row) => {
        if (!self || !config.selfEnabled) return
        const prefix = row.decision === 'speak' ? '主动说了一句：' : '本来想说一句：'
        self.note({
          petId: 'main',
          text: `${prefix}${row.text || ''}`,
          kind: 'thought',
          source: 'autonomy',
          importance: 2,
        })
        recallEngine.invalidate()
      },
    })
    autonomy.initSync()
    if (config.agencyEnabled && config.autonomyLevel !== 'off') autonomy.start()
    logger.info(`autonomy_loaded level=${config.autonomyLevel} enabled=${config.agencyEnabled ? 1 : 0}`)
  } catch (error) {
    logger.warn(`autonomy_init_failed ${error?.stack ?? error}`)
    autonomy = null
  }

  const models = createModelCatalog({
    ctx,
    log: logger,
    readFollow: () => readPetModel({ dataDir: dir }),
  })
  const complete = createLlmComplete(ctx, config, logger, {
    resolveFollow: () => readPetModel({ dataDir: dir }),
  })
  const learner = createLearner({
    store,
    config,
    log: logger,
    complete,
    onMerged: () => {
      // 写入后旧块立即失效，避免下一次 recall 命中过期缓存
      recallEngine.invalidate()
    },
    dir,
  })

  const petApi = resolvePetApi(ctx)

  // 语音服务独立初始化：失败只关语音，绝不影响记忆与设置页
  /** @type {any} */
  let voice = null
  try {
    voice = createVoiceService({ ctx, config, dir, log: logger })
    logger.info(
      `voice_ready wake=${voice.wakeWord()} enrolled=${voice.store?.enrolled ? 1 : 0} enabled=${config.voiceEnabled ? 1 : 0}`,
    )
  } catch (error) {
    logger.warn(`voice_init_failed ${error?.stack ?? error}`)
    voice = null
  }

  // 情绪语音（免费版）：注册一个自定义 VoiceProvider；默认关，关闭即回原生 Edge。
  /** @type {null | (() => void)} */
  let ttsDisposer = null
  const syncEmotionTts = () => {
    try {
      ttsDisposer?.()
    } catch {
      /* ignore */
    }
    ttsDisposer = null
    if (!config.ttsEmotion) return
    if (!petApi?.voice || typeof petApi.voice.register !== 'function') {
      logger.warn('tts_emotion_unavailable petApi.voice.register missing')
      return
    }
    try {
      const provider = createEmotionTts({ log: logger, intensity: config.ttsEmotionIntensity })
      ttsDisposer = petApi.voice.register(provider)
      logger.info(`tts_emotion_registered provider=${provider.id} intensity=${config.ttsEmotionIntensity}`)
    } catch (error) {
      logger.warn(`tts_emotion_failed ${error?.stack ?? error}`)
    }
  }
  syncEmotionTts()

  /**
   * 设置页保存：原地更新运行中的配置并持久化，随后让缓存与 LLM 解析失效。
   * @param {Record<string, any>} next 已经 normalizeConfig 过的完整配置
   */
  const applySettings = (next) => {
    Object.assign(config, next)
    store.maxFacts = config.maxFacts
    if (self) self.maxEntries = config.selfMaxEntries
    agency?.setLimits?.({ maxPending: config.agencyMaxPending, noteMaxChars: config.agencyNoteMaxChars })
    if (agency) {
      if (config.agencyEnabled) agency.startTicker?.(30000)
      else agency.stopTicker?.()
    }
    if (autonomy) {
      if (config.agencyEnabled && config.autonomyLevel !== 'off') autonomy.start()
      else autonomy.stop()
    }
    recallEngine.invalidate()
    complete.reset?.()
    syncEmotionTts()
    try {
      writeSettings(dir, {
        budgetChars: config.budgetChars,
        autoLearn: config.autoLearn,
        learnEveryTurns: config.learnEveryTurns,
        idleLearnMs: config.idleLearnMs,
        maxFacts: config.maxFacts,
        model: config.model,
        provider: config.provider,
        voiceEnabled: config.voiceEnabled,
        voiceWakeWord: config.voiceWakeWord,
        voiceRequire: config.voiceRequire,
        voiceThreshold: config.voiceThreshold,
        voiceLanguage: config.voiceLanguage,
        voiceKeepTranscript: config.voiceKeepTranscript,
        ttsEmotion: config.ttsEmotion,
        ttsEmotionIntensity: config.ttsEmotionIntensity,
        selfEnabled: config.selfEnabled,
        selfMaxEntries: config.selfMaxEntries,
        selfInject: config.selfInject,
        selfBudget: config.selfBudget,
        selfInjectMaxEvents: config.selfInjectMaxEvents,
        selfInjectWindowH: config.selfInjectWindowH,
        selfInjectQuotes: config.selfInjectQuotes,
        agencyEnabled: config.agencyEnabled,
        agencyMaxPending: config.agencyMaxPending,
        agencyNoteMaxChars: config.agencyNoteMaxChars,
        autonomyLevel: config.autonomyLevel,
        autonomyDailyMax: config.autonomyDailyMax,
        autonomyQuietStart: config.autonomyQuietStart,
        autonomyQuietEnd: config.autonomyQuietEnd,
        autonomyCooldownH: config.autonomyCooldownH,
        autonomyIgnoreDecay: config.autonomyIgnoreDecay,
      })
    } catch (error) {
      logger.warn(`settings_write_failed ${error?.stack ?? error}`)
    }
    logger.info(
      `settings_saved budget=${config.budgetChars} autoLearn=${config.autoLearn ? 1 : 0} turns=${config.learnEveryTurns} idle=${config.idleLearnMs} maxFacts=${config.maxFacts} model=${config.model || '-'}`,
    )
    return config
  }

  // 设置页后端：即使 petApi 不在也要能打开页面（只是显示未注册）。
  const webServer = (() => {
    try {
      return ctx?.get?.('webServer', false) ?? null
    } catch {
      return null
    }
  })()
  if (webServer && typeof webServer.register === 'function') {
    try {
      const api = createApiHandler({ config, store, recallEngine, logger, petApi, dir, applySettings, voice, self, models, agency, autonomy, whisperWatch, energy })
      const mount = () => {
        const off = webServer.register({ kind: 'prefix', path: '/pet-persona/api', handler: api.handler })
        logger.info(`settings_api_mounted dir=${dir}`)
        return typeof off === 'function' ? off : undefined
      }
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => mount(), 'dsh-pet-persona: settings api')
      } else {
        mount()
      }
    } catch (error) {
      logger.warn(`settings_api_failed ${error?.stack ?? error}`)
    }
  } else {
    logger.debug('settings_api_skipped webServer unavailable')
  }

  if (!petApi || !petApi.memory || typeof petApi.memory.register !== 'function') {
    logger.warn('petApi7340.memory 不可用：插件保持空转（数据层仍已初始化）')
    return () => {
      try {
        ttsDisposer?.()
      } catch {
        /* ignore */
      }
      try {
        voice?.dispose?.()
      } catch {
        /* ignore */
      }
      void self?.dispose?.()
      void autonomy?.dispose?.()
      void agency?.dispose?.()
      void learner.dispose()
      void store.dispose()
      void logger.dispose()
    }
  }

  /** @type {(() => void) | null} */
  let unregister = null
  let stopped = false

  const definition = {
    id: 'dsh-pet-persona',
    /**
     * 宿主：对话前同步调用（也接受 Promise，但我们永远同步返回）。
     * @param {{ petId: string, system: string, history: any[], userText: string }} input
     */
    recall(input) {
      const started = Date.now()
      try {
        if (config.debugRecallThrow) throw new Error('debug recall failure')
        if (config.debugRecallDelayMs > 0) {
          // 只用于验收「慢 recall 不拖住回复」：故意同步阻塞
          const until = Date.now() + config.debugRecallDelayMs
          while (Date.now() < until) {
            /* busy wait */
          }
        }
        if (!store.loaded) return undefined
        const petId = typeof input?.petId === 'string' && input.petId !== '' ? input.petId : 'default'
        // P2：自我块是独立的追加段，失败只丢这一层，事实块照常。
        let selfBlock
        if (config.selfInject && self) {
          try {
            const built = buildSelfBlock({
              state: self.state(petId),
              events: self.recent(petId, 24),
              budgetChars: config.selfBudget,
              maxEvents: config.selfInjectMaxEvents,
              windowH: config.selfInjectWindowH,
              quotes: config.selfInjectQuotes,
            })
            selfBlock = built.block
            if (selfBlock) {
              logger.debug(`self_inject petId=${petId} chars=${[...selfBlock].length} events=${built.eventIds.length}`)
            }
          } catch (error) {
            logger.warn(`self_inject_failed petId=${petId} ${error?.stack ?? error}`)
            selfBlock = undefined
          }
        }
        const result = recallEngine.recall(input ?? {}, store.active, {
          budgetChars: config.budgetChars,
          petId,
          selfBlock,
        })
        if (result.block === undefined || result.block === '') return undefined
        for (const id of result.hits) store.recordHit(id)
        const base = typeof input?.system === 'string' ? input.system : ''
        const system = base === '' ? result.block : `${base}\n\n${result.block}`
        logger.info(`recall_ok petId=${petId} facts=${result.hits.length} chars=${result.block.length} elapsed=${Date.now() - started}ms`)
        return { system }
      } catch (error) {
        logger.warn(`recall_error petId=${input?.petId ?? '?'} ${error?.stack ?? error}`)
        return undefined
      }
    },
    /**
     * 宿主：落盘后 fire-and-forget 调用，返回值被忽略。
     * @param {{ petId: string, userText: string, replyText: string, ts: number }} input
     */
    capture(input) {
      try {
        whisperWatch?.noteChatReply(input?.replyText)
        learner.capture(input ?? {})
      } catch (error) {
        logger.warn(`capture_error ${error?.stack ?? error}`)
      }
      // 自我记忆独立于事实抽取：失败只丢这一条，不影响 capture 主流程。
      try {
        if (config.selfEnabled && self && !isPersonaInstruction(input?.userText)) {
          self.record({
            petId: input?.petId,
            userText: input?.userText,
            replyText: input?.replyText,
            ts: input?.ts,
          })
          // 自我块内容变了；让 recall 的块缓存下次重建（即使 key 已含 selfBlock，也保持一致）。
          recallEngine.invalidate()
        }
      } catch (error) {
        logger.warn(`self_capture_failed ${error?.stack ?? error}`)
      }
      // L1 观察：只在桌宠对话里识别「记一下 / 提醒我」这类明确请求，只生成待确认提议。
      try {
        if (config.agencyEnabled && agency) {
          agency.observe({
            petId: input?.petId,
            userText: input?.userText,
            replyText: input?.replyText,
            ts: input?.ts,
          })
        }
      } catch (error) {
        logger.warn(`agency_observe_failed ${error?.stack ?? error}`)
      }
      // L3-A：记录互动，并立即做一次主动判断（不阻塞 capture）。
      try {
        if (config.agencyEnabled && autonomy) {
          autonomy.noteCapture({ ts: Number(input?.ts) || Date.now(), text: input?.userText })
          autonomy.tick(undefined, input?.petId || 'main').catch((error) => {
            logger.warn(`autonomy_tick_failed ${error?.stack ?? error}`)
          })
        }
      } catch (error) {
        logger.warn(`autonomy_note_failed ${error?.stack ?? error}`)
      }
    },
  }

  const register = () => {
    if (unregister) return
    try {
      const undo = petApi.memory.register(definition)
      unregister = typeof undo === 'function' ? undo : null
      logger.info(`memory_registered id=${definition.id} disposer=${unregister ? 'yes' : 'no'}`)
      try {
        logger.info(`memory_list ${JSON.stringify(petApi.memory.list())}`)
      } catch {
        /* list 只是排障 */
      }
    } catch (error) {
      logger.error(`memory_register_failed ${error?.stack ?? error}`)
    }
  }

  const teardown = () => {
    if (stopped) return
    stopped = true
    try {
      unregister?.()
    } catch (error) {
      logger.warn(`memory_unregister_failed ${error?.message ?? error}`)
    }
    unregister = null
    recallEngine.invalidate()
    try {
      whisperWatch?.stop?.()
    } catch {
      /* ignore */
    }
    whisperWatch = null
    try {
      ttsDisposer?.()
    } catch {
      /* ignore */
    }
    ttsDisposer = null
    try {
      voice?.dispose?.()
    } catch {
      /* ignore */
    }
    void self?.dispose?.()
    void autonomy?.dispose?.()
    void agency?.dispose?.()
    void learner.dispose()
    void store.dispose()
    void logger.dispose()
  }

  try {
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => {
        register()
        return teardown
      }, 'dsh-pet-persona: memory provider')
    } else {
      register()
    }
  } catch (error) {
    logger.error(`apply_effect_failed ${error?.stack ?? error}`)
    register()
  }

  return teardown
}
