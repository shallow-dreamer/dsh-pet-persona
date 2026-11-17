# 桌宠「自我记忆」计划书

版本：v0.2（2026-11-15）
状态：P1 已实现并安装；P2a 注入已实现（v0.5.0，74/74 单测，默认关）；P3 见 `docs/self-roadmap.md`
关联：`docs/self-roadmap.md`、`docs/butler-plan.md`、`docs/voice-plan.md`、`SPEC.md`

## 1. 问题

现在的 persona 只记「关于主人的长期事实」。宠物自己的经历、情绪、反思不落盘，跨会话后只剩 dsh-pet 的最近 5 轮聊天记忆，所以它像一个「记得主人的记录工具」，而不是「有连续自我的宠物」。

目标不是让宠物假装有情绪，而是给它一条**可追溯、可衰减、可解释**的自我线：

- 它做过什么（陪主人聊天、被夸奖、被凶、长时间没见）；
- 它现在什么心情（valence / energy，会随时间回落）；
- 偶尔一句自己的反思（P2，可选，不硬造）。

## 2. 非目标

- 不改 dsh-pet 源码，不碰 `whisperPrompt` 与人格所有权。
- 不把自我记忆混进主人事实（`facts.jsonl`），不参与 `主人.*` 的 key 空间。
- 不做“情绪即人格”：注入只提供状态提示，冲突时仍以 dsh-pet 人格为准。
- 不做云同步、不存原声、不记录敏感信息。
- P1 不注入对话；先保证记录与展示不干扰现有功能。

## 3. 数据模型

文件：`<DSH_HOME>/pet-persona/self.jsonl`（追加写，按需压缩）

```json
{"v":1,"id":"s_...","petId":"main","kind":"event","text":"陪主人聊了会儿天","quote":"","valence":0.2,"energy":0.6,"importance":2,"createdAt":"2026-11-15T03:20:00.000Z","hash":"...","source":"chat"}
```

- `kind`: `event`（发生的事）| `feeling`（明确的情绪事件）| `thought`（P2 反思，P1 不产生）
- `text`: ≤80 字，不含敏感信息；命中敏感词时降级为「和主人聊了会儿天」。
- `quote`: 可选原话 ≤60 字，仅当非敏感。
- `valence`: -1..1；`energy`: 0..1。
- 上限 `selfMaxEntries`（默认 500）；超过 1.5 倍时压缩，保留最近 500 条。
- 心情不单独存状态文件，由事件按时间衰减现算，避免状态与事件打架。

## 4. 心情算法（P1）

对最近 24h 的事件做指数衰减加权：

- 半衰期 6h：`w = 0.5 ** (ageHours / 6)`；
- `valence = Σ(w * v * importance) / Σ(w * importance)`，夹到 -1..1；
- `energy = 0.5 + Σ(w * (e - 0.5)) / Σw`，夹到 0..1；
- 无事件时 `valence=0, energy=0.5`，标签「平静」。

标签：`valence ≥ .35` 开心；`≥ .1` 不错；`≤ -.35` 难过/生气；`≤ -.1` 有点低落；否则平静。`energy ≥ .7` 精神；`≤ .35` 困倦；否则一般。

情绪来源只做轻量词典 + 对话长度/感叹号，不调用 LLM（P1 零额外 token）。

## 5. 写入路径

- 在 `index.js` 的 `capture` 中，`learner.capture(input)` 之后调用 `self.record(input)`；单独 try/catch，失败只记 `self_record_failed`。
- 不同步阻塞回复；内存更新 + 异步 append（串行队列），失败丢弃。
- 跳过：空 userText、纯人格指令（`isPersonaInstruction`）、敏感内容（`sensitiveReason`）。
- 去重：同 petId + 同文本 hash 在 10 分钟内只记一次，避免连续重复。

## 6. 注入（P2，默认关闭）

- 配置 `selfInject` 默认 false；开启后 recall 在记忆块之后追加：

```
【我现在的心情】
开心 · 精神。刚才陪主人聊了会儿天。
```

- 最多 2 行 + 1 条最近事件，独立预算 `selfBudget`（默认 160 字符）。
- 不改变「`system = base + "\n\n" + 记忆块`」的既有契约：没有记忆块时自我块单独作为追加段；有人格冲突时以 dsh-pet 为准。
- 注入失败一律降级为不追加，不影响主人记忆。

## 7. 展示（P1）

设置页第六个 tab「它自己」：

