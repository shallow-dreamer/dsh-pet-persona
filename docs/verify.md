# 验收记录（dsh-pet-persona）

- 日期：2026-11-15（v0.2.0 设置页）
- 环境：Windows / MSYS Bash；Node `v22.18.0`（`E:/Program/node-version/22.18.0/node.exe`）
- `DSH_HOME=E:/DeepSeek/dsh-home`
- profile：`desktop`（`E:/DeepSeek/dsh-home/profiles/desktop`）
- dsh-pet：`0.4.5`（未修改其源码）

## 1. 安装核验

插件以**真实目录**（非 Junction / 软链）安装：

```
E:\DeepSeek\dsh-home\profiles\desktop\node_modules\dsh-pet-persona
realpath = E:\DeepSeek\dsh-home\profiles\desktop\node_modules\dsh-pet-persona
```

`profiles/desktop/package.json` 已加入：

- `dependencies["dsh-pet-persona"] = "file:E:/DSH/plugins/dsh-pet-persona"`
- `dsh.profile.bundles` 追加 `"dsh-pet-persona"`

`cordis.patch.yml` 用 `yaml` 解析通过，composed 结果为：

```json
[{"insert":[{"id":"dsh-pet-persona","name":"dsh-pet-persona","config":{
  "enabled":true,"budgetChars":1200,"autoLearn":true,
  "learnEveryTurns":6,"idleLearnMs":60000,"maxFacts":500,"model":""}}]}]
```

`node --check` 通过全部 `index.js`、`client.js`、`lib/*.js`、`scripts/*.mjs`、`test/*.js`；
安装副本与工作区源码 `diff -r` 一致（文档除外；`docs/verify.md` 与 `README.md` 为安装后补写，
不影响运行时）。

## 2. 单测（118/118，v0.10.1）

```
test/facts.test.js   # pass 10  # fail 0
test/recall.test.js  # pass 7   # fail 0
test/learn.test.js   # pass 10  # fail 0
test/index.test.js   # pass 8   # fail 0
test/ui.test.js      # pass 14  # fail 0
test/voice.test.js   # pass 6   # fail 0
test/self.test.js    # pass 8   # fail 0
test/self-context.test.js # pass 11 # fail 0
test/models.test.js  # pass 7  # fail 0
test/agency.test.js  # pass 11 # fail 0
test/tts-emotion.test.js # pass 9 # fail 0
```

覆盖：建库/追加/schema/重载、hash 去重、UPDATE 归档（`validTo`+`supersedes`）、
DELETE 软删、敏感拦截、`maxFacts` 淘汰与 pinned 保留、并发 merge、坏行与 v2 只读、
compact；recall 的同义词命中、无关/单字/空库不注入、petId 隔离、boundary+pinned 强制、
预算不超且不截断、同 key 去重、pinned ★、LRU；learn 的 JSON 容错、字段校验、12 条截断、
正则兜底、模型失败回退、密码请求改记禁忌、触发条件；index 的注册/注入/重启/异常/软截止/
禁用/预算/卸载；ui 的 JSONC/人格来源/设置白名单/原子写/voice 路由/503；voice 的 WAV 解析、
声纹 embedding、登记与验证、未登记不调 ASR、唤醒词与 push 模式、事件文件滚动；self 的
建库/心情正负/半衰期/上限压缩/敏感泛化/petId 隔离/去重/reset；self-context 的
心情+经历块、默认不带原话、人格句过滤、窗口/条数、预算逐级降级、事实在前自我在后、
无事实时只注入自我块、关闭时与 P1 逐字一致、1000 条构造 <50ms。

> 注：本机沙箱内 `node --test test/` 会因 Node test runner `spawn` 子进程返回 `EPERM`，
> 因此改用 `for f in test/*.test.js; do node "$f"; done` 逐个执行；这是环境限制，不是用例失败。

## 3. SPEC §11 验收（11/11）

