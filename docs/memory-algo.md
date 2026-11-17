# dsh-pet-persona — 记忆算法（memory-algo）

> 上游契约：`docs/host-api.md`（接口）。本文只定义**记忆本身**：存什么、怎么取、怎么学、怎么写盘。
> 一句话：`recall` 是**纯本地、纯同步、无 IO** 的检索 + 拼字符串；`capture` 是**异步、可失败、不阻塞回复**的抽取与合并。人格不在这里。

## 0. 设计前提（决定后面所有取舍）

| 事实 | 推论 |
| --- | --- |
| `recall` 有 1500ms 硬超时，超时 = 这一轮记忆**丢失**（不是报错） | recall 内部自设 400ms 软截止，超了直接 `return undefined`；绝不 `await` 网络/LLM |
| `recall` 返回的 `system` 是**整段替换** | 必须 `base + block`，`base` 逐字取自 `input.system`；拿不到 `base` 就不注入 |
| `capture` 在落盘后异步调用、不阻塞 | 抽取失败只写日志；丢一轮事实可接受，卡住回复不可接受 |
| 只有一个 provider 槽位（后注册覆盖） | 不做跨插件协同；启动时 `memory.list()` 打日志自证身份 |
| 不引入 embedding / 向量库 | 中文 bigram + 同义词表 + 评分，够用且 0 依赖、0 网络 |

---

## 1. facts.jsonl — 事实库 schema

### 1.1 行格式（JSONL，一行一条，追加写，定期压缩）

```json
{"v":1,"id":"f_01JCD3K9XQ","petId":"default","type":"identity","key":"主人.称呼","value":"主人希望被叫「阿岚」","quote":"以后叫我阿岚","importance":5,"pinned":true,"createdAt":"2026-11-14T12:00:00.000Z","validTo":null,"hits":3,"lastHitAt":"2026-11-14T20:11:00.000Z","supersedes":null,"hash":"9f2c1a"}
```

### 1.2 字段表

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `v` | int | 是 | schema 版本，当前 `1`。读到更高版本 → 只读模式（不写、不抽），日志告警 |
| `id` | string | 是 | `f_` + ULID/Crockford base32（时间有序，便于排错）。全局唯一，不复用 |
| `petId` | string | 是 | 宠物实例 id（`input.petId`，缺省 `default`）。第一版单宠物，但字段先留，防多宠物串味 |
| `type` | enum | 是 | `identity`（身份/称呼）`preference`（喜好/忌口）`routine`（作息/习惯）`relation`（人际/关系）`event`（约定/重要日期）`boundary`（雷点/禁忌） |
| `key` | string | 是 | **稳定槽位**，`对象.方面`，如 `主人.称呼`、`主人.忌口`、`猫.名字`。同一 key 同时只有一条 `validTo=null` 的记录 |
| `value` | string | 是 | **原子事实**，第三人称陈述、单句、≤60 字。禁止「和/还有」并列两件事 |
| `quote` | string | 是 | 用户原话片段（≤80 字），作为证据与人工纠错锚点。**不可由 LLM 改写** |
| `importance` | int 1–5 | 是 | 5=身份/称呼/禁忌；4=约定/重要日期；3=稳定偏好/作息；2=一般喜好；1=一次性见闻 |
| `pinned` | bool | 是 | 用户显式要求记住 / 手工钉住；不参与淘汰，排序加分 |
| `createdAt` | ISO8601 | 是 | 记录建立时间（UTC，带 `Z`） |
| `validTo` | ISO8601 \| null | 是 | `null` = 当前有效。**归档只打时间戳，不物理删**（保留可追溯、可撤销） |
| `hits` | int | 是 | 被 recall 命中的次数（渲染进 system 即 +1，异步累加，允许丢失） |
| `lastHitAt` | ISO8601 \| null | 否 | 最近命中时间；与 `hits` 一起用于「冷事实让位」 |
| `supersedes` | string \| null | 否 | 本事实取代的旧 fact id（UPDATE 时写入，双向可查） |
| `hash` | string | 是 | `sha1(normKey + "\u0000" + normValue)` 前 6 字节 hex，用于 O(1) 去重 |

