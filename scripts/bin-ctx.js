'use strict'
const fs = require('node:fs')
const file =
  process.argv[2] ||
  'C:\\Users\\vince\\AppData\\Roaming\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe'
const needle = process.argv[3] || '"ses_"'
const before = Number(process.argv[4] || 400)
const after = Number(process.argv[5] || 800)
const maxHits = Number(process.argv[6] || 5)

const buf = fs.readFileSync(file)
const pat = Buffer.from(needle, 'utf8')
let idx = 0
let hits = 0
while (hits < maxHits) {
  const pos = buf.indexOf(pat, idx)
  if (pos === -1) break
  const start = Math.max(0, pos - before)
  const end = Math.min(buf.length, pos + pat.length + after)
  console.log(`--- hit @ ${pos} ---`)
  console.log(buf.subarray(start, end).toString('utf8'))
  idx = pos + pat.length
  hits++
}
if (hits === 0) console.log('no hits')