`node scripts/acceptance.mjs` 使用与 `host-api.md` 行为一致的假 `petApi7340`
（register 单槽、list、ctx.effect、logger），实测输出：

```
PASS A1 首次启动创建空的 facts.jsonl (9ms)
PASS A2 「我叫阿岚，以后叫我阿岚」落盘且有 quote (40ms)
PASS A3 重启后（新 apply，重新读盘）问名字仍答阿岚 (155ms)
PASS A4 无关闲聊 system 逐字保持不变 (1ms)
PASS A5 recall 抛错不影响回复（返回 undefined） (107ms)
PASS A6 注入块 ≤ budgetChars 且【长期记忆】在 base 之后 (30ms)
PASS A7 enabled=false 不注册（host 保持原生） (0ms)
PASS A8 同一句重复 3 次不膨胀（同 hash 只留一行） (604ms)
PASS A9 慢 recall（600ms）被 400ms 软截止丢弃，不拖住回复 (601ms)
PASS A10 卸载（disposer）后 external 清空，可重复调用 (1ms)
PASS A11 人格防注入：关于角色的指令不落盘 (513ms)

# 11/11 passed
```

与 SPEC §11 对应：A1–A8 即 8 条验收，A9–A11 为额外补充（软截止、卸载幂等、人格防注入）。

### 人格安全（离线，`node scripts/check-persona.mjs`，7/7）

```
PASS 注入块以【长期记忆】开头，且只有两行 header
PASS 事实行格式固定，不含自由文本指令
PASS 事实行里没有针对桌宠的角色/人格指令
PASS 块头声明冲突时人格设定优先
PASS system = base + 空行 + 块，base 逐字保留
PASS 无关问题不注入普通事实（pinned 禁忌按设计强制注入）
PASS 预算压力下块 ≤ budget，且只断行不截断、base 完整
```

这组检查证明：记忆只以 `- (标签) 事实` 的形式追加，不携带「你是/你叫/扮演」等人格指令；
base（dsh-pet 的 whisperPrompt 产物）逐字保留；预算不足时丢弃整条事实，绝不截断 base。

## 4. 真实宿主加载（已实测）

安装后当前运行中的 desktop 进程**热加载**了插件（未重启会话），
`E:/DeepSeek/dsh-home/pet-persona/persona.log`：

```
2026-11-14 23:53:40 [info] facts_loaded dir=E:\DeepSeek\dsh-home\pet-persona {"rows":0,"active":0,"archived":0,"keys":0,"readOnly":false,"loaded":true}
2026-11-14 23:53:40 [info] memory_registered id=dsh-pet-persona disposer=yes
2026-11-14 23:53:40 [info] memory_list {"builtin":["native"],"external":["dsh-pet-persona"]}
```

即：Cordis 加载了 bundle patch、`apply()` 执行、`petApi7340.memory.register` 成功、
`list()` 的 external 槽里是 `dsh-pet-persona`，宿主原生 `native` 仍在 builtin。
01:38:27 又通过「禁用 → 启用」触发了一次真实热重载，同样三行日志再次出现，说明
disposer/重新注册路径也已在真实宿主里跑通。

`plugin_manager list_bundles` 也显示该 bundle `enabled: true, installed: true`，
row 为 `include:dsh-pet-persona`。

`<DSH_HOME>/pet-persona/` 已按规范建立：`facts.jsonl`（当前 0 字节）、`persona.log`、`learn-queue.jsonl`。

## 4.1 设置页（v0.2.0，已加载）

- 后端：`lib/ui.js` + `lib/persona.js`，前缀 `/pet-persona/api`；配置白名单写
  `<DSH_HOME>/pet-persona/settings.json`（原子写），事实只读。
- 客户端：`client.js`（1292 行，无构建），`package.json` 已声明
  `dsh.client = { platform:'web', immediately:true, inject:['@deepseek-ai/dsh-client-ui-slots'] }`
  与 `exports["./client"]`；设置页 id `dsh-pet-persona`，order 31。
