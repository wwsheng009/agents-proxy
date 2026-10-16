// T: single-tool probes from the winning prefix set {edit,glob,grep,question,read}
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
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 40)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

;(async () => {
  for (const name of ['edit', 'glob', 'grep', 'question', 'read']) {
    const tool = full.tools.find(t => (t.function?.name || t.name) === name)
    await send(`T ${name} only`, JSON.stringify({
      model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
      tools: [tool], stream: true,
    }))
  }
})()
