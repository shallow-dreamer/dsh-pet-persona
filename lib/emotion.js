/**
 * 轻量多标签情绪分析：一句话里可以同时有多种情绪，不把心情压成单一好坏。
 * 只做规则匹配，不调用模型；用于自我记忆的事件标签与现算心情。
 */

export const EMOTION_LABELS = {
  joy: '开心',
  affection: '亲近',
  sadness: '难过',
  anger: '生气',
  anxiety: '担心',
  tiredness: '疲惫',
  surprise: '惊讶',
  calm: '平静',
}

export const EMOTION_COLORS = {
  joy: '#59d18b',
  affection: '#f08ab0',
  sadness: '#6aa9ff',
  anger: '#ff6b7a',
  anxiety: '#b98bff',
  tiredness: '#e8c15a',
  surprise: '#ff9f6b',
  calm: '#9aa4b2',
}

const LEXICON = [
  {
    key: 'joy',
    weight: 0.46,
    re: /开心|高兴|快乐|好耶|太棒|真棒|棒|喜欢|可爱|哈哈|嘻嘻|好玩|期待|惊喜|满足|幸福|不错|真好|甜|好舒服|终于|来啦|想吃/g,
  },
  {
    key: 'affection',
    weight: 0.42,
    re: /抱抱|贴贴|想你|爱你|亲亲|摸摸|蹭蹭|陪着你|陪你|温柔|好乖|乖|心疼|舍不得你/g,
  },
  {
    key: 'sadness',
    weight: 0.48,
    re: /难过|伤心|哭|委屈|失落|低落|沮丧|呜|唉|心里空|想哭|不舍|呜呜|舍不得/g,
  },
  {
    key: 'anger',
    weight: 0.46,
    re: /生气|讨厌|烦|哼|不理你|滚|凶|过分|气死|火大|别烦|不理我|生气啦|坏|打你|咬你/g,
  },
  {
    key: 'anxiety',
    weight: 0.44,
    re: /担心|紧张|害怕|怕|焦虑|不安|怎么办|慌|心里没底|忐忑/g,
  },
  {
    key: 'tiredness',
    weight: 0.5,
    re: /累|困|熬夜|没睡|疲惫|辛苦|撑不住|好困|睡不够|乏|没精神|睡着|想睡|睡觉|睡啦/g,
  },
  {
    key: 'surprise',
    weight: 0.36,
    re: /诶|欸|咦|哇|居然|真的吗|没想到|惊|竟然/g,
  },
  {
    key: 'calm',
    weight: 0.28,
    re: /平静|安静|还好|没事|放松|安心|慢慢来|不急/g,
  },
]

const NEG_JOY = /不开心|不高兴|不快乐|没意思|不好玩/g
const NEG_TIRED = /不累|不困|精神很好/g
const NEG_ANGER = /不生气|不讨厌|不烦/g

function hits(text, re) {
  let count = 0
  let match
  re.lastIndex = 0
  while ((match = re.exec(text)) !== null) {
    const before = text.slice(Math.max(0, match.index - 3), match.index)
    if (!/[不没别无]$/.test(before)) count += 1
    if (match[0].length === 0) re.lastIndex += 1
  }
  return count
}

/**
 * @param {string} text
 * @param {string} replyText
 */
export function analyzeEmotion(text = '', replyText = '') {
  const all = `${text}\n${replyText}`
  const scores = { joy: 0, affection: 0, sadness: 0, anger: 0, anxiety: 0, tiredness: 0, surprise: 0, calm: 0 }

  for (const item of LEXICON) {
    const n = hits(all, item.re)
    if (n > 0) scores[item.key] = Math.min(1, n * item.weight)
  }
  if (NEG_JOY.test(all)) scores.sadness = Math.min(1, scores.sadness + 0.35)
  if (NEG_TIRED.test(all)) scores.tiredness = Math.max(0, scores.tiredness - 0.4)
  if (NEG_ANGER.test(all)) {
    scores.anger = Math.max(0, scores.anger - 0.4)
    scores.calm = Math.min(1, scores.calm + 0.3)
  }

  const max = Math.max(...Object.values(scores))
  if (max < 0.3) scores.calm = Math.min(1, Math.max(scores.calm, 0.55))

  const list = Object.entries(scores)
    .filter(([, score]) => score > 0.08)
    .map(([key, score]) => ({ key, label: EMOTION_LABELS[key], color: EMOTION_COLORS[key], score: Number(score.toFixed(3)) }))
    .sort((a, b) => b.score - a.score)

  const primary = list[0] || { key: 'calm', label: '平静', color: EMOTION_COLORS.calm, score: 0.55 }
  const secondary = list[1] && list[1].score >= Math.max(0.18, primary.score * 0.55) ? list[1] : null

  const positive = scores.joy + scores.affection * 0.9 + scores.calm * 0.35 + scores.surprise * 0.15
  const negative = scores.sadness + scores.anger * 0.9 + scores.anxiety * 0.9 + scores.tiredness * 0.75
  const valence = Math.max(-1, Math.min(1, positive - negative))
  const energy = Math.max(0, Math.min(
    1,
    0.5 + scores.joy * 0.3 + scores.anger * 0.35 + scores.anxiety * 0.25
      + scores.surprise * 0.2 - scores.tiredness * 0.3 - scores.sadness * 0.15,
  ))

  return {
    scores,
    emotions: list.slice(0, 4),
    primary: primary.key,
    secondary: secondary?.key || '',
    valence: Number(valence.toFixed(3)),
    energy: Number(energy.toFixed(3)),
    mixText: blendLabel(primary, secondary),
    tags: list.slice(0, 3).map((item) => item.label),
  }
}

export function blendLabel(primary, secondary) {
  if (!primary) return '平静'
  if (!secondary) return primary.label
  const pair = `${primary.key}+${secondary.key}`
  const special = {
    'joy+tiredness': '开心但有点累',
    'tiredness+joy': '累了但心里开心',
    'anger+sadness': '又气又委屈',
    'sadness+anger': '委屈又有点生气',
    'sadness+affection': '难过又有点想被陪',
    'affection+sadness': '想贴贴，又有点难过',
    'joy+anxiety': '开心又有点担心',
    'anxiety+joy': '担心里带着期待',
    'anxiety+tiredness': '担心得有点累',
    'tiredness+anxiety': '累又有点不安',
    'surprise+joy': '又惊又喜',
    'joy+surprise': '开心得有点意外',
    'anger+tiredness': '烦得有点累',
    'tiredness+anger': '累到有点烦',
  }
  return special[pair] || `${primary.label}里带点${secondary.label}`
}
