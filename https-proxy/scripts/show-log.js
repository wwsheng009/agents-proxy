'use strict'

// show-log.js —— 把 proxy.js 的 JSON Lines 日志按请求折叠成人可读的摘要。
//
// 用法（在 https-proxy 目录下）：
//   node scripts/show-log.js                  # 最近 20 条记录
//   node scripts/show-log.js -n 5             # 最近 5 条
//   node scripts/show-log.js --all            # 全部
//   node scripts/show-log.js --file D:\x.log  # 指定日志文件
//   node scripts/show-log.js --raw            # 原始 JSON 行
//
// 只读，不修改日志。

const fs = require('node:fs')
const path = require('node:path')

const args = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}

const logFile = opt('--file', path.join(__dirname, '..', 'proxy.log'))
const raw = args.includes('--raw')
const limit = args.includes('--all') ? Infinity : Number(opt('-n', 20))

if (!fs.existsSync(logFile)) {
  console.error(`日志文件不存在: ${logFile}`)
  process.exit(1)
}

const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
const slice = lines.slice(-limit)

if (raw) {
  console.log(slice.join('\n'))
  process.exit(0)
}

const HEADER_PICK = [
  'authorization', 'user-agent', 'x-api-key', 'cookie',
  'x-opencode-session', 'x-opencode-session-id', 'x-session-affinity', 'x-session-id',
  'x-opencode-client', 'x-opencode-project', 'x-opencode-request',
  'traceparent', 'b3', 'content-type', 'accept', 'host',
]

for (const line of slice) {
  let r
  try {
    r = JSON.parse(line)
  } catch {
    console.log(`[无法解析] ${line.slice(0, 120)}`)
    continue
  }

  const kind = r.direction || r.event
  const time = (r.time || '').replace('T', ' ').replace('Z', '')
  const id = r.id ? `${r.id} ` : ''

  if (r.event) {
    console.log(`${time} ${kind} ${JSON.stringify({ ...r, time: undefined, event: undefined })}`)
    continue
  }

  if (kind === 'request') {
    console.log(`\n${time} ${id}→ ${r.method} ${r.target}  body=${r.body?.bytes ?? 0}B`)
    const h = r.headers || {}
    for (const k of HEADER_PICK) {
      if (h[k] !== undefined) console.log(`    ${k}: ${String(h[k]).slice(0, 120)}`)
    }
    if (r.body?.preview) {
      console.log(`    body: ${String(r.body.preview).replace(/\s+/g, ' ').slice(0, 500)}`)
    } else if (r.body?.model !== undefined || r.body?.messages !== undefined) {
      console.log(`    body摘要: model=${r.body.model} stream=${r.body.stream} messages=${r.body.messages}`
        + ` tools=${(r.body.tools || []).join(',') || '-'}`)
    }
  } else if (kind === 'response') {
    const ct = r.headers?.['content-type'] || ''
    console.log(`${time} ${id}← ${r.status} ${ct}`)
  } else if (kind === 'response_body') {
    const p = r.body?.preview
    const size = r.body?.bytes ?? 0
    const flags = [r.aborted ? 'aborted' : '', r.body?.truncated ? 'truncated' : ''].filter(Boolean).join(' ')
    console.log(`${time} ${id}← body ${size}B ${flags}`)
    if (p) console.log(`    ${String(p).replace(/\s+/g, ' ').slice(0, 500)}`)
  } else if (kind === 'connect') {
    console.log(`${time} ${id}⇄ CONNECT ${r.host}:${r.port}（盲隧道，不解密）`)
  } else if (kind === 'error' || kind === 'connect_error') {
    console.log(`${time} ${id}✗ ${kind}: ${r.error}`)
  } else {
    console.log(`${time} ${id}${kind} ${JSON.stringify(r).slice(0, 200)}`)
  }
}

console.log(`\n共 ${lines.length} 条记录，显示最近 ${slice.length} 条（${logFile}）`)