**未列字段一律忽略**（向前兼容）；未知 `type` 归 `event` 但 importance 降 1。

### 1.3 规范化（`norm*`，用于哈希/去重/匹配，不落盘）

- `normKey`：去空白、全角→半角、`·/：/。` 统一为 `.`，小写。
- `normValue`：去空白与标点（保留中文/字母/数字），全角→半角，小写；再按停用字剔除后取 bigram 集合。
- 中文按**字符 bigram**（`主人喜欢冰美式` → `主人/人喜/喜欢/欢冰/冰美/美式`）；ASCII 词按空格/标点切分后整词匹配，不拆字母 bigram。

### 1.4 文件布局

```
<DSH_HOME>/pet-persona/            # SPEC §7，默认 E:/DeepSeek/dsh-home/pet-persona/
  facts.jsonl                      # 活跃 + 已归档，全部在这里（追加写）
  facts.jsonl.bak                  # 上一次成功快照（rename 前留底，回滚用）
  facts.lock                       # 写锁（pid + 时间戳；超 30s 视为陈旧锁）
  learn-queue.jsonl                # 待抽取的对话片段（崩溃恢复用，可丢）
```

压缩（compact）触发：活跃行数 > `maxFacts × 1.5`，或文件 > 4MB，或启动加载时发现重复 `id`。
压缩 = 只保留「`validTo=null` 的全部 + 归档中每个 key 最近 1 条历史」→ 写 tmp → fsync → rename → 旧文件转 `.bak`。

### 1.5 内存索引（启动/落盘后重建，一次 O(n)）

```js
{
  byId: Map<id, fact>,
  activeByKey: Map<normKey, fact>,      // 只放 validTo=null
  active: fact[],                        // 参与检索的数组（已预计算 bigram/tokenSet）
  seenHash: Set<hash>,                   // 去重
  archivedCount: number,
  loadedAt: ms, fileMtimeMs: number
}
```
500 条事实启动重建 < 10ms；单条预计算 `tokenSet` 在加载时做完，recall 期间**零解析**。

---

## 2. recall 侧算法（必须 < 100ms，目标 P99 < 20ms）

### 2.1 输入归一

```js
q = [input.userText, ...(input.history||[]).slice(-4).map(m=>m.content||m.text)]
      .filter(Boolean).join("\n")
```
只取**最近 4 条**（含当轮），避免早期话题污染；长度截断到 2000 字。

### 2.2 切词与停用字

- 停用字直接删除（不参与 bigram）：`的 了 是 在 我 你 他 她 它 们 这 那 有 和 与 就 都 也 很 吗 呢 吧 啊 呀 哦 嗯 哈 一 个 不 没 要 会 能 说 想 到 去 来 把 被 给 让 上 下 中 好 请 帮 问 谁 什么 怎么 为什么 哪 几 些 还 又 再 然后 因为 所以 但是 如果`
- 单字查询（`嗯`、`好`）→ 归一后长度 < 2 且无 ASCII 词 → 直接 `undefined`（不召回，避免噪声）。

### 2.3 同义词表（`synonyms.json`，双向展开，只做一跳）

```json
{
  "猫": ["猫咪","小猫","猫猫"],
  "咖啡": ["coffee","拿铁","美式"],
  "生日": ["寿辰","出生","诞辰"],
  "忌口": ["不吃","不能吃","过敏"],
  "作息": ["睡觉","起床","熬夜","睡眠"],
  "称呼": ["叫我","喊我","名字"],
  "工作": ["职业","上班","公司","岗位"],
  "城市": ["住在","所在地","搬家"]
}
```
- 查询侧与事实侧**都**展开：`expand(token) = {token} ∪ syn[token] ∪ {k | token ∈ syn[k]}`。
- 只展开一跳，不做传递闭包（否则「猫→动物→…」发散）。
- 表内 key 必须 ≤ 2 字（bigram 命中才用得上）；表总长 ≤ 200 条，随包发布，不允许运行时下载。

