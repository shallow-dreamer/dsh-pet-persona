# dsh-pet-persona · 宿主侧接口契约

> 对象：dsh-pet **0.4.5** 宿主半侧（`E:/DeepSeek/dsh-home/profiles/desktop/node_modules/dsh-pet/src/host/`）
> 环境：DSH **0.2.2-rc.1**，profile=`desktop`，`DSH_HOME=E:/DeepSeek/dsh-home`
> 方法：只读源码核实。文中每条结论都带 `文件:行号`；标注「推断」的条目源码里没有直接证据，实施前需实测。

---

## 0. 基线

| 项 | 值 | 依据 |
| --- | --- | --- |
| dsh-pet 版本 | 0.4.5 | `package.json:2` |
| 宿主插件 id | `pet` | `src/host/index.ts:30`（`export const name = 'pet'`）|
| 宿主插件入口 | `src/host/index.ts`，`name/inject/apply` 均在插件入口导出 | `src/host/index.ts:30-36` |
| 服务提供点 | `createHostSetup(ctx)` 内 `ctx.provide('petApi7340', …)` | `src/host/plugin/setup.ts:194-215` |
| 提供时机 | `apply` 第一条语句即调用 `createHostSetup` | `src/host/index.ts:36-37` |

`petApi7340` 分**宿主侧**与**页面侧**两个容器，同名但互不可见、互不覆盖（`src/host/plugin/setup.ts:191-192` 注释）。本文只讲宿主侧（Node 进程里的 Cordis 服务）。

---

## 1. `ctx.provide('petApi7340', …)`：memory.register / list

### 1.1 服务载荷

```ts
ctx.provide('petApi7340', {
  balance: { register, list },
  voice:   { register, list },
  speech:  { register, list },
  memory:  { register, list },   // ← 本文关注点
})
```
`src/host/plugin/setup.ts:194-215`（memory 段在 210-214）。

设计约束（源码注释，`setup.ts:192-193`）：**只暴露 `register`（返回注销函数，配合 `ctx.effect` 在卸载时自动清理）与 `list`（排障用），不暴露 `unregister`** —— 任何插件都无法注销别人注册的 provider，注销只能走 register 的返回值。

### 1.2 确切签名

实现见 `src/host/chat-memory-provider.ts:78-103`，由 `setup.ts:211-214` 直接挂上去：

```ts
// memory.register：同步，立即生效，返回 disposer
function registerChatMemoryProvider(def: ChatMemoryProvider): () => void

// memory.list：只读，排障用
function listChatMemoryProviders(): { builtin: string[]; external: string[] }
```

`memory.register` 的行为（`chat-memory-provider.ts:78-89`）：

1. 校验（79-84），任一不满足**同步抛 `TypeError`**：
   - `def` 非对象 → `'memory provider 定义必须是对象'`
   - `id` 不是非空字符串 → `'id 必须是非空字符串'`
   - `id === 'native'` → `'不能占用原生实现标识: native'`
   - `recall` 与 `capture` 都不是函数 → `'recall 与 capture 至少要有一个是函数'`
2. `current = def`（85）——**单槽、后注册直接覆盖**。
3. 返回闭包（86-88）：`if (current === def) current = null` —— 迟到的 disposer 不会顶掉后来注册者（契约测试 `chat-memory-provider.test.ts:28-35`）。

`memory.list`（`chat-memory-provider.ts:101-103`）：
- `builtin` 恒为 `['native']`
- `external` 是当前第三方 id 的单元素数组，没注册时为 `[]`

### 1.3 注册时机与生命周期

| 事件 | 结果 | 依据 |
| --- | --- | --- |
| 我的插件 `apply` 内调用 `memory.register(def)` | 立即生效；下一次 `chatWithPet` 就开始用它 | `chat-memory-provider.ts:85`；使用点 `plugin/chat-memory.ts:147-149` |
| 我调 disposer（或 `ctx.effect` 在插件卸载时替我调） | 槽清空（仅当仍是我）→ dsh-pet 回到原生记忆路径 | `chat-memory-provider.ts:86-88` |
| 另一插件在我之后注册 | 我静默失效：不报错、不通知，`list().external` 才是真相 | `chat-memory-provider.ts:85, 101-103` |
| dsh-pet 自身卸载 | `petApi7340` 服务被撤销；槽值仍留在模块变量里（生产代码**没有**重置调用） | `chat-memory-provider.ts:69, 109-111`（`resetChatMemoryProviders` 仅测试使用，见 `chat-memory-provider.test.ts:13,18`）|
| 进程重启 | 槽为空，dsh-pet 走原生 | `chat-memory-provider.ts:69` |

