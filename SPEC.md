# dsh-pet-persona — 桌宠人格记忆插件（SPEC）

> 状态：设计规格（待实现）。实现者请按本文 + `docs/host-api.md` + `docs/memory-algo.md` 三份文件施工。
> 一句话：不改 dsh-pet 本体，用一个伴生插件挂到 `petApi7340.memory`，给桌宠补上「跨会话长期事实记忆」；人格仍由 dsh-pet 的 `whisperPrompt` 负责。

## 1. 目标

1. 桌宠能记住主人跨会话说过的稳定事实（名字、称呼、作息、喜好、约定、重要事件）。
2. 每轮对话把「相关事实」注入 system，不覆盖原人设、名字、时间声明。
3. 记忆完全本地落盘，重启 DSH 后仍在；卸载/禁用插件后 dsh-pet 行为恢复原样。
4. recall 纯同步、无 IO、不联网、不调 LLM，自设 400ms 软截止（宿主硬超时 1500ms；超时=本轮记忆丢失且不留日志）。

## 2. 非目标

- 不做 UI 面板（第一版只做后台 + 可选 CLI 工具）。
- 不替代 `whisperPrompt` 人格设定；不写角色扮演剧情。
- 不做多用户/多设备同步；不做向量数据库（不引入 embedding 依赖）。
- 不改 dsh-pet 源码，不 fork。

## 3. 运行环境

| 项 | 值 |
| --- | --- |
| DSH | 0.2.2-rc.1 |
| dsh-pet | 0.4.5（已装，`petApi7340.memory` 可用） |
| DSH_HOME | `E:/DeepSeek/dsh-home` |
| profile | `desktop` |
| 工作区 | `E:/DSH` |
| 插件源码 | `E:/DSH/plugins/dsh-pet-persona/` |
| 插件数据 | `E:/DeepSeek/dsh-home/pet-persona/` |

约束：插件包必须装成**真实目录**（`file:` 依赖），**不能用 Junction**，否则 `@deepseek-ai/*` 解析失败、插件静默不加载。

## 4. 包结构

```
E:/DSH/plugins/dsh-pet-persona/
  package.json          # type=module, main=index.js, dsh.bundle.patch=./cordis.patch.yml
  cordis.patch.yml      # insert 一个 plugin 条目，带入 config 默认值
  index.js              # 宿主侧：注册 provider、读写事实库
  docs/host-api.md      # 接口契约（host-api 产出）
  docs/memory-algo.md   # 记忆算法（memory-algo 产出）
  SPEC.md               # 本文件
  test/                 # 可选：node 脚本做离线单测
```

`cordis.patch.yml` 形态参考 `E:/DSH/plugins/dsh-independent-input/cordis.patch.yml`：

```yaml
- insert:
    - id: dsh-pet-persona
      name: dsh-pet-persona
      config:
        enabled: true
        budgetChars: 1200
        autoLearn: true
        learnEveryTurns: 6
```

## 5. 运行机制（时序）

```
用户发一句
  → dsh-pet 调 provider.recall({ petId, system, history, userText, ... })
       · 读本地 facts（内存缓存），中文 bigram 打分，预算内拼「【长期记忆】…」
       · 返回 { system: 原system + "\n\n" + 记忆块 }   ← 整段替换，必须保留原 system
       · 无命中/异常 → 返回 undefined（不改任何内容）
  → 宿主带新 system 请求模型，生成回复，落盘 memory.json
  → provider.capture({ petId, userText, replyText, ts })   ← 异步，不阻塞回复
       · 入队；每 N 轮或空闲 60s 触发一次事实抽取（LLM），合并进 facts.jsonl
```

关键点：
- recall 返回的 `system` 是**整段替换**，漏掉原 system 就等于删掉人设。
- recall 有 1500ms 硬超时，超时=当作没改；所以 recall 里禁止网络/LLM/大文件重读。
- 同一时刻只有一个 provider 生效（后注册覆盖），id 不能是 `native`。若用户还装了别的记忆插件，会互相顶掉——启动时用 `memory.list()` 打日志提示。
- `memory` 只暴露 `register`（同步生效，返回 disposer）与 `list`，**没有 unregister**；用 `ctx.effect` 绑定 disposer 即可在禁用/卸载时立即回原生。
- recall 在 dsh-pet 的串行写锁内执行（`plugin/chat-memory.ts:307/348`），慢 recall 会连带阻塞后续 `/chat` 与删历史——这是「recall 禁止 IO」的硬性理由。
- provider 槽是模块级单例，比 `petApi7340` 服务活得久；dsh-pet 重载后槽位是否保留未实测（见 `docs/host-api.md` §4），实现时加 `list()` 自检。

## 6. 接口契约

