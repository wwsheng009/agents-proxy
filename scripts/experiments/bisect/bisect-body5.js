// N: find exact threshold between 4 (403) and 8 (200): test 5, 6, 7.
// Also O: does an ARBITRARY (non-opencode) tool set work if large enough? (earlier 1.x era
// said 46 foreign tools -> 403; retest on new endpoint with 8 foreign tools)
const http = require('node:https')
const fs = require('node:fs')
const crypto = require('node:crypto')

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

const foreignTool = (name) => ({
  type: 'function',
  function: {
    name,
    description: `Foreign tool ${name}`,
    parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  },
})

;(async () => {
  for (const n of [5, 6, 7]) {
    const body = JSON.stringify({ model: full.model, messages: [{ role: 'user', content: 'Say ok' }], tools: full.tools.slice(0, n), stream: true })
    await send(`N ${n} real tools`, body)
  }
  // O: 8 foreign tools
  const foreign = Array.from({ length: 8 }, (_, i) => foreignTool(`foreign_tool_${i}`))
  const body = JSON.stringify({ model: full.model, messages: [{ role: 'user', content: 'Say ok' }], tools: foreign, stream: true })
  await send('O 8 foreign tools', body)
})()
