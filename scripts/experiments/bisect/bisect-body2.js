// G: bisect further - shrunk body WITHOUT tools. If G=200, tools don't matter either;
// the only body requirement is streaming shape or even less. If G=403, tools are required.
const http = require('node:https')
const fs = require('node:fs')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)

function mkBody(withTools) {
  const b = {
    model: full.model,
    messages: [{ role: 'user', content: 'Say ok' }],
    stream: true,
  }
  if (withTools) b.tools = full.tools
  return JSON.stringify(b)
}

function send(tag, hdrs, payload) {
  return new Promise(resolve => {
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 70)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

;(async () => {
  const base = { ...agent.headers }
  delete base['accept-encoding']; delete base['host']; delete base['content-length']

  const g = mkBody(false)
  base['content-length'] = Buffer.byteLength(g)
  await send('G validated-ses + minimal body + stream:true, no tools', base, g)

  const h = mkBody(true)
  base['content-length'] = Buffer.byteLength(h)
  await send('H validated-ses + minimal body + stream + real tools  ', base, h)
})()