注意：provider 槽是**模块级单例**（`chat-memory-provider.ts:69`），不是挂在服务对象上的；因此它比 `petApi7340` 服务本身活得久。若 dsh-pet 被禁用再启用，槽里可能仍是我的旧 provider —— 见 §4「dsh-pet 重载」。

---

## 2. `ChatMemoryProvider` 的 recall / capture

类型定义：`src/host/chat-memory-provider.ts:13-66`；调用与合并：`src/host/plugin/chat-memory.ts`。

```ts
interface ChatTurn { readonly role: 'user' | 'assistant'; readonly content: string; readonly ts: number }
interface ChatContent { readonly system: string; readonly history: readonly ChatTurn[]; readonly userText: string }
interface ChatContentPatch { readonly system?: string; readonly history?: readonly ChatTurn[]; readonly userText?: string }

interface ChatMemoryProvider {
  readonly id: string
  recall?(input: ChatContent & { readonly petId: string }): Promise<ChatContentPatch | undefined> | ChatContentPatch | undefined
  capture?(input: {
    readonly petId: string
    readonly userText: string
    readonly replyText: string
    readonly action?: string   // 动作名，不含素材
    readonly image?: string    // 配图名，不含字节
    readonly ts: number
  }): void | Promise<void>
}
```
（`chat-memory-provider.ts:14-18, 21-25, 28-32, 39-66`）

### 2.1 recall 入参从哪来

每次 `chatWithPet`（`POST /chat` 与 `/chat` 命令共用，见 `plugin/chat-memory.ts:297-298` 注释）：

| 字段 | 内容 | 依据 |
| --- | --- | --- |
| `petId` | 宠物实例 id（不是条目的 assetRoot） | `plugin/chat-memory.ts:348` |
| `system` | **完整**人设串：persona 正文 + 名字声明 + 一行时间背景 +（有历史时）【历史】说明，由 `composeSystemPrompt` 现拼 | `plugin/chat-memory.ts:339, 348-352`；`petSystemPrompt` 在 118-128 |
| `history` | **已截尾**的原生历史：`chatMemoryRounds` 轮（1 轮 = 1 问 1 答），每项只保留 `role/content/ts`，**不带** `image`/`action`/`meme` | `plugin/chat-memory.ts:132-135, 336, 350` |
| `userText` | 本轮用户原始输入 | `plugin/chat-memory.ts:351` |

调用时机细节：
- 只有「生成回复」这条路径调用；**碎碎念 / 梦话不调用**（`publishWhisper` 直接走 `generateWhisper`，`plugin/chat-memory.ts:208-267, 272-295`）。
- 即使历史为空也会调用（348 无条件执行）。
- 在 `withMemoryLock` 串行队列内调用（307 打开锁，348 在锁内）→ **recall 慢 = 整个对话写队列被占住**，不只是这一轮慢。

### 2.2 返回语义：整段**替换**，不是追加

合并代码只有三行（`plugin/chat-memory.ts:356-358`）：

```ts
system:   patch?.system   ?? system,
history:  patch?.history  ?? list,
userText: patch?.userText ?? text,
```

- **`system` 是整段替换**：核心不做任何拼接或追加。想「在 persona 后面加一段」必须自己拼 `input.system + '\n\n' + 附加内容` 再返回；只返回增量文本会把 persona / 名字 / 时间背景全部丢掉。
- `history` 同样是整段替换：返回 `[]` = 清空历史；返回 `undefined` = 保留原生历史。**没有 append 语义。**
- `userText` 整段替换（可用来改写用户输入，例如注入检索到的上下文）。
- 字段筛选按类型逐个收（`plugin/chat-memory.ts:158-161`）：
  - `system`：`typeof === 'string'`
  - `userText`：`typeof === 'string'`
  - `history`：`Array.isArray` 且**每一项**都通过 `isChatTurn`（`role` ∈ `user|assistant`、`content` 为 string、`ts` 为 number，定义在 34-41）—— **一项不合规就整段丢弃**（161）。
  - 空串是合法值（`''` 满足 `typeof === 'string'`）：`system: ''` 会让模型拿到空 system（人设全丢），`userText: ''` 会让模型面对空输入，不建议。
