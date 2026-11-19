# 宠物精力模块计划书

版本：v0.2（2026-11-20）
状态：已实现（v0.18.0），待重启 DSH 后实机验证
关联：`docs/self-plan.md`（心情/梦话）、`docs/agency-l3-plan.md`、`lib/whisper.js`、`lib/self.js`、dsh-pet 宿主
目标插件：`dsh-pet-persona`（E:\DSH\plugins\dsh-pet-persona）

## 1. 目标

给 dsh-pet 的桌宠加一条**精力（energy）**：

- 醒着时精力持续消耗；睡着时只恢复、不消耗。
- 精力越低，越会主动说不同强度的「该休息了」。
- 低于阈值自动睡下；精力满后自动醒来。
- 宠物状态始终以 dsh-pet 的 `pets.<id>.sleep.sleeping` 为准。
- 用户能强行唤醒，但精力为 0 时叫不醒。
- 像电子宠物机，但只有「精力」这一项：不能喂食、不能玩耍，只能靠休息恢复。

非目标：饥饿/清洁/心情值等其它养成数值；不改变 dsh-pet 自己的睡眠动画与菜单。

## 2. 与 dsh-pet 的接口

已确认（见 dsh-pet 源码）：

- 路由前缀 `/dsh-pet-7340`（`ROUTE_SEGMENT`），端口随 DSH web 变化（当前 56649）。
- `GET /state`：`pets.<id>.sleep.data.sleeping` 是醒/睡的唯一真相；`lock` 叶子表示第三方占用。
- `POST /sleep?pet=main`：让它睡下；返回 `{ok:true, sleeping:true, changed, start, loop, end}`；
  - 被锁时返回 `{ok:false, code:'locked'}`；
  - 没配睡觉动画返回 `{ok:false, code:'no-sleep-animations'}`；
  - 已经睡着时幂等返回 `changed:false`。
- `POST /wake?pet=main`：叫醒；返回 `{ok:true, sleeping:false, changed}`，永远安全、幂等。
- `POST /broadcast?pet=main` body `{text, duration?, anim?}`：把一句话写进 `pets.main.say` 气泡，
  用于「该休息了」「睡饱了」等台词；不经过模型生成。
- 睡觉/醒来时 dsh-pet 自己会从配置里挑台词弹气泡（`sleepStartTexts/sleepEndTexts`）；
  精力模块的台词应避免和它同时刷屏，可只在阈值跨越时说话。

## 3. 精力数值

| 项 | 值 | 说明 |
| --- | --- | --- |
| 范围 | 0–100（浮点，落盘保留 1 位） | 0 = 精疲力尽，100 = 满 |
| 初始值 | 100（首次运行） | 可配置 |
| 醒着消耗 | 1 点 / 10 分钟 | 满 → 空约 16.7 小时 |
| 睡着恢复 | 6 点 / 10 分钟 | 空 → 满约 2.8 小时 |
| 计时粒度 | 60 秒 tick | 按 `now - lastTick` 折算，支持关机/休眠后补算 |
| 时间跳变 | 单次最多补算 24h | 时钟回拨只更新 lastTick，不倒扣 |

数值都在 `config` 里可调；上表是默认值。

## 4. 状态机

```
awake ──精力≤20──▶ asleep（自动睡）
awake ──用户/菜单 sleep──▶ asleep
asleep ──精力≥100──▶ awake（自动醒）
asleep ──用户强行 wake 且精力>0──▶ awake（精力不补）
asleep ──用户强行 wake 且精力=0──▶ 拒绝：立刻再睡 + 气泡「叫不醒…」
```

- 精力 ≤ 0 时进入「睡死」：`sleeping=true` 且 `energy<=0`。任何 wake 请求都回写 sleep，
  并在气泡里说一句迷糊的话；直到精力恢复到 >0 才允许被叫醒。
- 精力 0 时**不自动醒**；只有恢复到 100 才自动醒。
- 用户手动点「起来」在精力 >0 时立即生效；精力值保持当前值（不奖励也不惩罚）。
- 如果用户手动让它睡（菜单），精力照常恢复；不强制要求精力低才能睡。

