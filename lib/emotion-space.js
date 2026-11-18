/**
 * 3D 情绪空间：把一条自我记忆放进球里，位置由多类情绪得分加权得到。
 *
 * 纯函数、无 DOM、无 IO：客户端只负责画，投影/布局/融合都在这里，可单独测试。
 * 坐标轴：x 亲近(+)/对抗(-)，y 有精神(+)/疲惫(-)，z 安心(+)/不安(-)，平静在球心。
 */

import { EMOTION_LABELS, EMOTION_COLORS, blendLabel } from './emotion.js'

export const EMOTION_ANCHORS = {
  joy: { x: 0.1, y: 0.9, z: 0.35 },
  affection: { x: 0.85, y: 0.35, z: 0.25 },
  sadness: { x: -0.1, y: -0.85, z: -0.45 },
  anger: { x: -0.85, y: 0.45, z: 0.2 },
  anxiety: { x: -0.2, y: 0.15, z: -0.9 },
  tiredness: { x: 0.1, y: -0.8, z: 0.3 },
  surprise: { x: 0.2, y: 0.7, z: -0.55 },
  calm: { x: 0, y: 0, z: 0 },
}

export const AXES = [
  { key: 'x', from: '对抗', to: '亲近' },
  { key: 'y', from: '疲惫', to: '有精神' },
  { key: 'z', from: '不安', to: '安心' },
]

export const DEFAULT_CAMERA = { rotX: -12, rotY: 18, f: 520, zoom: 1 }

/** 融合命名：短、可读，只描述共现，不当作新情绪。 */
export const FUSION_NAMES = {
  'joy+tiredness': '满足的累',
  'anger+sadness': '委屈',
  'affection+anxiety': '舍不得',
  'affection+joy': '甜甜的亲近',
  'affection+sadness': '心疼',
  'anger+anxiety': '又慌又气',
  'joy+surprise': '惊喜',
  'calm+tiredness': '放空',
  'anger+tiredness': '烦躁',
  'sadness+tiredness': '低落',
  'anxiety+surprise': '一惊',
  'calm+joy': '安心开心',
}

export const FUSION_COLORS = {
  'joy+tiredness': '#b9d97a',
  'anger+sadness': '#b07d9a',
  'affection+anxiety': '#d79ac0',
  'affection+joy': '#f0a8b8',
  'affection+sadness': '#b9a0d8',
  'anger+anxiety': '#c97a9e',
  'joy+surprise': '#ffc46b',
  'calm+tiredness': '#b8bda8',
  'anger+tiredness': '#d09a6a',
  'sadness+tiredness': '#8f9bc0',
  'anxiety+surprise': '#d09ac8',
  'calm+joy': '#a8d8b0',
}

function hash32(value) {
  const text = String(value ?? '')
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function jitterOf(event) {
  const hash = hash32(event?.id || `${event?.createdAt || ''}|${event?.text || ''}`)
  const pick = (shift) => (((hash >>> shift) & 0xff) / 255) * 2 - 1
  return { x: pick(0) * 0.03, y: pick(8) * 0.03, z: pick(16) * 0.03 }
}

/** 读取事件的多情绪得分；旧记录没有 emotions 时按 valence/energy 回退。 */
export function scoresOf(event) {
  const scores = {}
  const list = Array.isArray(event?.emotions) ? event.emotions : []
  for (const item of list) {
    const key = item?.key
    const score = Number(item?.score)
    if (!key || !(key in EMOTION_ANCHORS) || !Number.isFinite(score)) continue
    scores[key] = Math.max(scores[key] || 0, Math.min(1, score))
  }
  if (Object.keys(scores).length > 0) return scores

  const valence = Number(event?.valence) || 0
  const energy = Number.isFinite(Number(event?.energy)) ? Number(event.energy) : 0.5
  if (valence > 0.05) scores.joy = Math.min(1, valence)
  else if (valence < -0.05) scores.sadness = Math.min(1, -valence)
  if (energy > 0.6) scores.surprise = Math.min(1, (energy - 0.6) * 2)
  else if (energy < 0.4) scores.tiredness = Math.min(1, (0.4 - energy) * 2)
  if (Object.keys(scores).length === 0) scores.calm = 0.55
  return scores
}

/**
 * 事件在单位球里的位置。
 * 方向 = 多情绪锚点的加权和；距离 = 主导强度 + 其余情绪的少量加成。
 */
export function eventPosition(event, { jitter = true } = {}) {
  const scores = scoresOf(event)
  let vx = 0
  let vy = 0
  let vz = 0
  let max = 0
  let sum = 0
  for (const [key, score] of Object.entries(scores)) {
    if (key === 'calm' || score <= 0.08) continue
    const anchor = EMOTION_ANCHORS[key]
    vx += anchor.x * score
    vy += anchor.y * score
    vz += anchor.z * score
    sum += score
    if (score > max) max = score
  }

  const length = Math.hypot(vx, vy, vz)
  if (length < 1e-4) {
    return { x: 0, y: 0, z: 0, strength: 0, scores, dominant: 'calm' }
  }

  const strength = Math.min(1, max + 0.25 * Math.max(0, sum - max))
  const magnitude = strength * 0.9
  const offset = jitter ? jitterOf(event) : { x: 0, y: 0, z: 0 }
  const x = (vx / length) * magnitude + offset.x
  const y = (vy / length) * magnitude + offset.y
  const z = (vz / length) * magnitude + offset.z
  const dominant = Object.entries(scores)
    .filter(([key, score]) => key !== 'calm' && score > 0.08)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || 'calm'

  return { x, y, z, strength, scores, dominant }
}

export function pairKey(a, b) {
  return [a, b].sort().join('+')
}

export function fusionName(a, b) {
  if (!a || !b || a === b) return ''
  const key = pairKey(a, b)
  if (FUSION_NAMES[key]) return FUSION_NAMES[key]
  const left = { key: a, label: EMOTION_LABELS[a] || a }
  const right = { key: b, label: EMOTION_LABELS[b] || b }
  return blendLabel(left, right)
}

/**
 * 一条事件参与的融合对：两类都 ≥0.25，且次情绪 ≥ 主情绪的一半。
 * 最多看前 4 类，避免 3 类以上互相组合爆炸。
 */
export function fusionPairsOf(event) {
  const items = Object.entries(scoresOf(event))
    .filter(([, score]) => score >= 0.25)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 4)
  const pairs = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const [a, scoreA] = items[i]
      const [b, scoreB] = items[j]
      if (scoreB < scoreA * 0.5) continue
      const key = pairKey(a, b)
      pairs.push({
        key,
        a,
        b,
        scoreA,
        scoreB,
        name: fusionName(a, b),
        color: FUSION_COLORS[key] || EMOTION_COLORS[a],
      })
    }
  }
  return pairs
}