以 `docs/host-api.md` 为准（含 `src/host/plugin/setup.ts`、`chat-memory.ts`、`chat-memory-provider.ts` 的文件:行号引用）。实现前必须核对该文档中标了「待核实」的项。

## 7. 记忆模型

以 `docs/memory-algo.md` 为准。第一版最小字段：

```jsonl
{"id":"f_01H...","type":"identity|preference|routine|event|relation","key":"主人.称呼","value":"叫我阿岚","quote":"以后叫我阿岚","importance":5,"pinned":false,"createdAt":"2026-11-14T12:00:00Z","validTo":null,"hits":0}
```

- 文件：`<DSH_HOME>/pet-persona/facts.jsonl`（追加写，定期整理为快照）
- 写入：`tmp` 文件 + `rename` 原子替换；同一进程内用一条 Promise 队列串行化
- 容量：活跃事实 ≤ 500 条，超出按 importance/最近命中淘汰（打 `validTo`，不物理删）

## 8. 配置项（cordis config）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | true | 总开关；false 时注册一个 no-op 直接返回 undefined |
| `budgetChars` | 1200 | 注入记忆的字符预算（中文≈1 token/字，别当 token 用） |
| `autoLearn` | true | 是否在 capture 时自动抽事实 |
| `learnEveryTurns` | 6 | 每多少轮触发一次抽取 |
| `idleLearnMs` | 60000 | 空闲多久触发一次抽取 |
| `maxFacts` | 500 | 活跃事实上限 |
| `model` | 空=宿主默认 | 抽取用的模型，空则用 `agentDefaultModel` |

## 9. 工具（可选，P1）

- `pet_fact_list` / `pet_fact_forget <id>` / `pet_fact_add <value>`：便于用户纠错。
- 第一版可以不做；若做，必须 `inject: ['tools']` 且不影响 recall。

## 10. 安装与启用

```bash
# 1) 装到 profile（真实目录）
cd E:/DeepSeek/dsh-home/profiles/desktop
# 方式 A：改 package.json 依赖 "dsh-pet-persona": "file:E:/DSH/plugins/dsh-pet-persona"
#         并把 "dsh-pet-persona" 加进 dsh.profile.bundles
# 方式 B：
dsh plugin --profile desktop add E:/DSH/plugins/dsh-pet-persona
# 2) 重启 DSH（或插件管理页热加载）
# 3) 验证暴露：设置→插件，应看到 dsh-pet-persona 已启用、无报错
```

## 11. 验收标准

1. 首次启动后 `E:/DeepSeek/dsh-home/pet-persona/facts.jsonl` 被创建（可为空）。
2. 说「我叫阿岚，以后叫我阿岚」→ 若干轮后 facts 出现对应条目（`quote` 保留原话）。
3. 重启 DSH → 新会话问「我叫什么」→ 回答含「阿岚」。
4. 不相关闲聊时 recall 注入为空，system 与未装插件时**逐字相同**（对比日志/抓包）。
5. 人为让 recall 抛错 → 回复正常，仅日志告警。
6. 注入内容始终 ≤ `budgetChars`，且 `【长期记忆】` 出现在原 system 之后。
7. 卸载/禁用插件 → dsh-pet 人格与对话与从未安装时一致。
8. 事实重复陈述 3 次 → facts 不出现 3 条重复（合并或 UPDATE）。

## 12. 已知陷阱

- **覆盖 system**：返回 patch 时必须 `system: base + block`，不能只给块。
- **recall 里做重活**：任何 await 网络/LLM 都可能撞 1500ms 超时，表现为「时灵时不灵」。
- **provider 单槽**：与 dsh-fish-memory / dsh-pet-memory 类插件冲突，装前先 `memory.list()`。
- **memory.json 与 facts.jsonl 是两套**：前者是 dsh-pet 原生短期轮次，后者是我们的长期事实；不要互相改写。
- **petId**：facts 按 `petId` 分库或至少带 `petId` 字段，多宠物不要串味。
- **敏感信息**：抽取 prompt 明确要求跳过密码/密钥/证件号；落盘前做一次正则过滤。
- **不要把 `budgetChars` 当 token**：中文 1 字≈1 token，1200 字≈1200 token，按模型上下文留余量。

## 13. 实现顺序

1. 读 `docs/host-api.md` + `docs/memory-algo.md`，核对第 6 节「待核实」项。
2. 建包骨架（package.json / cordis.patch.yml / index.js 空实现），先 `dsh plugin add` 验证能加载、能 `ctx.get('petApi7340')`。
3. 实现 facts 存储层（读写/原子写/缓存）+ 单测。
4. 实现 recall（打分、预算、注入格式），用假 input 单测。
5. 接上 provider，验证「不改 system 时逐字相同」。
6. 实现 capture + 抽取队列 + LLM prompt。
7. 跑第 11 节 8 条验收；把结果写进 `docs/verify.md`。
8. 交给 lead 复核 diff。
