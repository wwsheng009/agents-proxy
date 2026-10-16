// X: minted session + read tool + stream:true. If 403, sessions must be registered by a
// real client bootstrap. If 200, the compat layer can fully mint sessions!
const http = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)
const read = full.tools.find(t => (t.function?.name || t.name) === 'read')

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ses = `ses_${crypto.randomBytes(6).toString('hex')}${Array.from(crypto.randomBytes(14)).map(b => BASE62[b % 62]).join('')}`

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
  res.on('end', () => { console.log('X minted-session + read + stream ->', res.statusCode); console.log(' ', d.slice(0, 150)) })
})
req.on('error', e => console.log('ERR', e.message))
req.end(payload)
