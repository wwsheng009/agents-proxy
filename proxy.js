'use strict'

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const { URL } = require('node:url')

const PORT = Number(process.env.PORT || 8787)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 0)
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://opencode.ai'
const LOG_BODY = /^(1|true|yes)$/i.test(process.env.LOG_BODY || '')
const MAX_BODY_LOG_BYTES = Number(process.env.MAX_BODY_LOG_BYTES || 16 * 1024)
const MAX_PREVIEW_CHARS = Number(process.env.MAX_PREVIEW_CHARS || 4000)
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || ''
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || ''
const LOG_FILE = process.env.LOG_FILE || ''
// 显式开关：默认脱敏；设为 true 后在日志中记录敏感 header 明文（仅用于本机学习/调试）。
const LOG_SENSITIVE_HEADERS = /^(1|true|yes)$/i.test(process.env.LOG_SENSITIVE_HEADERS || '')

const targetBase = new URL(TARGET_BASE_URL)
const sensitiveHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
])

const requestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function redactHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (sensitiveHeaders.has(lower) && !LOG_SENSITIVE_HEADERS) {
      result[name] = '[redacted]'
      continue
    }
    result[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

function summarizeBody(buffer) {
  if (!buffer || buffer.length === 0) {
    return { bytes: 0 }
  }

  const contentType = ''
  const summary = {
    bytes: buffer.length,
    contentType,
  }

  const text = buffer.toString('utf8')
  if (!LOG_BODY) {
    try {
      const parsed = JSON.parse(text)
      if (parsed && typeof parsed === 'object') {
        if (typeof parsed.model === 'string') summary.model = parsed.model
        if (typeof parsed.stream === 'boolean') summary.stream = parsed.stream
        if (Array.isArray(parsed.messages)) summary.messages = parsed.messages.length
        if (Array.isArray(parsed.tools)) {
          summary.tools = parsed.tools.map((tool) => tool?.function?.name || tool?.name || '[unknown]')
        }
      }
    } catch {
      // Keep only byte count for non-JSON bodies when body logging is disabled.
    }
    return summary
  }

  summary.preview = text.slice(0, MAX_PREVIEW_CHARS)
  if (buffer.length > MAX_BODY_LOG_BYTES) {
    summary.truncated = true
  }
  return summary
}

const logStream = LOG_FILE
  ? fs.createWriteStream(LOG_FILE, { flags: 'a' })
  : null

function logEvent(event) {
  const record = {
    time: new Date().toISOString(),
    ...event,
  }
  const line = JSON.stringify(record)
  const output = `${line}\n`
  process.stdout.write(output)
  if (logStream) logStream.write(output)
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > 32 * 1024 * 1024) {
        reject(new Error('Request body exceeds 32MB debug limit'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function resolveTarget(req) {
  if (/^https?:\/\//i.test(req.url || '')) {
    return new URL(req.url)
  }
  return new URL(req.url || '/', targetBase)
}

function forwardHttp(req, res, body, id) {
  const target = resolveTarget(req)
  const isHttps = target.protocol === 'https:'
  const transport = isHttps ? https : http
  const headers = { ...req.headers }

  delete headers.host
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['transfer-encoding']
  headers.host = target.host
  headers['content-length'] = String(body.length)

  logEvent({
    id,
    direction: 'request',
    method: req.method,
    target: target.toString(),
    headers: redactHeaders(headers),
    body: summarizeBody(body),
  })

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: Number(process.env.UPSTREAM_TIMEOUT_MS || 60000),
    },
    (upstreamRes) => {
      logEvent({
        id,
        direction: 'response',
        status: upstreamRes.statusCode,
        headers: redactHeaders(upstreamRes.headers),
      })

      res.writeHead(
        upstreamRes.statusCode || 502,
        upstreamRes.headers,
      )
      upstreamRes.pipe(res)
    },
  )

  upstream.on('timeout', () => {
    upstream.destroy(new Error('Upstream timeout'))
  })

  upstream.on('error', (error) => {
    logEvent({
      id,
      direction: 'error',
      error: error.message,
    })
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' })
    }
    res.end(
      JSON.stringify({
        error: {
          type: 'proxy_error',
          message: error.message,
        },
      }),
    )
  })

  upstream.end(body)
}

function handleConnect(req, clientSocket, head, id) {
  const [host, portText] = String(req.url || '').split(':')
  const port = Number(portText || 443)

  logEvent({
    id,
    direction: 'connect',
    host,
    port,
    note: 'TLS payload is not inspected; this is a blind TCP tunnel.',
  })

  const upstreamSocket = net.connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head && head.length) upstreamSocket.write(head)
    upstreamSocket.pipe(clientSocket)
    clientSocket.pipe(upstreamSocket)
  })

  upstreamSocket.on('error', (error) => {
    logEvent({
      id,
      direction: 'connect_error',
      error: error.message,
    })
    clientSocket.destroy()
  })

  clientSocket.on('error', () => upstreamSocket.destroy())
}

async function handleRequest(req, res) {
  const id = requestId()

  if (req.url === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        targetBaseUrl: targetBase.toString(),
        logBody: LOG_BODY,
      }),
    )
    return
  }

  try {
    const body = await collectBody(req)
    forwardHttp(req, res, body, id)
  } catch (error) {
    logEvent({
      id,
      direction: 'error',
      error: error.message,
    })
    if (!res.headersSent) {
      res.writeHead(400, { 'content-type': 'application/json' })
    }
    res.end(
      JSON.stringify({
        error: {
          type: 'bad_request',
          message: error.message,
        },
      }),
    )
  }
}

const server = http.createServer(handleRequest)

server.on('connect', (req, socket, head) => {
  handleConnect(req, socket, head, requestId())
})

server.listen(PORT, '127.0.0.1', () => {
  logEvent({
    event: 'listening',
    port: PORT,
    targetBaseUrl: targetBase.toString(),
    logBody: LOG_BODY,
    logSensitiveHeaders: LOG_SENSITIVE_HEADERS,
        bodyLimitBytes: MAX_BODY_LOG_BYTES,
  })
})

if (HTTPS_PORT > 0) {
  if (!TLS_KEY_FILE || !TLS_CERT_FILE) {
    logEvent({
      event: 'https_disabled',
      reason: 'HTTPS_PORT is set but TLS_KEY_FILE or TLS_CERT_FILE is missing',
    })
  } else {
    try {
      const tlsOptions = {
        key: fs.readFileSync(TLS_KEY_FILE),
        cert: fs.readFileSync(TLS_CERT_FILE),
      }
      const httpsServer = https.createServer(tlsOptions, handleRequest)
      httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => {
        logEvent({
          event: 'https_listening',
          port: HTTPS_PORT,
          targetBaseUrl: targetBase.toString(),
        })
      })
    } catch (error) {
      logEvent({
        event: 'https_error',
        error: error.message,
      })
    }
  }
}