- 返回值不是对象（`null`/字符串/数字）→ 直接忽略（157）。
- 没有任何可应用字段 → 返回 `undefined` 等同「不修改」（162）。

### 2.3 1500ms 硬超时

| 项 | 值 | 依据 |
| --- | --- | --- |
| 常量 | `RECALL_TIMEOUT_MS = 1500` | `plugin/chat-memory.ts:31` |
| 定时器 | `setTimeout(() => resolve(undefined), RECALL_TIMEOUT_MS)`，`timer.unref?.()` | `plugin/chat-memory.ts:152-155` |
| 竞速 | `Promise.race([Promise.resolve(recall.call(provider, {petId, ...content})), timeout])` | `plugin/chat-memory.ts:156` |
| 超时后行为 | race 得到 `undefined` → `!result` → 返回 `undefined` → **用原生 system/history/userText 继续生成** | `plugin/chat-memory.ts:157` |
| 是否记日志 | **不记**。超时走的是 `!result` 分支，`catch` 只接同步抛错 / reject（163-167） | `plugin/chat-memory.ts:156-167` |
| 底层 promise | 不取消，只是被忽略；`Promise.race` 已挂处理器，迟到的 reject 不会变成 unhandled rejection（**推断**，Promise.race 语义）| — |

副作用：这 1.5s 是在 `withMemoryLock` 内消耗的（307/348），会连带阻塞后续 `/chat` 与删历史。**伴生插件的 recall 应把网络/磁盘工作压到几百毫秒内，或先返回同步补丁、结果留到 capture 侧。**

### 2.4 capture

```ts
capture?(input: { petId; userText; replyText; action?; image?; ts }): void | Promise<void>
```
（`chat-memory-provider.ts:58-65`）

| 项 | 结论 | 依据 |
| --- | --- | --- |
| 时机 | 生成成功 → `memory.json` 写盘成功之后 | `plugin/chat-memory.ts:378-386` |
| 失败轮 | 不调用（`generated.ok === false` 在 364 提前返回） | `plugin/chat-memory.ts:364` |
| 碎碎念/梦话 | 不调用 | `208-267, 272-295`（无 capture 调用点）|
| 是否阻塞 | **不阻塞**：`void Promise.resolve().then(() => capture.call(provider, …))`，从不 await | `plugin/chat-memory.ts:186-187` |
| 返回值 | 被忽略 | `chat-memory-provider.ts:54-55` 注释 |
| 抛错/拒绝 | `log.warn('[dsh-pet] 记忆接收失败 id=' + provider.id + '：' + msg)`，不影响回复 | `plugin/chat-memory.ts:188-192` |
| 超时 | **没有**超时、没有重试、没有幂等键（只有 `ts`） | `186-192` |
| 时序 | 不在锁的 await 链上，**不保证**「capture 先于下一次 recall」 | `186` 的 fire-and-forget |

`ts` 与写入原生记忆的两条消息同源（`now = Date.now()`，365, 368-377），可作为对齐原生历史的时间戳。

### 2.5 同一时刻只有一个 provider 吗

**是。** 单槽 `let current`（`chat-memory-provider.ts:69`），注释明确理由（2-6）：记忆后端是二选一，两个 recall 同时改内容会冲突、两个 capture 同时上传会重复写。因此：

- 后注册覆盖先注册（85）；先注册者不会收到任何通知。
- 注销只在「当前仍是这一份」时生效（86-88），所以 A 注册 → B 注册 → A 注销，B 仍然生效（测试 28-35）。
- `id` 不能为 `native`（11, 81）；空 id 拒绝（80）。
- 判断「现在到底是谁在跑」只能 `list().external`（101-103）。

### 2.6 卸载后 dsh-pet 是否恢复正常

会。链路：插件被禁用 → DSH 执行 `ctx.effect` 注册的清理函数（`setup.ts:112-118` 的用法、`setup.ts:192-193` 的注释）→ 调用 register 返回的 disposer → `current = null` → `recallPatch` / `captureTurn` 开头的 `activeChatMemoryProvider()` 返回 `null`，直接 `return`（`plugin/chat-memory.ts:147-149, 183-185`）→ 原生路径，**无需重启 dsh-pet**。

唯一不确定的场景是 **dsh-pet 自身重载**（§4 最后一行）。

