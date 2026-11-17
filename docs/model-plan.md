# 模型选择（v1.0）

> 目标：让设置页的**抽取模型 provider/model** 像 dsh-pet 一样从 DSH 已配置的模型里下拉选择；
> 留空时默认跟随 dsh-pet 的 `chatModel`，再留空则跟随宿主当前对话模型。
> 只影响 capture→learn 的抽取调用，不影响 recall、注入、语音。

## 1. 现状

- `lib/llm.js:50-51`：`provider = config.provider || selection.provider`，`model = config.model || selection.model`；`selection` 来自 `agentDefaultModel.currentSelection()`。
- `lib/persona.js:126-169 readPersona()` 已能读 dsh-pet 用户层 + 默认层 JSONC，只取 `whisperPrompt/name/id`，没读 `chatModel`。
- `client.js:632-639` 是两个文本框，用户必须手写 provider/model，容易写错。
- 宿主 `llm` 服务已公开：
  - `listProviders()` → `{id,name}[]`
  - `listModels(provider)` → `{provider,id,name,description?,inputModalities?,badge?}[]`
  - `listConfigurableProviders()`、`discoverModels()`
- dsh-pet 的解析顺序（`src/host/model-selection.ts:45-57`）：条目 `chatModel` 优先，否则 `agentDefaultModel.currentSelection()`；
  `{provider:'',model:''}` 表示跟随当前对话。

## 2. 解析顺序（写死，不猜）

1. 本插件 `settings.json` 里 `provider`/`model` 都非空 → 用它。
2. 否则读 dsh-pet 当前宠物的 `chatModel`（条目级 → 顶层用户配置 → 默认配置）：
   - `{provider,model}` 都非空 → 用它。
3. 否则用宿主 `agentDefaultModel.currentSelection()`。
4. 都没有 → 抽取不可用，走正则兜底，并在日志里 `llm_unavailable`。

设置页的“跟随 dsh-pet（留空）”= 清空两个字段；显示层要告诉用户**当前生效的是哪一档**（dsh-pet / 宿主默认）。

## 3. 数据与接口

### 3.1 新增 `lib/models.js`

```js
createModelCatalog({ ctx, log, now = Date.now, ttlMs = 60_000 })
  .list({ refresh = false }) -> {
    ok, providers: [{id,name}], models: [{provider,id,name,label}],
    defaultSelection: {provider,model}|null,
    follow: {provider,model,source,petId}|null, // 读 dsh-pet chatModel
    fetchedAt
  }
  .invalidate()
```

- `llm.listModels` 逐个 provider 拉，单个失败不影响其它 provider；异常只 `log.warn`。
- 缓存 60s；设置页点“刷新模型”传 `?refresh=1`。
- 没有 `llm` 服务时返回空列表 + `error:'llm service unavailable'`，页面降级为文本输入。

### 3.2 `lib/persona.js`

新增 `readPetModel({ dataDir, env, petId })`：

- 复用现有 JSONC 读取，返回 `{provider, model, source: 'pet'|'global'|'default-pet'|'default'|'none', petId}`；
- 只接受 provider/model **都非空**的 `{provider,model}`；空对象视为“跟随”，继续向下找；
- 不抛错，读不到返回 `{provider:'',model:'',source:'none'}`。

### 3.3 `lib/llm.js`

`createLlmComplete(ctx, config, log, { resolveFollow })`：

- 解析顺序：`config` → `resolveFollow()?.{provider,model}` → `agentDefaultModel`；
- 成功时 debug 日志 `llm_selected provider=… model=… source=config|pet|default`；
- 设置保存后 `complete.reset()` 仍会重新解析。

### 3.4 `lib/ui.js`

- `createApiHandler({..., models = null })`；
- `GET /pet-persona/api/models`：`await models.list({ refresh: url.searchParams.get('refresh') === '1' })`；
- `/overview` 增 `model: {configured:{provider,model}, follow, defaultSelection}`（只读摘要，不阻塞）。

### 3.5 `index.js`

- 创建 `models = createModelCatalog({ ctx, log: logger })`；
- `createLlmComplete(..., { resolveFollow: () => readPetModel({ dataDir: dir }) })`；
- 把 `models` 传给 `createApiHandler`；初始化失败只 `models_init_failed`，不影响记忆。

## 4. 设置页交互

- provider 下拉：`跟随 dsh-pet（留空）` + `listProviders()`；
- model 下拉：选中 provider 后只列该 provider 的模型；provider 为空时禁用并显示“先选 provider，或留空跟随”；
- 若已保存的 model 不在列表里（模型被删/改名），保留一个 `旧值：xxx` 选项，避免静默清空；
- 下方提示：
  - 留空 → `将使用 dsh-pet 的 chatModel` 或 `将使用宿主默认：provider/model`；
  - 已选 → `抽取将使用 provider/model`。
- 提供“刷新模型”按钮（`/models?refresh=1`）；加载失败时降级为文本框，不阻塞保存。

## 5. 验收

| # | 场景 | 期望 |
| --- | --- | --- |
| M1 | 两字段留空，dsh-pet `chatModel={p,m}` | 抽取用 p/m，日志 `source=pet` |
| M2 | 两字段留空，dsh-pet `chatModel` 为空 | 抽取用宿主 `currentSelection()`，日志 `source=default` |
| M3 | 两字段填 p/m | 抽取用配置值，日志 `source=config` |
| M4 | `GET /models` | 返回 providers/models，单 provider 失败不整体失败 |
| M5 | 模型列表拿不到 | 页面降级文本输入，保存仍可用 |
| M6 | 设置保存后 | 下一次抽取生效，无需重启 |
| M7 | `readPetModel` | 条目级 > 顶层用户 > 默认条目 > 默认顶层；空对象继续下探 |
| M8 | 回归 | 74 项既有单测全绿，recall/voice/self 不受影响 |

## 6. 步骤与时间

1. 计划书（本文件）——0.5h
2. `readPetModel` + `lib/models.js` + 单测——2h
3. `llm.js` / `ui.js` / `index.js` 接线——1.5h
4. `client.js` 下拉与提示——2h
5. 全量测试、安装、热重载、`/models` 实测——1.5h
6. 文档与报告——0.5h

## 7. 风险

- **宿主 llm 服务不可用**：设置页降级文本框；抽取仍按原逻辑走。
- **模型列表很大**：只拉 provider 下的 model，缓存 60s，不自动轮询。
- **dsh-pet 改配置结构**：`readPetModel` 只依赖 `pets[].chatModel` 与顶层 `chatModel`；读不到就返回 none。
- **和 dsh-pet 抢模型**：本插件只在 capture 时调用一次，temperature 0.2，短 prompt；不写 dsh-pet 配置。
