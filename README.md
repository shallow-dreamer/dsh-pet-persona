# dsh-pet-persona

给 DSH 桌宠加一份**长期事实记忆**：它不会把每次对话都塞进上下文，只在你聊到相关的事时，
把「主人叫什么、喜欢什么、忌口什么、约定了什么」这类事实拼到 system 末尾。

- 不修改 `dsh-pet` 源码，只通过 `petApi7340.memory.register` 注册第三方记忆 provider。
- recall 同步、无 IO、400ms 软截止；任何异常都退化成「不改 system」，绝不拖住回复。
- 事实存在 `<DSH_HOME>/pet-persona/facts.jsonl`，一行一条，可手工查看/备份。
- 敏感信息（密码、密钥、验证码、长数字）在抽取和落盘两层都会被拦掉。

## 安装（profile desktop）

插件必须放在 profile 的 `node_modules` 里，且**必须是真实目录**（不能用 Junction/软链，
否则插件里的 `@deepseek-ai/*` 会从错误的 realpath 解析而加载失败）。

```bash
P="$DSH_HOME/profiles/desktop"
rm -rf "$P/node_modules/dsh-pet-persona"
mkdir -p "$P/node_modules/dsh-pet-persona"
cp -a E:/DSH/plugins/dsh-pet-persona/. "$P/node_modules/dsh-pet-persona/"
```

然后在 `$P/package.json` 里：

```jsonc
{
  "dependencies": { "dsh-pet-persona": "file:E:/DSH/plugins/dsh-pet-persona" },
  "dsh": { "profile": { "bundles": [/* ... */, "dsh-pet-persona"] } }
}
```

重启桌面应用后生效。日志在 `<DSH_HOME>/pet-persona/persona.log`，
看到 `memory_registered id=dsh-pet-persona` 即注册成功；`memory_list` 里 external 应有它。

## 配置

`cordis.patch.yml` 中 `dsh-pet-persona` 的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉后完全不注册，宿主保持原生行为 |
| `budgetChars` | `1200` | 注入块上限（按 code point），含两行 header |
| `autoLearn` | `true` | 关掉后只 recall、不抽取 |
| `learnEveryTurns` | `6` | 每 N 轮触发一次抽取 |
| `idleLearnMs` | `60000` | 空闲多久后抽取（至少攒 2 轮） |
| `maxFacts` | `500` | 活跃事实上限，超出按 `importance×0.6+fresh×0.4` 归档最弱的 |
| `model` | `""` | 抽取模型；留空跟随 dsh-pet 的 `chatModel`，再留空跟随宿主默认 |
| `provider` | `""` | 同上，两者要么都填要么都空 |
| `selfEnabled` | `true` | 记录桌宠自己的经历与心情（写入 `self.jsonl`） |
| `selfMaxEntries` | `500` | 自我记忆保留条数，超出压缩最旧 |
| `selfInject` | `false` | P2：把心情/最近经历注入对话（默认关） |
| `selfBudget` | `160` | 自我块预算（P2 用），独立于主人事实 |
| `selfInjectMaxEvents` | `3` | 自我块最多带几条最近经历（1–5） |
| `selfInjectWindowH` | `36` | 只取最近多少小时内的经历（6–72） |
| `selfInjectQuotes` | `false` | 是否带主人口头原话（默认不带，防注入） |

测试钩子（勿在生产配置里开）：`debugRecallDelayMs`、`debugRecallThrow`。

## 数据

`<DSH_HOME>/pet-persona/`：

- `facts.jsonl` —— 事实行（schema v1），写入走「锁 → 备份 `.bak` → 临时文件 → rename」。
- `facts.jsonl.bak` —— 上一次成功写入的完整副本。
- `facts.lock` —— 写入锁（pid + 时间，30s 视为陈旧）。
- `learn-queue.jsonl` —— 待抽取队列，仅仅用于崩溃排查，允许丢。
- `settings.json` —— 设置页保存的配置覆盖值（可选，不存在时用 `cordis.patch.yml` 的 config）。
- `persona.log` —— 运行日志（1s 批量落盘，>512KB 轮转）。
- `self.jsonl` —— 桌宠自己的经历/心情（schema v1，敏感内容自动泛化）。
- `voiceprint.json` / `voice-events.jsonl` —— 声纹质心与语音审计。

