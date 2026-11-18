// 设置 → 桌宠记忆：记忆脑图 / 事实列表 / 人格 × 记忆 / 插件设置。
// 纯手写客户端 chunk，与官方客户端插件同格式；不需要构建。
// 只读事实，不提供删除/编辑记忆的入口（记忆由对话自然更新）。
window.__ModuleLoader__.load({
  id: 'dsh-pet-persona',
  factory(require) {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement

    const API = '/pet-persona/api'

    const C = {
      text: 'var(--dsw-alias-label-primary, #e8e8ee)',
      sub: 'var(--dsw-alias-label-secondary, #b8b8c4)',
      faint: 'var(--dsw-alias-label-tertiary, #8d8d9c)',
      border: 'var(--dsw-alias-border-primary, rgba(255,255,255,.12))',
      bg: 'var(--dsw-alias-bg-secondary, #191920)',
      input: 'var(--dsw-alias-bg-primary, #101016)',
      accent: 'var(--dsw-alias-brand-primary, #6aa9ff)',
      danger: 'var(--dsw-alias-state-error-primary, #ff6b6b)',
      ok: 'var(--dsw-alias-state-success-primary, #59d18b)',
      canvas: '#12141a',
    }

    const TYPE_META = {
      identity: { label: '称呼', color: '#6aa9ff' },
      preference: { label: '偏好', color: '#59d18b' },
      routine: { label: '习惯', color: '#e8c15a' },
      relation: { label: '关系', color: '#b98bff' },
      event: { label: '约定', color: '#ff9f6b' },
      boundary: { label: '禁忌', color: '#ff6b7a' },
    }
    const typeMeta = (type) => TYPE_META[type] || { label: '事实', color: '#9aa4b2' }

    // —— 「它自己」3D 情绪球 ——
    // 锚点/阈值与 lib/emotion-space.js 保持一致；客户端 chunk 不能 import 服务端模块，所以这里保留一份渲染副本。
    const EMO_ORDER = ['joy', 'affection', 'sadness', 'anger', 'anxiety', 'tiredness', 'surprise', 'calm']
    const EMO_LABEL = { joy: '开心', affection: '亲近', sadness: '难过', anger: '生气', anxiety: '担心', tiredness: '疲惫', surprise: '惊讶', calm: '平静' }
    const EMO_COLOR = { joy: '#59d18b', affection: '#f08ab0', sadness: '#6aa9ff', anger: '#ff6b7a', anxiety: '#b98bff', tiredness: '#e8c15a', surprise: '#ff9f6b', calm: '#9aa4b2' }
    const MAP_ANCHORS = {
      joy: { x: 0.1, y: 0.9, z: 0.35 },
      affection: { x: 0.85, y: 0.35, z: 0.25 },
      sadness: { x: -0.1, y: -0.85, z: -0.45 },
      anger: { x: -0.85, y: 0.45, z: 0.2 },
      anxiety: { x: -0.2, y: 0.15, z: -0.9 },
      tiredness: { x: 0.1, y: -0.8, z: 0.3 },
      surprise: { x: 0.2, y: 0.7, z: -0.55 },
      calm: { x: 0, y: 0, z: 0 },
    }
    const MAP_FUSIONS = {
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
    const MAP_FUSION_COLORS = {
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
    const MAP_CAMERA = { rotX: -8, rotY: 22, zoom: 1.05 }
    const MAP_RADIUS = 180

    const mapHash32 = (value) => {
      const text = String(value ?? '')
      let hash = 2166136261
      for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index)
        hash = Math.imul(hash, 16777619)
      }
      return hash >>> 0
    }

    const mapScores = (event) => {
      const scores = {}
      const list = Array.isArray(event?.emotions) ? event.emotions : []
      for (const item of list) {
        const key = item?.key
        const score = Number(item?.score)
        if (!key || !(key in MAP_ANCHORS) || !Number.isFinite(score)) continue
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

    const mapPosition = (event, jitter = true) => {
      const scores = mapScores(event)
      let vx = 0
      let vy = 0
      let vz = 0
      let max = 0
      let sum = 0
      for (const [key, score] of Object.entries(scores)) {
        if (key === 'calm' || score <= 0.08) continue
        const anchor = MAP_ANCHORS[key]
        vx += anchor.x * score
        vy += anchor.y * score
        vz += anchor.z * score
        sum += score
        if (score > max) max = score
      }
      const length = Math.hypot(vx, vy, vz)
      const dominant = Object.entries(scores)
        .filter(([key, score]) => key !== 'calm' && score > 0.08)
        .sort((a, b) => b[1] - a[1])[0]?.[0] || 'calm'
      if (length < 1e-4) return { x: 0, y: 0, z: 0, strength: 0, dominant }
      const hash = mapHash32(event?.id || `${event?.createdAt || ''}|${event?.text || ''}`)
      const pick = (shift) => (((hash >>> shift) & 0xff) / 255) * 2 - 1
      const strength = Math.min(1, max + 0.25 * Math.max(0, sum - max))
      const magnitude = strength * 0.9
      return {
        x: (vx / length) * magnitude + (jitter ? pick(0) * 0.03 : 0),
        y: (vy / length) * magnitude + (jitter ? pick(8) * 0.03 : 0),
        z: (vz / length) * magnitude + (jitter ? pick(16) * 0.03 : 0),
        strength,
        dominant,
      }
    }

    const mapFusionName = (a, b) => {
      const key = [a, b].sort().join('+')
      return MAP_FUSIONS[key] || `${EMO_LABEL[a] || a}里带点${EMO_LABEL[b] || b}`
    }

    const mapFusionPairs = (event) => {
      const items = Object.entries(mapScores(event))
        .filter(([, score]) => score >= 0.25)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 4)
      const pairs = []
      for (let i = 0; i < items.length; i += 1) {
        for (let j = i + 1; j < items.length; j += 1) {
          const [a, scoreA] = items[i]
          const [b, scoreB] = items[j]
          if (scoreB < scoreA * 0.5) continue
          const key = [a, b].sort().join('+')
          pairs.push({ key, a, b, name: mapFusionName(a, b), color: MAP_FUSION_COLORS[key] || EMO_COLOR[a] })
        }
      }
      return pairs
    }

    const mapClusterFusions = (events, now = Date.now()) => {
      const groups = new Map()
      const cutoff = now - 168 * 3600 * 1000
      for (const event of events) {
        const created = Date.parse(event?.createdAt || '')
        if (Number.isFinite(created) && created < cutoff) continue
        const position = mapPosition(event, false)
        for (const pair of mapFusionPairs(event)) {
          if (!groups.has(pair.key)) groups.set(pair.key, { pair, items: [] })
          groups.get(pair.key).items.push({ event, position })
        }
      }
      const fusions = []
      for (const { pair, items } of groups.values()) {
        const buckets = []
        for (const item of items) {
          let bucket = buckets.find((candidate) => Math.hypot(
            item.position.x - candidate.cx,
            item.position.y - candidate.cy,
            item.position.z - candidate.cz,
          ) < 0.35)
          if (!bucket) {
            bucket = { cx: item.position.x, cy: item.position.y, cz: item.position.z, items: [] }
            buckets.push(bucket)
          }
          bucket.items.push(item)
          bucket.cx += (item.position.x - bucket.cx) / bucket.items.length
          bucket.cy += (item.position.y - bucket.cy) / bucket.items.length
          bucket.cz += (item.position.z - bucket.cz) / bucket.items.length
        }
        for (const bucket of buckets) {
          if (bucket.items.length < 2) continue
          fusions.push({
            key: pair.key,
            name: pair.name,
            color: pair.color,
            count: bucket.items.length,
            events: bucket.items.map((item) => item.event),
            x: bucket.cx,
            y: bucket.cy,
            z: bucket.cz,
          })
        }
      }
      return fusions.sort((a, b) => b.count - a.count)
    }

    const mapProject = (x, y, z, camera) => {
      const radX = ((camera?.rotX ?? -12) * Math.PI) / 180
      const radY = ((camera?.rotY ?? 18) * Math.PI) / 180
      const cosY = Math.cos(radY)
      const sinY = Math.sin(radY)
      const cosX = Math.cos(radX)
      const sinX = Math.sin(radX)
      const x1 = x * cosY + z * sinY
      const z1 = -x * sinY + z * cosY
      const y1 = y
      const y2 = y1 * cosX - z1 * sinX
      const z2 = y1 * sinX + z1 * cosX
      const scale = (520 / Math.max(1, 520 + z2)) * (camera?.zoom ?? 1)
      return {
        sx: 320 + x1 * scale,
        sy: 270 - y2 * scale,
        depth: z2,
        scale,
        opacity: Math.max(0.35, Math.min(1, 0.75 + (0.25 * -z2) / MAP_RADIUS)),
      }
    }

    const mapLayout = (events, camera) => {
      const points = events.map((event, index) => {
        const position = mapPosition(event)
        const projected = mapProject(position.x * MAP_RADIUS, position.y * MAP_RADIUS, position.z * MAP_RADIUS, camera)
        return {
          event,
          index,
          ...projected,
          strength: position.strength,
          color: EMO_COLOR[position.dominant] || EMO_COLOR.calm,
          showLabel: index < 8,
        }
      }).sort((a, b) => b.depth - a.depth)
      const fusions = mapClusterFusions(events).map((fusion) => ({
        ...fusion,
        ...mapProject(fusion.x * MAP_RADIUS, fusion.y * MAP_RADIUS, fusion.z * MAP_RADIUS, camera),
      })).sort((a, b) => b.depth - a.depth)
      return { points, fusions }
    }

    // —— 脑区视图：情绪不是孤立的点，而是落在大脑解剖区域里的软色块 ——
    const BRAIN_REGIONS = {
      joy: { x: 0.42, y: 0.22, z: 0.52, area: '伏隔核' },
      affection: { x: 0.6, y: 0.02, z: 0.18, area: '岛叶' },
      sadness: { x: -0.24, y: -0.16, z: 0.42, area: '前扣带' },
      anger: { x: -0.55, y: -0.3, z: 0.04, area: '杏仁核' },
      anxiety: { x: 0.54, y: -0.14, z: -0.2, area: '杏仁核前部' },
      tiredness: { x: 0, y: -0.66, z: -0.3, area: '脑干' },
      surprise: { x: 0.4, y: 0.44, z: -0.44, area: '蓝斑' },
      calm: { x: 0, y: 0.28, z: 0.04, area: '内侧前额叶' },
    }

    const brainShares = (events) => {
      const sums = {}
      let total = 0
      let calmSum = 0
      for (const event of events) {
        const scores = mapScores(event)
        calmSum += Number(scores.calm || 0)
        for (const [key, score] of Object.entries(scores)) {
          // 平静是底色，不参与彩色占比；单独作为「平静度」展示。
          if (key === 'calm' || !(key in BRAIN_REGIONS) || score <= 0.08) continue
          sums[key] = (sums[key] || 0) + score
          total += score
        }
      }
      if (total <= 0) {
        return {
          shares: calmSum > 0
            ? [{ key: 'calm', label: EMO_LABEL.calm, color: EMO_COLOR.calm, area: BRAIN_REGIONS.calm.area, share: 1 }]
            : [],
          total: 0,
          calmRatio: calmSum > 0 ? 1 : 0,
        }
      }
      const shares = EMO_ORDER
        .filter((key) => key !== 'calm' && (sums[key] || 0) > 0)
        .map((key) => ({
          key,
          label: EMO_LABEL[key],
          color: EMO_COLOR[key],
          area: BRAIN_REGIONS[key].area,
          share: total > 0 ? sums[key] / total : 0,
        }))
        .sort((a, b) => b.share - a.share)
      return { shares, total, calmRatio: calmSum / (calmSum + total) }
    }

    const brainProject = (key, camera) => {
      const anchor = BRAIN_REGIONS[key]
      if (!anchor) return mapProject(0, 0, 0, camera)
      return mapProject(anchor.x * MAP_RADIUS, anchor.y * MAP_RADIUS, anchor.z * MAP_RADIUS, camera)
    }

    // —— 3D 脑模型：真网格 + 表面脑回 + 情绪色水（canvas 绘制） ——
    const BRAIN3D_RADIUS = 170
    const buildBrain3D = () => {
      const faces = []
      const R = BRAIN3D_RADIUS
      const pushBlob = ({ cx = 0, cy = 0, cz = 0, rx, ry, rz, latN, lonN, fixed = null }) => {
        const grid = []
        for (let i = 0; i <= latN; i += 1) {
          const v = i / latN
          const theta = v * Math.PI
          const row = []
          for (let j = 0; j <= lonN; j += 1) {
            const u = j / lonN
            const phi = u * Math.PI * 2
            const sx = Math.sin(theta) * Math.cos(phi)
            const sy = Math.cos(theta)
            const sz = Math.sin(theta) * Math.sin(phi)
            let rad = 1
            if (!fixed) {
              rad += 0.05 * Math.max(0, sz) - 0.025 * Math.max(0, -sz)
              rad += 0.06 * Math.exp(-(((sy + 0.1) / 0.3) ** 2 + ((Math.abs(sx) - 0.84) / 0.24) ** 2 + ((sz + 0.02) / 0.55) ** 2))
              rad += 0.042 * Math.sin(8 * phi + 1.6 * Math.sin(3 * theta))
              rad += 0.03 * Math.sin(5 * theta + 1.1 * Math.sin(4 * phi))
              rad += 0.018 * Math.sin(13 * phi + 2.2 * theta)
              rad -= 0.026 * Math.pow(Math.max(0, Math.sin(7 * phi + 2.1 * theta)), 6)
            }
            row.push([cx + sx * rx * rad, cy + sy * ry * rad, cz + sz * rz * rad, u, v])
          }
          grid.push(row)
        }
        for (let i = 0; i < latN; i += 1) {
          for (let j = 0; j < lonN; j += 1) {
            const a = grid[i][j]
            const b = grid[i + 1][j]
            const c = grid[i + 1][j + 1]
            const d = grid[i][j + 1]
            faces.push({ a, b, c, d, fixed, u: (a[3] + c[3]) / 2, v: (a[4] + c[4]) / 2 })
          }
        }
      }
      pushBlob({ rx: 1.04 * R, ry: 0.82 * R, rz: 1.14 * R, latN: 76, lonN: 132 })
      pushBlob({ cy: -0.6 * R, cz: -0.5 * R, rx: 0.4 * R, ry: 0.26 * R, rz: 0.3 * R, latN: 22, lonN: 34, fixed: 'tiredness' })
      pushBlob({ cy: -0.52 * R, cz: -0.08 * R, rx: 0.13 * R, ry: 0.42 * R, rz: 0.13 * R, latN: 16, lonN: 22, fixed: 'tiredness' })
      return faces.map((face) => {
        const ux = face.b[0] - face.a[0]
        const uy = face.b[1] - face.a[1]
        const uz = face.b[2] - face.a[2]
        const vx = face.d[0] - face.a[0]
        const vy = face.d[1] - face.a[1]
        const vz = face.d[2] - face.a[2]
        let nx = uy * vz - uz * vy
        let ny = uz * vx - ux * vz
        let nz = ux * vy - uy * vx
        const len = Math.hypot(nx, ny, nz) || 1
        nx /= len; ny /= len; nz /= len
        const mx = (face.a[0] + face.b[0] + face.c[0] + face.d[0]) / 4
        const my = (face.a[1] + face.b[1] + face.c[1] + face.d[1]) / 4
        const mz = (face.a[2] + face.b[2] + face.c[2] + face.d[2]) / 4
        if (nx * mx + ny * my + nz * mz < 0) { nx = -nx; ny = -ny; nz = -nz }
        const cl = Math.hypot(mx, my, mz) || 1
        return { ...face, nx, ny, nz, mx: mx / cl, my: my / cl, mz: mz / cl }
      })
    }
    const BRAIN3D_FACES = buildBrain3D()

    const brainKeyAt = (nx, ny, nz, shares) => {
      let best = shares[0]?.key || 'calm'
      let bestScore = Infinity
      for (const item of shares) {
        const anchor = BRAIN_REGIONS[item.key]
        if (!anchor) continue
        const len = Math.hypot(anchor.x, anchor.y, anchor.z) || 1
        const dot = Math.max(-1, Math.min(1, (nx * anchor.x + ny * anchor.y + nz * anchor.z) / len))
        const angle = Math.acos(dot)
        const wobble = 0.05 * Math.sin(4 * Math.atan2(nz, nx) + 2.4 * ny) + 0.04 * Math.sin(7 * ny - 3 * Math.atan2(nz, nx))
        const score = (angle + wobble) ** 2 - 10 * Math.max(item.share, 0.05)
        if (score < bestScore) { bestScore = score; best = item.key }
      }
      return best
    }

    const hexRgb = (hex) => {
      const value = String(hex || '#9fb6c9').replace('#', '')
      return [parseInt(value.slice(0, 2), 16), parseInt(value.slice(2, 4), 16), parseInt(value.slice(4, 6), 16)]
    }

    const drawBrain3D = (canvas, { shares, camera, selected, calmRatio = 0 }) => {
      const ctx = canvas.getContext('2d')
      if (!ctx) return { faces: [] }
      const W = canvas.width
      const H = canvas.height
      ctx.clearRect(0, 0, W, H)
      const ry = (camera.rotY * Math.PI) / 180
      const rx = (camera.rotX * Math.PI) / 180
      const cosY = Math.cos(ry)
      const sinY = Math.sin(ry)
      const cosX = Math.cos(rx)
      const sinX = Math.sin(rx)
      const zoom = Number(camera.zoom) || 1
      const project = (x, y, z) => {
        const x1 = x * cosY - z * sinY
        const z1 = x * sinY + z * cosY
        const y1 = y * cosX - z1 * sinX
        const z2 = y * sinX + z1 * cosX
        const scale = (520 / (520 + z2)) * zoom
        return [W / 2 + x1 * scale, H / 2 - y1 * scale, z2]
      }
      const rgbOf = {}
      for (const item of shares) rgbOf[item.key] = hexRgb(item.color)
      const fallback = hexRgb(EMO_COLOR.calm)
      const L = [-0.36, 0.72, 0.6]
      const ll = Math.hypot(L[0], L[1], L[2])
      const drawn = []
      for (const face of BRAIN3D_FACES) {
        const pa = project(face.a[0], face.a[1], face.a[2])
        const pb = project(face.b[0], face.b[1], face.b[2])
        const pc = project(face.c[0], face.c[1], face.c[2])
        const pd = project(face.d[0], face.d[1], face.d[2])
        const n1x = face.nx * cosY - face.nz * sinY
        const n1z = face.nx * sinY + face.nz * cosY
        const n1y = face.ny * cosX - n1z * sinX
        const n2z = face.ny * sinX + n1z * cosX
        const culled = n2z < 0
        const diff = Math.max(0, (n1x * L[0] + n1y * L[1] + n2z * L[2]) / ll)
        const rim = (1 - Math.abs(n2z)) ** 2
        const groove = face.fixed ? 1 : 0.88 + 0.12 * (0.5 + 0.5 * Math.sin(11 * face.u * Math.PI * 2 + 2.2 * Math.sin(4 * face.v * Math.PI) + 0.8))
        const key = face.fixed && !rgbOf[face.fixed] ? (shares[0]?.key || 'calm') : (face.fixed || brainKeyAt(face.mx, face.my, face.mz, shares))
        const isSelected = Boolean(selected) && key === selected
        const shade = (0.44 + 0.56 * diff) * groove * (isSelected ? 1.16 : 1)
        const spec = diff ** 18 * 0.18
        const base = rgbOf[key] || fallback
        const r = Math.min(255, base[0] * shade + rim * 110 + spec * 255) | 0
        const g = Math.min(255, base[1] * shade + rim * 110 + spec * 255) | 0
        const b = Math.min(255, base[2] * shade + rim * 118 + spec * 255) | 0
        drawn.push({
          key,
          fill: `rgb(${r},${g},${b})`,
          depth: (pa[2] + pb[2] + pc[2] + pd[2]) / 4,
          points: [[pa[0], pa[1]], [pb[0], pb[1]], [pc[0], pc[1]], [pd[0], pd[1]]],
          selected: isSelected,
          culled,
        })
      }
      // 不再剔除背面：按深度全画，背面先画、正面后盖，深沟不会露底。
      const visible = drawn
      visible.sort((a, b) => a.depth - b.depth)
      for (const item of visible) {
        ctx.beginPath()
        ctx.moveTo(item.points[0][0], item.points[0][1])
        for (let i = 1; i < 4; i += 1) ctx.lineTo(item.points[i][0], item.points[i][1])
        ctx.closePath()
        ctx.fillStyle = item.fill
        ctx.fill()
        ctx.strokeStyle = item.selected ? 'rgba(255,255,255,.55)' : item.fill
        ctx.lineWidth = item.selected ? 1 : 0.9
        ctx.stroke()
      }
      if (calmRatio > 0) {
        ctx.save()
        ctx.globalCompositeOperation = 'source-atop'
        ctx.fillStyle = `rgba(150,164,184,${Math.min(0.42, 0.12 + 0.34 * calmRatio).toFixed(3)})`
        ctx.fillRect(0, 0, W, H)
        ctx.restore()
      }
      for (const item of shares) {
        if (item.share >= 0.05) continue
        const site = brainProject(item.key, camera)
        if (!site) continue
        ctx.beginPath()
        ctx.arc(site.sx, site.sy, 3.4, 0, Math.PI * 2)
        ctx.fillStyle = item.color
        ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,.75)'
        ctx.lineWidth = 1
        ctx.stroke()
        ctx.font = '600 10px system-ui, "Microsoft YaHei"'
        ctx.textAlign = 'center'
        ctx.fillStyle = item.color
        ctx.fillText(`${item.label} ${Math.round(item.share * 100)}%`, site.sx, site.sy - 7)
      }
      if (selected) {
        const info = shares.find((item) => item.key === selected)
        const site = brainProject(selected, camera)
        if (info && site) {
          const label = `${info.label} ${Math.round(info.share * 100)}%`
          ctx.font = '700 13px system-ui, "Microsoft YaHei"'
          ctx.textAlign = 'center'
          ctx.lineWidth = 3
          ctx.strokeStyle = 'rgba(8,14,24,.8)'
          ctx.strokeText(label, site.sx, site.sy - 4)
          ctx.fillStyle = C.text
          ctx.fillText(label, site.sx, site.sy - 4)
        }
      }
      return { faces: visible }
    }

    const pointInPoly = (x, y, points) => {
      let inside = false
      for (let i = 0, j = points.length - 1; i < points.length; j = i, i += 1) {
        const xi = points[i][0]
        const yi = points[i][1]
        const xj = points[j][0]
        const yj = points[j][1]
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi || 1e-9) + xi) inside = !inside
      }
      return inside
    }

    // —— 脑壳（风格化侧视轮廓）与「情绪像水填满脑壳」的加权 Voronoi 色块 ——
    const BRAIN_PATH = 'M 150 300 C 140 255 150 215 175 190 C 175 150 210 120 255 115 C 285 85 340 80 380 100 C 425 90 470 110 485 150 C 515 175 520 215 505 245 C 520 275 505 305 480 315 C 470 345 440 365 405 368 L 380 368 C 365 395 335 405 310 392 C 295 382 280 380 265 388 C 240 405 205 398 190 375 C 165 378 140 355 132 330 C 118 322 112 310 120 302 Z'
    const BRAIN_STEM = 'M 372 360 C 372 395 362 420 348 438 C 340 448 352 456 362 448 C 378 432 390 400 390 366 Z'
    const BRAIN_CEREBELLUM = { cx: 455, cy: 352, rx: 52, ry: 30 }
    const polyPath = (poly) => {
      if (!poly || poly.length < 3) return 'M 0 0'
      return poly.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p[0].toFixed(1)} ${p[1].toFixed(1)}`).join(' ') + ' Z'
    }
    const clipHalfPlane = (poly, ax, ay, b) => {
      if (!poly.length) return poly
      const out = []
      for (let i = 0; i < poly.length; i += 1) {
        const p = poly[i]
        const q = poly[(i + 1) % poly.length]
        const dp = ax * p[0] + ay * p[1] - b
        const dq = ax * q[0] + ay * q[1] - b
        if (dp <= 0) out.push(p)
        if ((dp < 0 && dq > 0) || (dp > 0 && dq < 0)) {
          const t = dp / (dp - dq)
          out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t])
        }
      }
      return out
    }
    const voronoiCells = (sites) => sites.map((site, index) => {
      let poly = [[-260, -220], [900, -220], [900, 780], [-260, 780]]
      sites.forEach((other, otherIndex) => {
        if (index === otherIndex) return
        const ax = 2 * (other.sx - site.sx)
        const ay = 2 * (other.sy - site.sy)
        if (ax === 0 && ay === 0) return
        const b = other.sx * other.sx + other.sy * other.sy - site.sx * site.sx - site.sy * site.sy + site.weight - other.weight
        poly = clipHalfPlane(poly, ax, ay, b)
      })
      return { ...site, d: polyPath(poly) }
    })


    const S = {
      page: { maxWidth: '980px', color: C.text, paddingBottom: '32px' },
      header: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' },
      title: { fontSize: '16px', fontWeight: 800, letterSpacing: '.2px', lineHeight: 1.35 },
      lead: { fontSize: '12px', color: C.sub, lineHeight: 1.8, margin: '6px 0 14px', maxWidth: '760px' },
      chips: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '8px' },
      chip: { fontSize: '11px', color: C.sub, border: `1px solid ${C.border}`, borderRadius: '999px', padding: '2px 9px', lineHeight: '18px', background: 'transparent' },
      chipHot: { fontSize: '11px', color: C.ok, border: `1px solid ${C.ok}55`, borderRadius: '999px', padding: '2px 9px', lineHeight: '18px' },
      card: { border: `1px solid ${C.border}`, borderRadius: '12px', padding: '14px', background: C.bg, marginBottom: '12px' },
      tabs: { display: 'flex', gap: '6px', borderBottom: `1px solid ${C.border}`, marginBottom: '14px', flexWrap: 'wrap' },
      tab: (on) => ({
        border: 'none',
        borderBottom: `2px solid ${on ? C.accent : 'transparent'}`,
        background: 'transparent',
        color: on ? C.text : C.faint,
        padding: '8px 10px',
        fontSize: '12px',
        fontWeight: on ? 700 : 500,
        cursor: 'pointer',
      }),
      btn: { border: `1px solid ${C.border}`, background: 'transparent', color: C.text, borderRadius: '8px', padding: '6px 11px', fontSize: '12px', cursor: 'pointer' },
      primary: { border: `1px solid ${C.accent}`, background: C.accent, color: '#08111f', borderRadius: '8px', padding: '7px 14px', fontSize: '12px', fontWeight: 700, cursor: 'pointer' },
      input: { background: C.input, color: C.text, border: `1px solid ${C.border}`, borderRadius: '7px', padding: '7px 9px', fontSize: '12px', outline: 'none' },
      row: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' },
      hint: { fontSize: '11px', color: C.faint, lineHeight: 1.7 },
      error: { fontSize: '12px', color: C.danger, whiteSpace: 'pre-wrap', lineHeight: 1.7, marginTop: '10px' },
      note: { fontSize: '12px', color: C.ok, minHeight: '18px', lineHeight: 1.7 },
      graphWrap: { position: 'relative', border: `1px solid ${C.border}`, borderRadius: '12px', overflow: 'hidden', background: C.canvas, marginBottom: '10px' },
      graphSvg: { display: 'block', width: '100%', height: '540px', touchAction: 'none', cursor: 'grab' },
      detail: {
        position: 'absolute', left: '12px', right: '12px', bottom: '12px', border: `1px solid ${C.border}`,
        borderRadius: '10px', background: 'rgba(19,21,27,.96)', padding: '12px 14px', color: '#ececf2',
        boxShadow: '0 10px 30px rgba(0,0,0,.35)', maxHeight: '46%', overflow: 'auto',
      },
      badge: (color) => ({
        display: 'inline-block', fontSize: '10.5px', lineHeight: '16px', padding: '1px 7px',
        borderRadius: '999px', color: '#0b1018', background: color, fontWeight: 700,
      }),
      detailValue: { fontSize: '15px', fontWeight: 700, margin: '8px 0 8px', lineHeight: 1.5, wordBreak: 'break-word' },
      kv: { display: 'grid', gridTemplateColumns: '58px 1fr', gap: '3px 10px', fontSize: '11.5px', lineHeight: 1.65 },
      kvKey: { color: '#8d93a1' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11px', lineHeight: 1.65, whiteSpace: 'pre-wrap', wordBreak: 'break-word' },
      table: { width: '100%', borderCollapse: 'collapse', fontSize: '12px' },
      th: { textAlign: 'left', color: C.faint, fontWeight: 600, fontSize: '11px', padding: '6px 8px', borderBottom: `1px solid ${C.border}`, whiteSpace: 'nowrap' },
      td: { padding: '7px 8px', borderBottom: `1px solid ${C.border}88`, verticalAlign: 'top', lineHeight: 1.55 },
      pre: { margin: 0, padding: '12px', borderRadius: '9px', background: C.input, border: `1px solid ${C.border}`, color: C.text, fontFamily: 'ui-monospace, SFMono-Regular, Consolas, monospace', fontSize: '11.5px', lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: '240px', overflow: 'auto' },
      split: { display: 'grid', gridTemplateColumns: 'minmax(0,1.05fr) minmax(0,1fr)', gap: '12px' },
      field: { marginBottom: '12px' },
      label: { display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '4px' },
      statGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0,1fr))', gap: '8px', marginBottom: '12px' },
      stat: { border: `1px solid ${C.border}`, borderRadius: '10px', padding: '9px 11px', background: C.bg },
      statNum: { fontSize: '18px', fontWeight: 800, lineHeight: 1.2 },
      statLabel: { fontSize: '10.5px', color: C.faint, marginTop: '2px' },
    }

    async function api(path, options = {}) {
      const res = await fetch(`${API}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options.headers || {}) },
      })
      const text = await res.text()
      let body = null
      try {
        body = text ? JSON.parse(text) : {}
      } catch {
        throw new Error(text.slice(0, 200) || `HTTP ${res.status}`)
      }
      if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`)
      return body
    }

    const fmtTime = (iso) => {
      if (!iso) return '—'
      const ts = Date.parse(iso)
      if (!Number.isFinite(ts)) return String(iso)
      return new Date(ts).toLocaleString('zh-CN', { hour12: false })
    }

    const splitKey = (key) => {
      const text = String(key ?? '')
      const dot = text.indexOf('.')
      if (dot < 0) return ['主人', text || '近况']
      return [text.slice(0, dot) || '主人', text.slice(dot + 1) || '近况']
    }

    /** 径向树：记忆 → 人 → 方面 → 事实。角度按叶子数量分扇区，避免重叠。 */
    function buildLayout(facts) {
      const people = new Map()
      for (const fact of facts) {
        const [person, aspect] = splitKey(fact.key)
        if (!people.has(person)) people.set(person, new Map())
        const aspects = people.get(person)
        if (!aspects.has(aspect)) aspects.set(aspect, [])
        aspects.get(aspect).push(fact)
      }
      const entries = [...people.entries()]
        .map(([person, aspects]) => ({
          person,
          count: [...aspects.values()].reduce((sum, list) => sum + list.length, 0),
          aspects: [...aspects.entries()].sort((a, b) => b[1].length - a[1].length),
        }))
        .sort((a, b) => b.count - a.count || a.person.localeCompare(b.person, 'zh'))

      const nodes = [{ id: 'root', kind: 'root', label: '记忆', x: 0, y: 0, count: facts.length }]
      const links = []
      const total = Math.max(1, facts.length)
      let cursor = -Math.PI / 2

      for (const entry of entries) {
        const pSpan = 2 * Math.PI * (entry.count / total)
        const pAngle = cursor + pSpan / 2
        const personNode = {
          id: `p:${entry.person}`, kind: 'person', label: entry.person, count: entry.count,
          x: Math.cos(pAngle) * 132, y: Math.sin(pAngle) * 132, angle: pAngle,
        }
        nodes.push(personNode)
        links.push({ from: 'root', to: personNode.id })

        const innerStart = cursor + pSpan * 0.07
        const innerSpan = pSpan * 0.86
        let aCursor = innerStart
        for (const [aspect, list] of entry.aspects) {
          const aSpan = innerSpan * (list.length / entry.count)
          const aAngle = aCursor + aSpan / 2
          const aspectNode = {
            id: `a:${entry.person}.${aspect}`, kind: 'aspect', label: aspect, count: list.length,
            x: Math.cos(aAngle) * 238, y: Math.sin(aAngle) * 238, angle: aAngle,
          }
          nodes.push(aspectNode)
          links.push({ from: personNode.id, to: aspectNode.id })

          const spread = Math.min(aSpan * 0.92, 0.62)
          list.forEach((fact, index) => {
            const leafAngle = list.length === 1
              ? aAngle
              : aAngle - spread / 2 + (spread * index) / (list.length - 1)
            const leaf = {
              id: `f:${fact.id}`, kind: 'leaf', label: fact.value, fact,
              x: Math.cos(leafAngle) * 332, y: Math.sin(leafAngle) * 332, angle: leafAngle,
            }
            nodes.push(leaf)
            links.push({ from: aspectNode.id, to: leaf.id })
          })
          aCursor += aSpan
        }
        cursor += pSpan
      }
      return { nodes, links }
    }

    const nodeById = (layout) => {
      const map = new Map()
      for (const node of layout.nodes) map.set(node.id, node)
      return map
    }

    function MemoryGraph({ facts, query, showArchived, selected, onSelect, petName }) {
      const visible = useMemo(
        () => facts.filter((fact) => showArchived || fact.status !== 'archived'),
        [facts, showArchived],
      )
      const layout = useMemo(() => buildLayout(visible), [visible])
      const byId = useMemo(() => nodeById(layout), [layout])
      const [view, setView] = useState({ x: 0, y: 0, k: 1 })
      const [hover, setHover] = useState('')
      const svgRef = useRef(null)
      const dragRef = useRef(null)
      const movedRef = useRef(false)

      const matches = useMemo(() => {
        const q = query.trim().toLowerCase()
        if (q === '') return null
        const hit = new Set()
        for (const fact of visible) {
          const hay = `${fact.key} ${fact.value} ${fact.quote || ''}`.toLowerCase()
          if (hay.includes(q)) hit.add(`f:${fact.id}`)
        }
        for (const node of layout.nodes) {
          if (node.kind !== 'leaf' || !hit.has(node.id)) continue
          hit.add(node.id)
          const [person, aspect] = splitKey(node.fact.key)
          hit.add(`p:${person}`)
          hit.add(`a:${person}.${aspect}`)
        }
        hit.add('root')
        return hit
      }, [layout.nodes, visible, query])

      const dim = (id) => matches != null && !matches.has(id)

      const onPointerDown = (event) => {
        if (event.button !== 0) return
        const rect = svgRef.current?.getBoundingClientRect()
        if (!rect) return
        movedRef.current = false
        dragRef.current = {
          sx: event.clientX,
          sy: event.clientY,
          pan: { ...view },
          scale: 960 / rect.width,
        }
        event.currentTarget.setPointerCapture?.(event.pointerId)
      }
      const onPointerMove = (event) => {
        const drag = dragRef.current
        if (!drag) return
        const dx = (event.clientX - drag.sx) * drag.scale
        const dy = (event.clientY - drag.sy) * drag.scale
        if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true
        setView({ x: drag.pan.x + dx, y: drag.pan.y + dy, k: drag.pan.k })
      }
      const onPointerUp = () => {
        dragRef.current = null
      }
      const zoomBy = (factor) => setView((prev) => ({ ...prev, k: Math.min(2.6, Math.max(0.45, prev.k * factor)) }))

      const labelAnchor = (x) => (x >= 6 ? 'start' : x <= -6 ? 'end' : 'middle')
      const labelDx = (x) => (x >= 6 ? 9 : x <= -6 ? -9 : 0)

      const renderNode = (node) => {
        const isRoot = node.kind === 'root'
        const isPerson = node.kind === 'person'
        const isAspect = node.kind === 'aspect'
        const isLeaf = node.kind === 'leaf'
        const color = isLeaf ? typeMeta(node.fact.type).color : isRoot ? '#dfe7ff' : isPerson ? '#9fc0ff' : '#7c8aa5'
        const r = isRoot ? 25 : isPerson ? 15 : isAspect ? 8.5 : 4.6
        const hot = hover === node.id || (isLeaf && selected && selected.id === node.fact.id)
        const opacity = dim(node.id) ? 0.14 : 1
        const text = isLeaf
          ? String(node.label || '').slice(0, 14) + (String(node.label || '').length > 14 ? '…' : '')
          : node.label
        return h('g', {
          key: node.id,
          style: { cursor: isLeaf ? 'pointer' : 'default', opacity, transition: 'opacity .18s' },
          onMouseEnter: () => setHover(node.id),
          onMouseLeave: () => setHover((current) => (current === node.id ? '' : current)),
          onClick: () => {
            if (isLeaf && !movedRef.current) onSelect(node.fact)
          },
          role: isLeaf ? 'button' : undefined,
        },
          isLeaf
            ? h('circle', { cx: node.x, cy: node.y, r: 11, fill: 'transparent' })
            : null,
          h('circle', {
            cx: node.x, cy: node.y, r: hot ? r * 1.28 : r,
            fill: isLeaf ? color : 'rgba(18,20,26,.9)',
            stroke: color,
            strokeWidth: isLeaf ? 1 : 3,
            style: { transition: 'r .15s' },
          }),
          isLeaf ? null : h('text', {
            x: node.x, y: node.y + 4, textAnchor: 'middle', fontSize: isRoot ? 12 : isPerson ? 11.5 : 10.5,
            fill: isRoot ? '#e8edff' : '#c6cfdf', fontWeight: isRoot ? 800 : isPerson ? 700 : 600,
            style: { pointerEvents: 'none', paintOrder: 'stroke', stroke: C.canvas, strokeWidth: 3, strokeLinejoin: 'round' },
          }, text),
          isLeaf ? h('text', {
            x: node.x + labelDx(node.x), y: node.y + 3.5, textAnchor: labelAnchor(node.x),
            fontSize: 10.5, fill: '#aeb8c8', style: { pointerEvents: 'none', paintOrder: 'stroke', stroke: C.canvas, strokeWidth: 3, strokeLinejoin: 'round' },
          }, text) : null,
          h('title', null, isLeaf
            ? `${node.fact.key} = ${node.fact.value}`
            : `${node.label} · ${node.count} 条`),
        )
      }

      return h('div', { style: S.graphWrap },
        h('div', { style: { position: 'absolute', zIndex: 2, top: '10px', left: '12px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', maxWidth: '60%' } },
          h('span', { style: { ...S.hint, color: '#8f97a8', background: 'rgba(20,22,28,.72)', padding: '2px 8px', borderRadius: '999px' } },
            `${visible.length} 条${query.trim() ? ` · 匹配「${query.trim()}」` : ''}`),
        ),
        h('div', { style: { position: 'absolute', zIndex: 2, top: '10px', right: '12px', display: 'flex', gap: '6px' } },
          h('button', { type: 'button', style: { ...S.btn, background: 'rgba(20,22,28,.8)', color: '#dfe3ec' }, onClick: () => zoomBy(1 / 1.2), title: '缩小' }, '−'),
          h('button', { type: 'button', style: { ...S.btn, background: 'rgba(20,22,28,.8)', color: '#dfe3ec' }, onClick: () => zoomBy(1.2), title: '放大' }, '+'),
          h('button', { type: 'button', style: { ...S.btn, background: 'rgba(20,22,28,.8)', color: '#dfe3ec' }, onClick: () => setView({ x: 0, y: 0, k: 1 }), title: '复位' }, '复位'),
        ),
        visible.length === 0
          ? h('div', { style: { position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', padding: '30px' } },
            h('div', null,
              h('div', { style: { fontSize: '34px', marginBottom: '8px' } }, '🫧'),
              h('div', { style: { fontSize: '13px', fontWeight: 700, color: '#dbe2f2' } }, `${petName || '桌宠'}还没有长期记忆`),
              h('div', { style: { ...S.hint, color: '#7f8798', marginTop: '6px', maxWidth: '340px' } },
                '对它说一句「记住，我叫阿岚」，或者「以后叫我主人」。下一轮对话后，这里会长出第一簇记忆。'),
            ))
          : null,
        h('svg', {
          ref: svgRef,
          viewBox: '-480 -360 960 720',
          style: S.graphSvg,
          onPointerDown,
          onPointerMove,
          onPointerUp,
          onPointerCancel: onPointerUp,
          onPointerLeave: onPointerUp,
          role: 'img',
          'aria-label': '宠物长期记忆脑图',
        },
          h('g', { transform: `translate(${view.x} ${view.y}) scale(${view.k})` },
            layout.links.map((link) => {
              const from = byId.get(link.from)
              const to = byId.get(link.to)
              if (!from || !to) return null
              const opacity = dim(to.id) ? 0.08 : to.kind === 'leaf' ? 0.25 : 0.42
              return h('line', {
                key: `${link.from}->${link.to}`,
                x1: from.x, y1: from.y, x2: to.x, y2: to.y,
                stroke: to.kind === 'leaf' ? typeMeta(to.fact.type).color : '#56627a',
                strokeWidth: to.kind === 'leaf' ? 0.9 : 1.4,
                strokeOpacity: opacity,
              })
            }),
            layout.nodes.map(renderNode),
          ),
        ),
        selected ? h(FactDetail, { fact: selected, onClose: () => onSelect(null) }) : null,
      )
    }

    function FactDetail({ fact, onClose }) {
      const meta = typeMeta(fact.type)
      const row = (label, value) => [
        h('div', { key: `${label}k`, style: S.kvKey }, label),
        h('div', { key: `${label}v` }, value),
      ]
      return h('div', { style: S.detail },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px' } },
          h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' } },
            h('span', { style: S.badge(meta.color) }, meta.label),
            h('span', { style: { ...S.hint, color: '#8d93a1' } }, fact.status === 'archived' ? '已归档（被新事实取代）' : '活跃'),
            fact.pinned ? h('span', { style: { ...S.hint, color: '#e8c15a' } }, '★ 置顶') : null,
          ),
          h('button', { type: 'button', style: { ...S.btn, padding: '2px 8px', color: '#c9ced8' }, onClick: onClose }, '收起'),
        ),
        h('div', { style: S.detailValue }, fact.value),
        h('div', { style: S.kv },
          row('键', h('span', { style: S.mono }, fact.key)),
          row('原话', fact.quote ? h('span', { style: S.mono }, fact.quote) : '—'),
          row('重要度', '★'.repeat(Math.max(1, Math.min(5, Number(fact.importance) || 3)))),
          row('命中', `${fact.hits || 0} 次`),
          row('记于', fmtTime(fact.createdAt)),
          fact.validTo ? row('归档', fmtTime(fact.validTo)) : null,
        ),
      )
    }

    function Legend() {
      return h('div', { style: { ...S.row, gap: '12px', marginBottom: '12px' } },
        Object.entries(TYPE_META).map(([type, meta]) => h('span', { key: type, style: { ...S.hint, display: 'inline-flex', alignItems: 'center', gap: '5px' } },
          h('i', { style: { width: '7px', height: '7px', borderRadius: '99px', background: meta.color, display: 'inline-block' } }),
          meta.label,
        )),
      )
    }

    function FactList({ facts, query, showArchived, selected, onSelect }) {
      const rows = useMemo(() => {
        const q = query.trim().toLowerCase()
        return facts
          .filter((fact) => showArchived || fact.status !== 'archived')
          .filter((fact) => q === '' || `${fact.key} ${fact.value} ${fact.quote || ''}`.toLowerCase().includes(q))
      }, [facts, query, showArchived])

      if (rows.length === 0) {
        return h('div', { style: { ...S.card, textAlign: 'center', color: C.faint, fontSize: '12px', padding: '30px' } },
          query.trim() ? `没有匹配「${query.trim()}」的事实` : '还没有记忆。对桌宠说「记住，我叫…」试试。')
      }
      return h('div', { style: { ...S.card, padding: '6px 4px', overflowX: 'auto' } },
        h('table', { style: S.table },
          h('thead', null, h('tr', null,
            h('th', { style: S.th }, '类型'),
            h('th', { style: S.th }, '键'),
            h('th', { style: S.th }, '内容'),
            h('th', { style: S.th }, '重要度'),
            h('th', { style: S.th }, '命中'),
            h('th', { style: S.th }, '时间'),
          )),
          h('tbody', null, rows.map((fact) => {
            const meta = typeMeta(fact.type)
            return h('tr', {
              key: fact.id,
              style: { cursor: 'pointer', opacity: fact.status === 'archived' ? 0.55 : 1, background: selected && selected.id === fact.id ? 'rgba(106,169,255,.1)' : 'transparent' },
              onClick: () => onSelect(fact),
            },
              h('td', { style: S.td }, h('span', { style: S.badge(meta.color) }, meta.label)),
              h('td', { style: { ...S.td, whiteSpace: 'nowrap', color: C.sub } }, h('span', { style: S.mono }, fact.key)),
              h('td', { style: S.td },
                h('span', { style: { fontWeight: 600 } }, fact.pinned ? '★ ' : '', fact.value),
                fact.quote ? h('div', { style: { ...S.hint, marginTop: '2px' } }, `“${fact.quote}”`) : null,
                fact.status === 'archived' ? h('div', { style: { ...S.hint, color: '#ff9f6b' } }, `已归档 ${fmtTime(fact.validTo)}`) : null,
              ),
              h('td', { style: { ...S.td, whiteSpace: 'nowrap', color: '#e8c15a' } }, '★'.repeat(Math.max(1, Math.min(5, Number(fact.importance) || 3)))),
              h('td', { style: S.td }, String(fact.hits || 0)),
              h('td', { style: { ...S.td, whiteSpace: 'nowrap', color: C.faint } }, fmtTime(fact.createdAt)),
            )
          })),
        ),
      )
    }

    function PersonaTab({ persona, guard, activity }) {
      const [query, setQuery] = useState('我是谁？')
      const [preview, setPreview] = useState(null)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const runPreview = async () => {
        setBusy(true)
        setError('')
        try {
          const result = await api('/preview', { method: 'POST', body: JSON.stringify({ query }) })
          setPreview(result)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }

      const sourceText = {
        pet: '宠物实例设置（用户层）',
        user: '用户层配置',
        default: 'dsh-pet 默认人设',
        none: '未找到',
      }[persona?.source] || '未知'

      return h('div', null,
        h('div', { style: S.split },
          h('div', { style: S.card },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', alignItems: 'center', marginBottom: '8px' } },
              h('div', { style: { fontSize: '13px', fontWeight: 700 } }, `${persona?.petName || '桌宠'}的人格（只读）`),
              h('span', { style: S.chip }, sourceText),
            ),
            persona?.available
              ? h('pre', { style: S.pre }, persona.text)
              : h('div', { style: { ...S.hint, padding: '12px' } }, '没有读到 whisperPrompt。人格由 dsh-pet 的配置管理，本插件只读。'),
            h('div', { style: { ...S.hint, marginTop: '8px' } },
              '人格 100% 由 dsh-pet 管理，本插件不写、不改。'),
            persona?.defaultsFile
              ? h('div', { style: { ...S.hint, marginTop: '4px' } }, `默认配置：${persona.defaultsFile}`)
              : null,
            persona?.userFile
              ? h('div', { style: { ...S.hint, marginTop: '2px' } }, `用户配置：${persona.userFile}`)
              : null,
          ),
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '4px' } }, '记忆怎么拼进去'),
            h('div', { ...{ style: S.hint } },
              'recall 返回的内容会追加在人格提示词之后，中间隔一个空行：',
            ),
            h('pre', { style: { ...S.pre, marginTop: '8px', maxHeight: '150px' } },
              '<人格 whisperPrompt>\n\n【长期记忆】\n以下是你在以往对话里记下的关于主人的事实……'),
            h('div', { style: { ...S.hint, marginTop: '8px' } },
              '块里只写事实、不写人格指令；与人格冲突时一律以上面的人格为准。'),
          ),
        ),

        h('div', { ...{ style: { ...S.card, marginTop: '12px' } } },
          h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '8px' } }, '预览：这一问会注入什么'),
          h('div', { style: S.row },
            h('input', {
              value: query,
              onChange: (event) => setQuery(event.target.value),
              placeholder: '例如：我是谁？今天喝什么？',
              style: { ...S.input, flex: '1 1 240px' },
              onKeyDown: (event) => {
                if (event.key === 'Enter') void runPreview()
              },
            }),
            h('button', { type: 'button', style: S.primary, disabled: busy, onClick: runPreview }, busy ? '计算中…' : '模拟 recall'),
          ),
          error ? h('div', { style: S.error }, error) : null,
          preview ? h('div', { style: { marginTop: '10px' } },
            h('div', { ...{ style: { ...S.row, marginBottom: '6px' } } },
              h('span', { style: S.chip }, `命中 ${preview.hits.length} 条`),
              h('span', { style: S.chip }, `${preview.block.length} 字`),
              h('span', { style: S.chip }, `预算 ${preview.budgetChars}`),
              h('span', { style: S.chip }, `${preview.elapsedMs} ms`),
            ),
            preview.block
              ? h('pre', { style: S.pre }, preview.block)
              : h('div', { style: { ...S.hint, padding: '10px', border: `1px dashed ${C.border}`, borderRadius: '8px' } },
                '没有命中记忆，这一轮 system 保持逐字不变。'),
            preview.block
              ? h('details', { style: { marginTop: '8px' } },
                h('summary', { style: { ...S.hint, cursor: 'pointer' } }, '展开最终 system（人格 + 记忆块）'),
                h('pre', { style: { ...S.pre, marginTop: '6px' } }, preview.system),
              )
              : null,
          ) : null,
        ),

        h('div', { style: { ...S.card, marginTop: '12px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' } },
            h('div', { style: { fontSize: '13px', fontWeight: 700 } }, '人格防注入记录'),
            h('span', { style: S.chip }, guard.length > 0 ? `最近 ${guard.length} 条` : '暂无拦截'),
          ),
          h('div', { ...{ style: { ...S.hint, marginTop: '6px' } } },
            '有人试图让它「变成猫 / 以后听我的」时，这类句子会被拦下，不进入长期记忆，人格不变。'),
          guard.length > 0
            ? h('div', { style: { ...S.mono, marginTop: '8px', color: '#b8b8c4' } }, guard.join('\n'))
            : null,
        ),

        activity.length > 0
          ? h('div', { style: { ...S.card, marginTop: '12px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '6px' } }, '最近活动'),
            h('div', { style: { ...S.mono, color: C.sub } }, activity.slice(0, 8).join('\n')),
          )
          : null,
      )
    }

    function SettingsTab({ overview, onSaved }) {
      const [form, setForm] = useState(null)
      const [busy, setBusy] = useState(false)
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [catalog, setCatalog] = useState(null)

      const loadModels = async (refresh = false) => {
        try {
          const data = await api(refresh ? '/models?refresh=1' : '/models')
          setCatalog(data || {})
        } catch (err) {
          setCatalog({ error: String(err.message || err) })
        }
      }

      useEffect(() => {
        if (!overview?.config) return
        setForm({
          budgetChars: overview.config.budgetChars,
          autoLearn: overview.config.autoLearn,
          learnEveryTurns: overview.config.learnEveryTurns,
          idleSec: Math.round((overview.config.idleLearnMs || 60000) / 1000),
          maxFacts: overview.config.maxFacts,
          model: overview.config.model || '',
          provider: overview.config.provider || '',
        })
      }, [overview])

      useEffect(() => {
        void loadModels(false)
      }, [])

      if (!form) return h('div', { style: S.hint }, '正在读取配置…')

      const set = (key, value) => setForm((prev) => ({ ...prev, [key]: value }))
      const save = async () => {
        setBusy(true)
        setNote('')
        setError('')
        try {
          const result = await api('/settings', {
            method: 'POST',
            body: JSON.stringify({
              budgetChars: Number(form.budgetChars),
              autoLearn: form.autoLearn === true,
              learnEveryTurns: Number(form.learnEveryTurns),
              idleLearnMs: Math.round(Number(form.idleSec) * 1000),
              maxFacts: Number(form.maxFacts),
              model: String(form.model || ''),
              provider: String(form.provider || ''),
            }),
          })
          setNote('已保存并即时生效。')
          onSaved?.(result.config)
        } catch (err) {
          setError(String(err.message || err))
        } finally {
          setBusy(false)
        }
      }
      const reset = () => {
        setForm({ budgetChars: 1200, autoLearn: true, learnEveryTurns: 6, idleSec: 60, maxFacts: 500, model: '', provider: '' })
        setNote('已恢复默认值，点「保存并生效」后写入。')
        setError('')
      }

      const field = (label, hint, control) => h('div', { style: S.field },
        h('label', { style: S.label }, label),
        control,
        hint ? h('div', { ...{ style: { ...S.hint, marginTop: '4px' } } }, hint) : null,
      )

      const numInput = (key, min, max, step = 1, suffix = '') => h('div', { style: S.row },
        h('input', {
          type: 'number', min, max, step, value: form[key],
          onChange: (event) => set(key, event.target.value),
          style: { ...S.input, width: '110px' },
        }),
        suffix ? h('span', { style: S.hint }, suffix) : null,
      )

      const providers = Array.isArray(catalog?.providers) ? catalog.providers : []
      const allModels = Array.isArray(catalog?.models) ? catalog.models : []
      const providerIds = providers.map((row) => row.id)
      if (form.provider && !providerIds.includes(form.provider)) providerIds.unshift(form.provider)
      const modelsForProvider = form.provider
        ? allModels.filter((row) => row.provider === form.provider)
        : []
      const modelIds = modelsForProvider.map((row) => row.id)
      if (form.model && !modelIds.includes(form.model)) modelIds.unshift(form.model)
      const follow = catalog?.follow
      const defaultSelection = catalog?.defaultSelection
      const effective = form.provider && form.model
        ? `${form.provider} / ${form.model}`
        : follow?.provider
          ? `dsh-pet：${follow.provider} / ${follow.model}`
          : defaultSelection
            ? `宿主默认：${defaultSelection.provider} / ${defaultSelection.model}`
            : '尚未解析到可用模型'
      const catalogHint = catalog?.error
        ? `模型列表不可用（${catalog.error}），可直接手填。`
        : `留空跟随 dsh-pet；当前生效：${effective}`

      return h('div', null,
        h('div', { style: S.split },
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '10px' } }, '抽取与注入'),
            field('注入预算（字符）', '每次最多在 system 里追加多少字。越大越容易塞满，推荐 800–1600。', numInput('budgetChars', 120, 8000, 20)),
            field('自动学习', '关闭后只保留已有记忆，不再从对话里抽新事实。',
              h('label', { style: { ...S.row, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: form.autoLearn, onChange: (event) => set('autoLearn', event.target.checked) }),
                h('span', { style: { fontSize: '12px' } }, form.autoLearn ? '开启' : '关闭'),
              )),
            field('每 N 轮抽取一次', '强信号（「记住」「我叫」等）会立刻抽取，不受这个值影响。', numInput('learnEveryTurns', 1, 100, 1, '轮')),
            field('空闲抽取等待', '攒够 2 轮后，静止这么久就抽一次；设为 5 秒 – 1 小时。', numInput('idleSec', 5, 3600, 5, '秒')),
          ),
          h('div', { style: S.card },
            h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '10px' } }, '记忆容量'),
            field('最多活跃事实', '超过后按「重要度 × 新鲜度」淘汰最旧的；置顶事实保留。', numInput('maxFacts', 20, 5000, 10, '条')),
            field('抽取 Provider', catalogHint,
              h('div', { style: S.row },
                catalog?.error || providers.length === 0
                  ? h('input', {
                    value: form.provider, placeholder: '例如 deepseek',
                    onChange: (event) => set('provider', event.target.value), style: { ...S.input, flex: 1 },
                  })
                  : h('select', {
                    value: form.provider,
                    onChange: (event) => {
                      const next = event.target.value
                      setForm((prev) => ({ ...prev, provider: next, model: '' }))
                    },
                    style: { ...S.input, flex: 1 },
                  },
                  h('option', { value: '' }, '跟随 dsh-pet（留空）'),
                  ...providerIds.filter((id) => id !== '').map((id) => {
                    const row = providers.find((item) => item.id === id)
                    return h('option', { key: id, value: id }, row?.name ? `${row.name}（${id}）` : id)
                  }),
                  ),
                h('button', { type: 'button', style: S.btn, onClick: () => void loadModels(true), title: '重新拉取模型列表' }, '刷新模型'),
              )),
            field('抽取模型', '只列出所选 Provider 下的模型；留空=跟随 dsh-pet 的 chatModel。',
              catalog?.error || modelsForProvider.length === 0
                ? h('input', {
                  value: form.model, placeholder: form.provider ? '例如 deepseek-chat' : '先选 Provider，或两边都留空跟随',
                  onChange: (event) => set('model', event.target.value), style: { ...S.input, width: '100%' },
                })
                : h('select', {
                  value: form.model,
                  onChange: (event) => set('model', event.target.value),
                  style: { ...S.input, width: '100%' },
                },
                h('option', { value: '' }, '跟随 dsh-pet（留空）'),
                ...modelIds.filter((id) => id !== '').map((id) => {
                  const row = modelsForProvider.find((item) => item.id === id)
                  return h('option', { key: id, value: id }, row?.label ? `${row.label}（${id}）` : id)
                }),
                )),
          ),
        ),
        h('div', { style: { ...S.card, marginTop: '12px' } },
          h('div', { style: { ...S.row, marginBottom: '8px' } },
            h('button', { type: 'button', style: S.primary, disabled: busy, onClick: save }, busy ? '保存中…' : '保存并生效'),
            h('button', { type: 'button', style: S.btn, disabled: busy, onClick: reset }, '恢复默认'),
            h('span', { style: S.note }, note),
          ),
          error ? h('div', { style: S.error }, error) : null,
          h('div', { ...{ style: { ...S.hint, marginTop: '8px' } } },
            `配置写入本插件自己的 settings.json，不改 dsh-pet：${overview?.dataDir || ''}/settings.json`),
          h('div', { ...{ style: { ...S.hint, marginTop: '4px' } } },
            '记忆数据本身在 facts.jsonl；删除文件等于清空记忆，插件会在下次启动时重建。'),
        ),
      )
    }

    function concatFloat(chunks) {
      const total = chunks.reduce((sum, part) => sum + part.length, 0)
      const out = new Float32Array(total)
      let at = 0
      for (const part of chunks) {
        out.set(part, at)
        at += part.length
      }
      return out
    }

    /** Float32 -> 16k/16bit/单声道 WAV（ArrayBuffer）。 */
    function encodeWav(samples, sampleRate) {
      const target = 16000
      const ratio = sampleRate / target
      const length = Math.max(1, Math.floor(samples.length / ratio))
      const pcm = new Int16Array(length)
      for (let i = 0; i < length; i += 1) {
        const start = Math.floor(i * ratio)
        const end = Math.min(samples.length, Math.max(start + 1, Math.floor((i + 1) * ratio)))
        let sum = 0
        for (let j = start; j < end; j += 1) sum += samples[j]
        const value = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)))
        pcm[i] = value < 0 ? value * 0x8000 : value * 0x7fff
      }
      const buffer = new ArrayBuffer(44 + pcm.length * 2)
      const view = new DataView(buffer)
      const write = (offset, text) => {
        for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
      }
      write(0, 'RIFF')
      view.setUint32(4, 36 + pcm.length * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, target, true)
      view.setUint32(28, target * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, pcm.length * 2, true)
      new Int16Array(buffer, 44).set(pcm)
      return buffer
    }

    function toBase64(buffer) {
      const bytes = new Uint8Array(buffer)
      let binary = ''
      const step = 0x8000
      for (let at = 0; at < bytes.length; at += step) {
        binary += String.fromCharCode.apply(null, bytes.subarray(at, at + step))
      }
      return btoa(binary)
    }

    /**
     * 录一段并返回 16k WAV。VAD 只用于「说完了自动停」，不传音频特征。
     * @returns {{done: Promise<{reason:string, base64:string|null}>, stop:()=>void, cancel:()=>void}}
     */
    async function captureAudio({ maxSeconds = 8, useVad = true } = {}) {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('这个浏览器不支持麦克风')
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      })
      const AC = window.AudioContext || window.webkitAudioContext
      const ac = new AC()
      if (ac.state === 'suspended') await ac.resume()
      const source = ac.createMediaStreamSource(stream)
      const processor = ac.createScriptProcessor(4096, 1, 1)
      const sink = ac.createGain()
      sink.gain.value = 0
      source.connect(processor)
      processor.connect(sink)
      sink.connect(ac.destination)

      const chunks = []
      let frames = 0
      let started = false
      let silenceSeconds = 0
      let finished = false
      let resolveDone
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })

      const cleanup = () => {
        try { processor.disconnect() } catch { /* ignore */ }
        try { source.disconnect() } catch { /* ignore */ }
        try { sink.disconnect() } catch { /* ignore */ }
        try { stream.getTracks().forEach((track) => track.stop()) } catch { /* ignore */ }
        try { ac.close() } catch { /* ignore */ }
      }

      const finish = (reason) => {
        if (finished) return
        finished = true
        cleanup()
        if (chunks.length === 0) {
          resolveDone({ reason, base64: null })
          return
        }
        const wav = encodeWav(concatFloat(chunks), ac.sampleRate)
        resolveDone({ reason, base64: toBase64(wav) })
      }

      processor.onaudioprocess = (event) => {
        if (finished) return
        const data = event.inputBuffer.getChannelData(0)
        chunks.push(new Float32Array(data))
        frames += data.length
        const seconds = frames / ac.sampleRate
        let energy = 0
        for (let i = 0; i < data.length; i += 1) energy += data[i] * data[i]
        const rms = Math.sqrt(energy / data.length)
        if (rms > 0.018) {
          started = true
          silenceSeconds = 0
        } else if (started) {
          silenceSeconds += data.length / ac.sampleRate
        }
        if (seconds >= maxSeconds) finish('max')
        else if (useVad && started && seconds > 0.7 && silenceSeconds > 0.9) finish('silence')
      }

      return {
        done,
        stop: () => finish('stop'),
        cancel: () => finish('cancel'),
      }
    }

    function VoiceTab({ overview, onSaved }) {
      const [status, setStatus] = useState(overview?.voice || null)
      const [events, setEvents] = useState([])
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const [error, setError] = useState('')
      const [samples, setSamples] = useState([])
      const [score, setScore] = useState(null)
      const [last, setLast] = useState(null)
      const [listening, setListening] = useState(false)
      const listeningRef = useRef(false)
      const captureRef = useRef(null)
      const stopRequestedRef = useRef(false)
      const mountedRef = useRef(true)

      const config = overview?.config || {}
      const [wakeDraft, setWakeDraft] = useState(config.voiceWakeWord || '')
      useEffect(() => {
        setWakeDraft(config.voiceWakeWord || '')
      }, [config.voiceWakeWord])

      const refresh = useCallback(async () => {
        try {
          const [s, e] = await Promise.all([api('/voice/status'), api('/voice/events?limit=12')])
          if (!mountedRef.current) return
          setStatus(s.voice || null)
          setEvents(Array.isArray(e.events) ? e.events : [])
        } catch (err) {
          if (mountedRef.current) setError(String(err?.message || err))
        }
      }, [])

      useEffect(() => {
        mountedRef.current = true
        void refresh()
        return () => {
          mountedRef.current = false
          listeningRef.current = false
          captureRef.current?.cancel?.()
        }
      }, [refresh])

      const saveVoice = async (patch) => {
        setBusy('save')
        setNote('')
        setError('')
        try {
          const result = await api('/settings', { method: 'POST', body: JSON.stringify(patch) })
          onSaved?.(result.config)
          await refresh()
          setNote('已保存并即时生效。')
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const record = async ({ maxSeconds, useVad }) => {
        const capture = await captureAudio({ maxSeconds, useVad })
        captureRef.current = capture
        return capture.done
      }

      const recordSample = async () => {
        setBusy('enroll')
        setError('')
        setNote('')
        try {
          const { base64 } = await record({ maxSeconds: 3, useVad: false })
          if (base64) {
            setSamples((prev) => [...prev, base64].slice(0, 8))
            setNote(`已录 ${Math.min(3, samples.length + 1)}/3 段；建议同一环境连续录 3 段。`)
          }
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
          captureRef.current = null
        }
      }

      const saveEnroll = async () => {
        if (samples.length < 3) {
          setError('至少录 3 段声纹。')
          return
        }
        setBusy('enroll')
        setError('')
        try {
          const result = await api('/voice/enroll', { method: 'POST', body: JSON.stringify({ samples }) })
          setNote(`声纹已登记（${result.samples} 段，一致性 ${(result.consistency * 100).toFixed(0)}%）。`)
          setSamples([])
          setScore(result.consistency)
          await refresh()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const testSpeaker = async () => {
        setBusy('verify')
        setError('')
        setNote('')
        try {
          const { base64 } = await record({ maxSeconds: 3, useVad: false })
          if (!base64) return
          const result = await api('/voice/verify', { method: 'POST', body: JSON.stringify({ audio: base64 }) })
          setScore(result.score)
          setNote(result.match ? `声纹匹配（${(result.score * 100).toFixed(0)}%）。` : `不太像已登记的声音（${(result.score * 100).toFixed(0)}%），阈值 ${(result.threshold * 100).toFixed(0)}%。`)
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
          captureRef.current = null
        }
      }

      const pushStart = async () => {
        if (busy !== '') return
        setBusy('talk')
        setError('')
        setNote('')
        stopRequestedRef.current = false
        try {
          const capture = await captureAudio({ maxSeconds: 8, useVad: true })
          captureRef.current = capture
          if (stopRequestedRef.current) capture.stop()
          const { base64, reason } = await capture.done
          if (!base64 || reason === 'cancel') return
          const result = await api('/voice/utterance', { method: 'POST', body: JSON.stringify({ audio: base64, mode: 'push' }) })
          setLast(result)
          await refresh()
          if (!result.accepted) setNote(`没有发出去：${result.reason}`)
          else setNote(`已交给桌宠：${result.text}`)
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
          captureRef.current = null
        }
      }

      const pushEnd = () => {
        stopRequestedRef.current = true
        captureRef.current?.stop?.()
      }

      const stopListening = () => {
        listeningRef.current = false
        captureRef.current?.cancel?.()
        setListening(false)
      }

      const listenLoop = async () => {
        if (!config.voiceEnabled) {
          setError('先打开「语音对话」，再开常听。')
          return
        }
        if (!status?.enrolled && config.voiceRequire !== false) {
          setError('还没有登记声纹：为了不把电视/旁人声音发出去，必须先登记。')
          return
        }
        listeningRef.current = true
        setListening(true)
        setError('')
        while (listeningRef.current) {
          try {
            const capture = await captureAudio({ maxSeconds: 10, useVad: true })
            captureRef.current = capture
            const { base64 } = await capture.done
            captureRef.current = null
            if (!listeningRef.current) break
            if (base64) {
              const result = await api('/voice/utterance', { method: 'POST', body: JSON.stringify({ audio: base64, mode: 'wake' }) })
              if (mountedRef.current) setLast(result)
            }
          } catch (err) {
            if (mountedRef.current) setError(String(err?.message || err))
            break
          }
          await new Promise((resolve) => setTimeout(resolve, 600))
        }
        if (mountedRef.current) setListening(false)
      }

      const toggleListen = () => {
        if (listeningRef.current) stopListening()
        else void listenLoop()
      }

      const resetSpeaker = async () => {
        setBusy('reset')
        setError('')
        try {
          await api('/voice/reset', { method: 'POST', body: '{}' })
          setSamples([])
          setScore(null)
          setNote('已删除本机声纹，原声从未保存。')
          await refresh()
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const card = (title, children) => h('div', { style: S.card },
        h('div', { style: { fontSize: '13px', fontWeight: 700, marginBottom: '10px' } }, title),
        children,
      )
      const field = (label, hint, control) => h('div', { style: S.field },
        h('label', { style: S.label }, label),
        control,
        hint ? h('div', { style: { ...S.hint, marginTop: '4px' } }, hint) : null,
      )
      const toggle = (label, checked, onChange) => h('label', { style: { ...S.row, cursor: 'pointer' } },
        h('input', { type: 'checkbox', checked, onChange: (event) => onChange(event.target.checked) }),
        h('span', { style: { fontSize: '12px' } }, checked ? '开启' : '关闭'),
        h('span', { style: S.hint }, label),
      )

      const ready = status?.ready || {}
      return h('div', null,
        card('状态', h('div', null,
          h('div', { style: S.chips },
            h('span', { style: config.voiceEnabled ? S.chipHot : S.chip }, config.voiceEnabled ? '语音已开启' : '语音关闭'),
            h('span', { style: status?.enrolled ? S.chipHot : S.chip }, status?.enrolled ? `声纹已登记（${status.samples} 段）` : '未登记声纹'),
            h('span', { style: ready.speech ? S.chip : S.chip }, ready.speech ? '识别服务就绪' : '识别服务不可用'),
            h('span', { style: ready.commands && ready.agent ? S.chip : S.chip }, ready.commands && ready.agent ? '对话通道就绪' : '没有可用会话'),
            h('span', { style: S.chip }, `唤醒词「${status?.wakeWord || '小鲸鱼'}」`),
          ),
          h('div', { style: { ...S.hint, marginTop: '8px' } },
            '识别用宿主自带的语音转文字；原声不会保存，也不会上传第三方。声纹只保存一组数字（embedding）。当前是实验特征，先保证「不误放行」，后续可换更强的声纹模型。'),
          h('div', { style: S.row },
            h('button', { type: 'button', style: S.btn, onClick: () => void refresh() }, '刷新状态'),
            status?.lastEvent
              ? h('span', { style: S.hint }, `最近：${status.lastEvent.accepted ? '已发送' : '已拒绝'} · ${status.lastEvent.reason || '-'} · ${fmtTime(status.lastEvent.ts)}`)
              : null,
          ),
        )),
        card('声纹', h('div', null,
          h('div', { style: S.hint }, '录 3 段你的声音，之后只认这个声音。没登记时所有语音都会被拒绝——这是为了不让电视或旁人误触发、白花 token。'),
          h('div', { style: { ...S.row, marginTop: '8px' } },
            h('button', { type: 'button', style: S.primary, disabled: busy !== '', onClick: () => void recordSample() },
              busy === 'enroll' ? '处理中…' : samples.length >= 3 ? '再录一段' : `录第 ${samples.length + 1} 段`),
            h('button', { type: 'button', style: S.btn, disabled: busy !== '' || samples.length < 3, onClick: () => void saveEnroll() }, '保存声纹'),
            h('button', { type: 'button', style: S.btn, disabled: busy !== '' || !status?.enrolled, onClick: () => void testSpeaker() }, '测试一次'),
            h('button', { type: 'button', style: S.btn, disabled: busy !== '' || !status?.enrolled, onClick: () => void resetSpeaker() }, '删除声纹'),
            h('span', { style: S.hint }, `已录 ${samples.length}/3 段${score === null ? '' : ` · 最近相似度 ${(score * 100).toFixed(0)}%`}`),
          ),
          field('判定阈值', '越高越严格。80% 起步；经常认不出自己就往下调一点，误认旁人往上调。',
            h('div', { style: S.row },
              h('input', {
                type: 'range', min: 0.5, max: 0.98, step: 0.01,
                value: config.voiceThreshold ?? 0.8,
                onChange: (event) => saveVoice({ voiceThreshold: Number(event.target.value) }),
                style: { flex: '1 1 200px', accentColor: '#6aa9ff' },
              }),
              h('span', { style: { ...S.mono, minWidth: '48px' } }, `${Math.round((config.voiceThreshold ?? 0.8) * 100)}%`),
            )),
        )),
        card('说话方式', h('div', null,
          field('语音对话', '关闭时插件完全不碰麦克风；打开后还要通过声纹这一关。',
            toggle('允许接收语音', config.voiceEnabled === true, (next) => void saveVoice({ voiceEnabled: next }))),
          field('唤醒词', '留空 = 跟随桌宠名字，改名后自动跟着变；一旦手动填写，就不再自动变化。',
            h('div', { style: S.row },
              h('input', {
                value: wakeDraft, placeholder: status?.wakeWord || '小鲸鱼',
                onChange: (event) => setWakeDraft(event.target.value),
                style: { ...S.input, width: '220px' },
              }),
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => void saveVoice({ voiceWakeWord: wakeDraft }),
              }, '保存唤醒词'),
              h('button', {
                type: 'button', style: S.btn,
                onClick: () => { setWakeDraft(''); void saveVoice({ voiceWakeWord: '' }) },
              }, '跟随宠物名'),
            )),
          field('必须声纹', '关掉后任何人都能说；不推荐。默认开着。',
            toggle('只接受已登记的声音', config.voiceRequire !== false, (next) => void saveVoice({ voiceRequire: next }))),
          field('保留转写文本', '只写进本机 voice-events.jsonl（最多 500 条 / 128KB），关掉就只留“已发送/被拒绝”。',
            toggle('保存识别出的文字', config.voiceKeepTranscript !== false, (next) => void saveVoice({ voiceKeepTranscript: next }))),
          h('div', { style: { ...S.row, marginTop: '10px' } },
            h('button', {
              type: 'button', style: S.primary, disabled: busy !== '' || listening,
              onPointerDown: (event) => { event.preventDefault(); void pushStart() },
              onPointerUp: (event) => { event.preventDefault(); pushEnd() },
              onPointerLeave: () => pushEnd(),
              onPointerCancel: () => pushEnd(),
            }, busy === 'talk' ? '听着…（松手结束）' : '按住说话（说完松手）'),
            h('button', { type: 'button', style: listening ? S.primary : S.btn, disabled: busy !== '', onClick: toggleListen },
              listening ? '停止常听' : '开始常听'),
          ),
          h('div', { style: { ...S.hint, marginTop: '6px' } },
            '常听会一直占用麦克风，只在你说出唤醒词后才把话交给桌宠；没说出唤醒词的那段会被丢弃。怕费 token 就先用「按住说话」。'),
        )),
        card('情绪语音（免费版）', h('div', null,
          field('启用情绪语音', '仍用内置 Edge 音色，只按文本情绪调整音高、语速和音量。开启后到「设置 → 桌宠」的语音里选择「桌宠情绪语音（免费版）」下的音色；关闭即回原生。',
            toggle('让声音有起伏', config.ttsEmotion === true, (next) => void saveVoice({ ttsEmotion: next }))),
          field('情绪强度', '1.0 是默认；越高起伏越明显，建议 0.8–1.2。',
            h('div', { style: S.row },
              h('input', {
                type: 'range', min: 0.5, max: 1.5, step: 0.1,
                value: config.ttsEmotionIntensity ?? 1,
                onChange: (event) => void saveVoice({ ttsEmotionIntensity: Number(event.target.value) }),
                style: { flex: '1 1 200px', accentColor: '#b98bff' },
              }),
              h('span', { style: { ...S.mono, minWidth: '48px' } }, `${(config.ttsEmotionIntensity ?? 1).toFixed(1)}×`),
            )),
          h('div', { style: S.hint },
            '免费版是规则判定，不是真·情感模型；如果听感还不够，再换 Azure/OpenAI 的情感 TTS。'),
          last
            ? h('div', { style: { ...S.card, background: C.input, marginTop: '10px', marginBottom: 0 } },
              h('div', { style: S.hint }, last.accepted ? `已交给桌宠：${last.text}` : `没有发出去：${last.reason}`),
              last.reply ? h('div', { style: { fontSize: '12px', marginTop: '4px' } }, `回复：${last.reply}`) : null,
            )
            : null,
        )),
        card('最近语音', events.length === 0
          ? h('div', { style: S.hint }, '还没有语音记录。')
          : h('div', null, events.map((event, index) => h('div', {
            key: `${event.ts}-${index}`,
            style: { ...S.row, justifyContent: 'space-between', padding: '5px 0', borderBottom: `1px solid ${C.border}55` },
          },
          h('span', { style: { ...S.hint, color: event.accepted ? C.ok : C.faint } }, event.accepted ? '已发送' : `未发送 · ${event.reason || '-'}`),
          h('span', { style: S.hint }, event.text || '（未保留文本）'),
          h('span', { style: S.hint }, `${Math.round((event.score || 0) * 100)}% · ${fmtTime(event.ts)}`),
          )))),
        note ? h('div', { style: S.note }, note) : null,
        error ? h('div', { style: S.error }, error) : null,
      )
    }

    function SelfTab({ data, petName, config, onSaved }) {
      const state = data?.state || { moodText: '平静 · 一般', valence: 0, energy: 0.5, events: 0 }
      const events = Array.isArray(data?.events) ? data.events : []
      const kindLabel = { event: '经历', feeling: '心情', thought: '想法' }
      const [view, setView] = useState('map')
      const [selected, setSelected] = useState(null)
      const [injectCfg, setInjectCfg] = useState(() => ({
        selfInject: config?.selfInject === true,
        selfBudget: Number(config?.selfBudget ?? 160),
        selfInjectMaxEvents: Number(config?.selfInjectMaxEvents ?? 3),
        selfInjectWindowH: Number(config?.selfInjectWindowH ?? 36),
        selfInjectQuotes: config?.selfInjectQuotes === true,
      }))
      const [preview, setPreview] = useState(data?.previewBlock || '')
      const [previewing, setPreviewing] = useState(false)
      const [savingInject, setSavingInject] = useState(false)
      const [injectError, setInjectError] = useState('')
      const [mapMode, setMapMode] = useState(() => {
        try {
          return localStorage.getItem('dsh-pet-persona.selfMapMode') === '2d' ? '2d' : '3d'
        } catch {
          return '3d'
        }
      })
      const [camera, setCamera] = useState(MAP_CAMERA)
      const [selectedEmotion, setSelectedEmotion] = useState('')
      const mapSvgRef = useRef(null)
      const brainCanvasRef = useRef(null)
      const brainHitsRef = useRef({ faces: [] })
      const mapDragRef = useRef(null)
      const mapMovedRef = useRef(false)
      const pickEmotion = (key) => {
        setSelected(null)
        setSelectedEmotion((prev) => (prev === key ? '' : key))
      }
      const switchMapMode = (mode) => {
        setMapMode(mode)
        try {
          localStorage.setItem('dsh-pet-persona.selfMapMode', mode)
        } catch {
          // localStorage 不可用时只影响记忆，不影响本次切换。
        }
      }
      const emotionOfEvent = (event) => {
        const list = Array.isArray(event?.emotions) ? event.emotions : []
        if (list.length > 0) {
          const top = list[0]
          return { key: top.key, label: EMO_LABEL[top.key] || top.label || '经历', color: EMO_COLOR[top.key] || '#9aa4b2', list }
        }
        const value = Number(event?.valence) || 0
        const key = value >= 0.35 ? 'joy' : value >= 0.1 ? 'calm' : value > -0.1 ? 'calm' : value > -0.35 ? 'sadness' : 'sadness'
        return { key, label: EMO_LABEL[key], color: EMO_COLOR[key], list: [] }
      }
      const emotionText = (event) => {
        const list = Array.isArray(event?.emotions) ? event.emotions : []
        return list.length > 0 ? list.slice(0, 3).map((item) => item.label || EMO_LABEL[item.key]).join(' + ') : emotionOfEvent(event).label
      }
      const groupList = EMO_ORDER
        .map((key) => ({
          key,
          label: EMO_LABEL[key],
          color: EMO_COLOR[key],
          items: events.filter((event) => emotionOfEvent(event).key === key),
        }))
        .filter((group) => group.items.length > 0)
      const mapNodes = []
      if (view === 'map' && mapMode === '2d' && groupList.length > 0) {
        const n = groupList.length
        groupList.forEach((group, groupIndex) => {
          const angle = (-90 + (groupIndex * 360) / n) * (Math.PI / 180)
          const bx = Math.cos(angle) * 128
          const by = Math.sin(angle) * 128
          mapNodes.push({ type: 'branch', key: group.key, label: group.label, color: group.color, x: bx, y: by, count: group.items.length })
          const leaves = group.items.slice(0, 5)
          const base = (groupIndex * 360) / n - 90
          const span = Math.min(46, (360 / n) * 0.72)
          leaves.forEach((event, leafIndex) => {
            const leafAngle = (base + (leaves.length === 1 ? 0 : (leafIndex / (leaves.length - 1) - 0.5) * span)) * (Math.PI / 180)
            const radius = 236
            mapNodes.push({
              type: 'leaf',
              key: event.id || `${event.createdAt}-${leafIndex}`,
              event,
              color: group.color,
              x: Math.cos(leafAngle) * radius,
              y: Math.sin(leafAngle) * radius,
            })
          })
        })
      }
      const loadPreview = async () => {
        setPreviewing(true)
        setInjectError('')
        try {
          const res = await api('/self/preview', { method: 'POST', body: JSON.stringify({ query: '你好' }) })
          setPreview(res.selfBlock || '')
        } catch (err) {
          setInjectError(String(err?.message || err))
        } finally {
          setPreviewing(false)
        }
      }
      useEffect(() => { void loadPreview() }, [])
      useEffect(() => {
        const element = brainCanvasRef.current
        if (!element || view !== 'map' || mapMode !== '3d') return undefined
        const onWheel = (event) => {
          event.preventDefault()
          setCamera((prev) => ({
            ...prev,
            zoom: Math.max(0.55, Math.min(2.4, prev.zoom * (event.deltaY > 0 ? 0.92 : 1.08))),
          }))
        }
        element.addEventListener('wheel', onWheel, { passive: false })
        return () => element.removeEventListener('wheel', onWheel)
      }, [view, mapMode])
      useEffect(() => {
        const canvas = brainCanvasRef.current
        if (!canvas || view !== 'map' || mapMode !== '3d') return
        const { shares, calmRatio } = brainShares(events)
        brainHitsRef.current = drawBrain3D(canvas, { shares, camera, selected: selectedEmotion, calmRatio })
      }, [view, mapMode, camera, selectedEmotion, events])
      const saveInject = async () => {
        setSavingInject(true)
        setInjectError('')
        try {
          const res = await api('/settings', { method: 'POST', body: JSON.stringify(injectCfg) })
          if (res.config) onSaved?.(res.config)
          await loadPreview()
        } catch (err) {
          setInjectError(String(err?.message || err))
        } finally {
          setSavingInject(false)
        }
      }
      const toggle = h('div', { style: { ...S.row, gap: '6px' } },
        ['map', 'timeline'].map((mode) => h('button', {
          key: mode,
          type: 'button',
          onClick: () => setView(mode),
          style: { ...S.btn, opacity: view === mode ? 1 : 0.55, padding: '4px 10px' },
        }, mode === 'map' ? '脑图' : '时间线')),
      )
      const mapSelectedCard = selected
        ? h('div', { style: { ...S.card, background: C.input, marginTop: '4px', marginBottom: 0 } },
          h('div', { style: { ...S.row, justifyContent: 'space-between' } },
            h('span', { style: { ...S.chip, color: selected.valence >= 0 ? C.ok : C.danger } },
              `${kindLabel[selected.kind] || '经历'} · ${emotionText(selected)}`),
            selected.source && selected.source !== 'chat'
              ? h('span', { style: S.chip },
                selected.source === 'autonomy' ? '自主决定'
                  : selected.source === 'whisper' ? '自言自语'
                    : '自主执行')
              : null,
            h('span', { style: S.hint }, fmtTime(selected.createdAt)),
          ),
          h('div', { style: { fontSize: '12px', marginTop: '4px' } }, selected.text),
          selected.quote ? h('div', { style: { ...S.hint, marginTop: '2px' } }, `主人当时说：「${selected.quote}」`) : null,
        )
        : null
      const render2D = () => h('div', null,
        h('svg', { viewBox: '-320 -270 640 540', style: { width: '100%', height: '430px', display: 'block' } },
          h('circle', { cx: 0, cy: 0, r: 44, fill: C.input, stroke: C.border }),
          h('text', { x: 0, y: -2, textAnchor: 'middle', fill: C.text, fontSize: 15, fontWeight: 700 }, '我'),
          h('text', { x: 0, y: 16, textAnchor: 'middle', fill: C.faint, fontSize: 10 }, `${events.length} 条`),
          mapNodes.filter((node) => node.type === 'branch').map((node) => h('g', { key: `b-${node.key}` },
            h('line', { x1: 0, y1: 0, x2: node.x, y2: node.y, stroke: node.color, strokeWidth: 1.4, opacity: 0.55 }),
            h('circle', { cx: node.x, cy: node.y, r: 24, fill: `${node.color}33`, stroke: node.color, strokeWidth: 1.5 }),
            h('text', { x: node.x, y: node.y + 4, textAnchor: 'middle', fill: C.text, fontSize: 12, fontWeight: 700 }, node.label),
            h('text', { x: node.x, y: node.y + 34, textAnchor: 'middle', fill: C.faint, fontSize: 10 }, `${node.count} 条`),
          )),
          mapNodes.filter((node) => node.type === 'leaf').map((node) => h('g', {
            key: `l-${node.key}`,
            style: { cursor: 'pointer' },
            onClick: () => setSelected(node.event),
          },
            h('line', { x1: 0, y1: 0, x2: node.x, y2: node.y, stroke: node.color, strokeWidth: 0.6, opacity: 0.16 }),
            h('circle', { cx: node.x, cy: node.y, r: 5, fill: node.color }),
            h('text', {
              x: node.x + (node.x >= 0 ? 9 : -9),
              y: node.y + 4,
              textAnchor: node.x >= 0 ? 'start' : 'end',
              fill: C.text,
              fontSize: 10,
            }, String(node.event.text || '').slice(0, 9)),
          )),
        ),
      )
      const render3D = () => {
        const { shares, calmRatio } = brainShares(events)
        const project = (x, y, z) => mapProject(x, y, z, camera)
        const pointerDown = (event) => {
          mapDragRef.current = { x: event.clientX, y: event.clientY, rotX: camera.rotX, rotY: camera.rotY }
          mapMovedRef.current = false
          event.currentTarget.setPointerCapture?.(event.pointerId)
        }
        const pointerMove = (event) => {
          const drag = mapDragRef.current
          if (!drag) return
          const dx = event.clientX - drag.x
          const dy = event.clientY - drag.y
          if (Math.hypot(dx, dy) > 4) mapMovedRef.current = true
          if (!mapMovedRef.current) return
          setCamera((prev) => ({
            ...prev,
            rotY: drag.rotY + dx * 0.35,
            rotX: Math.max(-80, Math.min(80, drag.rotX + dy * 0.35)),
          }))
        }
        const pointerUp = () => { mapDragRef.current = null }
        const pick = (callback) => () => {
          if (mapMovedRef.current) return
          callback()
        }
        const percent = (value) => (value > 0 && value < 0.005 ? '<1%' : `${Math.round(value * 100)}%`)
        const clickBrain = (event) => {
          if (mapMovedRef.current) return
          const canvas = brainCanvasRef.current
          if (!canvas) return
          const rect = canvas.getBoundingClientRect()
          const point = {
            x: (event.clientX - rect.left) * (canvas.width / rect.width),
            y: (event.clientY - rect.top) * (canvas.height / rect.height),
          }
          const hits = brainHitsRef.current
          for (let index = hits.faces.length - 1; index >= 0; index -= 1) {
            const face = hits.faces[index]
            if (pointInPoly(point.x, point.y, face.points)) {
              pickEmotion(face.key)
              return
            }
          }
        }
        const detail = () => {
          if (selectedEmotion) {
            const info = shares.find((item) => item.key === selectedEmotion)
            if (!info) return null
            const rows = events
              .map((event) => ({ event, score: Number(mapScores(event)[selectedEmotion] || 0) }))
              .filter((row) => row.score > 0.08)
              .sort((a, b) => b.score - a.score)
              .slice(0, 8)
            return h('div', { style: { ...S.card, background: C.input, marginTop: '6px', marginBottom: 0 } },
              h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                h('span', { style: { ...S.chip, color: info.color, borderColor: `${info.color}88` } },
                  `${info.label} · ${info.area} · ${percent(info.share)}`),
                h('button', {
                  type: 'button',
                  style: { ...S.btn, padding: '2px 9px' },
                  onClick: () => setSelectedEmotion(''),
                }, '关闭'),
              ),
              h('div', { style: { ...S.hint, margin: '6px 0' } },
                `这种情绪占全部情绪权重的 ${percent(info.share)}；下面 ${rows.length} 条是和它关系最强的经历。`),
              rows.length === 0
                ? h('div', { style: S.hint }, '还没有这类情绪的记忆。')
                : rows.map((row, index) => h('div', {
                  key: row.event.id || `${row.event.createdAt}-${index}`,
                  style: { padding: '6px 0', borderBottom: `1px solid ${C.border}55` },
                },
                  h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                    h('span', { style: { ...S.hint, color: info.color } }, `相关度 ${Math.round(row.score * 100)}%`),
                    h('span', { style: S.hint }, fmtTime(row.event.createdAt)),
                  ),
                  h('div', { style: { fontSize: '12px', marginTop: '2px' } }, row.event.text),
                  row.event.quote ? h('div', { style: { ...S.hint, marginTop: '2px' } }, `主人当时说：「${row.event.quote}」`) : null,
                )),
            )
          }
          return null
        }
        return h('div', null,
          h('canvas', {
            ref: brainCanvasRef,
            width: 640,
            height: 540,
            style: {
              width: '100%',
              height: 'auto',
              aspectRatio: '640 / 540',
              display: 'block',
              borderRadius: '10px',
              background: 'radial-gradient(circle at 46% 40%, #17202e, #0b1018 72%)',
              cursor: mapDragRef.current ? 'grabbing' : 'grab',
              touchAction: 'none',
              userSelect: 'none',
            },
            onPointerDown: pointerDown,
            onPointerMove: pointerMove,
            onPointerUp: pointerUp,
            onPointerLeave: pointerUp,
            onClick: clickBrain,
            onDoubleClick: () => setCamera(MAP_CAMERA),
            role: 'img',
            'aria-label': '三维情绪脑模型',
          }),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '4px 8px', marginTop: '6px' } },
            shares.map((item) => h('button', {
              key: item.key,
              type: 'button',
              onClick: () => pickEmotion(item.key),
              title: `${item.label} · ${item.area}`,
              style: {
                ...S.chip,
                cursor: 'pointer',
                display: 'inline-flex',
                alignItems: 'center',
                gap: '4px',
                color: C.text,
                background: item.key === selectedEmotion ? `${item.color}22` : 'transparent',
                borderColor: item.key === selectedEmotion ? `${item.color}aa` : C.border,
              },
            },
              h('span', { style: { width: '8px', height: '8px', borderRadius: '50%', background: item.color } }),
              `${item.label} ${percent(item.share)}`,
            )),
          ),
          h('div', { style: { ...S.hint, marginTop: '2px' } },
            h('span', { style: { display: 'inline-block', width: '8px', height: '8px', borderRadius: '50%', background: EMO_COLOR.calm, marginRight: '4px' } }),
            `平静度 ${percent(calmRatio)}：平静是底色，不计入彩色占比，只把整体压暗一点。`),
          h('div', { style: { ...S.hint, marginTop: '4px' } },
            `每种情绪像一层有颜色的水，一起填满整个脑壳：面积约等于它在全部情绪权重里的占比（共 ${events.length} 条经历）；多种情绪的经历会分别计入各情绪占比，主图不再画融合；拖动旋转、滚轮缩放、双击复位，点色块或下方标签查看这类情绪的对话。`),
          h('div', { style: { ...S.hint, marginTop: '2px' } },
            '脑区位置：伏隔核=开心 · 岛叶=亲近 · 前扣带=难过 · 杏仁核=生气 · 杏仁核前部=担心 · 脑干=疲惫 · 蓝斑=惊讶 · 内侧前额叶=平静。'),
          detail(),
        )
      }
      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: '8px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 700 } }, '注入到它眼前的自己'),
            h('span', { style: injectCfg.selfInject ? S.chipHot : S.chip }, injectCfg.selfInject ? '已开启' : '默认关闭'),
          ),
          h('div', { style: { ...S.hint, marginBottom: '8px' } },
            '开启后，每次桌宠回话前会在主人事实块后面追加一小段【现在的我】：当前心情 + 最近 3 条经历，独立预算，不带原话。关掉就完全恢复原样。'),
          h('label', { style: { ...S.row, ...S.hint, cursor: 'pointer', marginBottom: '8px' } },
            h('input', {
              type: 'checkbox',
              checked: injectCfg.selfInject,
              onChange: (event) => setInjectCfg((prev) => ({ ...prev, selfInject: event.target.checked })),
            }),
            '开启自我注入（selfInject）',
          ),
          h('div', { style: { ...S.row, gap: '10px', flexWrap: 'wrap', marginBottom: '8px' } },
            h('label', { style: { ...S.hint, display: 'flex', alignItems: 'center', gap: '4px' } },
              '预算',
              h('input', {
                type: 'number', min: 80, max: 800, value: injectCfg.selfBudget,
                onChange: (event) => setInjectCfg((prev) => ({ ...prev, selfBudget: Number(event.target.value) })),
                style: { ...S.input, width: '80px' },
              }),
            ),
            h('label', { style: { ...S.hint, display: 'flex', alignItems: 'center', gap: '4px' } },
              '条数',
              h('input', {
                type: 'number', min: 1, max: 5, value: injectCfg.selfInjectMaxEvents,
                onChange: (event) => setInjectCfg((prev) => ({ ...prev, selfInjectMaxEvents: Number(event.target.value) })),
                style: { ...S.input, width: '60px' },
              }),
            ),
            h('label', { style: { ...S.hint, display: 'flex', alignItems: 'center', gap: '4px' } },
              '窗口(h)',
              h('input', {
                type: 'number', min: 6, max: 72, value: injectCfg.selfInjectWindowH,
                onChange: (event) => setInjectCfg((prev) => ({ ...prev, selfInjectWindowH: Number(event.target.value) })),
                style: { ...S.input, width: '66px' },
              }),
            ),
            h('label', { style: { ...S.row, ...S.hint, cursor: 'pointer' } },
              h('input', {
                type: 'checkbox', checked: injectCfg.selfInjectQuotes,
                onChange: (event) => setInjectCfg((prev) => ({ ...prev, selfInjectQuotes: event.target.checked })),
              }),
              '带主人口头原话',
            ),
          ),
          h('div', { style: { ...S.row, gap: '8px', marginBottom: '8px' } },
            h('button', {
              type: 'button', style: S.primary, disabled: savingInject,
              onClick: () => void saveInject(),
            }, savingInject ? '保存中…' : '保存注入设置'),
            h('button', { type: 'button', style: S.btn, disabled: previewing, onClick: () => void loadPreview() },
              previewing ? '生成中…' : '刷新预览'),
          ),
          injectError ? h('div', { style: { ...S.hint, color: C.danger, marginBottom: '6px' } }, injectError) : null,
          preview
            ? h('pre', { style: { ...S.mono, background: C.input, border: `1px solid ${C.border}`, borderRadius: '8px', padding: '10px', whiteSpace: 'pre-wrap', margin: 0, maxHeight: '220px', overflow: 'auto' } }, preview)
            : h('div', { style: S.hint }, previewing ? '正在生成预览…' : '还没有可注入的内容：先和它聊几句，或在下面脑图里看到经历后再看。'),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: '8px' } },
            h('div', { style: { fontSize: '13px', fontWeight: 700 } }, `${petName}现在的心情`),
            h('span', { style: S.chip }, state.moodText || '平静 · 一般'),
          ),
          h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '10px' } },
            (Array.isArray(state.emotions) ? state.emotions : []).slice(0, 4).map((emotion) => h('span', {
              key: emotion.key,
              title: `${emotion.label} ${Math.round((emotion.score || 0) * 100)}%`,
              style: {
                ...S.chip,
                borderColor: `${EMO_COLOR[emotion.key] || '#9aa4b2'}88`,
                color: EMO_COLOR[emotion.key] || C.text,
              },
            }, `${emotion.label} ${Math.round((emotion.score || 0) * 100)}%`)),
          ),
          h('div', { style: { ...S.hint, marginBottom: '4px' } }, `心情 ${Math.round(((state.valence + 1) / 2) * 100)}%`),
          h('div', { style: { height: '8px', borderRadius: '6px', background: C.input, overflow: 'hidden', marginBottom: '10px' } },
            h('div', { style: { width: `${Math.round(((state.valence + 1) / 2) * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#6aa9ff,#59d18b)' } }),
          ),
          h('div', { style: { ...S.hint, marginBottom: '4px' } }, `精力 ${Math.round((state.energy || 0) * 100)}%`),
          h('div', { style: { height: '8px', borderRadius: '6px', background: C.input, overflow: 'hidden' } },
            h('div', { style: { width: `${Math.round((state.energy || 0) * 100)}%`, height: '100%', background: 'linear-gradient(90deg,#e8c15a,#ff9f6b)' } }),
          ),
          h('div', { style: { ...S.hint, marginTop: '8px' } },
            `最近 ${state.events || 0} 条自我记忆${state.updatedAt ? ` · 更新于 ${fmtTime(state.updatedAt)}` : ''}`),
        ),
        h('div', { style: S.card },
          h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: '6px' } },
            h('div', { style: { fontSize: '12px', fontWeight: 700 } }, '它自己的记忆'),
            toggle,
          ),
          events.length === 0
            ? h('div', { style: S.hint }, '还没有自我记忆。和它聊几句、夸夸它或惹它生气，这里才会慢慢有东西。')
            : view === 'map'
              ? h('div', null,
                h('div', { style: { ...S.row, justifyContent: 'space-between', marginBottom: '6px' } },
                  h('div', { style: { ...S.row, gap: '6px' } },
                    [['3d', '3D 脑区'], ['2d', '平面 2D']].map(([mode, label]) => h('button', {
                      key: mode,
                      type: 'button',
                      onClick: () => switchMapMode(mode),
                      style: { ...S.btn, opacity: mapMode === mode ? 1 : 0.55, padding: '4px 10px' },
                    }, label)),
                  ),
                  mapMode === '3d'
                    ? h('button', {
                      type: 'button',
                      style: { ...S.btn, padding: '4px 10px' },
                      onClick: () => setCamera(MAP_CAMERA),
                    }, '复位视角')
                    : null,
                ),
                mapMode === '3d' ? render3D() : render2D(),
                mapMode === '3d' ? null : mapSelectedCard,
                mapMode !== '3d' && !mapSelectedCard
                  ? h('div', { style: { ...S.hint, marginTop: '2px' } },
                    '点圆点看这条记忆；心情分支按当前情绪聚合，最多显示 5 条最近的。')
                  : null,
              )
              : h('div', null, events.map((event, index) => h('div', {
                key: event.id || `${event.createdAt}-${index}`,
                style: { padding: '7px 0', borderBottom: `1px solid ${C.border}55` },
              },
              h('div', { style: { ...S.row, justifyContent: 'space-between' } },
                h('span', { style: { ...S.chip, color: event.valence >= 0 ? C.ok : C.danger } },
                  `${kindLabel[event.kind] || '经历'} · ${emotionText(event)}`),
                h('span', { style: S.hint }, fmtTime(event.createdAt)),
              ),
              h('div', { style: { fontSize: '12px', marginTop: '3px' } }, event.text),
              event.quote ? h('div', { style: { ...S.hint, marginTop: '2px' } }, `主人当时说：「${event.quote}」`) : null,
              ))),
        ),
        h('div', { style: S.note },
          '这里记录的是它自己的经历和心情，和「记忆脑图」里的主人事实分开存放；心情会随时间慢慢回落，不会硬改它的人格。'),
      )
    }

    function AgencyTab({ overview, onChanged }) {
      const [data, setData] = useState(null)
      const [autonomy, setAutonomy] = useState(null)
      const [busy, setBusy] = useState('')
      const [note, setNote] = useState('')
      const config = (overview && overview.config) || {}
      const enabled = config.agencyEnabled !== false

      const load = useCallback(async () => {
        try {
          const [agencyData, autonomyData] = await Promise.all([api('/agency'), api('/agency/autonomy')])
          setData(agencyData)
          setAutonomy(autonomyData?.autonomy || null)
        } catch (err) {
          setNote(String(err?.message || err))
        }
      }, [])

      useEffect(() => { void load() }, [load])

      const decide = async (id, action) => {
        setBusy(id)
        setNote('')
        try {
          await api('/agency/decide', { method: 'POST', body: JSON.stringify({ id, action }) })
          await load()
          onChanged?.()
        } catch (err) {
          setNote(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const undo = async (id) => {
        setBusy(id)
        setNote('')
        try {
          await api('/agency/undo', { method: 'POST', body: JSON.stringify({ id }) })
          await load()
          onChanged?.()
        } catch (err) {
          setNote(String(err?.message || err))
        } finally {
          setBusy('')
        }
      }

      const toggle = async (next) => {
        setNote('')
        try {
          await api('/settings', { method: 'POST', body: JSON.stringify({ agencyEnabled: next }) })
          onChanged?.()
        } catch (err) {
          setNote(String(err?.message || err))
        }
      }

      const setLevel = async (level) => {
        setNote('')
        try {
          await api('/agency/autonomy', { method: 'POST', body: JSON.stringify({ level }) })
          await load()
          onChanged?.()
        } catch (err) {
          setNote(String(err?.message || err))
        }
      }

      const proposals = Array.isArray(data?.proposals) ? data.proposals : []
      const pending = proposals.filter((item) => item.status === 'pending')
      const history = proposals.filter((item) => item.status !== 'pending').slice(0, 30)

      const card = (item) => h('div', {
        key: item.id,
        style: { ...S.card, borderLeft: `3px solid ${item.kind === 'tidy' ? '#e8c15a' : '#6aa9ff'}` },
      },
        h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
          h('div', null,
            h('div', { style: { fontSize: '12px', fontWeight: 700 } },
              `${item.kind === 'note' ? '记一条' : item.kind === 'reminder' ? '提醒' : item.kind === 'reminder_due' ? '提醒到点' : item.kind === 'digest' ? '整理心情' : '整理记忆'}`,
              h('span', { style: { ...S.chip, marginLeft: '8px' } }, item.status === 'pending' ? '待确认' : item.status === 'done' ? '已完成' : item.status === 'undone' ? '已撤销' : item.status)),
            h('div', { style: { marginTop: '4px', fontSize: '13px', fontWeight: 600 } }, item.title || ''),
            h('div', { style: { marginTop: '4px', fontSize: '13px', whiteSpace: 'pre-wrap' } }, item.detail || ''),
            item.payload?.due ? h('div', { style: { ...S.muted, marginTop: '4px' } }, `到点：${item.payload.due}`) : null,
          ),
          h('div', { style: S.muted }, fmtTime(item.createdAt)),
        ),
        item.status === 'pending'
          ? h('div', { style: { ...S.row, marginTop: '10px' } },
              h('button', { style: S.btn, disabled: busy === item.id, onClick: () => decide(item.id, 'approve') }, '允许'),
              h('button', { style: S.btn, disabled: busy === item.id, onClick: () => decide(item.id, 'reject') }, '拒绝'),
            )
          : item.status === 'done'
            ? h('div', { style: { ...S.row, marginTop: '10px' } },
                h('span', { style: S.muted }, item.result || '已完成'),
                item.undo ? h('button', { style: S.btn, disabled: busy === item.id, onClick: () => undo(item.id) }, '撤销') : null,
              )
            : null,
      )

      return h('div', null,
        h('div', { style: S.card },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
            h('div', null,
              h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, '自主行为 · L1 观察 / L2 可逆动作'),
              h('div', { style: S.muted }, '只做记录、提醒和整理，全部要你点头；不会删文件、改设置、执行 shell 或对外发送。'),
            ),
            h('label', { style: { ...S.row, cursor: 'pointer' } },
              h('input', { type: 'checkbox', checked: enabled, onChange: (event) => toggle(event.target.checked) }),
              h('span', { style: { fontSize: '12px' } }, enabled ? '已开启' : '已关闭'),
            ),
          ),
          data?.stats ? h('div', { style: { ...S.chips, marginTop: '10px' } },
            h('span', { style: S.chip }, `待确认 ${data.stats.pending ?? pending.length}`),
            h('span', { style: S.chip }, `已完成 ${data.stats.done ?? 0}`),
            h('span', { style: S.chip }, `撤销 ${data.stats.undone ?? 0}`),
            h('span', { style: S.chip }, `拒绝 ${data.stats.rejected ?? 0}`),
            h('span', { style: S.chip }, `失败 ${data.stats.failed ?? 0}`),
          ) : null,
        ),
        h('div', { style: { ...S.card, marginTop: '10px' } },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' } },
            h('div', null,
              h('div', { style: { fontWeight: 700, marginBottom: '4px' } }, '主动观察 · L3-A'),
              h('div', { style: S.muted }, '只按确定性规则判断要不要说一句；不写用户数据、不调工具。'),
            ),
            h('select', {
              value: autonomy?.level || config.autonomyLevel || 'observe',
              onChange: (event) => setLevel(event.target.value),
              style: { background: C.input, color: C.text, border: '1px solid ' + C.border, borderRadius: '8px', padding: '6px 8px', fontSize: '12px' },
            },
              h('option', { value: 'off' }, '关闭（off）'),
              h('option', { value: 'observe' }, '只观察（observe）'),
              h('option', { value: 'assist' }, '允许主动说（assist）'),
            ),
          ),
          h('div', { style: { ...S.chips, marginTop: '10px' } },
            h('span', { style: S.chip }, `今天主动 ${autonomy?.spokenToday ?? 0}/${autonomy?.dailyMax ?? 3}`),
            h('span', { style: S.chip }, `被忽略 ${autonomy?.ignoredToday ?? 0}`),
            autonomy?.degraded ? h('span', { style: { ...S.chip, color: C.danger } }, '今天已降级') : null,
            h('span', { style: S.chip }, `静默 ${autonomy?.quiet?.start || '23:30'}–${autonomy?.quiet?.end || '08:00'}`),
            h('span', { style: S.chip }, `冷却 ${autonomy?.cooldownH ?? 6}h`),
          ),
          (Array.isArray(autonomy?.decisions) ? autonomy.decisions : []).length === 0
            ? h('div', { style: { ...S.muted, marginTop: '8px' } }, '还没有主动决策记录。')
            : h('div', { style: { marginTop: '8px' } },
                ...(autonomy.decisions || []).slice(0, 8).map((row, index) => h('div', {
                  key: `${row.ts}-${index}`,
                  style: { display: 'flex', gap: '8px', padding: '4px 0', fontSize: '12px', borderTop: index === 0 ? 'none' : '1px solid rgba(120,140,200,.12)' },
                },
                  h('span', { style: { ...S.muted, minWidth: '132px' } }, fmtTime(row.ts)),
                  h('span', { style: { minWidth: '70px', fontWeight: 600 } }, row.decision || ''),
                  h('span', { style: { color: C.text2 } }, [row.trigger, row.text || row.reason].filter(Boolean).join(' · ')),
                ))),
        ),
        note ? h('div', { style: { ...S.card, color: C.danger } }, note) : null,
        h('div', { style: { fontSize: '13px', fontWeight: 700, margin: '14px 0 8px' } }, '等你确认'),
        pending.length === 0
          ? h('div', { style: S.card }, h('div', { style: S.muted }, '没有待确认的事。对它说「记一下……」或「提醒我……」试试。'))
          : pending.map(card),
        h('div', { style: { fontSize: '13px', fontWeight: 700, margin: '14px 0 8px' } }, '历史'),
        history.length === 0
          ? h('div', { style: S.card }, h('div', { style: S.muted }, '还没有执行记录。'))
          : history.map(card),
        h('div', { style: { fontSize: '13px', fontWeight: 700, margin: '14px 0 8px' } }, '审计记录'),
        (Array.isArray(data?.audit) ? data.audit : []).length === 0
          ? h('div', { style: S.card }, h('div', { style: S.muted }, '暂无审计记录。'))
          : h('div', { style: S.card },
              ...(data.audit || []).slice(0, 20).map((row, index) => h('div', {
                key: `${row.ts}-${index}`,
                style: { display: 'flex', gap: '8px', padding: '4px 0', fontSize: '12px', borderTop: index === 0 ? 'none' : '1px solid rgba(120,140,200,.12)' },
              },
                h('span', { style: { ...S.muted, minWidth: '132px' } }, fmtTime(row.ts)),
                h('span', { style: { minWidth: '64px', fontWeight: 600 } }, row.event || ''),
                h('span', { style: { color: C.text2, overflow: 'hidden', textOverflow: 'ellipsis' } },
                  [row.kind, row.title, row.result, row.error].filter(Boolean).join(' · ')),
              ))),
      )
    }

    function Page() {
      const [tab, setTab] = useState('graph')
      const [overview, setOverview] = useState(null)
      const [facts, setFacts] = useState([])
      const [persona, setPersona] = useState(null)
      const [guard, setGuard] = useState([])
      const [activity, setActivity] = useState([])
      const [selfData, setSelfData] = useState(null)
      const [loading, setLoading] = useState(true)
      const [error, setError] = useState('')
      const [query, setQuery] = useState('')
      const [showArchived, setShowArchived] = useState(false)
      const [selected, setSelected] = useState(null)

      const load = useCallback(async (options = {}) => {
        if (!options.silent) setLoading(true)
        setError('')
        try {
          const [o, f, p, a, sf] = await Promise.all([
            api('/overview'),
            api('/facts?archived=1'),
            api('/persona'),
            api('/activity'),
            api('/self?limit=60').catch(() => null),
          ])
          setOverview(o)
          setFacts(Array.isArray(f.facts) ? f.facts : [])
          setPersona(p.persona || null)
          setGuard(Array.isArray(p.guard) ? p.guard : [])
          setActivity(Array.isArray(a.lines) ? a.lines : [])
          setSelfData(sf)
          setSelected((current) => {
            if (!current) return null
            const still = (f.facts || []).find((fact) => fact.id === current.id)
            return still || null
          })
        } catch (err) {
          setError(String(err?.message || err))
        } finally {
          if (!options.silent) setLoading(false)
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const stats = overview?.stats || {}
      const petName = overview?.persona?.petName || '桌宠'
      const registered = Array.isArray(overview?.provider?.external) && overview.provider.external.includes('dsh-pet-persona')
      const archivedCount = facts.filter((fact) => fact.status === 'archived').length
      const activeFacts = facts.filter((fact) => fact.status !== 'archived')

      const tabs = [
        ['graph', '记忆脑图'],
        ['list', '事实列表'],
        ['persona', '人格 × 记忆'],
        ['voice', '语音'],
        ['self', '它自己'],
        ['agency', '自主'],
        ['settings', '设置'],
      ]

      return h('div', { style: S.page },
        h('style', null,
          '.ppx-btn:hover{background:rgba(120,140,200,.14)!important}\n' +
          '.ppx-tab:hover{color:var(--dsw-alias-label-primary,#e8e8ee)!important}\n' +
          '.ppx-card input[type=checkbox]{accent-color:#6aa9ff;cursor:pointer}\n' +
          '.ppx-scroll::-webkit-scrollbar{width:8px;height:8px}\n' +
          '.ppx-scroll::-webkit-scrollbar-thumb{background:rgba(120,140,200,.25);border-radius:8px}'),
        h('div', { style: S.header },
          h('div', null,
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' } },
              h('span', { style: { fontSize: '18px' } }, '🐾'),
              h('div', { style: S.title }, `${petName}的记忆`),
            ),
            h('div', { style: S.chips },
              h('span', { style: S.chip }, `活跃 ${stats.active ?? activeFacts.length}`),
              h('span', { style: S.chip }, `归档 ${Math.max(stats.archived ?? 0, archivedCount)}`),
              h('span', { style: S.chip }, `置顶 ${stats.pinned ?? 0}`),
              h('span', { style: registered ? S.chipHot : S.chip }, registered ? '记忆 provider 已注册' : '未注册（仅查看）'),
              stats.readOnly ? h('span', { style: S.chip }, '只读模式：数据版本较新') : null,
            ),
          ),
          h('div', { style: S.row },
            h('button', { type: 'button', className: 'ppx-btn', style: S.btn, onClick: () => void load() }, loading ? '刷新中…' : '刷新'),
          ),
        ),
        h('div', { style: S.lead },
          '这里能看到它记住了什么、这些记忆怎么拼进它的人格提示词。人格本身由 dsh-pet 管理，本页只读不改；记忆会随对话自然更新。'),
        error
          ? h('div', { style: { ...S.card, borderColor: '#ff6b7a66' } },
            h('div', { style: { ...S.hint, color: C.danger, marginBottom: '6px' } }, '读取失败：'),
            h('div', { style: S.error }, error),
            h('div', { ...{ style: { ...S.hint, marginTop: '8px' } } },
              '如果提示 404，说明宿主里的插件还是旧构建：刷新页面前先在插件管理里把 dsh-pet-persona 关一次再打开。'),
          )
          : null,
        h('div', { style: S.tabs },
          tabs.map(([key, label]) => h('button', {
            key, type: 'button', className: 'ppx-tab', style: S.tab(tab === key), onClick: () => setTab(key),
          }, label)),
        ),
        loading && !overview
          ? h('div', { style: { ...S.card, textAlign: 'center', color: C.faint, fontSize: '12px', padding: '40px' } }, '正在读取记忆…')
          : null,
        !loading && overview && tab === 'graph'
          ? h('div', null,
            h('div', { style: S.statGrid },
              h('div', { style: S.stat }, h('div', { style: S.statNum }, String(stats.active ?? 0)), h('div', { style: S.statLabel }, '活跃事实')),
              h('div', { style: S.stat }, h('div', { style: S.statNum }, String(stats.archived ?? 0)), h('div', { style: S.statLabel }, '归档事实')),
              h('div', { style: S.stat }, h('div', { style: S.statNum }, String(stats.pinned ?? 0)), h('div', { style: S.statLabel }, '置顶')),
              h('div', { style: S.stat }, h('div', { style: S.statNum }, String(stats.keys ?? 0)), h('div', { style: S.statLabel }, '事实键')),
            ),
            h('div', { style: { ...S.row, marginBottom: '10px', justifyContent: 'space-between' } },
              h('input', {
                value: query, onChange: (event) => setQuery(event.target.value),
                placeholder: '搜索记忆（值 / 键 / 原话）…', style: { ...S.input, flex: '1 1 240px' },
              }),
              h('label', { style: { ...S.row, ...S.hint, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: showArchived, onChange: (event) => setShowArchived(event.target.checked) }),
                '显示归档',
              ),
            ),
            h(MemoryGraph, {
              facts, query, showArchived, selected, onSelect: setSelected, petName,
            }),
            h(Legend),
            overview?.lastUpdatedAt
              ? h('div', { style: { ...S.hint, marginBottom: '10px' } }, `最近更新：${fmtTime(overview.lastUpdatedAt)} · 数据目录：${overview.dataDir}`)
              : null,
            activity.length > 0
              ? h('div', { style: S.card },
                h('div', { style: { fontSize: '12px', fontWeight: 700, marginBottom: '6px' } }, '最近活动'),
                h('div', { style: { ...S.mono, color: C.sub } }, activity.slice(0, 6).join('\n')),
              )
              : null,
          )
          : null,
        !loading && overview && tab === 'list'
          ? h('div', null,
            h('div', { style: { ...S.row, marginBottom: '10px', justifyContent: 'space-between' } },
              h('input', {
                value: query, onChange: (event) => setQuery(event.target.value),
                placeholder: '搜索记忆…', style: { ...S.input, flex: '1 1 240px' },
              }),
              h('label', { style: { ...S.row, ...S.hint, cursor: 'pointer' } },
                h('input', { type: 'checkbox', checked: showArchived, onChange: (event) => setShowArchived(event.target.checked) }),
                '显示归档',
              ),
            ),
            h(FactList, { facts, query, showArchived, selected, onSelect: setSelected }),
            selected ? h(FactDetail, { fact: selected, onClose: () => setSelected(null) }) : null,
          )
          : null,
        !loading && overview && tab === 'persona'
          ? h(PersonaTab, { persona, guard, activity })
          : null,
        !loading && overview && tab === 'voice'
          ? h(VoiceTab, {
            overview,
            onSaved: (config) => setOverview((prev) => (prev ? { ...prev, config } : prev)),
          })
          : null,
        !loading && overview && tab === 'self'
          ? h(SelfTab, {
            data: selfData,
            petName,
            config: overview.config,
            onSaved: (config) => setOverview((prev) => (prev ? { ...prev, config } : prev)),
          })
          : null,
        !loading && overview && tab === 'agency'
          ? h(AgencyTab, {
            overview,
            onChanged: () => load({ silent: true }),
          })
          : null,
        !loading && overview && tab === 'settings'
          ? h(SettingsTab, {
            overview,
            onSaved: (config) => setOverview((prev) => (prev ? { ...prev, config } : prev)),
          })
          : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'dsh-pet-persona',
          order: 31,
          label: () => '桌宠记忆',
        }, Page))
      },
    }
  },
})
