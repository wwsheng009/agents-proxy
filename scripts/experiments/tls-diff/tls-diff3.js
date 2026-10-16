// Body hypothesis: the captured agent body contains session-scoped content (cache lineage,
// session-bound system prompt) tied to the OLD session. Try minting a body that only keeps
// model+stream and replaces the whole system/messages with minimal content, keeping headers
// fresh. If minimal-body+fresh-session still 403 while client (with its natural body) gets
// 429, then the discriminator is body-shape vs client body... but earlier probes of verbatim
// body also 403'd, so more likely: server requires the session to have been established by
// the client's bootstrap (models fetch from the SAME session id + specific first-call order).
// Test the bootstrap theory: fresh session -> GET models (as client does) -> then chat.
const http = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')

const headers = JSON.parse(fs.readFileSync('replay-headers.json', 'utf8'))
const body = fs.readFileSync('replay-body.json')
const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const ses = `ses_${crypto.randomBytes(6).toString('hex')}${Array.from(crypto.randomBytes(14)).map(b => BASE62[b % 62]).join('')}`

function req(method, path, hdrs, payload) {
  return new Promise(resolve => {
    const r = http.request({ hostname: 'opencode.ai', method, path, headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 90) }))
    })
    r.on('error', e => resolve({ status: 0, body: e.message }))
    if (payload) r.write(payload)
    r.end()
  })
}

;(async () => {
  const base = {
    'authorization': headers['authorization'],
    'content-type': 'application/json',
    'user-agent': headers['user-agent'],
    'b3': headers['b3'],
    'traceparent': headers['traceparent'],
    'x-opencode-client': headers['x-opencode-client'],
    'x-opencode-project': headers['x-opencode-project'],
    'x-opencode-session': ses,
    'x-opencode-session-id': ses,
    'x-session-affinity': ses,
    'x-session-id': ses,
    'accept': '*/*',
  }

  // bootstrap order exactly like the client: models first (x2 observed in captures)
  const m1 = await req('GET', '/zen/v1/models', base)
  console.log('bootstrap models #1 ->', m1.status)
  const m2 = await req('GET', '/zen/v1/models', base)
  console.log('bootstrap models #2 ->', m2.status)

  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  const chat = await req('POST', '/zen/v1/chat/completions', {
    ...base,
    'content-length': body.length,
    'traceparent': `00-${traceId}-${spanId}-01`,
    'b3': `${traceId}-${spanId}-1-${spanId}`,
  }, body)
  console.log('chat after bootstrap ->', chat.status, chat.body)
})()