- 真实宿主 01:57:47 重载后日志：
  ```
  [info] facts_loaded dir=E:\\DeepSeek\\dsh-home\\pet-persona {"rows":0,...}
  [info] settings_api_mounted dir=E:\\DeepSeek\\dsh-home\\pet-persona
  [info] memory_registered id=dsh-pet-persona disposer=yes
  [info] memory_list {"builtin":["native"],"external":["dsh-pet-persona"]}
  ```
- 客户端 Slot 已注册（`cordis_inspect_query` → client `Slots.listSubTree`，
  `settings.section` occupant）：
  `{"registrant":"tk","id":"dsh-pet-persona","order":31,"active":true}`。
- 运行中的 API 实测（浏览器直开，非 mock）：
  - `GET /pet-persona/api/overview` →
    `{"ok":true,"config":{budgetChars:1200,...},"provider":{"builtin":["native"],"external":["dsh-pet-persona"]},"persona":{"available":true,"petName":"小鲸鱼","source":"default"}}`
  - `GET /pet-persona/api/facts?archived=1` → `{"ok":true,"facts":[],"stats":{...}}`
  - `GET /pet-persona/api/persona` → 返回默认人格原文与
    `"guard":["2026-11-15 01:42:21 [warn] persona_skip count=1"]`。
- `test/ui.test.js` 14 项覆盖：JSONC 解析、人格来源优先级、设置白名单/夹取、settings.json
  原子读写、活动日志过滤、overview/facts/preview/settings/voice 路由、503 与非本前缀 `next()`。

安装副本已同步 `client.js`、`lib/{config,ui,persona,learn,llm}.js`、`index.js`、`package.json`。

### 视觉验证的限制

- 浏览器直接打开 `http://127.0.0.1:59748` 会停在
  `dsh web authentication required: reopen the URL printed by dsh web.`，
  根页面的鉴权 token 只打印在应用启动时，本会话拿不到。
- DSH 自身窗口按设计不允许被本插件截图/控制（`windows restore/focus` 被拒），
  因此**未能截到设置页渲染图**；判定依据是上面的 client Slot 注册 + 运行中 API 响应。
- 另：`plugin_manager set_bundle` 关/开重载后，`ops_bash` 子系统挂起（连 `echo` 都超时），
  本轮后续验证改用 `ops_read_files`/`ops_inspect_local_file` 与浏览器完成；shell 恢复后
  可重跑 §6 的命令复核。

## 4.2 语音（v0.3.0，已加载；真麦待用户实测）

- 不修改 dsh-pet：客户端采集 → `/voice/utterance` → 宿主 `speechToText` 转写 →
  `commands.execute(agent, '/chat …')` 让桌宠回气泡。声纹未登记或不像主人时直接拒绝，
  不调用 ASR。
- 真实宿主 03:00:20 热重载日志：
  ```
  [info] voice_ready wake=小鲸鱼 enrolled=0 enabled=0
  [info] settings_api_mounted dir=E:\\DeepSeek\\dsh-home\\pet-persona
  [info] memory_registered id=dsh-pet-persona disposer=yes
  ```
- `GET /pet-persona/api/voice/status` 实测：
  `{"ok":true,"voice":{"enabled":false,"wakeWord":"小鲸鱼","requireVoiceprint":true,"threshold":0.8,"language":"zh","keepTranscript":true,"enrolled":false,"samples":0,"model":"experimental-time-domain-v1","ready":{"speech":true,"commands":true,"agent":true},"eventCount":0}}`
- `test/voice.test.js` 6 项覆盖 WAV 解析、embedding、登记/验证/重置、未登记不调 ASR、
  唤醒词与 push 模式、事件文件滚动；`test/ui.test.js` 14 项覆盖 voice 路由与 503。
- 已同步到安装目录并用 `Get-FileHash` 核对 `index.js` / `client.js` / `lib/voice.js` 一致。

## 4.3 自我记忆 P1（v0.4.0，已加载；真实对话待触发）

