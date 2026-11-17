/**
 * 同义词表加载：随包发布的 `synonyms.json` 只在这里读一次（模块初始化 / 宿主 apply 期），
 * recall 调用期只用编译好的 Map，不碰磁盘。
 *
 * @module dsh-pet-persona/lib/synonyms
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSynonymIndex } from './util.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FILE = join(HERE, 'synonyms.json')

/** 包内兜底：synonyms.json 损坏时仍能用最小表，不让 recall 失效。 */
const FALLBACK = {
  猫: ['猫咪', '小猫', '猫猫'],
  咖啡: ['coffee', '拿铁', '美式'],
  生日: ['寿辰', '诞辰'],
  忌口: ['不吃', '不能吃', '过敏'],
  作息: ['睡觉', '起床', '熬夜', '睡眠'],
  称呼: ['叫我', '喊我', '名字'],
  工作: ['职业', '上班', '公司'],
  城市: ['住在', '所在地'],
}

/**
 * 读表并编译成 { syn, rev }；任何异常都回落到内置表。
 *
 * @param {{ warn?: (msg: string) => void }} [logger]
 * @returns {{ syn: Map<string, string[]>, rev: Map<string, string[]> }}
 */
export function loadSynonymIndex(logger) {
  try {
    const table = JSON.parse(readFileSync(FILE, 'utf8'))
    const index = buildSynonymIndex(table)
    if (index.syn.size > 0) return index
  } catch (error) {
    logger?.warn?.(`synonyms_load_failed ${error?.message ?? error}`)
  }
  return buildSynonymIndex(FALLBACK)
}
