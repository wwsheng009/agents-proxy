// Bisect header diffs: compat sent traceparent/b3 + accept:event-stream + msg_ id.
// Direct-200 test had none of those. Test each addition on a fresh minted session.
const http = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')

const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
let lt = 0, c = 0
function desc(ts = Date.now()) {
  if (ts !== lt) { lt = ts; c = 0 }
  c++
  const cur = BigInt(ts) * 0x1000n + BigInt(c)
  const v = ~cur
  const t = Array.from({ length: 6 }, (_, i) => Number((v >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('')
  const b = crypto.getRandomValues(new Uint8Array(14))
  return t + Array.from(b, x => chars[x % 62]).join('')
}
function msg() {
  const cur = BigInt(Date.now()) * 0x1000n + BigInt(1)
  const t = Array.from({ length: 6 }, (_, i) => Number((cur >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, '0')).join('')
  const b = crypto.getRandomValues(new Uint8Array(14))
  return 'msg_' + t + Array.from(b, x => chars[x % 62]).join('')
}

const log = fs.readFileSync('clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const read = JSON.parse(agent.body.preview).tools.find(t => t.function.name === 'read')
const payload = JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'Say ok' }], tools: [read], stream: true })

function mk(tag, extra) {
  const ses = 'ses_' + desc()
  return new Promise(res => {
    const h = {
      'authorization': 'Bearer public', 'content-type': 'application/json',
      'user-agent': agent.headers['user-agent'], 'x-opencode-client': 'cli',
      'x-opencode-project': 'global',
      'x-opencode-session': ses, 'x-opencode-session-id': ses,
      'x-session-affinity': ses, 'x-session-id': ses,
      'accept': '*/*', 'content-length': Buffer.byteLength(payload),
      ...extra,
    }
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: h }, rp => {
      let d = ''
      rp.on('data', x => d += x)
      rp.on('end', () => { console.log(`${tag} -> ${rp.statusCode}`); res() })
    })
    r.on('error', e => { console.log('ERR', e.message); res() })
    r.end(payload)
  })
}

;(async () => {
  await mk('1 bare                    ', {})
  await mk('2 +msg_ request id        ', { 'x-opencode-request': msg() })
  await mk('3 +traceparent/b3         ', (() => { const t = crypto.randomBytes(16).toString('hex'); const s = crypto.randomBytes(8).toString('hex'); return { traceparent: `00-${t}-${s}-01`, b3: `${t}-${s}-1-${s}` } })())
  await mk('4 accept event-stream     ', { 'accept': 'text/event-stream' })
})()
