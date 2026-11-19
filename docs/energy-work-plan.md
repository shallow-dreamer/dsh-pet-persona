# 精力 · 工作状态消耗计划书

版本：v0.1（2026-11-20）
状态：计划（未实现）
关联：`docs/energy-plan.md`（精力 M1–M5，v0.18.4）、`lib/energy.js`、`lib/config.js`、`client.js`、插件 `dsh-pet`

## 1. 问题

现在精力只有两档速率：

- 醒着 `energyDrainPerHour = 6`
- 睡着 `energyRecoverPerHour = 36`

但「醒着」内部差别很大：等主人、发呆、思考、连续调工具、整理结果，消耗不可能一样。dsh-pet 已经把这份状态暴露出来了，只是精力模块还没用：

- `/dsh-pet-7340/state` → `sections.workStatus.data = { state, task, sessionId }`
- `state` 取值（`dsh-pet/src/shared/work-status.ts:12` 的 `WORK_STATUS_STATES`，顺序固定，勿中间插入）：
  `thinking`（turn/start）、`working`（tool/call）、`result`（tool/result）、`waiting`（approval/asked）、`success`（turn/end completed）、`error`（turn/end error/max-tokens）
- `state = null` 表示空闲
- 该叶子的 `counter` 每次快照变化都会变；`task` 是当前任务描述，`sessionId` 用于气泡点击
- 实测 2026-11-20：`{"counter":1795107501615,"data":{"state":"working","task":"这工具是干嘛的","sessionId":"session-..."}}`

目标：**工作时比单纯醒着掉得快**，且不同工作档位速率不同；睡着仍然只恢复，工作状态不影响恢复。

## 2. 速率模型

### 2.1 档位 → 每小时消耗

| workStatus | 含义 | 默认消耗（点/小时） | 说明 |
| --- | --- | --- | --- |
| `null` / 无 workStatus | 空闲醒着 | 6 | 等于现在的 `energyDrainPerHour` |
| `waiting` | 等审批 / 等主人 | 4 | 比空闲还省，基本在挂机 |
| `thinking` | 一轮开始、思考中 | 12 | 2× 空闲 |
| `working` | 调工具、连续干活 | 18 | 3× 空闲，主力消耗 |
| `result` | 工具返回、整理结果 | 9 | 1.5× 空闲 |
| `success` / `error` | 一轮结束的瞬时态 | 6 | 当作空闲，不额外扣 |

实现上不新增「工作点数」概念，只把 `levelAt()` 的速率从常数换成按当前 `workStatus.state` 查表：

```
ratePerHour = sleeping ? +recoverPerHour : -drainFor(state)
drainFor(state) = {
  null: idle, waiting: idle*0.65, thinking: idle*2,
  working: idle*3, result: idle*1.5, success/error: idle,
}
```

默认倍率写进配置，允许改：

- `energyWorkEnabled`（默认 true）：关掉就退回单档空闲消耗
- `energyWorkDrainPerHour`（默认 18）：`working` 档
- `energyThinkDrainPerHour`（默认 12）：`thinking` 档
- `energyWaitDrainPerHour`（默认 4）：`waiting` 档
- `energyResultDrainPerHour`（默认 9）：`result` 档

`sleepAt` / `wakeAt` / 唤醒惩罚沿用现有规则；睡着时**一律按恢复算**，不看工作状态。

### 2.2 采样粒度

精力 tick 是 60s；workStatus 可能在两次 tick 之间切好几档。第一版按「tick 时看到的档位覆盖这一分钟」算，误差最多一分钟；不追求精确到每次 tool/call。

可选增强（不在 M1）：读 `sections.workStatus.counter`，把两次 tick 之间发生过的状态记成事件序列，按估算时长分摊。只有用户反馈「掉得不准」时再做。

## 3. 与睡觉的关系

现状：≤20 自动睡、≥100 自动醒、外部唤醒扣 5、0 精力叫不醒。

工作状态加入后有三条规则要拍板/实现：

1. **工作中不打断**：精力掉到 `sleepAt` 时，如果 `state` 是 `thinking`/`working`/`result`，先不睡，最多延后 10 分钟；期间说一句「这段还没写完…」；10 分钟后仍在工作就照睡（避免永远不睡）。
2. **睡着不被工作叫醒**：主人开始新会话（`thinking`）不自动唤醒它；只有精力 ≥ `wakeAt` 才醒。保持「睡觉优先」。
3. **工作阈值台词**：跨 70/40/20/5 时按档位换说法，`working` 的 40 档说「有点累了，先把手头这段收个尾」而不是通用「有点累了」。

实现落点：

