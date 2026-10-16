// M: how many tools needed? H (all tools) = 200, L (2) = 403. Bisect count: 4, 8, 12.
// Also N: does the tools ARRAY need to be the full canonical set, or >=N of the real set?
const http = require('node:https')
const fs = require('node:fs')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)
console.log('client tools count:', full.tools.length, '| names:', full.tools.map(t => t.function?.name || t.name).join(','))

function send(tag, payload) {
  return new Promise(resolve => {
    const hdrs = { ...agent.headers }
    delete hdrs['accept-encoding']; delete hdrs['host']
    hdrs['content-length'] = Buffer.byteLength(payload)
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 50)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

;(async () => {
  const names = full.tools.map(t => t.function?.name || t.name)
  for (const n of [4, 8, 12, 16, full.tools.length - 1]) {
    if (n > full.tools.length) continue
    const body = JSON.stringify({
      model: full.model,
      messages: [{ role: 'user', content: 'Say ok' }],
      tools: full.tools.slice(0, n),
      stream: true,
    })
    await send(`M ${n} tools (${names.slice(0, n).join('+')})`, body)
  }
})()
