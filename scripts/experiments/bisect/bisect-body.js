// E: validated session + FULL agent body but minimal system? No — bisect the body:
// take the validated 200 body, keep everything, only shrink messages to the minimal user msg.
// If E=200 => server doesn't inspect body content, only session+headers; then D's failure
// means 'accept' or some other header matters. If E=403 => full body (with tools/system)
// is required.
const http = require('node:https')
const fs = require('node:fs')

const log = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\clean-capture.log', 'utf8')
const reqs = log.split('\n').filter(l => l.includes('"direction":"request"')).map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
const ses = agent.headers['x-opencode-session']

const full = JSON.parse(agent.body.preview)
const shrunk = JSON.stringify({
  model: full.model,
  messages: [{ role: 'user', content: 'Say ok' }],
  tools: full.tools,
  stream: full.stream,
  stream_options: full.stream_options,
  max_completion_tokens: full.max_completion_tokens,
})

function send(tag, hdrs, payload) {
  return new Promise(resolve => {
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/inference/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log(tag, '->', res.statusCode, d.slice(0, 80)); resolve() })
    })
    r.on('error', e => { console.log(tag, 'ERR', e.message); resolve() })
    r.end(payload)
  })
}

;(async () => {
  const base = { ...agent.headers }
  delete base['accept-encoding']; delete base['host']; delete base['content-length']
  // E: validated session + full headers + shrunk body (no system, minimal user, real tools)
  await send('E validated-ses + shrunk body(no system)', base, shrunk)

  // F: validated session + full headers + full body again (control, should 200)
  const fullBody = Buffer.from(agent.body.preview, 'utf8')
  await send('F validated-ses + full body (control)  ', base, fullBody)
})()