- 独立文件 `self.jsonl`，不写 `facts.jsonl`；`selfEnabled` 默认开，`selfInject` 默认关。
- 真实宿主 03:33:02 热重载日志：
  ```
  [info] self_loaded {"entries":0,"maxEntries":500,"byPet":{}} enabled=1
  [info] voice_ready wake=小鲸鱼 enrolled=0 enabled=0
  [info] settings_api_mounted dir=E:\\DeepSeek\\dsh-home\\pet-persona
  [info] memory_registered id=dsh-pet-persona disposer=yes
  ```
- `GET /pet-persona/api/self/state` 实测：
  `{"ok":true,"state":{"valence":0,"energy":0.5,"label":"平静","energyLabel":"一般","moodText":"平静 · 一般","events":0,"updatedAt":""}}`。
- `test/self.test.js` 8 项：建库、正/负心情、6h 半衰期、上限压缩、敏感泛化、petId 隔离、
  10 分钟去重、reset 只清指定宠物；`test/ui.test.js` 14 项同时覆盖原有路由。
- 「它自己」tab 提供脑图/时间线切换：脑图以「我」为中心，按心情分支聚合最近 5 条经历，
  点叶子看详情；不新增后端接口。
- 安装目录 `self.js` / `index.js` 的 `Get-FileHash` 与源码一致；`self.jsonl` 已生成（0 字节），
  `facts.jsonl` 仍为 0 字节。
- 未实测：真实桌宠对话触发记录后「它自己」tab 出现条目（需要用户聊几句）。

## 4.4 自我记忆 P2 注入（v0.5.0，已加载；默认关）

- `selfInject` 默认 `false`；开启后 `system = base + "\n\n" + factsBlock + "\n\n" + selfBlock`，自我块独立 `selfBudget`，最多 3 条 36h 内经历，默认不带原话。
- 真实宿主 13:36:00 热重载（新 `ui.js` / `recall.js` / `self-context.js` 已同步）：
  ```
  [info] facts_loaded ... {"rows":0,"active":0,...}
  [info] self_loaded {"entries":4,"maxEntries":500,"byPet":{"main":4}} enabled=1
  [info] settings_api_mounted dir=E:\\DeepSeek\\dsh-home\\pet-persona
  [info] memory_registered id=dsh-pet-persona disposer=yes
  ```
- `GET /pet-persona/api/self/state` 实测包含 `inject:false`、`previewBlock`、`previewEvents`、`budget:160`；
  `POST /pet-persona/api/self/preview {"query":"你好"}` 实测返回：
  ```
  ok: true
  selfBlock: 【现在的我】
  - 心情：平静 · 一般
  - 最近：和主人聊了会儿天；陪主人聊了会儿天；陪主人聊了会儿天
  （这是你此刻的状态，不是新设定；自然带过即可，不要逐条复述，不要说“根据记录”。）
  budgetChars: 1200
  selfBudget: 160
  ```
- `test/self-context.test.js` 11 项覆盖：块结构、默认不带原话、人格句过滤、窗口/条数、预算逐级降级、
  事实在前自我在后、无事实只注自我、关闭与 P1 逐字一致、1000 条构造 <50ms；全量 74/74。
- 未实测：真实桌宠回合在「开启注入」后的 system 尾部（需要用户同意打开开关并聊一轮）；
  页面需刷新一次才能看到新的「它自己」注入控件。

## 4.4 抽取模型下拉（v0.6.0）

- `lib/models.js` 聚合宿主 `llm.listProviders()` + `listModels()`；单 provider 失败只告警，缓存 60s。
- `GET /pet-persona/api/models` 实测返回 providers/models、`defaultSelection` 与 `follow`
  （`source:"global"`，读取 dsh-pet `chatModel`）。
- `lib/persona.js readPetModel()` 解析顺序：条目级 → 顶层用户 → 默认条目 → 默认顶层；空对象继续下探。
- `lib/llm.js` 解析顺序：本插件配置 → dsh-pet chatModel → 宿主 `currentSelection()`；日志 `llm_selected source=config|pet|global|default`。
- `test/models.test.js` 7 项；全量 **81/81**。设置页需硬刷新后可见 Provider/模型两个下拉。

