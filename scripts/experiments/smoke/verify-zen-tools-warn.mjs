// Verify the `zen_tools_missing` warn added to loadZenTools() (docs/过程与坑.md 坑 8).
// Three cases, each sending one real POST /inference/v1/chat/completions through proxy.js:
//   1. ZEN_TOOLS_FILE -> nonexistent  : expect 1 warn (reason=工具面文件不存在)        + upstream 403 (no read injected -> gate ② fails)
//   2. ZEN_TOOLS_FILE -> has read     : expect 0 warn                                 + forwarded tools[0].name === 'read' + upstream 200
//   3. ZEN_TOOLS_FILE -> no read entry: expect 1 warn (reason=canonical 工具面里没有 read 条目) + upstream 403
// The forwarded body is read back from LOG_FILE, so no packet capture is needed. 3 upstream calls total.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const REPO = 'E:\\projects\\ai\\opencode-proxy'
const TMP = path.join(os.tmpdir(), 'opencode-proxy-verify')
fs.mkdirSync(TMP, { recursive: true })

const readTool = () => ({
  type: 'function',
  function: {
    name: 'read',
    description: 'Read a file from the local filesystem.',
    parameters: {
      type: 'object',
      properties: {
        filePath: { type: 'string', description: 'The absolute path to the file to read.' },
        offset: { type: 'integer', description: 'Line offset to start reading from.' },
        limit: { type: 'integer', description: 'Maximum number of lines to read.' },
      },
      required: ['filePath'],
    },
  },
})

const bashTool = () => ({
  type: 'function',
  function: {
    name: 'bash',
    description: 'Run a shell command.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
})

const TOOLS_WITH_READ = path.join(TMP, 'tools-with-read.json')
const TOOLS_WITHOUT_READ = path.join(TMP, 'tools-without-read.json')
const TOOLS_MISSING = path.join(TMP, 'tools-does-not-exist.json')
fs.writeFileSync(TOOLS_WITH_READ, JSON.stringify([readTool()], null, 2))
fs.writeFileSync(TOOLS_WITHOUT_READ, JSON.stringify([bashTool()], null, 2))
fs.rmSync(TOOLS_MISSING, { force: true })

// Caller sends its own tools and no `read` — the exact shape that needs the injection.
const BODY = JSON.stringify({
  model: 'deepseek-v4.1-flash-free',
  messages: [{ role: 'user', content: 'Say ok' }],
  tools: [bashTool()],
})

async function waitForEvent(logFile, event, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(logFile)) {
      const hit = fs.readFileSync(logFile, 'utf8').split('\n').some((line) => {
        try { return JSON.parse(line).event === event } catch { return false }
      })
      if (hit) return true
    }
    await sleep(100)
  }
  throw new Error(`timeout waiting for event=${event} in ${logFile}`)
}

function readLog(logFile) {
  return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)] } catch { return [] }
  })
}

async function runCase(name, port, toolsFile) {
  const logFile = path.join(TMP, `${name}.log`)
  fs.rmSync(logFile, { force: true })
  const proxy = spawn('node', ['proxy.js'], {
    cwd: REPO,
    env: {
      ...process.env,
      PORT: String(port),
      ZEN_COMPAT: 'true',
      ZEN_TOOLS_FILE: toolsFile,
      LOG_FILE: logFile,
      LOG_BODY: 'true',
    },
    stdio: 'ignore',
  })
  try {
    await waitForEvent(logFile, 'listening')
    const res = await fetch(`http://127.0.0.1:${port}/inference/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer public' },
      body: BODY,
      signal: AbortSignal.timeout(60000),
    })
    const text = await res.text()
    await sleep(300)

    const lines = readLog(logFile)
    const warns = lines.filter((line) => line.event === 'zen_tools_missing')
    const request = [...lines].reverse().find((line) => line.direction === 'request')
    let forwarded = null
    try { forwarded = JSON.parse(request.body.preview) } catch { /* keep null */ }
    const firstTool = forwarded?.tools?.[0]
    const firstToolName = firstTool?.function?.name || firstTool?.name || null

    console.log(`\n=== ${name} ===`)
    console.log(`  ZEN_TOOLS_FILE     : ${toolsFile}`)
    console.log(`  upstream status    : ${res.status}`)
    console.log(`  injected tools[0]  : ${firstToolName} (caller sent ${forwarded?.tools?.length ?? '?'} tools, stream=${forwarded?.stream})`)
    console.log(`  warn count         : ${warns.length}`)
    for (const warn of warns) {
      console.log(`  warn reason        : ${warn.reason}`)
    }
    console.log(`  response body      : ${text.slice(0, 160).replace(/\s+/g, ' ')}`)
    return { status: res.status, warns, firstToolName, forwarded, text }
  } finally {
    proxy.kill()
    await sleep(300)
  }
}

const results = []
results.push(['missing-file', await runCase('missing-file', 8796, TOOLS_MISSING)])
results.push(['with-read', await runCase('with-read', 8797, TOOLS_WITH_READ)])
results.push(['without-read-entry', await runCase('without-read-entry', 8798, TOOLS_WITHOUT_READ)])

console.log('\n=== assertions ===')
const checks = []
const byName = Object.fromEntries(results)

checks.push(['missing-file -> exactly 1 warn',
  byName['missing-file'].warns.length === 1])
checks.push(['missing-file -> reason=工具面文件不存在',
  byName['missing-file'].warns[0]?.reason === '工具面文件不存在'])
checks.push(['missing-file -> warn carries toolsFile',
  byName['missing-file'].warns[0]?.toolsFile === TOOLS_MISSING])
checks.push(['missing-file -> upstream 403 (no injection)',
  byName['missing-file'].status === 403])
checks.push(['with-read -> no warn',
  byName['with-read'].warns.length === 0])
checks.push(['with-read -> read prepended to caller tools',
  byName['with-read'].firstToolName === 'read' && byName['with-read'].forwarded?.tools?.length === 2])
checks.push(['with-read -> upstream 200',
  byName['with-read'].status === 200])
checks.push(['without-read-entry -> exactly 1 warn',
  byName['without-read-entry'].warns.length === 1])
checks.push(['without-read-entry -> reason=canonical 工具面里没有 read 条目',
  byName['without-read-entry'].warns[0]?.reason === 'canonical 工具面里没有 read 条目'])
checks.push(['without-read-entry -> upstream 403',
  byName['without-read-entry'].status === 403])

let failed = 0
for (const [label, ok] of checks) {
  if (!ok) failed += 1
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`)
}
console.log(`\n${checks.length - failed}/${checks.length} passed`)
process.exit(failed === 0 ? 0 : 1)