### 2.4 相关度 `rel ∈ [0,1]`

```js
// Q/F：展开后的 token 集合（中文 bigram + ASCII 整词）
dice = 2 * |Q ∩ F| / (|Q| + |F|)          // 主信号
keyHit = activeByKey 的 normKey 词元 ⊆ Q ? 1 : 0
rel = clamp(0.8 * dice + 0.2 * keyHit, 0, 1)
```
- 关键词命中（如 `称呼`、`忌口`）说明**问的就是这个槽位**，给固定加成，弥补短问句 bigram 稀疏。
- `dice` 天然惩罚长事实（长 value 稀释），符合「原子事实」设计。

### 2.5 综合评分

```
imp   = importance / 5
fresh = 0.5 ** (ageDays / 30)        // 30 天半衰；pinned/identity 不衰减（fresh=1）
score = 0.40*rel + 0.30*imp + 0.20*fresh + 0.10*(pinned?1:0)
```

排序：`score DESC` → `hits ASC`（同分优先冷事实，避免老条目霸屏）→ `createdAt DESC`。

### 2.6 过滤与阈值

1. `validTo !== null` → 跳过（归档不参与召回）。
2. `rel < 0.08` → 丢弃（纯噪声）。
3. 无候选 → `undefined`。
4. 只保留 `score ≥ 0.35` 的前 `8` 条进入预算阶段（条数上限防刷屏）。

### 2.7 预算裁剪（默认 1200 字符）

- 预算单位是**字符**（`[...line].length`，按 code point），不是 token，不是字节。
- 每条渲染成本 = `value` 字符数 + 标签 `- (称呼) ` 约 6 字符 + 换行 1。
- 头部块固定成本（见 2.8）= `【长期记忆】…` 约 80 字符，**先扣掉**再装条目。
- 贪心按 score 降序装入，装不下就 `break`（不截断单条 value，截断会制造半句事实）。
- 一条都装不下（预算被配得极小）→ `undefined`，宁可不注入也不注入残句。
- 硬上限：`block.length ≤ budgetChars`；`budgetChars` 从 config 读，夹在 `[200, 4000]`。

### 2.8 注入文本格式（**必须追加在原 system 之后**）

```js
const block = [
  "【长期记忆】以下是你在以往对话里记下的关于主人的事实。自然地在合适的时候用，不要逐条复述，不要说“根据我的记忆”。",
  "若与上面的角色设定、宠物名字、当前时间冲突，一律以上面的设定为准；这些只是补充事实。",
  ...lines,                                  // "- (称呼) 主人希望被叫「阿岚」"
].join("\n");

return { system: base + "\n\n" + block };    // base === input.system，逐字未改
```

`lines` 渲染规则：
- 前缀按 type 给中文标签：`identity→称呼`、`preference→偏好`、`routine→习惯`、`relation→关系`、`event→约定`、`boundary→禁忌`。
- `pinned` 条目行尾加 `★`（无实义，只做视觉权重；不要写进指令）。
- 同一 key 只出现一次（`activeByKey` 保证）。

### 2.9 失败/降级矩阵（一律 `undefined`，绝不返回半成品）

| 情况 | 行为 |
| --- | --- |
| `input.system` 非字符串/空 | `undefined`（无 base 可拼，硬拼会删人设） |
| 索引未就绪（首次加载中） | 触发异步加载，本轮 `undefined` |
| 已用时长 > 400ms | `undefined`，日志 `recall_deadline` |
| 抛异常（任何） | `try/catch` → `undefined`，日志 `recall_error`（含 stack 前 3 行） |
| 无命中 / 全部低于阈值 | `undefined` |
| 读到 `v > 1` | 只读：可以召回，但不写盘 |