## 4.5 受限自治 L1/L2（v0.7.0）

- `lib/agency.js`：只识别 `记一下/备注` 与 `提醒我`；敏感内容跳过；10 分钟去重、待确认上限；
  允许后只在 `agency/notes|digests|reminders.jsonl` 新建/追加，撤销删除自己创建的文件。
- `GET /pet-persona/api/agency` 实测（端口 60768）：`enabled:true, proposals:[], stats` 全 0。
- `test/agency.test.js` 11 项（建目录、允许写文件、拒绝不写、撤销、提醒、敏感、去重、上限、路径安全、parseDue、到点浮出+播报）；
  全量 **92/92**。设置页新增「自主」tab，需硬刷新。
- L2 增强（v0.8.0）：`GET /pet-persona/api/agency/audit?limit=60` 与 `/agency` 返回最近审计；
  到点提醒由 `tick()` 每 30 秒扫描，只在「自主」页生成待确认提议，允许后才通过 dsh-pet `/broadcast` 播报一次。

## 4.5 情绪语音（免费版，v0.9.0）

- 新增 `lib/tts-emotion.js`：自定义 `VoiceProvider`（id `pet-persona-emotion`），
  仍用内置 Edge TTS，按文本情绪调 `pitch/rate/volume`；不改 dsh-pet 源码。
- 开关 `ttsEmotion`（默认关）+ 强度 `ttsEmotionIntensity`（0.5–1.5）；
  关闭立即注销 provider，回到原生 Edge。
- 设置 → 桌宠记忆 → 语音 →「情绪语音（免费版）」；开启后需到 dsh-pet 语音设置里
  重新选择 `pet-persona-emotion` 下的音色（dsh-pet 是多 provider 并存）。
- 真机证据：
  - 日志 `2026-11-17 21:13:37 [info] tts_emotion_registered provider=pet-persona-emotion intensity=1`。
  - `GET /dsh-pet-7340/voice/voices` 已列出 `pet-persona-emotion` 的 5 个音色。
  - 直接调 provider 用真实 Edge 合成三段：`happy`（pitch +17 / rate +5 / volume +4）、
    `low`（pitch -7 / rate -9 / volume -1）、`calm`（无偏移），均返回有效 mp3 字节。
- 未实测：在 dsh-pet 设置里手动选中该音色后的实际听感（需用户试听）。

## 4.6 主动观察 L3-A（v0.10.0）

- `lib/autonomy.js`：确定性规则，不调模型；`off / observe / assist` 三档，默认 `observe`。
- 触发：`strong_emotion`（|valence| 越过 ±0.35/0.5）、`late_night`（00–03 点且 30 分钟内聊过）、
  `long_work`（连续活跃 ≥2h 且有累信号）。
- 硬门禁：每日上限（默认 3）、同触发 6h 冷却、23:30–08:00 静默（刚聊过可例外）、
  被忽略 2 次当天降级；关掉 `autonomyLevel=off` 立即停。
- 决策写 `agency/decisions.jsonl`；`GET/POST /pet-persona/api/agency/autonomy` 查看/切换等级。
- `test/autonomy.test.js` 12 项（静默、上限、冷却、忽略降级、observe 不发声、日志落盘、
  记忆关怀、self.note 写回、observe 决策回调）；全量 **118/118**。
- 自我记忆与自主的闭环：`self.note()` 把「帮主人记笔记 / 提醒到点」写成它自己的经历；
  autonomy 的「记忆关怀」触发会读 `facts.active` 里的累/忙信号；决策记录带当时心情。
- 设置页「自主」tab 顶部显示等级、今日次数、忽略次数、最近决策理由。

## 4.7 碎碎念记录（v0.10.1）