- 顶部心情卡：valence/energy 双条 + 标签 + 最近更新时间；
- 时间线：kind 徽章、text、原话、时间；空态提示「和它聊几句，它才会慢慢有自己的一天」；
- 刷新按钮；不提供编辑（避免伪造记忆）；提供「清空自我记忆」需二次确认（P1 可只做后端 reset）。

## 8. API

前缀 `/pet-persona/api`：

- `GET /self?pet=main&limit=50` → `{ok,state,events}`
- `GET /self/state?pet=main` → `{ok,state}`
- `POST /self/reset` `{pet?}` → `{ok,removed}`（谨慎，UI 二次确认）
- `GET /overview` 增 `self: {enabled, entries, mood}` 摘要。

## 9. 配置

在现有 `settings.json` 增：

- `selfEnabled: true`（总开关）
- `selfMaxEntries: 500`（20–5000）
- `selfInject: false`（P2 才生效）
- `selfBudget: 160`（80–800，P2）

旧配置无需迁移：`normalizeConfig` 给默认值。

## 10. 验证与验收

单测（`test/self.test.js`）：

1. 首次启动创建空 `self.jsonl`，不碰 `facts.jsonl`；
2. 正向对话 valence > 0，负向 < 0；
3. 时间衰减：旧事件权重更低（注入 now 钩子）；
4. 上限压缩后条数 ≤ max，顺序保留最新；
5. 敏感对话不落原文；人格指令不落；
6. petId 隔离；reset 只清指定宠物；
7. 记录失败不影响 capture/facts（注入抛错的 store）。

验收（真实宿主）：

- 说「记住，我叫阿岚」→ 主人事实仍正常；「它自己」出现一条 event；
- 说「谢谢你，真乖」→ 心情变好；说「你好烦」→ 变差；
- 重启/热重载后时间线与心情延续；
- 关闭 `selfEnabled` 后不再写，但 facts/voice 不受影响；
- 原有 55 条单测 + 11 条验收仍全绿。

## 11. 里程碑

- P1（本次）：self 存储 + 心情算法 + 记录 + API + 展示 + 单测；不注入。
- P2：注入心情块（可关）+ 预算/冲突验收。
- P3（可选）：LLM 反思（低频、可关、严格限长），以及“重要日子”事件。

## 12. 风险

| 风险 | 处理 |
| --- | --- |
| 自我记忆污染主人事实 | 独立文件/独立 store；recall 只读 facts |
| 情绪变成硬设定 | 只注入状态提示；冲突以 dsh-pet 人格为准 |
| 写入影响回复延迟 | 内存更新 + 异步 append；失败静默 |
| 文件膨胀 | 500 条上限 + 1.5 倍压缩 |
| 伪造/过度拟人 | 只记录真实对话里发生的事；不做无来源的心理独白（P3 才可选） |
| 与 dsh-pet 最近 5 轮重复 | 自我记忆只做跨会话摘要，不复制整段聊天 |

## 13. P1 实施记录（v0.4.0）

- 代码：`lib/self.js`（SelfStore + 6h 半衰期 + 敏感泛化）、`lib/config.js`（4 个 self 键）、
  `lib/ui.js`（`/self`、`/self/state`、`/self/reset`）、`index.js`（创建/注入 capture/teardown）、
  `client.js`（「它自己」tab）；`test/self.test.js` 8 项。
- 全量：63/63 单测（facts 10 / recall 7 / learn 10 / index 8 / ui 14 / voice 6 / self 8）；
  acceptance 11/11；人格检查 7/7。
- 真实宿主 03:33:02 热重载日志：
  `self_loaded {"entries":0,"maxEntries":500,"byPet":{}} enabled=1`，并照常
  `voice_ready` / `settings_api_mounted` / `memory_registered`。
- `GET /pet-persona/api/self/state` 实测：
  `{"ok":true,"state":{"valence":0,"energy":0.5,"label":"平静","energyLabel":"一般","moodText":"平静 · 一般","events":0,"updatedAt":""}}`。
- 数据目录已生成空 `self.jsonl`；`facts.jsonl` 仍为 0 字节，未被触碰。
- P2a 已实现：`selfInject` 默认关，开启后追加独立【现在的我】块；`test/self-context.test.js` 11 项、
  全量 74/74，真实 `/self/state` 与 `/self/preview` 已验证。
- 尚未实测：真实桌宠回合开启注入后的 system 尾部（需用户同意打开开关并聊一轮）。
