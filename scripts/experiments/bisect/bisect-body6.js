// P: threshold is between 4 and 5? Test exact: 5 worked. Test 4 again + check WHICH tools
// matter (maybe first-4 alphabetically missing a required one). Try last-4 and specific singles.
// Also Q: foreign tools MIXED with real (4 real + 4 foreign)?
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

const foreignTool = (name) => ({
  type: 'function',
  function: { name, description: `x ${name}`, parameters: { type: 'object', properties: { i: { type: 'string' } }, required: ['i'] } },
})

;(async () => {
  const t = full.tools
  // Q: 4 real + 4 foreign (mixed)
  await send('Q 4 real + 4 foreign', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: [...t.slice(0, 4), ...Array.from({ length: 4 }, (_, i) => foreignTool(`f${i}`))],
    stream: true,
  }))
  // R: 1 real tool alone (maybe a specific required tool e.g. 'shell')
  const shell = t.find(x => (x.function?.name || x.name) === 'shell')
  await send('R shell only', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: [shell], stream: true,
  }))
  // S: 5 real tools from the END (webfetch..execute)
  await send('S last-5 real tools', JSON.stringify({
    model: full.model, messages: [{ role: 'user', content: 'Say ok' }],
    tools: t.slice(-5), stream: true,
  }))
})()