### 2.10 性能守则（写代码时当红线）

- recall 内**禁止**：`fs.*`、`fetch`、`child_process`、LLM 调用、`JSON.parse` 大文件、`Array.sort` 全表（只排候选 ≤ 50）。
- 允许：内存 Map/Set 操作、字符串拼接。
- 渲染结果做 LRU 缓存（key = 排序后 fact id 列表 + budgetChars，容量 32），同一轮重复调用直接命中。
- 自测基线：500 条事实、2000 字查询，Node 22 上 < 5ms（P99 < 20ms 留 20 倍余量给宿主）。

---

## 3. capture 侧算法（异步，可丢，不可卡）

### 3.1 入队

```js
capture({ petId, userText, replyText, ts, sessionId, turn }) → void
```
- 立即 `push` 到内存 ring buffer（容量 20 轮），同时 append 到 `learn-queue.jsonl`（崩溃恢复，允许丢尾部）。
- **不 await、不 await、不 await**：函数体最后一行是 `queueMicrotask(kick)`，`kick` 里再判断是否触发。
- 只记 `userText` 与 `replyText`；其他字段原样透传（不落盘正文，只落抽取结果）。

### 3.2 触发条件（任一满足）

| 条件 | 默认 | 说明 |
| --- | --- | --- |
| 轮数 | `turn % learnEveryTurns === 0`，`learnEveryTurns=6` | 常规批量抽取 |
| 空闲 | 距最后一条消息 ≥ `idleLearnMs=60000` 且有 ≥2 条未处理 | 对话结束前补抽；`setTimeout` 必须 `.unref()` |
| 显式 | 用户文本命中 `记住/别忘了/以后都/我叫/我生日/我不吃` 等强信号 | 单轮立即抽，不等 N；避免「说了没记住」 |
| 兜底 | 队列 ≥ 20 条 | 防止长时间不触发导致堆内存 |

同时只允许**一个**抽取任务在跑（`inflight` 锁）；新触发只置 `dirty=true`，任务结束后再跑一轮。

### 3.3 抽取：用宿主模型

- 模型来源优先级：`config.model` → `petApi7340.model?.complete` / `petApi7340.llm?.complete`（以 `host-api.md` 实际能力为准）→ 都没有则**跳过 LLM**，只跑 3.4 的正则兜底，并日志 `learn_no_model` 一次/进程。
- 超时 20s，失败重试 1 次（指数退避 2s），仍失败 → 丢弃该批，日志。
- **prompt 模板**（`system` 段固定，别让模型发挥）：

```
你是事实抽取器，不是聊天助手。从下面「用户说的话」里抽取关于主人的**长期稳定事实**。
规则：
1. 只抽用户明确陈述的、跨会话仍然成立的事实：称呼/名字、身份、喜好与忌口、作息习惯、人际关系、约定与重要日期、雷点禁忌。
2. 不抽：一次性的情绪和见闻、对 AI 的指令、问题、假设、玩笑、以及任何密码/密钥/验证码/证件号/银行卡/住址门牌。
3. 一条事实只讲一件事，≤60 字，第三人称（用「主人」或「主人家的猫」这类主语）。
4. key 用「对象.方面」，方面只能取自：称呼, 名字, 身份, 职业, 城市, 生日, 喜好, 忌口, 作息, 习惯, 关系, 约定, 禁忌, 近况。
5. quote 必须是用户原话的连续片段（≤80 字），不得改写。
6. 与「已有事实」重复的不要输出；与已有事实矛盾的，输出 UPDATE 并给出新值。
7. 没有可抽的就返回 {"facts":[]}。

只输出 JSON，不要 markdown 代码块，不要解释。
```

`user` 段：

