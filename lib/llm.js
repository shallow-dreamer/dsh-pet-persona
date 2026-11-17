/**
 * 抽取用的 LLM 适配层：把宿主的 `llm.stream` 包成一个简单的 `complete({system,user,signal})`。
 *
 * 这里只做「拿到默认 provider/model + 拼消息 + 收文本」三件事：
 * - provider/model 优先取配置，其次取宿主 `agentDefaultModel.currentSelection()`；
 * - `@deepseek-ai/dsh-llm` 只在运行时动态 import（插件包不硬依赖宿主内部包），
 *   拿不到构造器时退回纯对象消息，并自己累积文本块；
 * - 任何一步不可用都返回 null，让 learn 走正则兜底，绝不把异常抛给宿主。
 *
 * @module dsh-pet-persona/lib/llm
 */

const SESSION_ID = 'dsh-pet-persona'

/**
 * @param {any} ctx
 * @param {string} name
 * @returns {any}
 */
function tryGet(ctx, name) {
  try {
    return ctx?.get?.(name, false) ?? null
  } catch {
    return null
  }
}

/**
 * @param {any} ctx 宿主上下文
 * @param {{ model?: string, provider?: string }} config
 * @param {ReturnType<import('./log.js').createLogger>} [log]
 * @param {{ resolveFollow?: () => { provider?: string, model?: string, source?: string } | null }} [options]
 * @returns {(input: { system: string, user: string, signal: AbortSignal }) => Promise<string>}
 */
export function createLlmComplete(ctx, config = {}, log = null, options = {}) {
  /** @type {Promise<{ llm: any, provider: string, model: string, helpers: any } | null> | null} */
  let pending = null

  const resolve = async () => {
    const llm = tryGet(ctx, 'llm')
    if (!llm || typeof llm.stream !== 'function') {
      log?.warn?.('llm_unavailable no llm service')
      return null
    }
    let selection = null
    try {
      selection = tryGet(ctx, 'agentDefaultModel')?.currentSelection?.() ?? null
    } catch {
      selection = null
    }
    let follow = null
    if (typeof config.provider !== 'string' || config.provider.trim() === '' || typeof config.model !== 'string' || config.model.trim() === '') {
      try {
        follow = options?.resolveFollow?.() ?? null
      } catch (error) {
        log?.debug?.(`llm_follow_failed ${error?.message ?? error}`)
        follow = null
      }
    }
    const configured = String(config.provider || '').trim() !== '' && String(config.model || '').trim() !== ''
    const provider = configured ? String(config.provider).trim() : String(follow?.provider || selection?.provider || '')
    const model = configured ? String(config.model).trim() : String(follow?.model || selection?.model || '')
    if (provider === '' || model === '') {
      log?.warn?.('llm_unavailable no provider/model')
      return null
    }
    log?.debug?.(`llm_selected provider=${provider} model=${model} source=${configured ? 'config' : follow?.provider ? (follow?.source ?? 'pet') : 'default'}`)
    let helpers = null
    try {
      helpers = await import('@deepseek-ai/dsh-llm')
    } catch {
      log?.debug?.('llm_helpers_unavailable fallback=plain-messages')
    }
    return { llm, provider, model, helpers }
  }

  const complete = async ({ system, user, signal }) => {
    pending ??= resolve().catch((error) => {
      log?.warn?.(`llm_resolve_failed ${error?.message ?? error}`)
      return null
    })
    const ready = await pending
    if (!ready) return ''
    const { llm, provider, model, helpers } = ready

    /** @type {any[]} */
    const messages = []
    if (typeof helpers?.createUserMessage === 'function') {
      messages.push(helpers.createUserMessage({ content: [{ type: 'text', text: user }], source: { kind: 'user' } }))
    } else {
      messages.push({ role: 'user', content: [{ type: 'text', text: user }] })
    }

    /** @type {Record<string, any>} */
    const options = {
      provider,
      model,
      sessionId: SESSION_ID,
      messages,
      system,
      temperature: 0.2,
      ...(signal ? { signal } : {}),
    }

    if (typeof helpers?.BlockAssembler === 'function') {
      const assembler = new helpers.BlockAssembler()
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      return assembler
        .blocks()
        .filter((block) => block?.type === 'text')
        .map((block) => (typeof block.text === 'string' ? block.text : ''))
        .join('')
        .trim()
    }

    // 兜底：不知道 chunk 具体形状时，尽量从常见文本增量里拼
    let text = ''
    for await (const chunk of llm.stream(options)) {
      if (typeof chunk === 'string') text += chunk
      else if (Array.isArray(chunk?.content)) {
        for (const block of chunk.content) if (block?.type === 'text' && typeof block.text === 'string') text += block.text
      } else if (typeof chunk?.text === 'string') text += chunk.text
      else if (typeof chunk?.delta === 'string') text += chunk.delta
    }
    return text.trim()
  }

  // 设置页改了 model/provider 之后，下一次抽取重新解析 provider/model。
  complete.reset = () => {
    pending = null
  }
  return complete
}
