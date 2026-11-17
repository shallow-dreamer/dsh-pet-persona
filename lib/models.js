/**
 * 模型目录：把宿主 `llm` 服务的 provider/model 列表包成设置页可用的结构。
 *
 * - 只读，不修改宿主配置；
 * - 单个 provider 的 `listModels` 失败只记日志，不影响其它 provider；
 * - 60s 缓存，设置页可 `refresh=1` 强制刷新；
 * - 没有 llm 服务时返回空列表，让设置页降级为文本框。
 *
 * @module dsh-pet-persona/lib/models
 */

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
 * @param {{ ctx: any, log?: ReturnType<import('./log.js').createLogger> | null, now?: () => number, ttlMs?: number, readFollow?: () => any }} options
 */
export function createModelCatalog({ ctx, log = null, now = Date.now, ttlMs = 60_000, readFollow = null } = {}) {
  /** @type {{ providers: any[], models: any[], defaultSelection: any, follow: any, fetchedAt: string, error?: string } | null} */
  let cache = null
  let cachedAt = 0
  /** @type {Promise<any> | null} */
  let inflight = null

  const load = async () => {
    const llm = tryGet(ctx, 'llm')
    const providers = []
    const models = []
    let error = ''

    if (!llm || typeof llm.listProviders !== 'function') {
      error = 'llm service unavailable'
    } else {
      try {
        const listed = await llm.listProviders()
        for (const provider of Array.isArray(listed) ? listed : []) {
          if (!provider || typeof provider.id !== 'string' || provider.id === '') continue
          providers.push({ id: provider.id, name: String(provider.name ?? provider.id) })
        }
      } catch (err) {
        error = `listProviders failed: ${err?.message ?? err}`
        log?.warn?.(`models_list_providers_failed ${error}`)
      }
      for (const provider of providers) {
        try {
          const rows = await llm.listModels(provider.id)
          for (const row of Array.isArray(rows) ? rows : []) {
            if (!row || typeof row.id !== 'string' || row.id === '') continue
            models.push({
              provider: String(row.provider ?? provider.id),
              id: row.id,
              name: String(row.name ?? row.id),
              label: String(row.badge ? `${row.name ?? row.id}（${row.badge}）` : (row.name ?? row.id)),
            })
          }
        } catch (err) {
          log?.warn?.(`models_list_failed provider=${provider.id} ${err?.message ?? err}`)
        }
      }
    }

    let defaultSelection = null
    try {
      const selection = tryGet(ctx, 'agentDefaultModel')?.currentSelection?.() ?? null
      if (selection?.provider && selection?.model) {
        defaultSelection = { provider: String(selection.provider), model: String(selection.model) }
      }
    } catch {
      defaultSelection = null
    }

    let follow = null
    try {
      follow = typeof readFollow === 'function' ? readFollow() : null
    } catch (err) {
      log?.warn?.(`models_follow_failed ${err?.message ?? err}`)
      follow = null
    }

    const result = {
      providers,
      models,
      defaultSelection,
      follow: follow && (follow.provider || follow.model) ? follow : null,
      fetchedAt: new Date(now()).toISOString(),
      ...(error ? { error } : {}),
    }
    cache = result
    cachedAt = now()
    return result
  }

  const list = async ({ refresh = false } = {}) => {
    if (!refresh && cache && now() - cachedAt < ttlMs) return cache
    if (!inflight) {
      inflight = load().finally(() => {
        inflight = null
      })
    }
    return inflight
  }

  return {
    list,
    invalidate: () => {
      cache = null
      cachedAt = 0
    },
  }
}