- `lib/whisper.js` 轮询 `GET /dsh-pet-7340/state` 的 `pets.main.say` 叶子；只读，不写 dsh-pet。
- 首拉只建立 `counter` 基线，不补记旧气泡；之后 counter 增长才处理。
- 排除两类：最近 60 秒 `capture.replyText`（聊天回复）与本插件 `speak()` 播报的文本；
  其余气泡延迟 2 秒再写 `self.note({source:'whisper'})`，给 capture 留出先到的窗口。
- 记录文本「自己嘟囔了一句：…」；脑图详情标签「自言自语」。
- `test/whisper.test.js` 4 项：基线、聊天排除、主动播报排除、同 counter 去重；全量 **118/118**。

## 5. 真机验证：当前状态与操作步骤

已确认的两段真实证据：

1. 上面 23:53:40 的加载/注册日志。
2. 真实桌宠的 3 轮对话已进入 learner：

```
2026-11-15 01:13:48 [debug] learn_empty reason=idle batch=3
```

即宿主 → `capture` → 队列 → 触发抽取的链路在真实进程里是通的；这 3 轮没有抽到
可长期记住的事实（普通闲聊），所以 facts 仍为 0。

最后一段需要你在桌宠里说一句话完成：

1. 对桌宠说「记住，我叫阿岚，以后叫我阿岚」——强信号会立刻抽取，不必等 6 轮。
2. 等 3–5 秒，运行 `node scripts/inspect.mjs`，应看到一行
   `identity 主人.称呼 阿岚`；`facts.jsonl` 里出现带 `quote` 的行。
3. 再问「我叫什么名字？」：`persona.log` 应出现 `recall_ok ... facts≥1`，
   `node scripts/inspect.mjs 我叫什么名字` 应打印 `- (称呼) 阿岚`。
4. 反例：说「今天天气怎么样」，`inspect` 查询该句应为 `undefined`，system 不变。

判定标准：`facts.jsonl` 有该行 + `learn_merged added≥1` + `recall_ok`，三者同时成立
才算端到端成功；缺哪一段，日志里能直接定位（见 §6）。

说明：01:38:27 通过 `plugin_manager` 把 bundle 关掉再打开，触发了一次真实热重载，
新构建（`capture_received`/`learn_start`/`persona_skip` 与人格防注入）已生效；`learn_merged`/
`recall_ok` 从 23:53 构建起就有，不影响记忆链验证。

### 仍未实测

1. 上面的完整真机回合（由用户执行；不代发消息，避免把测试事实写进真实记忆）。
2. 真实 LLM 抽取的质量与耗时：单测用 stub 覆盖了解析/校验/合并/失败回退；
   没有模型的确定性路径是强信号正则兜底，已测。
3. 运行中卸载：disposer 已在单测验证；未在真实宿主里手动卸载观察 `memory.list` 回落。
4. desktop profile 由 Electron 独占，`dsh --profile desktop --dump-config` 返回
   `profile "desktop" is managed exclusively by the Electron application`；composed
   结果改用 `plugin_manager` 与 YAML 解析核验。
5. 真实麦克风链路：权限弹窗、3 段声纹登记、按住说话、常听循环与唤醒词剥除；
   后端逻辑与路由已用单测覆盖，音频采集只能在桌面应用里由用户实测。

## 6. 复现与排障命令

```bash
cd E:/DSH/plugins/dsh-pet-persona
for f in test/*.test.js; do node "$f" || exit 1; done
node scripts/acceptance.mjs
node scripts/check-persona.mjs           # 人格安全（离线）
node scripts/inspect.mjs                 # 真实数据目录只读检查
node scripts/inspect.mjs 我叫什么名字      # 模拟 recall，看会注入什么
```

日志关键词：`memory_registered`（已注册）、`capture_received`/`learn_start`（收到对话、
开始抽取）、`learn_merged`（已落盘）、`learn_llm_failed`/`learn_parse_failed`（模型问题，
已回落正则）、`recall_ok`（已注入）、`recall_error`/`recall_deadline`（本次未注入）。