---

## 3. 最小可用伴生插件骨架（ESM）

### 3.1 安装形态（与本机已有本地插件一致）

本地插件在 profile 里是 `file:` 依赖 + 进 `bundles` 列表，参照 `E:/DSH/plugins/dsh-independent-input`：

- `E:/DeepSeek/dsh-home/profiles/desktop/package.json:18` → `"dsh-independent-input": "file:E:/DSH/plugins/dsh-independent-input"`
- 同文件 `:52` → bundles 数组里登记 `"dsh-independent-input"`
- 插件入口 `E:/DSH/plugins/dsh-independent-input/index.js:14-15`（`name` / `inject`）、`:285`（`apply`）、`:504-507`（`apply` 返回 disposer）

> 即：新建 `E:/DSH/plugins/dsh-pet-persona/`（`package.json` 里 `"type": "module"` + `main: "index.js"`），在 profile 的 `package.json` 加依赖与 bundles 名。

### 3.2 骨架

```js
// E:/DSH/plugins/dsh-pet-persona/index.js
export const name = 'dsh-pet-persona'
// 只声明 dsh-pet 提供的服务；dsh-pet 不在时 Cordis 会等它出现（推断），apply 不会先跑
export const inject = ['petApi7340']

const PROVIDER_ID = 'dsh-pet-persona'

/**
 * 软取服务：DSH 的 ctx 是严格 getter，未写进 inject 的服务裸读会抛
 * （dsh-pet 自己的注释见 setup.ts:124-126）。缺失要求返回 undefined。
 * ctx.get(name, required) 语义见 setup.ts:121-132。
 */
function getPetApi(ctx) {
  try {
    const get = ctx?.get
    if (typeof get === 'function') return get.call(ctx, 'petApi7340', false) ?? undefined
  } catch { /* 服务已被撤销 / 容器不认这个键 */ }
  return undefined
}

export function apply(ctx) {
  const log = (level, msg) => { try { ctx?.logger?.[level]?.(`[pet-persona] ${msg}`) } catch { /* ignore */ } }

  const api = getPetApi(ctx)
  const memory = api?.memory
  if (typeof memory?.register !== 'function') {
    // 降级：不接管记忆，插件其余功能（纯客户端/纯配置）照常
    log('warn', 'petApi7340.memory 不可用，降级为不接管记忆')
    return
  }

  const provider = {
    id: PROVIDER_ID,
    // 硬约束：<1500ms；返回值只做整段替换，追加要自己拼
    async recall({ petId, system, history, userText }) {
      const extra = await recallPersona(petId, userText) // 自己实现；失败/慢就返回 undefined
      if (!extra) return undefined
      return { system: system + '\n\n' + extra }
      // 也可以改写 history / userText：返回即整段替换（plugin/chat-memory.ts:356-358）
    },
    // 不阻塞；抛错只会被 dsh-pet 记一条 warn
    async capture({ petId, userText, replyText, action, image, ts }) {
      await capturePersona({ petId, userText, replyText, action, image, ts })
    },
  }

  let dispose
  try {
    dispose = memory.register(provider) // 同步；非法定义会抛 TypeError
  } catch (error) {
    log('warn', `记忆接管失败：${error?.message ?? error}`)
    return
  }

  // 卸载清理：effect 回调返回 disposer，Cordis 在插件销毁时调用
  // （dsh-pet 自己也这么用：setup.ts:112-118）
  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => { try { dispose?.() } catch { /* ignore */ } }, 'dsh-pet-persona: memory provider')
  }
}
```

说明：
- `apply` 可以是 async，也可以直接 `return` 一个 disposer（`independent-input/index.js:504-507`）；上面选 `ctx.effect` 是为了与 dsh-pet 的注册方式保持一致。
- 不要在模块顶层缓存 `api` 或 provider 引用跨插件重载；每次 `apply` 重新取、重新注册。
- 自己实现的 `recallPersona` 必须设内部超时（建议 ≤800ms）并吞掉异常；外部 1500ms 超时**不留日志**，排障会很难。

### 3.3 安全降级（`petApi7340` 尚未提供 / 不存在）

