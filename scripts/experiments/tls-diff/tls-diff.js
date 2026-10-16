// TLS stack differential: same captured bytes via node(OpenSSL) vs bun(BoringSSL, same as client).
// Under active rate-limit, if bun gets 429 and node gets 403, TLS fingerprint is the discriminator.
const fs = require('node:fs')
const { execFileSync } = require('node:child_process')

const headers = JSON.parse(fs.readFileSync('replay-headers.json', 'utf8'))
const body = fs.readFileSync('replay-body.json')

async function send() {
  const res = await fetch('https://opencode.ai/zen/v1/chat/completions', {
    method: 'POST',
    headers: Object.fromEntries(Object.entries(headers).filter(([k]) => k !== 'accept-encoding' && k !== 'host' && k !== 'content-length')),
    body,
  })
  const text = await res.text()
  return { status: res.status, body: text.slice(0, 100) }
}

const runtime = process.isBun ? 'bun' : 'node'
send().then(r => {
  console.log(`${runtime} (TLS=${process.isBun ? 'BoringSSL' : 'OpenSSL'}) -> ${r.status}`)
  console.log('  ', r.body)
})
