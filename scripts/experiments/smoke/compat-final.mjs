// THE definitive compat test: minimal third-party body via proxy compat mode on the NEW endpoint.
// This is what the 1.x proxy promised: minimal OpenAI body -> proxy fills everything -> 200.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

fs.rmSync('E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', { force: true })
const proxy = spawn('node', ['proxy.js'], {
  cwd: 'E:\\projects\\ai\\opencode-proxy',
  env: { ...process.env, PORT: '8795', ZEN_COMPAT: 'true', LOG_FILE: 'E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', LOG_BODY: 'true' },
  stdio: 'ignore',
})
await sleep(1200)

// minimal body, no system, no session headers, non-streaming — the exact 1.x promise
const body = JSON.stringify({ model: 'deepseek-v4.1-flash-free', messages: [{ role: 'user', content: 'Say ok' }] })
const res = await fetch('http://127.0.0.1:8795/inference/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': 'Bearer public' },
  body,
})
const text = await res.text()
console.log('compat minimal body /inference/v1 ->', res.status)
console.log(' ', text.slice(0, 300))

// also: old /zen/v1 path via compat (should now fail upstream — endpoint deprecated)
const res2 = await fetch('http://127.0.0.1:8795/zen/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'authorization': 'Bearer public' },
  body,
})
const t2 = await res2.text()
console.log('compat minimal body /zen/v1     ->', res2.status)
console.log(' ', t2.slice(0, 160))
proxy.kill()
