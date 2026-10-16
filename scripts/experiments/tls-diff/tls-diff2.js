// Everything-differential: replay with fully minted fresh session + fresh trace + fresh request id,
// keeping only UA/project/authorization/body from capture. If STILL 403 while client gets 429,
// the discriminator must be in the body or a stateful per-session server memory.
const http = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')

const headers = JSON.parse(fs.readFileSync('replay-headers.json', 'utf8'))
const body = fs.readFileSync('replay-body.json')

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
function mintSes() {
  return `ses_${crypto.randomBytes(6).toString('hex')}${Array.from(crypto.randomBytes(14)).map(b => BASE62[b % 62]).join('')}`
}
function mintMsg() {
  return `msg_${crypto.randomBytes(6).toString('hex')}${Array.from(crypto.randomBytes(14)).map(b => BASE62[b % 62]).join('')}`
}

const ses = mintSes()
const traceId = crypto.randomBytes(16).toString('hex')
const spanId = crypto.randomBytes(8).toString('hex')

function send(tag, hdrs, payload) {
  return new Promise(resolve => {
    const req = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/zen/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.status || res.statusCode, d.slice(0, 80)); resolve() })
    })
    req.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    req.end(payload)
  })
}

;(async () => {
  // A: captured session + captured trace (baseline)
  const a = { ...headers }
  delete a['accept-encoding']; delete a['host']; delete a['content-length']
  await send('A captured-session+trace     ', a, body)

  // B: fresh everything
  const b = { ...a }
  b['x-opencode-session'] = ses
  b['x-opencode-session-id'] = ses
  b['x-session-affinity'] = ses
  b['x-session-id'] = ses
  b['x-opencode-request'] = mintMsg()
  b['traceparent'] = `00-${traceId}-${spanId}-01`
  b['b3'] = `${traceId}-${spanId}-1-${spanId}`
  await send('B fresh-session+trace+msg   ', b, body)
})()
