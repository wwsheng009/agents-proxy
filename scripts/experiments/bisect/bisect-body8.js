// U: 'read' + foreign tools; V: read with mutated schema (to test exact-match); W: read + stream:false
const http = require('node:https')
const fs = require('node:fs')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const full = JSON.parse(agent.body.preview)
const read = full.tools.find(t => (t.function?.name || t.name) === 'read')

function send(tag, payload, path = '/inference/v1/chat/completions') {
  return new Promise(resolve => {
    const hdrs = { ...agent.headers }
    delete hdrs['accept-encoding']; delete hdrs['host']
    hdrs['content-length'] = Buffer.byteLength(payload)
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path, headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 40)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

const foreignTool = (name) => ({
  type: 'function',
  function: { name, description: `x ${name}`, parameters: { type: 'object', properties: { i: { type: 'string' } }, required: ['i'] } },
})

;(async () => {
  // U: read + 4 foreign
  await send('U read + 4 foreign', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: [read, foreignTool('f0'), foreignTool('f1'), foreignTool('f2'), foreignTool('f3')],
    stream: true,
  }))

  // V: read with mutated description (schema not byte-exact)
  const mutated = JSON.parse(JSON.stringify(read))
  mutated.function.description = mutated.function.description + ' mutated'
  await send('V read mutated-description', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: [mutated], stream: true,
  }))

  // W: read exact + stream:false
  await send('W read exact + stream:false', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: [read], stream: false,
  }))
})()
