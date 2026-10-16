// Verify /v1/models, /inference/v1/models, /v1beta/models all return model lists through the proxy.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'

fs.rmSync('E:\\projects\\ai\\opencode-proxy\\fresh-capture.log', { force: true })
const proxy = spawn('node', ['proxy.js'], {
  cwd: 'E:\\projects\\ai\\opencode-proxy',
  env: { ...process.env, PORT: '8796', ZEN_COMPAT: 'true', LOG_FILE: 'E:\\projects\\ai\\opencode-proxy\\fresh-capture.log' },
  stdio: 'ignore',
})
await sleep(1200)

for (const path of ['/v1/models', '/inference/v1/models', '/v1beta/models']) {
  try {
    const res = await fetch(`http://127.0.0.1:8796${path}`, { headers: { authorization: 'Bearer anything' } })
    const text = await res.text()
    let n = 0
    try { n = JSON.parse(text).data.length } catch {}
    console.log(`${path} -> ${res.status}  models=${n}`)
  } catch (e) {
    console.log(`${path} -> ERR ${e.message}`)
  }
}
proxy.kill()