/**
 * 把同类融合对在空间上聚成云。用质心贪心聚类，事件规模 ≤ 几百，够用。
 */
export function clusterFusions(events = [], { now = Date.now(), radius = 0.35, windowH = 168, minCount = 2 } = {}) {
  const groups = new Map()
  const cutoff = now - windowH * 3600 * 1000

  for (const event of events) {
    const createdAt = Date.parse(event?.createdAt || '')
    if (Number.isFinite(createdAt) && createdAt < cutoff) continue
    const position = eventPosition(event, { jitter: false })
    for (const pair of fusionPairsOf(event)) {
      if (!groups.has(pair.key)) groups.set(pair.key, { pair, events: [] })
      groups.get(pair.key).events.push({ event, position })
    }
  }

  const clusters = []
  for (const group of groups.values()) {
    const buckets = []
    for (const item of group.events) {
      let target = null
      for (const bucket of buckets) {
        const distance = Math.hypot(
          item.position.x - bucket.cx,
          item.position.y - bucket.cy,
          item.position.z - bucket.cz,
        )
        if (distance < radius) { target = bucket; break }
      }
      if (!target) {
        target = { cx: item.position.x, cy: item.position.y, cz: item.position.z, items: [] }
        buckets.push(target)
      }
      target.items.push(item)
      const count = target.items.length
      target.cx += (item.position.x - target.cx) / count
      target.cy += (item.position.y - target.cy) / count
      target.cz += (item.position.z - target.cz) / count
    }

    for (const bucket of buckets) {
      if (bucket.items.length < minCount) continue
      const memberEvents = bucket.items.map((item) => item.event)
      clusters.push({
        key: group.pair.key,
        name: group.pair.name,
        color: group.pair.color,
        count: memberEvents.length,
        x: bucket.cx,
        y: bucket.cy,
        z: bucket.cz,
        events: memberEvents,
      })
    }
  }

  return clusters.sort((a, b) => b.count - a.count)
}

/** 透视投影：positions 已是像素空间；返回屏幕坐标与深度。 */
export function projectPoint(point, camera = DEFAULT_CAMERA, viewport = { width: 640, height: 540 }) {
  const { rotX = -12, rotY = 18, f = 520, zoom = 1 } = camera
  const radX = (rotX * Math.PI) / 180
  const radY = (rotY * Math.PI) / 180
  const cosY = Math.cos(radY)
  const sinY = Math.sin(radY)
  const cosX = Math.cos(radX)
  const sinX = Math.sin(radX)

  const x1 = point.x * cosY + point.z * sinY
  const z1 = -point.x * sinY + point.z * cosY
  const y1 = point.y
  const y2 = y1 * cosX - z1 * sinX
  const z2 = y1 * sinX + z1 * cosX

  const scale = (f / Math.max(1, f + z2)) * zoom
  const cx = point.cx ?? viewport.width / 2
  const cy = point.cy ?? viewport.height / 2
  return {
    sx: cx + x1 * scale,
    sy: cy + y2 * scale,
    depth: z2,
    scale,
    opacity: Math.max(0.35, Math.min(1, 0.75 + (0.25 * -z2) / 180)),
  }
}

/**
 * 一次布局：事件点 + 融合云，按远到近排序，调用方直接按序绘制即可。
 */
export function layoutEmotionMap(events = [], options = {}) {
  const {
    radius = 180,
    now = Date.now(),
    viewport = { width: 640, height: 540 },
    camera = DEFAULT_CAMERA,
    jitter = true,
    fusionRadius = 0.35,
    fusionWindowH = 168,
  } = options

  const points = events.map((event) => {
    const position = eventPosition(event, { jitter })
    return {
      event,
      x: position.x * radius,
      y: position.y * radius,
      z: position.z * radius,
      strength: position.strength,
      dominant: position.dominant,
      color: EMOTION_COLORS[position.dominant] || EMOTION_COLORS.calm,
    }
  }).map((point) => ({ ...point, ...projectPoint(point, camera, viewport) }))

  points.sort((a, b) => b.depth - a.depth)

  const fusions = clusterFusions(events, {
    now, radius: fusionRadius, windowH: fusionWindowH,
  }).map((cluster) => {
    const projected = projectPoint(
      { x: cluster.x * radius, y: cluster.y * radius, z: cluster.z * radius },
      camera, viewport,
    )
    return { ...cluster, ...projected }
  }).sort((a, b) => b.depth - a.depth)

  return { points, fusions, radius, camera, viewport }
}
