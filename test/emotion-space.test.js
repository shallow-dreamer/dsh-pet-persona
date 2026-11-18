import test from 'node:test'
import assert from 'node:assert/strict'

import {
  EMOTION_ANCHORS,
  AXES,
  DEFAULT_CAMERA,
  FUSION_NAMES,
  scoresOf,
  eventPosition,
  fusionPairsOf,
  fusionName,
  clusterFusions,
  projectPoint,
  layoutEmotionMap,
} from '../lib/emotion-space.js'

const NOW = Date.parse('2026-11-18T12:00:00.000Z')
const iso = (hoursAgo) => new Date(NOW - hoursAgo * 3600_000).toISOString()

const emotionEvent = (id, pairs, extra = {}) => ({
  id,
  text: `事件${id}`,
  createdAt: iso(1),
  emotions: pairs.map(([key, score]) => ({ key, score, label: key })),
  ...extra,
})

test('锚点：平静在球心，其余七类在单位球附近', () => {
  assert.deepEqual(EMOTION_ANCHORS.calm, { x: 0, y: 0, z: 0 })
  for (const [key, anchor] of Object.entries(EMOTION_ANCHORS)) {
    if (key === 'calm') continue
    const length = Math.hypot(anchor.x, anchor.y, anchor.z)
    assert.ok(length > 0.8 && length < 1.05, `${key} length=${length}`)
  }
  assert.equal(AXES.length, 3)
  assert.ok(DEFAULT_CAMERA.f > 0)
})

test('单情绪事件落在该锚点方向的射线上，强度由得分决定', () => {
  const strong = eventPosition(emotionEvent('j1', [['joy', 0.9]]), { jitter: false })
  const weak = eventPosition(emotionEvent('j2', [['joy', 0.3]]), { jitter: false })
  const anchor = EMOTION_ANCHORS.joy
  const anchorLength = Math.hypot(anchor.x, anchor.y, anchor.z)

  assert.ok(Math.abs(strong.x - (anchor.x / anchorLength) * strong.strength * 0.9) < 1e-6)
  assert.ok(Math.abs(strong.y - (anchor.y / anchorLength) * strong.strength * 0.9) < 1e-6)
  assert.ok(strong.strength > weak.strength)
  assert.ok(strong.strength <= 1)
})

test('混合情绪落在两类锚点之间，而不是任一侧', () => {
  const position = eventPosition(emotionEvent('mix', [['joy', 0.5], ['tiredness', 0.5]]), { jitter: false })
  const joy = EMOTION_ANCHORS.joy
  const tired = EMOTION_ANCHORS.tiredness
  const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z
  assert.ok(dot(position, joy) > 0)
  assert.ok(dot(position, tired) > 0)
  assert.ok(position.y < joy.y && position.y > tired.y)
})

test('只有平静时落在球心；无情绪字段时按 valence/energy 回退', () => {
  const calm = eventPosition(emotionEvent('c', [['calm', 0.55]]), { jitter: true })
  assert.ok(Math.hypot(calm.x, calm.y, calm.z) < 1e-6)
  assert.equal(calm.strength, 0)
  assert.equal(calm.dominant, 'calm')

  const legacy = eventPosition({ id: 'old', valence: 0.8, energy: 0.9, createdAt: iso(2) }, { jitter: false })
  assert.ok(legacy.strength > 0)
  assert.equal(legacy.dominant, 'joy')
  assert.equal(scoresOf({ emotions: 'bad' }).calm, 0.55)
})

test('抖动由事件 id 决定：同一事件位置稳定，不同事件错开', () => {
  const a1 = eventPosition(emotionEvent('same', [['joy', 0.6]]))
  const a2 = eventPosition(emotionEvent('same', [['joy', 0.6]]))
  const b = eventPosition(emotionEvent('other', [['joy', 0.6]]))
  assert.deepEqual(a1, a2)
  assert.notDeepEqual({ x: a1.x, y: a1.y, z: a1.z }, { x: b.x, y: b.y, z: b.z })

  const noJitter = eventPosition(emotionEvent('same', [['joy', 0.6]]), { jitter: false })
  assert.ok(Math.abs(a1.x - noJitter.x) <= 0.03)
  assert.ok(Math.abs(a1.y - noJitter.y) <= 0.03)
  assert.ok(Math.abs(a1.z - noJitter.z) <= 0.03)
})