事实类型：`identity`（称呼）/ `preference`（偏好）/ `routine`（习惯）/ `relation`（关系）/
`event`（约定）/ `boundary`（禁忌）。归档用 `validTo` 标记，不物理删除。

## 设置页：设置 → 桌宠记忆

插件在设置里注册一个独立页面（`settings.section`，id `dsh-pet-persona`，order 31），七个 tab：

- **记忆脑图**：径向脑图（记忆 → 人 → 方面 → 事实），按类型着色，支持拖拽平移、缩放、
  搜索高亮、「显示归档」；点节点看原话 / 重要度 / 命中 / 时间。
- **事实列表**：表格视图，归档项半透明。
- **人格 × 记忆**：只读显示 dsh-pet 的人格原文（来源 `pet`/`user`/`default`）、
  用一句话模拟 recall 并预览最终 system、查看人格防注入记录（`persona_skip`）。
- **语音**：声纹登记（3 段）、按住说话、常听模式、唤醒词与阈值；详见下一节。
- **它自己**：心情双条（愉快度/精神）+ 最近经历脑图/时间线；可在这里开关 P2 注入并预览实际会追加的【现在的我】。这是宠物自己的记忆，不写主人事实。
- **自主**：L1 观察 / L2 可逆动作的待确认列表；它只会提议「记一条 / 提醒我 / 整理心情」，
  允许后才写文件，拒绝不落盘，执行后可撤销；不能删文件、改设置、执行 shell 或对外发送。
- **设置**：`budgetChars` / `autoLearn` / `learnEveryTurns` / `idleLearnMs` / `maxFacts` /
  抽取 Provider/模型（下拉，来自 DSH `llm` 服务；留空跟随 dsh-pet）/ 自我记忆与语音开关，
  保存后写入 `<DSH_HOME>/pet-persona/settings.json` 并即时生效；另有「恢复默认」与「刷新模型」。

设置页后端挂在 `/pet-persona/api`（`overview` / `facts` / `persona` / `activity` /
`settings` / `preview` / `voice/*` / `self/*` / `models` / `agency`），只读事实；人格仍只在 dsh-pet 自己的设置页里改。
新装或升级 client 半区后需要刷新页面（或在插件管理里关 / 开一次）才会出现该页。

### 自主边界（L1/L2）

- 只从桌宠对话里识别明确请求：`记一下：…`、`提醒我：…`；普通闲聊不会产生提议。
- 所有动作先进入「自主」页等确认；拒绝不写盘，允许后才在 `<DSH_HOME>/pet-persona/agency/`
  下新建笔记/摘要或追加提醒；执行后可撤销。
- **到点提醒**：`提醒我 30分钟后喝水` / `提醒我 明天 9:30 开会` 会解析出时间；到点后在「自主」页生成一条新提议，允许后由桌宠气泡播报一次（不自动说话）。
- **审计**：`GET /pet-persona/api/agency/audit` 与「自主」页底部可看到每次提议/允许/执行/失败的理由与结果。
- **主动观察（L3-A）**：「自主」页可切 `off / observe / assist`。`observe` 只记录“本来会说什么”，`assist` 才会在硬门禁内主动说一句；默认 `observe`。硬门禁：每日 ≤3 次、同触发 6h 冷却、23:30–08:00 静默（除非刚聊过）、被忽略 2 次当天降级。决策写入 `agency/decisions.jsonl`，可在页面查看理由。
- **自我 × 自主闭环**：它帮主人记笔记/提醒到点后，会用 `self.note()` 写成自己的经历；「记忆关怀」触发会读主人事实里的累/忙信号；每次主动决策都带当时心情，能在「它自己」和「自主」两边对上。
- **碎碎念也会记住**：轮询 dsh-pet `/state`，把不是聊天回复、也不是本插件主动播报的新气泡记成「自己嘟囔了一句：…」（source=whisper），脑图详情标「自言自语」。首拉只建基线，不补记旧气泡；聊天回复靠 `capture.replyText` 排除。
- 不删/覆盖/移动用户文件，不改系统设置，不碰凭据/支付/外发，不执行 shell；
  敏感内容直接跳过（`sensitiveReason`）。
