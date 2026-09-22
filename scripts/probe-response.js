'use strict'

// 抓取一次真实 API 响应的【完整响应头 + 完整 SSE 体】，
// 检查返回中是否携带费用/用量/限流信息（usage、cost、ping chunk、rate limit 头）。
// 复用 manifest 中第一条原始请求的 payload 与 header（单次免费额度调用）。
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const manifest = JSON.parse(fs.readFileSync('data/replay/manifest.json', 'utf8'))
const entry = manifest.find((m) => m.complete) // 第一条: 2467B 标题生成
// usage/cost 块在流【结束】时才注入：把 max_tokens 压小强制快速收流，body 其余不动
const payload = JSON.parse(fs.readFileSync(entry.payloadFile, 'utf8'))
payload.max_tokens = 64
const PAYLOAD_FILE = 'data/replay/probe-response-payload.json'
fs.writeFileSync(PAYLOAD_FILE, JSON.stringify(payload))
const URL = `https://opencode.ai${entry.path}`
const OUT_HEADERS = 'data/replay/resp-headers.txt'
const OUT_BODY = 'data/replay/resp-body.sse'

const SKIP = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])
const args = ['-sS', '-N', '-m', '60', '-D', OUT_HEADERS, '-o', OUT_BODY, '-X', 'POST', URL]
for (const [k, v] of Object.entries(entry.headers)) {
  if (SKIP.has(k.toLowerCase())) continue
  args.push('-H', `${k}: ${v}`)
}
args.push('--data-binary', `@${PAYLOAD_FILE}`)

const run = spawnSync('curl.exe', args, { encoding: 'utf8', timeout: 70000 })
if (run.stderr) process.stderr.write(run.stderr)

const headers = fs.readFileSync(OUT_HEADERS, 'utf8').trim()
const body = fs.readFileSync(OUT_BODY, 'utf8')

console.log('=== response headers ===')
console.log(headers)

console.log('\n=== header names ===')
const names = headers
  .split(/\r?\n/)
  .filter((l) => l.includes(':') && !l.startsWith('HTTP'))
  .map((l) => l.split(':')[0].toLowerCase())
console.log(names.join(', '))
console.log('rate-limit-ish:', names.filter((n) => /rate|limit|retry|quota/.test(n)).join(', ') || '(none)')

const events = body.split(/\n\n/).filter(Boolean)
console.log('\n=== sse stats ===')
console.log('events:', events.length, 'bytes:', Buffer.byteLength(body))

console.log('\n=== fields found ===')
console.log('usage in body:', /"usage"\s*:/.test(body))
console.log('cost in body:', /"cost"\s*:/.test(body))
console.log('ping event:', /type.{0,4}ping/.test(body))

console.log('\n=== last 4 events ===')
for (const e of events.slice(-4)) console.log(e.slice(0, 500))

console.log('\nsaved:', OUT_HEADERS, OUT_BODY)
