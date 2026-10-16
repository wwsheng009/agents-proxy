// I: tools alone? minimal body + real tools + stream:true = 200 (H). J: without stream?
// K: with tools but ONE tool only? This maps the full rule surface for the compat layer.
const http = require('node:https')
const fs = require('node:fs')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)

function send(tag, payload) {
  return new Promise(resolve => {
    const hdrs = { ...agent.headers }
    delete hdrs['accept-encoding']; delete hdrs['host']
    hdrs['content-length'] = Buffer.byteLength(payload)
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 60)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

;(async () => {
  await send('J tools + stream:false', JSON.stringify({
    model: full.model,
    messages: [{ role: 'user', content: 'Say ok' }],
    tools: full.tools,
    stream: false,
  }))

  await send('K 1 tool + stream:true ', JSON.stringify({
    model: full.model,
    messages: [{ role: 'user', content: 'Say ok' }],
    tools: [full.tools[0]],
    stream: true,
  }))

  await send('L 2 tools + stream:true', JSON.stringify({
    model: full.model,
    messages: [{ role: 'user', content: 'Say ok' }],
    tools: full.tools.slice(0, 2),
    stream: true,
  }))
})()