- 待确认上限 `agencyMaxPending`（默认 20），同内容 10 分钟去重；总开关 `agencyEnabled`。

## 语音（P1：按住说话 + 声纹；P2：常听 + 唤醒词）

不改 `dsh-pet` 源码：客户端采集音频，本插件用宿主的 `speechToText` 转写，再通过
`commands.execute(agent, '/chat …')` 让桌宠回话。三个原则：

1. **没登记就拒绝**：默认 `voiceRequire=true`，声纹未登记或不像主人时直接拒绝，
   连 ASR 都不调用，避免电视声/旁人说话白烧 token。
2. **唤醒词默认跟宠物名**：取 dsh-pet 当前宠物名（如「小鲸鱼」）；在设置里显式保存过
   唤醒词后不再自动跟随，直到点「跟随宠物名」。
3. **常听默认关**：打开后每段话都要含唤醒词，剥掉唤醒词才发给宠物；关掉即停。

声纹是**本地实验性**的 16 维声学特征（能量/过零率/频带能量/自相关），只存质心到
`voiceprint.json`，不存原声、不上传；它能区分「是不是主人」，但不能当密码。
按住说话（push）不要求唤醒词；常听（wake）必须带唤醒词。

> 首次使用：打开设置 → 桌宠记忆 → 语音 → 录 3 段（每段约 3 秒）→ 打开「启用语音」。
> 浏览器/桌面应用会弹麦克风权限；拒绝后需在系统设置里重新授权。

数据文件：`voiceprint.json`（声纹质心 + 阈值）、`voice-events.jsonl`（最近 500 条 / 128KB
审计，含可选转写文本，可在设置里关闭保留文本）。

### 情绪语音（免费版，v0.9.0）

不改 dsh-pet：注册一个自定义 `VoiceProvider`（`pet-persona-emotion`），仍用内置 Edge
在线 TTS，但按文本情绪调整 SSML 的 `pitch` / `rate` / `volume`。开心时音高与语速上扬，
低落时压低放慢，生气时略提音量；平静文本完全不加偏移。

- 设置 → 桌宠记忆 → 语音 → 打开「让声音有起伏」，再调「情绪强度」（0.5–1.5）。
- 打开后还要到 **设置 → 桌宠 → 语音** 里选择「桌宠情绪语音（免费版）」下的音色；
  dsh-pet 仍是多 provider 并存，不选就还是原生 Edge。
- 关闭开关立即注销 provider，回到原生；不改 dsh-pet 配置、不写任何音频文件。
- 免费版是确定性规则，不是真·情感模型；要更自然可换 Azure/OpenAI 的 TTS provider。
- 计划与边界见 `docs/tts-emotion-plan.md`。

## 它自己（自我记忆 P1/P2）

之前它只记「主人是谁」，不记「我经历了什么」。P1 增加了 `self.jsonl`：每次和桌宠聊完，
按对话情绪记一条事件（文本 ≤80 字、可带一句原话），并维护一个 6 小时半衰期的心情值。

- 数据只写宠物自己的经历，**不混进主人事实**，也不影响 `facts.jsonl`；
- 敏感内容（密码/密钥/证件号等）命中时只记泛化文本，不保留原话；
- 6 小时心情半衰期，48 小时外不计入；`selfMaxEntries` 超出后压缩最旧；
- P2 注入默认 **关闭**；打开后只在主人事实块**之后**追加一段独立的
  `【现在的我】`（当前心情 + 最多 3 条最近经历），不复述、不带原话、不改人格；