| 情形 | 处理 |
| --- | --- |
| dsh-pet 未安装 / 未启用 | `inject: ['petApi7340']` 让 DSH 等待该服务（**推断**，Cordis 注入语义，本次未在 0.2.2-rc.1 源码中验证）；即使 apply 被跑到，`getPetApi` 返回 `undefined`，打一条 warn 后直接退化为「不接管」 |
| 服务存在但 `memory.register` 不是函数（未来版本改形） | 同上，函数存在性检查兜住 |
| `register` 抛 `TypeError` | 捕获 → 记 warn → 不接管；**绝不让异常冒出 apply**，否则整个伴生插件会被判加载失败 |
| 运行中 dsh-pet 被禁用 | 服务撤销、`recall/capture` 不再被调用；我的插件若无其他动作即静默；不建议在循环里轮询 `getPetApi`（会与严格 getter 打架），需要时以 `try/catch` 包裹 |
| 与另一个记忆插件同时装 | 后注册者赢；本插件应在 `apply` 里读一次 `memory.list()` 记日志，便于确认自己是否生效 |

原则：**伴生插件的任何故障都不能改变 dsh-pet 的可用性**。注册失败、recall 抛错、capture 抛错在 dsh-pet 侧全部已隔离（§4），唯一能把事情闹大的是「在 apply 里让异常逸出」和「recall 超过 1500ms」。

---

## 4. 失败模式清单

| # | 触发 | dsh-pet 行为 | 用户可见影响 | 依据 |
| --- | --- | --- | --- | --- |
| 1 | `register` 定义非法 / id 空 / id `'native'` / 两方法都缺 | 同步 `throw TypeError`，槽不变 | 若在 apply 里未捕获：我的插件加载失败；dsh-pet 完全不受影响 | `chat-memory-provider.ts:79-84` |
| 2 | `recall` 同步抛错或 reject | 捕获 → `log.warn('[dsh-pet] 记忆召回失败 id=<id>：<msg>')` → 本轮用原生内容 | 回复正常，记忆未注入 | `plugin/chat-memory.ts:163-167` |
| 3 | `recall` 超过 1500ms | 竞速返回 `undefined` → 不修改内容继续生成；**无日志** | 回复正常，注入静默丢失（最难排障的一类） | `plugin/chat-memory.ts:31, 152-157` |
| 4 | `recall` 返回非法形状（非对象 / 字段类型错 / 历史项缺 `ts`） | 非对象忽略；字段逐个按类型丢；history 一项不合规整段丢；全空 → `undefined` | 回复正常，可能只丢一部分补丁 | `plugin/chat-memory.ts:157-162`、`34-41` |
| 5 | `recall` 返回 `system: ''` | 空 system 原样交给模型 | 人设/时间背景全丢，回复可能跑偏 | `plugin/chat-memory.ts:159, 356` |
| 6 | `recall` 返回 `history: []` | 历史清空（合法） | 模型失去上下文 | `plugin/chat-memory.ts:161, 357` |
| 7 | `capture` 同步抛错或 reject | `log.warn('[dsh-pet] 记忆接收失败 id=<id>：<msg>')`，回复已返回 | 回复不受影响；记忆未上传（静默丢数据） | `plugin/chat-memory.ts:186-192` |
| 8 | `capture` 返回永不 settle 的 Promise | 无超时，promise 悬挂 | 无用户影响，进程里多一个悬挂 promise（每次对话一个） | `plugin/chat-memory.ts:186`（无 race/timeout） |
| 9 | 我的插件被禁用 | `ctx.effect` 清理 → disposer → `current = null` | dsh-pet **立即**恢复原生记忆，无需重启 | `chat-memory-provider.ts:86-88`、`setup.ts:112-118, 192-193` |
| 10 | 我 `apply` 过但 `register` 从未成功 | 槽保持 null（或别人） | 走原生 / 走别人 | `chat-memory-provider.ts:85-88` |
| 11 | 两个伴生插件抢槽 | 后注册者生效，先注册者**静默**失效 | 无报错；排障只能 `list()` | `chat-memory-provider.ts:2-6, 85, 101-103` |
| 12 | dsh-pet 被禁用 | `petApi7340` 撤销；我的 recall/capture 不再被调用 | 桌宠消失；我的插件需自行判断要不要停后台任务 | `setup.ts:194-215` |
| 13 | dsh-pet 被禁用后重新启用 | 槽是否仍是我的 provider 取决于模块是否被重新求值；没有生产代码重置槽，也没有「重注册」钩子 | 可能静默回到原生（**推断 / 待实测**） | `chat-memory-provider.ts:69, 109-111` |
| 14 | 宿主版本升级、接口改名 | 无版本协商、无能力探测（服务对象上没有 `version` 字段） | 只能靠存在性检查降级 | `setup.ts:194-215`（载荷无版本键） |

