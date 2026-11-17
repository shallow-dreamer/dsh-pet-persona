#!/usr/bin/env node
/**
 * 只读检查工具：看真实数据目录里记了什么，以及某个问题会注入什么记忆块。
 *
 *   node scripts/inspect.mjs                     # 列出当前活跃事实
 *   node scripts/inspect.mjs 我叫什么名字          # 模拟一次 recall，打印将被注入的块
 *   node scripts/inspect.mjs --pet default 我叫什么 # 指定 petId
 *
 * 不写 facts.jsonl、不调用模型、不启动宿主。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { resolveDataDir } from '../index.js'
import { FactStore } from '../lib/facts.js'
import { createRecall } from '../lib/recall.js'
import { loadSynonymIndex } from '../lib/synonyms.js'

const noop = { debug() {}, info() {}, warn() {}, error() {}, flush() {}, dispose() {} }

const args = process.argv.slice(2)
let petId = 'default'
const query = []
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--pet' && args[i + 1]) {
    petId = args[i + 1]
    i += 1
  } else {
    query.push(args[i])
  }
}

const dir = resolveDataDir()
const file = join(dir, 'facts.jsonl')
console.log(`数据目录: ${dir}`)
if (!existsSync(file)) {
  console.error('facts.jsonl 不存在：插件还没在宿主里加载过，或 enabled=false。')
  process.exit(1)
}

const store = new FactStore({ dir, maxFacts: 500, log: noop })
store.loadSync()
const active = store.active
const archived = store.rows.length - active.length
console.log(`活跃事实: ${active.length} 条（历史归档 ${archived} 条，全部 ${store.rows.length} 条）\n`)

if (active.length === 0) {
  console.log('（暂无事实：先对桌宠说「记住，我叫阿岚」，再回来跑一次。）')
  process.exit(0)
}

if (query.length === 0) {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n)
  console.log(`${pad('type', 11)}${pad('key', 14)}${pad('value', 20)}imp pin hits  created`)
  for (const fact of [...active].sort((a, b) => String(a.key).localeCompare(String(b.key)))) {
    console.log(
      pad(fact.type, 11) +
        pad(fact.key, 14) +
        pad(fact.value, 20) +
        `${fact.importance}   ${fact.pinned ? '★' : ' '}   ${String(fact.hits ?? 0).padEnd(4)}  ${fact.createdAt}`,
    )
  }
  process.exit(0)
}

const text = query.join(' ')
const engine = createRecall({ synonyms: loadSynonymIndex(noop), log: noop })
const result = engine.recall({ petId, system: '', history: [], userText: text }, active, {
  budgetChars: 1200,
  petId,
})
console.log(`问题: ${text}`)
if (!result.block) {
  console.log('结果: undefined（本轮不会注入任何记忆，system 保持原样）')
  process.exit(0)
}
console.log(`命中: ${result.hits.join(', ')}  |  耗时 ${result.elapsedMs}ms  |  ${result.block.length} 字符\n`)
console.log('--- 将追加到 system 的块 ---')
console.log(result.block)
console.log('--- 宿主实际得到的 system 形如 ---')
console.log(`<原 system>\n\n${result.block}`)