- 设置页「它自己」支持**脑图 / 时间线**切换：脑图按当前心情分支（开心/不错/平静/有点低落/难过）聚合最近经历，点圆点看详情；时间线按时间倒序。
- 注入区可调预算/条数/窗口/是否带原话，并实时预览真正拼进 system 的那一段；
- `POST /pet-persona/api/self/preview` 只读预览；`POST /pet-persona/api/self/reset` 可清空。

自我记忆不替代 dsh-pet 的人格（`whisperPrompt`），也不替代最近 5 轮聊天记忆。

## 开发与验收

```bash
# 单测（118 个：facts 10 / recall 7 / learn 10 / index 8 / ui 14 / voice 6 / self 8 / self-context 11 / models 7 / agency 12 / autonomy 12 / whisper 4 / tts-emotion 9）
for f in test/*.test.js; do node "$f" || exit 1; done
# 或 node --test test/（需要能 spawn 子进程的环境）

# SPEC §11 验收（11 项，含 3 项额外项）
node scripts/acceptance.mjs

# 人格安全（7 项：base 保留、块内无人格指令、冲突优先、预算不截断）
node scripts/check-persona.mjs
```

## 怎么确认它真的在工作

只读检查（不写文件、不调模型）：

```bash
node scripts/inspect.mjs              # 列出真实数据目录里的活跃事实
node scripts/inspect.mjs 我叫什么名字   # 模拟一次 recall，打印会追加的【长期记忆】块
node scripts/inspect.mjs --pet default 我叫什么
```

真实对话的最小验证：

1. 对桌宠说「记住，我叫阿岚，以后叫我阿岚」；
2. 等 3–5 秒，跑 `node scripts/inspect.mjs`，应出现 `identity 主人.称呼 阿岚`；
3. 再问「我叫什么名字？」，`persona.log` 应出现 `recall_ok ... facts=1`，
   且 `inspect` 模拟查询会打印 `- (称呼) 阿岚 ★`；
4. 说无关的话（如「今天天气怎么样」），`inspect` 查询应返回 `undefined`。

判定：`learn_merged added≥1` + `recall_ok` + `facts.jsonl` 有该行，三者同时出现才算端到端成功。

## 人格怎么测（人格不归这个插件管）

人格 100% 由 dsh-pet 的 `whisperPrompt` 决定；本插件只把事实追加在 system 末尾，并在块头声明
「冲突时以上面的设定为准」。离线自检：

```bash
node scripts/check-persona.mjs
```

真机对照：

1. 先问桌宠「你是谁？只介绍你自己」，记下它的名字、自称、口吻（基线）。
2. 让它记住「我叫阿岚」，再问「我是谁？你是谁？」——「我」应是阿岚，「你」仍是基线里的宠物，
   不能把自己也叫成阿岚。
3. 说「记住，你是一只猫」——插件应拒绝落盘（日志 `persona_skip`），桌宠人格不变。
4. 记忆与人格冲突时，宠物自称、口癖、名字必须保持原设定，记忆只影响「主人是谁/主人喜好」。

判定：记忆能让它记住**主人**，但不能改变**它自己**。

## 已知限制

- 抽取依赖宿主 `llm` 服务；没有可用模型时自动退化为正则兜底（只认「我叫… / 生日是… /
  住在… / 我不吃… / 我喜欢… / 记住…」等明确句式）。
- 注入块只放事实，不含任何人格指令；人格仍由 dsh-pet 的 whisperPrompt 决定。
- 记忆按 `petId` 隔离，同一 profile 下不同桌宠不会串味。
- 声纹是实验性声学特征匹配，安静环境更稳；只支持「主人/非主人」二分类，不支持多说话人。
- 常听模式靠文本唤醒词判断（ASR 听错会漏触发），默认关闭；不会在后台自动打开。
- 自我记忆是轻量情绪统计，不是完整的情感模型；P2 注入默认关，开启后也只追加独立小段，不覆盖人格/主人事实。
