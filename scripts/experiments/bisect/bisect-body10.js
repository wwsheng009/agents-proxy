// Mint with the EXACT v2 algorithm (schema/identifier.ts) and test the full gate:
// minted-v2-session + read tool + stream:true on /inference/v1
const http = require('node:https')
const fs = require('node:fs')

const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lastTimestamp = 0
let counter = 0

function descending(timestamp = Date.now()) {
  if (timestamp !== lastTimestamp) { lastTimestamp = timestamp; counter = 0 }
  counter++
  const current = BigInt(timestamp) * 0x1000n + BigInt(counter)
  const value = ~current
  const time = Array.from({ length: 6 }, (_, i) =>
    Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('')
  const bytes = crypto.getRandomValues(new Uint8Array(26 - 12))
  return time + Array.from(bytes, b => chars[b % 62]).join('')
}

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)
const read = full.tools.find(t => (t.function?.name || t.name) === 'read')
const ses = 'ses_' + descending()

const payload = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'Say ok' }],
  tools: [read],
  stream: true,
})
const hdrs = {
  'authorization': 'Bearer public',
  'content-type': 'application/json',
  'user-agent': agent.headers['user-agent'],
  'x-opencode-client': 'cli',
  'x-opencode-project': agent.headers['x-opencode-project'],
  'x-opencode-session': ses,
  'x-opencode-session-id': ses,
  'x-session-affinity': ses,
  'x-session-id': ses,
  'accept': '*/*',
  'content-length': Buffer.byteLength(payload),
}
const req = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: hdrs }, res => {
  let d = ''
  res.on('data', c => d += c)
  res.on('end', () => { console.log('Y v2-minted ses + read + stream ->', res.statusCode); console.log(' ', d.slice(0, 120)) })
})
req.on('error', e => console.log('ERR', e.message))
req.end(payload)