test('融合判定：两类都过 0.25 且次情绪不低于主情绪一半', () => {
  const mixed = fusionPairsOf(emotionEvent('f1', [['joy', 0.5], ['tiredness', 0.3]]))
  assert.equal(mixed.length, 1)
  assert.equal(mixed[0].key, 'joy+tiredness')
  assert.equal(mixed[0].name, '满足的累')

  assert.deepEqual(fusionPairsOf(emotionEvent('f2', [['joy', 0.5], ['tiredness', 0.1]])), [])
  const weak = fusionPairsOf(emotionEvent('f3', [['anxiety', 0.3], ['affection', 0.4]]))
  assert.equal(weak[0].name, '舍不得')
  assert.equal(FUSION_NAMES['anger+sadness'], '委屈')
})

test('融合命名：内置表优先，未列出的组合回退成 A 里带点 B', () => {
  assert.equal(fusionName('sadness', 'anger'), '委屈')
  const fallback = fusionName('sadness', 'anxiety')
  assert.ok(fallback.includes('难过') && fallback.includes('担心'), fallback)
  assert.equal(fusionName('joy', 'joy'), '')
})

test('融合云：同类且空间相近的事件聚成一团，成员和颜色可追溯', () => {
  const events = [
    emotionEvent('a', [['joy', 0.5], ['tiredness', 0.45]]),
    emotionEvent('b', [['joy', 0.52], ['tiredness', 0.47]]),
    emotionEvent('c', [['joy', 0.48], ['tiredness', 0.44]]),
  ]
  const clusters = clusterFusions(events, { now: NOW })
  assert.equal(clusters.length, 1)
  assert.equal(clusters[0].key, 'joy+tiredness')
  assert.equal(clusters[0].count, 3)
  assert.equal(clusters[0].events.length, 3)
  assert.ok(clusters[0].color)
})

test('融合云：相距很远的事件不硬并，单条不成云', () => {
  const near = [
    emotionEvent('n1', [['joy', 0.9], ['tiredness', 0.05]]),
    emotionEvent('n2', [['joy', 0.88], ['tiredness', 0.06]]),
  ]
  // 0.05/0.06 不构成融合对
  assert.equal(clusterFusions(near, { now: NOW }).length, 0)

  const far = [
    emotionEvent('f1', [['joy', 0.6], ['tiredness', 0.5]]),
    emotionEvent('f2', [['anger', 0.95], ['sadness', 0.6]]),
  ]
  assert.equal(clusterFusions(far, { now: NOW }).length, 0)
})

test('融合云：超出时间窗口的事件不参与', () => {
  const events = [
    emotionEvent('old1', [['joy', 0.5], ['tiredness', 0.5]], { createdAt: iso(200) }),
    emotionEvent('old2', [['joy', 0.5], ['tiredness', 0.5]], { createdAt: iso(210) }),
  ]
  assert.equal(clusterFusions(events, { now: NOW, windowH: 168 }).length, 0)
  assert.equal(clusterFusions(events, { now: NOW, windowH: 240, minCount: 2 }).length, 1)
})

test('投影：球心在画面中心，远处更小更淡，近处更大', () => {
  const viewport = { width: 640, height: 540 }
  const center = projectPoint({ x: 0, y: 0, z: 0 }, DEFAULT_CAMERA, viewport)
  assert.equal(center.sx, 320)
  assert.equal(center.sy, 270)

  const far = projectPoint({ x: 0, y: 0, z: 160 }, DEFAULT_CAMERA, viewport)
  const near = projectPoint({ x: 0, y: 0, z: -160 }, DEFAULT_CAMERA, viewport)
  assert.ok(far.scale < near.scale)
  assert.ok(far.opacity < near.opacity)
  assert.ok(far.depth > near.depth)
})

test('布局：点按远到近排序，位置不超出球半径，融合云带屏幕坐标', () => {
  const events = [
    emotionEvent('a', [['joy', 0.9]]),
    emotionEvent('b', [['sadness', 0.9]]),
    emotionEvent('c', [['joy', 0.5], ['tiredness', 0.5]]),
    emotionEvent('d', [['joy', 0.52], ['tiredness', 0.5]]),
  ]
  const layout = layoutEmotionMap(events, { now: NOW, radius: 180, jitter: false })
  assert.equal(layout.points.length, 4)
  for (let index = 1; index < layout.points.length; index += 1) {
    assert.ok(layout.points[index - 1].depth >= layout.points[index].depth)
  }
  for (const point of layout.points) {
    assert.ok(Math.hypot(point.x, point.y, point.z) <= 180.01)
    assert.ok(point.sx > 0 && point.sx < 640)
    assert.ok(point.color)
  }
  assert.equal(layout.fusions.length, 1)
  assert.ok(Number.isFinite(layout.fusions[0].sx))
})