## 5. 休息请求（按程度）

跨阈值时各说一次（同一阈值 30 分钟内不重复）：

| 精力 | 状态 | 气泡示例 | 频率 |
| --- | --- | --- | --- |
| ≤70 | 有点累 | 「有点困了…我眯一会儿好不好」 | 首次跨过时说 |
| ≤40 | 明显累 | 「真的累了，想趴一会儿」 | 首次跨过时说 |
| ≤20 | 撑不住 | 「不行了，我要睡了…」然后自动睡 | 首次跨过时说，紧接 sleep |
| ≤5 | 快没电 | 「眼皮好重…」 | 首次跨过时说 |
| 0 | 睡死 | 被叫时「唔…叫不醒的…」 | 被 wake 时 |

阈值跨过才说，避免每次 tick 重复；文案池随机取，可配置。

## 6. 存储

`E:\DeepSeek\dsh-home\pet-persona\energy.json`：

```json
{
  "main": {
    "level": 72.4,
    "updatedAt": "2026-11-19T00:45:00+08:00",
    "sleeping": false,
    "lastThreshold": 70,
    "lastSpokeAt": "2026-11-19T00:40:00+08:00"
  }
}
```

- 原子写（临时文件 + rename），启动时读；文件坏/缺失按初始 100 处理。
- `sleeping` 只作为观察缓存，真相仍以 dsh-pet `/state` 为准；启动时用 `/state` 校准。
- 按 petId 分键，当前只有 `main`。

## 7. 与现有代码的接法

- 新增 `lib/energy.js`（纯逻辑 + 一个 watcher）：
  - `createEnergyStore({dir, config})`：读/写 energy.json，`levelAt(now)` 折算当前精力。
  - `createEnergyWatch({store, petId, endpoint, sleep, wake, say, log})`：
    - 每 60s tick：读 `/state` 校准 sleeping → 按醒/睡折算精力 → 跨阈值说话 → 到点 sleep/wake。
    - `sleep()` = POST `/sleep?pet=`；`wake()` = POST `/wake?pet=`；`say()` = POST `/broadcast`。
    - 监听 `/state` 里 `sleeping` 从 true→false 且能量为 0：立即 sleep + say「叫不醒」。
- `lib/ui.js`：`/self` 响应加 `energy: {level, sleeping}`，设置页可显示。
- `client.js`：心情卡旁边加一条精力条（0–100），睡眠时显示「睡眠恢复中 +x/10min」。
- 轮询复用 `lib/whisper.js` 已有的 5s `/state` 轮询：把 sleep 叶子同时交给 energy watch，
  避免两套轮询；或 energy 用 60s 独立定时器，读同一个 state 缓存。

## 8. 失败与边角

- dsh-pet 不可达：本 tick 跳过，保留 lastTick，不扣不补；连续失败只在日志里记一次。
- 被锁（`locked`）：不能睡；精力继续消耗，每 5 分钟重试一次 sleep；气泡提示「被占用，睡不着」。
- 没有睡觉动画（`no-sleep-animations`）：只降精力、不强制睡，记日志一次，提示用户补配置。
- DSH 重启：从 energy.json 按时间差补算；如果重启期间一直「醒着」（sleeping 缓存 false）会扣精力，
  建议启动时若 dsh-pet 实际睡着则按睡着补算，避免冤枉扣。
- 长时间关机：最多补 24h，避免一开机就 0。
- 时钟回拨：只更新 updatedAt，不扣不多。
- 用户手动睡：不改变精力恢复速率；手动醒（>0）正常。
- 提醒与 dsh-pet 自带入睡台词冲突：跨阈值台词在进入 sleep 前 1 个 tick 说，或仅用气泡短句。

## 9. 里程碑

- M1：`lib/energy.js` 数值模型 + 存储 + 单测（时间折算、阈值、0 精力拒醒、时间跳变）。
- M2：接 dsh-pet `/sleep`、`/wake`、`/state`，自动睡/自动醒跑通（可用假 endpoint）。
- M3：阈值台词 + 自动睡 + 叫不醒逻辑。
- M4：`/self` 暴露 energy、设置页/心情卡精力条。
- M5：真实宿主联调（改 dsh-pet 菜单睡觉/起来、观察精力条与气泡），验收后提交。

