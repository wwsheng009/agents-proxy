'use strict'

const fs = require('node:fs')
const path = require('node:path')

const logFile = process.argv[2] || 'proxy.log'
const outDir = process.argv[3] || path.join('data', 'replay')

fs.mkdirSync(outDir, { recursive: true })

const lines = fs.readFileSync(logFile, 'utf8').split(/\r?\n/).filter(Boolean)
const manifest = []

for (const line of lines) {
  let rec
  try {
    rec = JSON.parse(line)
  } catch {
    continue
  }
  if (rec.direction !== 'request') continue

  const preview =
    rec.body && typeof rec.body.preview === 'string' ? rec.body.preview : ''
  const bytes = rec.body ? Number(rec.body.bytes) || 0 : 0
  const previewBytes = Buffer.byteLength(preview, 'utf8')

  let jsonParseOk = false
  if (preview) {
    try {
      JSON.parse(preview)
      jsonParseOk = true
    } catch {
      jsonParseOk = false
    }
  }

  // proxy.js 只保留前 MAX_PREVIEW_CHARS 个字符；
  // 当 preview 的字节数 >= 记录的 body 字节数且可解析时，payload 才是完整的。
  const complete = jsonParseOk && previewBytes >= bytes

  const safeId = String(rec.id).replace(/[^a-zA-Z0-9_-]/g, '_')
  const payloadFile = path.join(outDir, `${safeId}.json`)
  fs.writeFileSync(payloadFile, preview, 'utf8')

  let pathname = ''
  try {
    pathname = new URL(rec.target).pathname
  } catch {
    pathname = ''
  }

  manifest.push({
    id: rec.id,
    time: rec.time,
    method: rec.method,
    target: rec.target,
    path: pathname,
    bytes,
    previewBytes,
    complete,
    jsonParseOk,
    payloadFile,
    headers: rec.headers || {},
  })
}

const manifestFile = path.join(outDir, 'manifest.json')
fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2))

console.log(
  JSON.stringify(
    manifest.map((m) => ({
      id: m.id,
      time: m.time,
      bytes: m.bytes,
      previewBytes: m.previewBytes,
      complete: m.complete,
      jsonParseOk: m.jsonParseOk,
      payloadFile: m.payloadFile,
      truncatedBy:
        m.bodyTruncated !== undefined ? m.bodyTruncated : m.previewBytes < m.bytes,
    })),
    null,
    2,
  ),
)
console.log(`manifest: ${manifestFile}`)