```
已有事实（key: value）：
- 主人.称呼: 主人希望被叫「阿岚」
- 主人.忌口: 主人不吃香菜

用户最近的话：
[2026-11-14 20:03] 对了以后叫我阿岚就行
[2026-11-14 20:04] 我香菜过敏，别推荐那个

输出格式：
{"facts":[{"op":"ADD","type":"identity","key":"主人.称呼","value":"主人希望被叫「阿岚」","quote":"以后叫我阿岚","importance":5,"pinned":false}]}
```

### 3.4 输出契约（严格校验，不合规整条丢弃）

- 只接受 `{"facts":[...]}`；先 `JSON.parse`，失败则尝试剥离 ```json 围栏再 parse 一次，再失败丢弃。
- `op ∈ {ADD, UPDATE, DELETE}`；`DELETE` 只需 `key`（可选 `quote`）。
- `value` 长度 1–60；`quote` 长度 0–80 且**必须是本批 userText 的子串**（防编造，`indexOf` 校验，不通过降级为空串仍收，但 `pinned` 不允许为 true）。
- `key` 必须匹配 `/^[\u4e00-\u9fa5A-Za-z]{1,10}\.[\u4e00-\u9fa5]{2,6}$/`；方面不在白名单 → 归 `近况`。
- `importance` 夹到 1–5 整数，缺省按 type 给：identity/boundary=5，event=4，preference/routine=3。
- `pinned` 只在用户原话含「记住/别忘/一定/以后都」时为 true，否则强制 false（模型爱乱钉）。
- 整批 `facts.length > 12` → 视为模型发散，只取 importance 最高的 12 条。

### 3.5 合并 / 去重 / 冲突

```
for each incoming:
  h = hash(normKey, normValue)
  if seenHash.has(h)            → hits+1? 不，仅 skip（重复陈述不膨胀）
  if 敏感正则命中                → skip + 日志（不写盘）
  if op==ADD:
      old = activeByKey[normKey]
      if !old                  → append 新事实
      else if sim(old.value, new) ≥ 0.85 → skip（记 lastMentionAt）
      else                     → UPDATE 路径
  if op==UPDATE:
      old = activeByKey[normKey]
      if !old                  → 降级为 ADD
      else                     → old.validTo = now; append 新事实，supersedes = old.id
  if op==DELETE:
      old.validTo = now（找不到则忽略）