## 10. 验收

- A1 首次运行精力 100，醒着 10 分钟扣 1。
- A2 精力 ≤20 自动 sleep，`/state.sleeping=true`，气泡说累。
- A3 睡着 10 分钟恢复 6，满 100 自动 wake。
- A4 精力 0 时点「起来」被拒绝，1 个 tick 内回睡，气泡「叫不醒」。
- A5 精力 >0 时强行唤醒成功，精力不跳变。
- A6 被锁时不能睡，解锁后自动补睡。
- A7 重启后按时间差补算，不重复跨阈值说话。
- A8 时钟回拨/前跳 30 天不会把精力算成负数或瞬间 0。
- A9 没有睡觉动画时不崩，日志有一次明确提示。
- A10 手动睡/醒与自动逻辑不打架（不会刚醒又被立刻睡回去，除非精力 0）。

## 11. 待拍板（已拍板）

1. 消耗/恢复速率是否用 1/10min、6/10min？
2. 初始精力 100 还是 80？
3. 自动醒的线是 100 还是 95（避免刚好 100 抖动）？
4. 强行唤醒是否扣 5 点精力（惩罚赖床）？
5. 精力条放设置页、心情卡，还是桌宠右键面板？

## 12. 风险

- dsh-pet 睡眠是 host 内存态，重启即空：重启后要靠 `/state` 校准，不能只信 energy.json。
- 自动 sleep 与 dsh-pet 菜单「睡觉」共用同一状态，用户手动操作优先，精力模块只观察和补动作。
- 每 60s 一次 `/state` + 偶尔 POST，频率低；不要每次 tick 都 broadcast。
- 精力为 0 时若 dsh-pet 反复被外部 wake，需要防抖（1 分钟内最多回睡 1 次、气泡 1 次）。

## 13. 实现记录（v0.18.0）

已拍板（2026-11-20，实施中问过使用者）：

- 速率：醒着 1 点 / 10 分钟（6/h），睡着 6 点 / 10 分钟（36/h）；
- 初始精力 100；
- 强行唤醒扣 5 点；
- 自动醒线 100。

实现位置：

- `lib/energy.js`：`createEnergyStore`（读写 `<dir>/energy.json`，按 petId 分键、临时文件 + rename、补算上限 24h、时钟回拨不变）+ `createEnergyWatch`（60s tick，读 `/dsh-pet-7340/state` 校准、阈值播报、自动睡/醒、0 精力拒醒、扣点、防抖）。
- `lib/config.js`：`energyEnabled`、`energyStart`、`energyDrainPerHour`、`energyRecoverPerHour`、`energySleepAt`、`energyWakeAt`、`energyWakePenalty`；均有 clamp。
- `index.js`：在 `speak` 之后创建 store/watch 并 `start()`，传给 `createApiHandler`，dispose 时 `stop()`。
- `lib/ui.js`：`/self` 与 `/self/state` 增加 `energy: { level, sleeping, updatedAt, drainPerHour, recoverPerHour, sleepAt, wakeAt }`。
- `client.js`：心情卡精力条改用真实 `energy.level`（0–100），睡眠时显示「睡眠恢复中」，≤20 红→黄；下方提示当前速率与阈值。

行为细节：

- 阈值 70/40/20/5 只在向下跨过时各播报一次；回到 75 以上重置，可再次播报。
- ≤20 自动 `POST /sleep`；睡着 ≥100 自动 `POST /wake` 并说「睡饱了，我回来啦。」。
- 被外部唤醒且精力 ≤0：立刻 `POST /sleep` 并说「唔…叫不醒的…」，60s 防抖；精力 >0 的强行唤醒扣 5 点。
- `locked` / `no-sleep-animations` 只记一次日志，不刷屏。

验证：`test/energy.test.js` 7 项；全量 15+1 个测试文件 143 项全过；`node --check` 通过。

注意：`lib/*` 变更要重启 DSH 才生效；`energy.json` 首次启动时按 start 写入。