- `lib/energy.js`：`createEnergyWatch` 每 tick 读 `sections.workStatus.data.state`，传给 `levelAt`/`drainFor`；新增 `workSleepDelayUntil`（延后睡觉截止时间）与 `lastWorkState`；`store.entry` 持久化 `lastWorkState`（可选）。
- 自动睡的条件从 `level <= sleepAt` 改为 `level <= sleepAt && (workState 不在工作中 || now >= workSleepDelayUntil)`。
- 阈值台词表按 `workState` 分两组（空闲组 / 工作组）。
- 手动唤醒仍扣 5；若 `state` 是 `working`，醒来后第一句可以说「我醒了，你继续」。

## 4. 配置与设置页

新增白名单与设置卡（在「精力」卡里加一行「工作时消耗」）：

- 开关 `energyWorkEnabled`
- 数字：`energyWorkDrainPerHour`（默认 18）
- 说明文字：「工作（调工具）时每小时消耗；空闲按上面的消耗算，思考/整理按比例。」

`lib/config.js` 的 `DEFAULTS`、`normalizeConfig`（clamp：work ≥ idle、work ≤ 60）、`lib/ui.js` 的 `publicConfig`/`EDITABLE`、`client.js` 的 `energyCfg` 一并补。

## 5. UI

- 精力条下方提示按状态显示：
  - 空闲：「醒着每小时消耗 6 点」
  - 工作：「工作中 · 每小时约 18 点」
  - 睡着：「睡眠恢复中 · 每小时 36 点」
- 心情卡右侧「睡着/醒着」chip 可加「工作中」小字（可选，先不加，避免太挤）。
- 精力条本地插值（v0.18.4）已有；工作档位切换后最多 60s 对齐一次速率。

## 6. 数据与兼容

- 旧 `energy.json` 没有 `lastWorkState`：按 `null` 处理，读不到 workStatus 时也按空闲算。
- `/state` 请求失败：沿用最近一次档位，超过 3 次失败退回空闲速率，避免网络问题把精力瞬间抽干。
- 插件 `dsh-pet` 未启用或无 `sections.workStatus`：整块功能自动退化为单档消耗。
- 宿主侧 `workStatusEnabled` 关掉时不会写该叶子，同样退化为空闲。

## 7. 里程碑

- **W1**：`drainFor(state)` + `createEnergyWatch` 读 workStatus；配置字段与 clamp；单测覆盖档位 → 速率。
- **W2**：工作中延后睡觉、阈值分组台词、手动唤醒台词；单测覆盖延后与到点照睡。
- **W3**：设置卡「工作时消耗」、精力条提示、白名单；`test/ui.test.js` 补字段。
- **W4**：`docs/energy-plan.md` 增加工作档位一节；真实宿主验证（`working` 时掉速明显更快）；提交。

## 8. 验收

- A1 空闲醒着 1 小时掉 6 点，`working` 1 小时掉 18 点（同起点对比）。
- A2 `thinking` 1 小时 12 点，`result` 1 小时 9 点，`waiting` 1 小时 4 点。
- A3 睡着时无论 workStatus 是什么，都只按恢复速率涨。
- A4 精力降到 20 且 `working`：不立刻睡，最多延后 10 分钟；期间正常掉精力。
- A5 延后到点仍 `working`：照睡，并说「撑不住了…先睡会儿」。
- A6 睡着时开始新会话：不醒；精力到 100 才醒。
- A7 `/state` 连不上：按最近档位算，连续 3 次失败退回空闲；不出现瞬间掉光。
- A8 设置页改「工作时消耗」并保存，下一 tick 生效。

## 9. 待拍板

1. `working` 18 点/小时（3×）是否合适？想更狠可以 24，想温和 12。
2. 工作中延后睡觉：10 分钟够不够？还是干脆「工作期间不睡，直到空闲」？
3. 睡着时主人开始新会话，要不要「迷迷糊糊醒一下」？默认不醒。
4. `waiting` 比空闲还省（4 点）是否符合直觉？
5. 是否要把倍率暴露到设置页，还是只给一个「工作时消耗」数字？

## 10. 风险

- **采样误差**：60s 粒度会把「短暂 thinking」算成整分钟；先接受，必要时用 counter 增强。
- **状态卡死**：宿主异常时 `workStatus.state` 可能停在 `working`，导致一直高消耗。需要「同档连续 90 分钟」视为异常、退回空闲速率，并在日志标记。
- **睡觉与工作打架**：工作延后睡觉可能让精力长期低位；10 分钟上限 + 到点照睡兜底。
- **设置页膨胀**：精力卡已有 6 个数字，再加一行要控制宽度；必要时折叠「高级」。
- **旧配置**：没有 work 字段时按默认倍率，不改变现有用户手感（空闲速率还是 6）。