---

## 5. 核实中与「直觉预期」不符的点

1. **`system` 是整段替换**（`plugin/chat-memory.ts:356`），不是追加。这是最容易误用的契约点：返回增量文本 = 丢掉全部人设。
2. **`history` 不是全量记忆**，而是按用户配置 `chatMemoryRounds` 截尾后的窗口（`plugin/chat-memory.ts:336`，轮数定义 132-135），且已剥掉 `image/action/meme`。
3. **超时与异常处理不对称**：异常有 `warn`，超时完全静默（156-157 vs 163-167）。超时只能靠 `memory.list()` + 行为观察反推。
4. **recall 慢会阻塞整条串行队列**（307 + 348），影响后续所有 `/chat` 与删历史，而不只是当前这一轮。
5. **capture 没有任何可靠性机制**：无超时、无重试、无幂等键（仅 `ts`），丢失与重复都要自己兜（`186-192`）。
6. **第三方 provider 与原生记忆是叠加关系，不是替换**：原生 `memory.json` 照常写（`378`），第三方只是改写「发给模型的内容」并额外收一份 `capture`；它不会阻止原生落盘，也读不到原生文件里的额外字段（`image/action` 已在传给 recall 前剥掉，350）。
7. **没有 unregister**（`setup.ts:192-193` 注释），只有 register 的返回值；且 disposer 是「条件清空」，不能保证一定能把槽清掉。
8. **provider id 不能为 `native`**（`chat-memory-provider.ts:11, 81`）。
9. **dsh-pet 自己的 `inject` 里没有 `petApi7340`**（`src/host/index.ts:32`：`webServer, agentDefaultModel, credentials, llm, commands, connection`）——它是提供方；照抄它的 inject 会拿不到这个服务。

---

## 6. 接口契约摘要（可直接进 SPEC，≤40 行）

```
服务：petApi7340（宿主侧，dsh-pet 0.4.5 在 apply 第一条语句 provide；页面侧同名不同容器）
载荷：{ balance, voice, speech, memory }，每族仅 { register, list }；无 unregister。

memory.register(def) → () => void        // 同步；非法定义抛 TypeError
memory.list() → { builtin: ['native'], external: [id] | [] }

interface ChatMemoryProvider {
  id: string                             // 非空，且 !== 'native'
  recall?(input: { petId, system, history, userText })
    : ChatContentPatch | Promise<ChatContentPatch | undefined> | undefined
  capture?(input: { petId, userText, replyText, action?, image?, ts }): void | Promise<void>
}
// recall/capture 至少实现一个；单槽、后注册覆盖前注册、disposer 条件清空。

recall 入参：system = 完整人设串（persona+名字+时间+【历史】说明）；
             history = 已按 chatMemoryRounds 截尾的原生历史（role/content/ts，无 image/action）；
             userText = 用户原文。
recall 返回：字段级整段替换（system/history/userText 各自 ?? 合并）；无 append 语义；
             history 必须每一项 role∈{user,assistant}、content:string、ts:number，否则整段丢弃；
             空串合法（system:'' = 人设全丢）；返回 undefined/非对象 = 不修改。
recall 超时：1500ms 硬超时；超时与非法形状均降级为「不修改」，超时不留日志；
             调用在对话串行锁内，慢 recall 会阻塞后续对话与删历史。
recall 异常：捕获并 log.warn（含 provider id），本轮用原生内容。

capture 时机：生成成功且 memory.json 落盘之后；失败轮不调用；碎碎念不调用。
capture 语义：fire-and-forget，不阻塞回复；返回值忽略；异常仅 log.warn；
             无超时、无重试、无幂等键（ts 与原生两条消息同源）。

生命周期：注册即在下一轮生效；插件卸载必须经 ctx.effect 调 disposer → 槽 null → 原生路径恢复；
         dsh-pet 自身重载时槽的存续取决于模块缓存，需自愈（待验证）。
降级：以 inject:['petApi7340'] + ctx.get('petApi7340', false) 双重兜底；
     register 抛错必须捕获，绝不让异常逸出 apply；任何故障不得影响 dsh-pet 可用性。
```