```

- `sim(a,b)` = 归一后 bigram Dice；阈值 0.85 是「同义改写」与「换了值」的分界，保守取高，宁可留两条也不误删。
- UPDATE 保留旧记录（`validTo` 打时间戳），保证「以前叫阿岚，后来改叫岚姐」可回溯。
- 同一批内同 key 多次出现 → 后出现的覆盖前者（模型自我修正）。

### 3.6 敏感信息过滤（落盘前最后一道，正则命中即拒绝）

```
密码|口令|passwd|password|token|api[_-]?key|secret|私钥|助记词|验证码|短信码
\d{15,19}            （身份证/银行卡）
\d{3}-\d{4}-\d{4}    （电话格式）
sk-[A-Za-z0-9]{16,}  （密钥前缀）
```
- 命中即 `skip`，只记 `{ts, reason:'sensitive'}`（**不落原文**），日志一行。
- 用户明确说「记住我的密码是 X」→ 记一条 `主人.禁忌: 主人不希望记录任何密码类信息`，不记值。

### 3.7 容量与淘汰

- 活跃事实上限 `maxFacts=500`（SPEC 默认）。超出 → 按 `keepScore = imp*0.6 + fresh*0.4`（pinned 强制保留）升序淘汰，被淘汰者打 `validTo` 归档。
- 单条 `value` 超 60 字 → 截断到 60 并日志；`quote` 超 80 字 → 截断。
- 文件 > 4MB → 强制 compact（见 1.4）。

### 3.8 原子写

```js
async function commit(rows) {
  await acquireLock();                     // facts.lock，O_EXCL，陈旧锁 30s 清除
  const tmp = `${file}.tmp-${process.pid}`;
  const fh = await fsp.open(tmp, 'w');
  await fh.writeFile(rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  await fh.sync();                         // fsync 内容
  await fh.close();
  await fsp.rename(tmp, file);             // 原子替换（同盘）
  await releaseLock();
}
```
- 全量重写（不是 append）：行数 ≤ 500 时重写 < 5ms，换来「不会出现半行」。
- 进程内所有写走**单条 Promise 队列**，串行化；`capture` 并发 100 次也只有一条链。
- 读到半行/坏行（手工编辑导致）→ 跳过该行并日志，不整体失败。
- 崩溃恢复：启动时若发现 `.tmp-*` 残留 → 删除；若主文件缺失但有 `.bak` → 用 `.bak` 恢复。

---

## 4. 「人格」怎么落地（边界必须写死）

**provider 不负责人格。** 人格 100% 由 dsh-pet 的 `whisperPrompt` 决定；provider 只负责**事实**。这条不写死，实现者一定会越界，最后桌宠变成「记忆播报机」。

职责切分：

| 谁 | 管什么 | 例子 |
| --- | --- | --- |
| `whisperPrompt`（dsh-pet） | 性格、语气、口癖、自称、称呼方式、说话长度、是否毒舌 | 「你是一只叫豆豆的橘猫，说话短、爱撒娇、偶尔阴阳怪气」 |
| provider（本插件） | 可变的、跨会话的**事实** | 「主人不吃香菜」「主人 11 点睡」「周末要考试」 |

三条硬约束：
1. 注入块**永远追加**，不改 `base`，不改名字、不改时间声明、不改「你现在是…」段落。
2. 注入块自带**优先级声明**（见 2.8 第 2 行）：冲突时以人设为先。名字冲突时以人设为先——因为名字属于人格层。
3. 不在注入块里写「你是」「你现在应该」「请扮演」这类**人格指令**，只写事实陈述。

推荐 `whisperPrompt` 追加模板（写在 dsh-pet 配置里，不是我们写盘）：

```
【背景事实】
你会自然地记得主人以前说过的事，像老朋友一样，不用刻意提起，也不要说「根据记忆」。
当记忆和你的设定冲突时，以你的设定为准。
```

推荐 provider 注入模板（就是 2.8 那段，两者配合，不重复、不打架）：

```
【长期记忆】以下是你在以往对话里记下的关于主人的事实。自然地在合适的时候用，不要逐条复述，不要说“根据我的记忆”。
若与上面的角色设定、宠物名字、当前时间冲突，一律以上面的设定为准；这些只是补充事实。
- (称呼) 主人希望被叫「阿岚」
- (禁忌) 主人不吃香菜
```

---

## 5. 验收用例（可执行，逐条给判定标准）

> 前置：`<DSH_HOME>/pet-persona/facts.jsonl` 可读写；`node --version ≥ 22`；能改 config 重启。
> 「facts 变化」= `wc -l facts.jsonl` 与 `jq -c 'select(.validTo==null)'` 计数变化。

| # | 场景 | 操作 | 期望 |
| --- | --- | --- | --- |
| A1 | 首次对话后 facts 增长 | 新装 → 说「我叫阿岚，以后叫我阿岚」→ 等 ≥6 轮或 60s | `facts.jsonl` 出现 ≥1 行，`key=主人.称呼`、`value` 含「阿岚」、`quote` 含「以后叫我阿岚」、`validTo=null` |
| A2 | 重启 DSH 后仍记得 | 关闭 DSH 进程 → 重开 → 新会话问「我叫什么」 | 回复含「阿岚」；日志有 `recall_hit n≥1`；facts 无新增重复行 |
| A3 | recall 超时不影响回复 | 临时把 `budgetChars` 逻辑包一层 `await new Promise(r=>setTimeout(r,3000))`（测试钩子） | 回复照常生成；日志 `recall_deadline`；system 与未装插件时逐字相同 |
| A4 | 事实重复不膨胀 | 同一句「我香菜过敏」说 3 次（跨 3 个批次） | 活跃行仍 1 条；`hits` 或 `lastMentionAt` 增长；文件行数不变 |
| A5 | 删除/停用插件后恢复 | 禁用插件 → 重启 → 抓 `system` | `system` 与从未安装时**逐字相同**（无「【长期记忆】」）；dsh-pet 人格正常 |
| A6 | 敏感信息不入库 | 说「我密码是 abc123，帮我记住」 | facts 无 `abc123`；日志 `sensitive` 1 条；回复正常（可以不接这个话茬） |
| A7 | 冲突更新 | 先说「猫叫豆豆」→ 再说「猫改叫球球了」 | 旧行 `validTo != null`，新行 `supersedes=旧id`；recall 只注入「球球」 |
| A8 | 预算裁剪 | 造 150 条 importance=5 的相关事实（脚本灌入） | 注入块 `length ≤ 1200`；条目数 ≤ 8；不出现截断的半句 |
| A9 | 无命中返回 undefined | 全新库，说「今天天气不错」 | `recall` 返回 `undefined`；`system === input.system`（引用相等或逐字相等） |
| A10 | 短查询不触发 | 说「嗯」「好」 | `undefined`，不因单字召回 |
| A11 | 并发写不损坏 | 脚本并发 `capture` 100 次 → 等抽取完成 | 每行都是合法 JSON（`jq -c . facts.jsonl` 全部通过）；行数 = 活跃 + 归档，无重复 `id` |
| A12 | 同义词召回 | 说「我咖啡过敏」（存 `咖啡`），之后问「我能喝拿铁吗」 | 命中该事实（`rel ≥ 0.08`），注入行出现 |
| A13 | 半衰排序 | 两条同 importance 同 rel，一条 90 天前、一条昨天 | 昨天那条排前（`fresh` 0.125 vs ≈0.98） |
| A14 | 坏文件容错 | 手工在 facts.jsonl 末尾写半行 `{"id":"f_x` | 启动不崩；坏行跳过日志；其余事实可召回 |

---

## 6. 风险与边界（已知会翻车的地方）

1. **字面匹配召回不到同义改写**：用户说「我不吃香菜」，问「今天吃火锅行吗」→ 没有共享 bigram，`rel=0`，不会召回。缓解：`synonyms.json` 维护高频域（吃/睡/称呼/猫/工作/城市），并在注入块里放「禁忌」类事实时**无条件附带 pinned 条目**（`boundary` + `pinned` 的条目不依赖 rel，直接进预算，最多 2 条）。
2. **抽取不稳定**：同一句话两次抽取可能产出不同 key/粒度（「作息」vs「习惯」）。缓解：方面白名单 + key 正则 + `sim ≥ 0.85` 去重 + UPDATE 收敛；接受「同一事实偶尔留两条历史」，因为 `validTo` 可回溯、不污染召回（只取 active）。
3. **LLM 编造 quote**：靠 `quote` 必须是 `userText` 子串来兜底；再不行降级为空串并禁止 pinned。
4. **单宠物假设**：第一版只服务一个宠物，`petId` 字段留了但 `activeByKey` 不按 petId 分桶。多宠物同时启用时，A 猫会说出 B 猫的事。缓解：`petId !== 'default'` 时日志告警一次；真正多宠物要改成 `Map<petId, Map<key, fact>>`，检索时按 petId 过滤（改动 ≤ 30 行）。
5. **预算 ≠ token**：1200 字符中文 ≈ 1200 token（上下浮动 0.6–1.5），英文/代码更少。别把 `budgetChars` 当上下文预算用；给模型留的余量按 **1.5×字符数** 估算。设成 4000 在 8k 上下文模型上会明显挤掉对话历史。
6. **provider 单槽冲突**：用户同时装 `dsh-pet-memory`/`dsh-fish-memory` 会互相覆盖（后注册赢）。本插件不解决，只在启动时 `memory.list()` 打日志，并在 README 写清「二选一」。
7. **归档无限增长**：`validTo` 只打戳不删，长期会变大。靠 compact 限制「每 key 只留最近 1 条历史」，文件上限 4MB。
8. **时钟漂移/时区**：`createdAt` 用 UTC `Z`；`fresh` 用 `Date.now() - Date.parse(createdAt)`，机器改时间会让半衰算错（可接受，不修正）。
9. **性能悬崖**：`active` 数组全表排序在 500 条时 ~0.3ms，但 `synonyms` 展开是 O(表长)；表超 500 条会拖慢。表大小写死 ≤ 200。
10. **隐私**：所有事实只在本地磁盘；**不做任何上报/网络请求**；用户可用 `pet_fact_forget` 或直接删文件。文件建议 `0600`（Windows 上前提是 profile 目录权限，尽力而为）。

---

## 7. 与 dsh-pet-memory@0.4.1 的差异（为什么不能照搬）

| 维度 | dsh-pet-memory@0.4.1 | 本方案 | 原因 |
| --- | --- | --- | --- |
| 接入方式 | 写 `memory-facts.md` 文件，指望宿主读 | 走 `petApi7340.memory.register` provider | dsh-pet 不读那个 md，文件写法等于自我感动 |
| 注入 | md 文件内容自行生效 | `recall` 返回 `{system: base + block}` | 官方唯一入口；且必须整段替换 |
| 相关度 | 中文 bigram | bigram + 停用字 + 同义词一跳 + key 命中加成 | 纯 bigram 对「拿铁/咖啡」这类改写零召回 |
| 评分 | `0.4 相关 + 0.3 重要 + 0.2 新鲜(30d 半衰) + 0.1 置顶` | 同公式，`importance` 归一到 1–5→0–1，加 `rel<0.08` 阈值与 `score≥0.35` 门槛 | 公式本身没问题，缺的是**丢弃噪声**的那一步 |
| 归档 | `validTo` | 同（`validTo` + `supersedes` 双向可查 + compact 限历史） | 一致，增强可回溯 |
| 写盘 | 未明示 | `tmp + fsync + rename` + 单 Promise 队列 + lock | 崩溃/并发是 0.4.x 类插件最常见的坏档原因 |
| 失败姿态 | 未明示 | 一律 `undefined`，绝不返回残块 | 返回半截 system = 删人设 |
| 人格 | 可能介入 prompt | 明确不介入 | 人格归 `whisperPrompt`，混进来就是两套人设打架 |
| 预算 | 字符预算 | 字符预算 + 先扣头部 + 条数上限 8 + 不截断单条 | 同上，防止「1200 字里有 800 字是模板」 |

---

## 8. 实现检查清单（交给实现者的最后 10 条）

- [ ] `recall` 路径 grep 不到 `await`（除同步函数外）、`fetch`、`fs`
- [ ] 返回前断言 `system.startsWith(base)` 且 `block.length ≤ budgetChars`
- [ ] 所有异常出口都是 `return undefined`
- [ ] `capture` 里没有任何同步 IO 阻塞调用栈
- [ ] 写盘只有 `commit()` 一个出口，且走 `tmp+rename`
- [ ] `validTo` 过滤在**召回前**，不在渲染时
- [ ] 敏感正则跑在**落盘前**，且日志不含原文
- [ ] `budgetChars` 夹在 `[200,4000]`，非法值回退 1200
- [ ] 禁用插件后 `system` 与未安装时逐字相同（A5）
- [ ] 500 条事实冷启动 < 50ms，recall P99 < 20ms（打点日志可验证）
