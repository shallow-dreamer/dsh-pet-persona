/**
 * 插件日志：内存缓冲 + 定时落盘，recall 期间只 push 数组（不触发 IO）。
 *
 * 桌面版 DSH 没有控制台，ctx.logger 只写 stdout 会丢；所以同时写 `<dataDir>/persona.log`。
 * 单文件超过 512KB 轮转成 `.1`，不无限增长。
 * @module dsh-pet-persona/lib/log
 */

import { appendFile, mkdir, rename, stat } from 'node:fs/promises'
import { join } from 'node:path'

const MAX_BYTES = 512 * 1024

/**
 * @param {object} options
 * @param {string} options.dir 日志目录
 * @param {(level: string, msg: string) => void} [options.sink] 额外出口（ctx.logger）
 * @param {number} [options.flushMs]
 * @param {() => number} [options.now]
 */
export function createLogger({ dir, sink, flushMs = 1000, now = Date.now } = {}) {
  const file = dir ? join(dir, 'persona.log') : ''
  /** @type {string[]} */
  let buffer = []
  let timer = null
  let flushing = null
  let closed = false

  const stamp = () => {
    const d = new Date(now())
    const pad = (n, w = 2) => String(n).padStart(w, '0')
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
  }

  const record = (level, msg) => {
    const line = `${stamp()} [${level}] ${msg}`
    buffer.push(line)
    // 缓冲上限：recall 高频写日志也不吃内存；丢最旧的
    if (buffer.length > 500) buffer.splice(0, buffer.length - 500)
    try {
      sink?.(level, msg)
    } catch {
      /* ctx.logger 抛错不能影响插件 */
    }
    schedule()
  }

  const schedule = () => {
    if (closed || timer || !file) return
    timer = setTimeout(() => {
      timer = null
      void flush()
    }, flushMs)
    timer.unref?.()
  }

  const rotateIfNeeded = async () => {
    if (!file) return
    try {
      const info = await stat(file)
      if (info.size > MAX_BYTES) await rename(file, `${file}.1`)
    } catch {
      /* 文件不存在 / 改名失败：继续追加即可 */
    }
  }

  const flush = async () => {
    if (flushing) return flushing
    if (!file || buffer.length === 0) return
    const lines = buffer
    buffer = []
    flushing = (async () => {
      try {
        await mkdir(dir, { recursive: true })
        await rotateIfNeeded()
        await appendFile(file, lines.join('\n') + '\n', 'utf8')
      } catch {
        /* 日志失败不能中断插件 */
      } finally {
        flushing = null
      }
    })()
    return flushing
  }

  return {
    file,
    debug: (msg) => record('debug', msg),
    info: (msg) => record('info', msg),
    warn: (msg) => record('warn', msg),
    error: (msg) => record('error', msg),
    flush,
    async dispose() {
      closed = true
      if (timer) clearTimeout(timer)
      timer = null
      await flush()
    },
  }
}
