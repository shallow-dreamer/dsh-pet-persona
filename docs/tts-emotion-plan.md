# 桌宠语音情绪化（免费版）计划书

> 版本 v1.0 · 目标插件：`dsh-pet-persona` · 不改 `dsh-pet` 源码

## 1. 目标

让 dsh-pet 的语音听起来有情绪起伏，而不是平铺直叙。免费版只使用 dsh-pet 自带的 Edge 在线 TTS，通过自定义 `VoiceProvider` 在 SSML 的 `pitch` / `rate` / `volume` 上做文章。

- 有明确的情绪方向：开心、低落、惊讶、撒娇、生气、平静。
- 不改 dsh-pet 源码，不新增付费 API。
- 设置里可一键开关，关掉立即回到原生 Edge。
- 失败时不拖垮语音：合成抛错由宿主归一成 `generate-error`，不静默返回空音频。

## 2. 非目标

- 不做 Azure `mstts:express-as` 那种真·情感风格（免费 Edge 通道不支持）。
- 不做声纹/音色克隆。
- 不改 dsh-pet 的音色选择逻辑；不写入 dsh-pet 配置。
- 不把情绪判断交给 LLM；免费版是确定性规则。

## 3. 现状与约束

- dsh-pet 注册表是**单槽**：`petApi7340.voice.register(provider)` 一旦注册，所有语音合成走它；注销走返回的 disposer。
- `SynthInput` 只有 `{ text, voice, rate, signal? }`；`rate` 是 -50..100 的百分比。
- 底层 `@andresaya/edge-tts` 支持 `pitch`（-100..100 Hz）、`rate`（-100..200%）、`volume`（-100..100%）。
- provider 的 `voices` 必须列出自己支持的音色；注册后旧 `edge/...` 限定 id 不再解析，用户需要在设置里重新选一次音色。
- 宿主按「文本 + 音色 + 语速」缓存合成结果；免费版的情绪只由文本决定，因此缓存安全。

## 4. 方案

### 4.1 新增 `lib/tts-emotion.js`

导出：

```js
createEmotionTts({ log, now, intensity = 1 })
// -> { id, name, voices, format: 'mp3', synthesize(input): Promise<Uint8Array> }
```

- `id: 'pet-persona-emotion'`
- `name: '桌宠情绪语音（免费版）'`
- `voices`: 与 Edge 中文常用音色同名的子集：
  - `zh-CN-XiaoyiNeural`（小艺 · 女 · 活泼）
  - `zh-CN-XiaoxiaoNeural`（晓晓 · 女 · 温柔）
  - `zh-CN-YunxiNeural`（云希 · 男 · 阳光）
  - `zh-CN-YunjianNeural`（云健 · 男 · 沉稳）
  - `zh-CN-liaoning-XiaobeiNeural`（小北 · 女 · 东北）
- `format: 'mp3'`；`timeoutMs: 12000`。

### 4.2 情绪判定（确定性）

对文本做轻量打分，得到 `emotion` 与 `strength`（0–1）：

| 信号 | 判定 | 调整 |
|---|---|---|
| `!` `！`、`哈哈`、`好耶`、`太棒`、`喜欢` | happy | pitch +8..18Hz，rate +6..15% |
| `?` `？`、`诶`、`欸`、`真的吗` | surprised | pitch +10..20Hz，rate +4..10% |
| `…` `～` `~`、`呜`、`唉`、`累`、`难过`、`委屈` | low | pitch -6..14Hz，rate -8..16% |
| `哼`、`讨厌`、`生气`、`不理你` | angry | pitch +4..10Hz，rate +4..8%，volume +3..6% |
| 默认 | calm | 0 |

- `rate` 输入是宿主给的百分比，叠加情绪偏移后夹在 -40..40。
- `pitch` 夹在 -30..30 Hz；`volume` 夹在 -10..10%。
- 末尾 `…`/`～` 额外把尾音放慢：rate -2..5%。
- 强度 = `min(1, 命中词数 * 0.25 + 标点权重)`，再乘 `intensity`（0.5–1.5）。

### 4.3 合成

```js
const { EdgeTTS } = await import('@andresaya/edge-tts')
const tts = new EdgeTTS()
const bytes = await tts.generate(text, voice, { pitch, rate, volume, signal, timeout })
return bytes
```

- 动态 import 失败 → 抛 `edge-tts unavailable`，宿主记 `generate-error`。
- 空文本/超 500 字由宿主先拦；provider 仍做一次兜底。
- 失败重试 1 次（仅网络类错误），仍失败则抛出。

### 4.4 注册与开关

- 配置新增：
  - `ttsEmotion: false`（默认关，安装后可在设置里打开）
  - `ttsEmotionIntensity: 1`（0.5–1.5）
- `index.js` 在 `petApi.voice.register` 可用且 `ttsEmotion` 为真时注册；`ctx.effect` 绑定 disposer。
- `applySettings` 开关变化时：先注销旧 provider，再按新配置注册；失败只记 `tts_emotion_failed`，不影响语音/记忆。
- 关闭即回到原生 Edge，无需重启。

### 4.5 设置页

「语音」tab 增加：

- 开关「情绪语音（免费版）」；
- 强度滑杆 0.5–1.5；
- 说明：开启后需在 dsh-pet 语音设置里重新选一次音色（provider 从 `edge` 变为 `pet-persona-emotion`）；
- 当前生效 provider 提示。

## 5. 测试

`test/tts-emotion.test.js`：

1. `scoreEmotion('好耶！')` → happy，参数方向正确。
2. `scoreEmotion('唉…好累')` → low，pitch/rate 为负。
3. `scoreEmotion('哼，不理你了')` → angry，volume > 0。
4. `scoreEmotion('今天天气不错')` → calm，偏移为 0。
5. provider 形状合法（id kebab-case、voices 非空、format mp3）。
6. `synthesize` 用注入的假 edge 客户端：断言传入 `pitch/rate/volume` 在夹取范围，返回 Uint8Array。
7. edge 抛错时 `synthesize` 抛错，不返回空字节。

## 6. 验收

- A1：默认 `ttsEmotion=false`，语音与现在完全一致。
- A2：打开后设置页显示生效；桌宠说「好耶！」音高/语速高于「唉…」。
- A3：关掉后 provider 注销，`voice.list()` 回到原生 edge。
- A4：断网/edge 失败时语音报错，不影响文字聊天与记忆。
- A5：全量单测仍全绿。

## 7. 风险

| 风险 | 处理 |
|---|---|
| 单槽替换导致旧音色失效 | 设置页明确提示重新选音色；关闭即回原生 |
| Edge 免费通道限流/断网 | 抛错、宿主记日志；不做静默降级 |
| 情绪规则误判 | 强度上限 1.5，参数夹取；默认 calm 不改变 |
| 缓存命中旧音频 | 情绪只由文本决定；强度改变时同文本仍命中旧缓存，属可接受 |
| 听起来仍像播音腔 | 免费版上限；后续可替换为 Azure/OpenAI provider |

## 8. 实施顺序

1. 计划书（本文）。
2. `lib/tts-emotion.js` + 单测。
3. 配置 / index 注册 / 设置页开关。
4. 全量测试 92 → 99。
5. 安装 profile、热重载、开关实测、文档。
