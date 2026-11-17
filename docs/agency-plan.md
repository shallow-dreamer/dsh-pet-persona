# 自主行为（L1 + L2）计划书 v1.0

> 目标：让桌宠在“关键时刻”能自己判断、主动提议，并在用户确认后执行**可逆的小动作**；
> 任何情况下都不删除/覆盖用户数据、不改系统设置、不执行 shell、不对外发送。

## 1. 能力边界

| 档 | 行为 | 是否自动 |
| --- | --- | --- |
| L1 观察 | 识别「记一下 / 提醒我 / 今天聊得很多」等信号，生成提议 | 自动生成，**不落盘** |
| L2 可逆 | 写一条笔记、建一条提醒、生成一份当日摘要 | 用户点「允许」后执行，可撤销 |
| L3 系统级 | 删除/覆盖/移动文件、装软件、改设置、权限、支付、外发 | **不做**，不接执行器 |

硬红线（代码里直接拒绝，不依赖提示词）：

- 不执行 shell / 不调用 `child_process` / 不碰 `process` 之外的系统 API；
- 不写用户工作区、不覆盖任何已有文件；只写 `<DSH_HOME>/pet-persona/agency/` 下**新建**文件；
- 不删除文件；撤销只撤销自己创建的文件/记录；
- 拒绝密码、密钥、验证码、身份证/银行卡号等敏感内容（复用 `sensitive.js`）；
- 单条文本 ≤ 200 字；待确认提议 ≤ 20 条；每 10 分钟同类提议去重；
- 执行失败只记录，不重试写盘；全局开关 `agencyEnabled` 可随时关。

## 2. 数据与文件

```
pet-persona/
  agency/
    notes/<id>.md          # 一条笔记一个文件，wx 新建，永不覆盖
    digests/<YYYY-MM-DD>.md# 当日摘要，已存在则拒绝
    reminders.jsonl        # 追加；撤销=追加 cancelled 记录，不删行
    proposals.jsonl        # 提议的追加日志（状态快照）
  agency-audit.jsonl       # 审计：propose/approve/reject/execute/undo/fail
```

提议对象：

```json
{
  "id": "a_...", "petId": "main", "kind": "note|reminder|digest",
  "risk": "low|medium", "title": "…", "detail": "…",
  "payload": { "text": "…", "due": "…" },
  "status": "pending|approved|rejected|done|failed|undone",
  "createdAt": "ISO", "decidedAt": "ISO", "result": "…", "undo": {…}
}
```

## 3. 决策规则（L1，纯规则，不调模型）

- `记一下/记下/帮我记/备注：X` → `note`（低风险）
- `提醒我 X` / `X 的时候提醒我` → `reminder`（低风险，`due` 只做原样保存，暂不自动排程）
- 当天 `self` 事件 ≥ 5 且未生成摘要 → `digest`（低风险，内容由确定性模板拼，不调模型）
- 已归档事实 > 100 或活跃 ≥ 90% 上限 → `tidy` 建议（**只提示**，不自动归档）
- 同一 `kind + 归一化文本` 10 分钟内只提一次；`pending` 满 20 条不再新增。

## 4. 交互

设置页新增第 7 个 tab「自主」：

- 顶部：总开关、待确认数、审计条数；「刷新」。
- 待确认卡片：风险徽章、标题、详情、目标路径（只读）、按钮「允许」「拒绝」。
- 历史：状态、时间、结果；`done` 且可撤销的显示「撤销」。
- 说明文字：所有动作都可在这里看到；宠物不会自己删文件或执行命令。

不主动弹窗、不主动说话；先做“提议可见、确认可控”。

## 5. 执行器

| kind | 动作 | 撤销 |
| --- | --- | --- |
| note | 新建 `agency/notes/<id>.md`（`wx`） | 删除该文件（仅自己创建的 id） |
| reminder | 追加 `agency/reminders.jsonl` | 追加 `{id, cancelled:true}`，不删行 |
| digest | 新建 `agency/digests/<date>.md`（`wx`） | 删除该文件 |
| tidy | 无执行器，只提示 | — |

所有写文件前：路径必须 `resolve` 在 `agency/` 内；文件名固定由 id/日期生成；不使用用户文本做文件名。

## 5.1 L2 增强：到点提醒与审计（v0.8.0）

L1/L2 六步落地后补充的两项「自主性」增强：

1. **提醒到点浮出**
   - `parseDue(text, now)` 只认明确时间：`2026-11-18 09:30`、`明天 9:30`、`30 分钟后`；认不出返回空，不猜。
   - 用户确认「提醒」时把 `due` 写入 `reminders.jsonl`；agency 每 30 秒 `tick()` 一次。
   - 到点生成一条 `reminder_due` 待确认提议，不自动执行；用户点「允许」后通过 dsh-pet `/broadcast` 让桌宠气泡播报一次（`speak` 由 index 注入，调用失败只记 `agency_speak_failed`）。
   - 同一提醒只浮出一次（`notified` 持久化）；队列满时等下一轮。
2. **审计详情**
   - `GET /pet-persona/api/agency/audit?limit=60`，`/agency` 同时带最近 40 条。
   - 设置页「自主」底部显示时间、事件、kind/title/result/error，便于回溯「它为什么提议 / 执行了什么 / 哪一步失败」。

边界不变：仍然只有「提议 → 用户允许 → 可逆执行」；到点提醒也只是提议，不自动说话。

---

## 6. 验收

| # | 场景 | 期望 |
| --- | --- | --- |
| A1 | 桌宠对话「记一下：明天买猫粮」 | 生成 1 条 pending note，无文件写入 |
| A2 | 点「允许」 | 生成 `agency/notes/<id>.md`，内容含文本；审计 `execute` |
| A3 | 再点「撤销」 | 文件被删除；审计 `undo`；其他文件不动 |
| A4 | 「提醒我 9 点吃药」 | 生成 reminder；允许后追加一行；撤销只追加 cancelled |
| A5 | 同一句说两次 | 10 分钟内只有 1 条 pending |
| A6 | 含密码/密钥的文本 | 不生成提议，审计 `sensitive_skip` |
| A7 | pending 达 20 | 不再新增，返回 `queue_full` |
| A8 | 执行时文件已存在 | 拒绝并记 `failed`，不覆盖 |
| A9 | 关闭总开关 | 不生成、不执行；已有 pending 仍可查看/拒绝 |
| A10 | 回归 | 81 项既有单测全绿；facts/self/voice 不受影响 |

## 7. 步骤

1. 本计划书
2. `lib/agency.js`：存储、规则、执行器、审计、撤销
3. `index.js` / `config.js` / `ui.js` 接线
4. `client.js`「自主」tab
5. `test/agency.test.js` + 全量
6. 安装、热重载、真实 API 验证、文档

## 8. 风险

- **误触发**：只在 capture（桌宠对话）里观察，规则保守；不确定就不提议。
- **重复打扰**：去重 + 上限；默认不主动弹窗。
- **撤销不彻底**：笔记/摘要是一个文件一个动作；提醒是追加式，撤销保留审计。
- **未来扩展**：L3 永不默认开启；若以后接系统动作，必须先做权限沙箱和 dry-run，不在本版范围。
