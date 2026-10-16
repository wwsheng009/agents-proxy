// Capture the client's CURRENT failing request (should be 429) and compare its status vs
// a node replay of the same bytes in the same second. If client=429 and replay=403 with
// IDENTICAL bytes at the SAME moment, then there's a hard stateful discriminator we cannot
// see (e.g., first-seen TCP connection token, or per-connection attestation from the client
// binary). If replay also gets 429, then earlier 403s were stale-state artifacts and proxy
// might work when quota resets.
import { spawn, execSync } from 'node:child_process'
import http from 'node:https'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

const cfgPath = process.env.USERPROFILE + '\\.config\\opencode\\opencode.jsonc'
fs.writeFileSync(cfgPath, JSON.stringify({
  $schema: 'https://opencode.ai/config.json',
  provider: { opencode: { options: { baseURL: 'http://127.0.0.1:8791/zen/v1' } } },
}, null, 2))

fs.rmSync('E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', { force: true })
const proxy = spawn('node', ['proxy.js'], {
  cwd: 'E:\\projects\\ai\\opencode-proxy',
  env: { ...process.env, PORT: '8791', ZEN_COMPAT: 'false', LOG_FILE: 'E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', LOG_BODY: 'true' },
  stdio: 'ignore',
})
await sleep(1200)

console.log('live client via transparent proxy (expect 429 now)...')
try { execSync('opencode run --model opencode/big-pickle "Say ok"', { stdio: 'ignore', timeout: 120000 }); console.log('client: OK (200!)') }
catch { console.log('client: failed (429 expected)') }
await sleep(1000)

const lines = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', 'utf8').split('\n').filter(l => l.includes('"direction":"request"'))
const reqs = lines.map(l => JSON.parse(l))
const agent = reqs[reqs.length - 1]
console.log('client request path was:', agent.target)

// status the proxy saw for THIS request
const resLines = fs.readFileSync('E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', 'utf8').split('\n').filter(l => l.includes('"direction":"response"'))
const lastRes = JSON.parse(resLines[resLines.length - 1])
console.log('client got status:', lastRes.status)

// now replay same bytes node-direct within the same window
const hdrs = { ...agent.headers }
delete hdrs['accept-encoding']; delete hdrs['host']; delete hdrs['content-length']
const body = Buffer.from(agent.body.preview, 'utf8')
function send(hdrs, body) {
  return new Promise(resolve => {
    const r = http.request({ hostname: 'opencode.ai', method: 'POST', path: '/zen/v1/chat/completions', headers: hdrs }, res => {
      let d = ''
      res.on('data', c => d += c)
      res.on('end', () => { console.log('node replay same-second ->', res.statusCode, d.slice(0, 80)); resolve() })
    })
    r.on('error', e => { console.log('replay ERR', e.message); resolve() })
    r.end(body)
  })
}
await send(hdrs, body)
proxy.kill()
fs.writeFileSync(cfgPath, JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2))
