'use strict'

const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const manifestFile = process.argv[2] || 'data/replay/manifest.json'
const proxyBase = process.argv[3] || 'http://127.0.0.1:8787'
const logFile = process.argv[4] || 'proxy.log'

const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const lineCountBefore = fs.existsSync(logFile)
  ? fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).length
  : 0

const SKIP_HEADERS = new Set(['host', 'content-length', 'connection', 'transfer-encoding'])
const results = []

for (const entry of manifest) {
  if (!entry.complete) {
    results.push({
      id: entry.id,
      replayed: false,
      reason: `payload truncated: only ${entry.previewBytes}/${entry.bytes} bytes in log preview`,
    })
    continue
  }

  const args = [
    '-sS',
    '-N',
    '-m',
    '60',
    '-D',
    '-',
    '--compressed',
    '-X',
    'POST',
    `${proxyBase}${entry.path}`,
  ]
  for (const [name, value] of Object.entries(entry.headers || {})) {
    if (SKIP_HEADERS.has(name.toLowerCase())) continue
    args.push('-H', `${name}: ${value}`)
  }
  args.push('--data-binary', `@${entry.payloadFile}`)

  const run = spawnSync('curl.exe', args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 70000,
  })

  const output = `${run.stdout || ''}${run.stderr || ''}`
  const statusMatch = output.match(/^HTTP\/[\d.]+\s+(\d+)/m)
  results.push({
    id: entry.id,
    replayed: true,
    curlExit: run.status,
    status: statusMatch ? Number(statusMatch[1]) : null,
    bodySnippet: output.split(/\r?\n\r?\n/).slice(1).join('\n\n').slice(0, 300),
  })
}

const lineCountAfter = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean).length

console.log(JSON.stringify({ logLinesBefore: lineCountBefore, logLinesAfter: lineCountAfter, results }, null, 2))
