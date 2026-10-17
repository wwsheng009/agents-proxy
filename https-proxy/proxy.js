'use strict'

// https-proxy —— 通用本地 HTTP/HTTPS 请求观测代理（零第三方依赖）
//
// 职责边界：**只转发、只记录，不改写**。
//   · 反向代理模式：把收到的请求转发到 TARGET_BASE_URL；
//   · 标准代理模式：作为 HTTP_PROXY/HTTPS_PROXY 接收普通 HTTP 请求和 CONNECT 隧道；
//   · 可选 HTTPS 反向监听（HTTPS_PORT + 本地证书），便于用 curl/浏览器直连观测。
//
// 这里**没有**任何 header/body 改写逻辑：opencode 免费道的 v2 兼容层
// （端点改写、身份头组、会话铸造、read 工具补齐、SSE→JSON 回组）由
// 仓库的 Go 版 `../proxy-go/` 承担，两者互不依赖。
//
// 说明：标准 HTTPS_PROXY 的 CONNECT 默认是**盲隧道**，TLS 载荷不被解密；
// 要看 HTTPS 请求明文，有两种办法：
//   ① 把客户端 base URL 指向本代理（反向代理模式，明文进来）；
//   ② 开 `MITM=true`：代理在 CONNECT 后用自己的本地 CA 按 SNI 动态签证书，
//      在本地终止 TLS 并解密记录，再以客户端身份连上游（客户端需信任 ca.pem）。

const http = require('node:http')
const https = require('node:https')
const tls = require('node:tls')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const zlib = require('node:zlib')
const { spawnSync } = require('node:child_process')
const { URL } = require('node:url')

const PORT = Number(process.env.PORT || 8787)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 0)
// 反向代理目标。留空 = 只支持标准代理模式（请求行里带绝对 URL）。
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || ''
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || ''
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || ''
// 日志默认落盘：未指定 LOG_FILE 时写到 <https-proxy>/proxy.log。
// 设 LOG_FILE="" 或 LOG_FILE=off 可关闭文件写入（仅输出到控制台）。
const LOG_FILE = (() => {
  const value = process.env.LOG_FILE
  if (value === undefined) return path.join(__dirname, 'proxy.log')
  if (/^(0|false|no|off|none)$/i.test(value.trim())) return ''
  return value
})()
// 是否把完整原始 body 写入日志文件。默认 true：目标是完整观察请求，
// 设为 false 才退回「只记字节数 + 结构摘要」。
const LOG_BODY = /^(1|true|yes)$/i.test(process.env.LOG_BODY ?? 'true')
// 非 UTF-8/二进制 body 是否附加 base64 原样副本（LOG_BODY=true 时生效）。
// 默认 true：完整观察时同时保留可读文本与原始字节两份。
const LOG_BODY_BASE64 = /^(1|true|yes)$/i.test(process.env.LOG_BODY_BASE64 ?? 'true')
// header 脱敏开关：默认【关闭】——完整记录 authorization / cookie / api key 等，
// 便于端到端观察请求。设为 true 时才把敏感 header 写成 [redacted]。
// 日志文件已整体 gitignore，仍请勿外发。
const LOG_REDACT_HEADERS = /^(1|true|yes)$/i.test(process.env.LOG_REDACT_HEADERS ?? 'false')
// 兼容旧变量名：LOG_SENSITIVE_HEADERS=true 等价于 LOG_REDACT_HEADERS=false。
const LEGACY_SENSITIVE_HEADERS = /^(1|true|yes)$/i.test(process.env.LOG_SENSITIVE_HEADERS ?? '')
// 控制台是否输出日志行（不含完整 body）。默认开；设为 false 后控制台完全静默，
// 日志只写 LOG_FILE。完整 body 永远只进文件，不进控制台。
const LOG_STDOUT = /^(1|true|yes)$/i.test(process.env.LOG_STDOUT ?? 'true')
const UPSTREAM_TIMEOUT_MS = Number(process.env.UPSTREAM_TIMEOUT_MS || 60000)

// ---- MITM（可选，默认关闭）----
// 开启后 CONNECT 不再盲转发：按 SNI 用本地 CA 现签域名证书，在本地解密并记录。
// 代价是客户端必须信任 MITM_CA_CERT（否则报证书错误），且需要系统有 openssl。
// MITM 仍需显式开启（-Mitm / MITM=true）：它要求客户端信任本地 CA，
// 默认打开会让未安装 CA 的客户端直接握手失败。日志开关则默认全开。
const MITM = /^(1|true|yes)$/i.test(process.env.MITM ?? 'false')
const MITM_CA_CERT = process.env.MITM_CA_CERT || path.join(__dirname, 'certs', 'ca.pem')
const MITM_CA_KEY = process.env.MITM_CA_KEY || path.join(__dirname, 'certs', 'ca.key')
const MITM_CERT_DIR = process.env.MITM_CERT_DIR || path.join(__dirname, 'certs', 'mitm')

// 单请求体内存上限（超过即拒，避免调试代理把内存吃光）。
const MAX_REQUEST_BYTES = 32 * 1024 * 1024
// 响应体旁路记录上限：超过后放弃记录，只留字节数与 truncated 标记（转发不受影响）。
const MAX_RESPONSE_LOG_BYTES = 64 * 1024 * 1024

const targetBase = TARGET_BASE_URL ? new URL(TARGET_BASE_URL) : null
const sensitiveHeaders = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'cookie',
  'set-cookie',
  // WorkBuddy 等 Electron 客户端会带设备令牌；默认脱敏，避免日志泄露。
  'x-device-token',
  'x-access-token',
  'x-refresh-token',
])

const requestId = () =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`

function redactHeaders(headers) {
  const result = {}
  for (const [name, value] of Object.entries(headers || {})) {
    const lower = name.toLowerCase()
    if (sensitiveHeaders.has(lower) && LOG_REDACT_HEADERS && !LEGACY_SENSITIVE_HEADERS) {
      result[name] = '[redacted]'
      continue
    }
    result[name] = Array.isArray(value) ? value.join(', ') : String(value)
  }
  return result
}

// 解压上限：避免解压炸弹把调试代理的内存吃光。
const MAX_DECODE_BYTES = 128 * 1024 * 1024

// 按 Content-Encoding 逐层解压（gzip / deflate / br / zstd）。
// 失败时保留原始字节，并把原因写进日志，不影响转发。
function decodeBody(buffer, contentEncoding) {
  if (!buffer || buffer.length === 0) return { buffer, decoded: false }
  const encodings = String(contentEncoding || '')
    .toLowerCase()
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
    // 多编码按声明顺序的逆序解码（如 "gzip, br" → 先 br 后 gzip）。
    .reverse()
  if (encodings.length === 0) return { buffer, decoded: false }

  let current = buffer
  const applied = []
  for (const encoding of encodings) {
    try {
      if (encoding === 'gzip' || encoding === 'x-gzip') {
        current = zlib.gunzipSync(current, { maxOutputLength: MAX_DECODE_BYTES })
      } else if (encoding === 'br') {
        current = zlib.brotliDecompressSync(current, { maxOutputLength: MAX_DECODE_BYTES })
      } else if (encoding === 'deflate') {
        current = zlib.inflateSync(current, { maxOutputLength: MAX_DECODE_BYTES })
      } else if (encoding === 'zstd' && typeof zlib.zstdDecompressSync === 'function') {
        current = zlib.zstdDecompressSync(current, { maxOutputLength: MAX_DECODE_BYTES })
      } else {
        return { buffer, decoded: false, unsupported: encoding }
      }
      applied.push(encoding)
    } catch (error) {
      return { buffer, decoded: false, error: error.message }
    }
  }
  return { buffer: current, decoded: true, encodings: applied }
}

function summarizeBody(rawBuffer, contentType, contentEncoding) {
  if (!rawBuffer || rawBuffer.length === 0) {
    return { bytes: 0 }
  }

  const summary = {
    // bytes 始终是网络上的原始字节数；解压后大小见 decodedBytes。
    bytes: rawBuffer.length,
  }
  if (contentType) summary.contentType = contentType
  if (contentEncoding) summary.contentEncoding = contentEncoding

  const decoded = decodeBody(rawBuffer, contentEncoding)
  const buffer = decoded.buffer
  if (decoded.decoded) {
    summary.decodedBytes = buffer.length
    summary.decodedEncodings = decoded.encodings
  } else if (decoded.error) {
    summary.decodeError = decoded.error
  } else if (decoded.unsupported) {
    summary.undecodedEncoding = decoded.unsupported
  }

  if (!buffer || buffer.length === 0) {
    return summary
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

  // LOG_BODY=true：记录完整原始 body（不再截断、不再折叠）。
  // body 正常情况下是 UTF-8 JSON/SSE 文本，preview 直接存原始字符串全文；
  // 若含非法 UTF-8 字节（二进制/压缩流），则回退为 base64 原样副本，
  // 保证"所有原始信息"不丢字节。
  const roundTrips = Buffer.compare(Buffer.from(text, 'utf8'), buffer) === 0
  if (roundTrips) {
    summary.preview = text
  } else {
    summary.rawBase64 = buffer.toString('base64')
  }
  if (LOG_BODY_BASE64 && !summary.rawBase64 && buffer.length > 0) {
    summary.rawBase64 = buffer.toString('base64')
  }
  if (!roundTrips || LOG_BODY_BASE64) {
    summary.encoding = roundTrips ? 'utf8' : 'base64'
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
  // 控制台只输出紧凑摘要（不打完整 body，避免大请求体刷屏）；
  // 完整 body 仅写入 LOG_FILE（LOG_BODY=true 时）。
  if (logStream) {
    logStream.write(`${line}\n`)
  }
  if (LOG_STDOUT && !LOG_BODY) {
    process.stdout.write(`${line}\n`)
  } else if (LOG_STDOUT) {
    const { body, ...rest } = record
    process.stdout.write(`${JSON.stringify(rest)}\n`)
  }
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let total = 0

    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_REQUEST_BYTES) {
        reject(new Error(`Request body exceeds ${MAX_REQUEST_BYTES} byte debug limit`))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function resolveTarget(req, mitmHost) {
  // MITM 模式：TLS 已在本地终止，请求行是相对路径，按 Host 头还原出 https:// 目标。
  if (mitmHost) {
    const host = String(req.headers.host || mitmHost)
    return new URL(`https://${host}${req.url || '/'}`)
  }
  if (/^https?:\/\//i.test(req.url || '')) {
    return new URL(req.url)
  }
  if (!targetBase) {
    throw new Error(
      '未设置 TARGET_BASE_URL：反向代理模式不可用。'
      + '请设置 TARGET_BASE_URL 后重启，或改用标准代理模式（请求行带绝对 URL）',
    )
  }
  return new URL(req.url || '/', targetBase)
}

function forwardHttp(req, res, body, id, mitmHost) {
  const target = resolveTarget(req, mitmHost)
  const isHttps = target.protocol === 'https:'
  const transport = isHttps ? https : http

  // 纯透传：只清理逐跳（hop-by-hop）头，重建 host/content-length，其余原样转发。
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
    body: summarizeBody(
      body,
      headers['content-type'] || '',
      headers['content-encoding'] || '',
    ),
  })

  const upstream = transport.request(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (isHttps ? 443 : 80),
      method: req.method,
      path: `${target.pathname}${target.search}`,
      headers,
      timeout: UPSTREAM_TIMEOUT_MS,
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

      // 响应体旁路记录：不阻塞转发（SSE 仍然即时流向客户端），
      // 边转发边收集完整原始响应体，结束后追加一条 response_body 事件。
      const chunks = []
      let total = 0
      let capped = false
      let bodyLogged = false
      upstreamRes.on('data', (chunk) => {
        total += chunk.length
        if (!capped && total <= MAX_RESPONSE_LOG_BYTES) {
          chunks.push(chunk)
        } else if (!capped) {
          capped = true
          chunks.length = 0
        }
      })
      // 客户端提前断开（如调用方取消了这次请求）时，响应流不会触发 end，
      // 只触发 close。此时仍把已收到的部分落盘，并标注 aborted，
      // 否则这类请求会只剩 response 头、完全没有 body 记录。
      const logResponseBody = (closedEarly) => {
        if (bodyLogged) return
        bodyLogged = true
        const payload = capped
          ? { bytes: total, truncated: true, reason: `response_body exceeds ${MAX_RESPONSE_LOG_BYTES} byte log cap` }
          : summarizeBody(
            Buffer.concat(chunks),
            upstreamRes.headers['content-type'] || '',
            upstreamRes.headers['content-encoding'] || '',
          )
        logEvent({
          id,
          direction: 'response_body',
          status: upstreamRes.statusCode,
          headers: redactHeaders(upstreamRes.headers),
          body: payload,
          ...(closedEarly ? { aborted: true } : {}),
        })
      }
      upstreamRes.on('end', () => logResponseBody(false))
      upstreamRes.on('close', () => logResponseBody(!upstreamRes.complete))

      // 客户端提前断开（例如调用方拿到结果后就取消这次请求）时，上游 SSE 流可能
      // 一直挂在 keep-alive 连接上不结束 —— 既不会触发 end 也不会触发 close。
      // 这里主动中止上游并落盘已收到的部分，避免日志缺口和句柄泄漏。
      res.on('close', () => {
        if (!res.writableFinished && !upstreamRes.complete) {
          upstreamRes.destroy()
          logResponseBody(true)
        }
      })
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

// ---- MITM：按 SNI 动态签发域名证书（openssl 生成，结果缓存到磁盘 + 内存）----

const mitmContexts = new Map()

// openssl 常不在 Windows PATH 里（Git for Windows 自带一份）。
// 依次尝试：显式 OPENSSL_BIN → PATH → 常见安装位置；找不到时 MITM 降级为盲隧道。
const OPENSSL_CANDIDATES = [
  process.env.OPENSSL_BIN,
  'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
  'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
  'C:\\Program Files\\OpenSSL-Win64\\bin\\openssl.exe',
  'C:\\Program Files (x86)\\OpenSSL-Win32\\bin\\openssl.exe',
].filter(Boolean)

let resolvedOpenssl
function resolveOpenssl() {
  if (resolvedOpenssl !== undefined) return resolvedOpenssl
  for (const candidate of OPENSSL_CANDIDATES) {
    if (candidate === 'openssl' || !fs.existsSync(candidate)) continue
    resolvedOpenssl = candidate
    return resolvedOpenssl
  }
  // 最后尝试 PATH 里的 openssl。
  const probe = spawnSync('openssl', ['version'], { encoding: 'utf8', windowsHide: true })
  resolvedOpenssl = !probe.error && probe.status === 0 ? 'openssl' : null
  return resolvedOpenssl
}

function openssl(args) {
  const bin = resolveOpenssl()
  if (!bin) {
    throw new Error(
      'openssl 不可用（MITM 需要 openssl；可安装 Git for Windows，'
      + '或用 OPENSSL_BIN 指定 openssl.exe 路径）',
    )
  }
  const result = spawnSync(bin, args, { encoding: 'utf8', windowsHide: true })
  if (result.error) {
    throw new Error(`openssl 不可用：${result.error.message}（bin=${bin}）`)
  }
  if (result.status !== 0) {
    throw new Error(`openssl ${args[0]} 失败：${String(result.stderr || '').trim().slice(0, 300)}`)
  }
  return result.stdout
}

if (MITM) {
  const bin = resolveOpenssl()
  logEvent({ event: 'mitm_openssl', bin: bin || null, available: Boolean(bin) })
}

// 所有域名共用一把叶子私钥，只有证书按域名不同 —— 省掉每个域名一次 RSA 密钥生成。
function mitmLeafKeyPath() {
  return path.join(MITM_CERT_DIR, '_leaf.key')
}

function ensureMitmLeafKey() {
  const keyPath = mitmLeafKeyPath()
  if (fs.existsSync(keyPath)) return
  fs.mkdirSync(MITM_CERT_DIR, { recursive: true })
  openssl(['genpkey', '-algorithm', 'RSA', '-pkeyopt', 'rsa_keygen_bits:2048', '-out', keyPath])
}

function mitmCertPath(host) {
  return path.join(MITM_CERT_DIR, `${host.replace(/[^A-Za-z0-9._-]/g, '_')}.crt`)
}

function issueMitmCert(host) {
  const certPath = mitmCertPath(host)
  if (!fs.existsSync(certPath)) {
    ensureMitmLeafKey()
    const san = net.isIP(host) ? `IP:${host}` : `DNS:${host}`
    openssl([
      'req', '-x509', '-new', '-sha256',
      '-key', mitmLeafKeyPath(),
      '-subj', `/CN=${host}`,
      '-addext', `subjectAltName=${san}`,
      '-addext', 'basicConstraints=critical,CA:FALSE',
      '-addext', 'keyUsage=critical,digitalSignature,keyEncipherment',
      '-addext', 'extendedKeyUsage=serverAuth',
      '-CA', MITM_CA_CERT,
      '-CAkey', MITM_CA_KEY,
      '-set_serial', `0x${crypto.randomBytes(16).toString('hex')}`,
      '-days', '825',
      '-out', certPath,
    ])
  }
  return { key: fs.readFileSync(mitmLeafKeyPath()), cert: fs.readFileSync(certPath) }
}

function mitmContextFor(host) {
  const cached = mitmContexts.get(host)
  if (cached) return cached
  const { key, cert } = issueMitmCert(host)
  const ctx = tls.createSecureContext({ key, cert, minVersion: 'TLSv1.2' })
  mitmContexts.set(host, ctx)
  return ctx
}

// 解密后的请求交给同一套转发/记录逻辑；mitmHost 用于还原 https:// 目标。
const mitmServer = http.createServer((req, res) => {
  handleRequest(req, res, req.socket?.__mitmHost)
})
mitmServer.on('clientError', (error, socket) => {
  logEvent({ direction: 'mitm_error', error: error.message })
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n')
  else socket.destroy()
})
// WebSocket 等 Upgrade 请求：把解密后的请求行与头原样转给上游，之后双向透传字节。
mitmServer.on('upgrade', (req, socket, head) => {
  const host = String(req.headers.host || req.socket?.__mitmHost || '')
  const id = requestId()
  logEvent({
    id,
    direction: 'upgrade',
    target: `wss://${host}${req.url || '/'}`,
    headers: redactHeaders(req.headers),
    note: 'WebSocket/Upgrade 只记录握手头，之后是字节流透传',
  })
  const upstream = tls.connect({ host, port: 443, servername: host, ALPNProtocols: ['http/1.1'] }, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`]
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`)
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
    if (head && head.length) upstream.write(head)
    upstream.pipe(socket)
    socket.pipe(upstream)
  })
  upstream.on('error', (error) => {
    logEvent({ id, direction: 'error', error: error.message })
    socket.destroy()
  })
  socket.on('error', () => upstream.destroy())
})

function handleConnect(req, clientSocket, head, id) {
  const [host, portText] = String(req.url || '').split(':')
  const port = Number(portText || 443)

  // 只有 443 走 MITM；其它端口（如 8443）保持盲隧道，避免误判协议。
  const useMitm = MITM && port === 443
  logEvent({
    id,
    direction: 'connect',
    host,
    port,
    mitm: useMitm,
    note: useMitm
      ? 'TLS terminated locally with a CA-signed cert; request/response recorded in plaintext.'
      : 'TLS payload is not inspected; this is a blind TCP tunnel.',
  })

  if (!useMitm) {
    blindTunnel(host, port, clientSocket, head, id)
    return
  }

  let ctx
  try {
    ctx = mitmContextFor(host)
  } catch (error) {
    // 签不出证书（缺 openssl / 缺 ca.key）时降级为盲隧道，保证代理仍然可用。
    logEvent({ id, direction: 'mitm_error', host, error: error.message, fallback: 'blind_tunnel' })
    blindTunnel(host, port, clientSocket, head, id)
    return
  }

  clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
  if (head && head.length) clientSocket.unshift(head)

  const tlsSocket = new tls.TLSSocket(clientSocket, {
    isServer: true,
    secureContext: ctx,
    // 按 SNI 现签：CONNECT 里给的是 IP 或与 SNI 不一致时（部分客户端会这样），
    // 证书仍然与客户端实际请求的域名匹配，不会报 hostname mismatch。
    SNICallback: (servername, cb) => {
      try {
        cb(null, mitmContextFor(servername))
      } catch (error) {
        logEvent({ id, direction: 'mitm_error', host: servername, error: error.message, fallback: 'connect_host_cert' })
        cb(null, ctx)
      }
    },
    ALPNProtocols: ['http/1.1'],
  })
  tlsSocket.__mitmHost = host
  // 握手完成后以 SNI 为准（SNI 缺失时保留 CONNECT host）。
  tlsSocket.on('secure', () => {
    if (tlsSocket.servername) tlsSocket.__mitmHost = tlsSocket.servername
  })
  tlsSocket.on('error', (error) => {
    logEvent({ id, direction: 'connect_error', host, error: error.message })
    tlsSocket.destroy()
  })
  mitmServer.emit('connection', tlsSocket)
}

function blindTunnel(host, port, clientSocket, head, id) {
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

async function handleRequest(req, res, mitmHost) {
  const id = requestId()

  if (req.url === '/__proxy/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(
      JSON.stringify({
        ok: true,
        targetBaseUrl: targetBase ? targetBase.toString() : null,
        logBody: LOG_BODY,
        logFile: LOG_FILE || null,
        redactHeaders: LOG_REDACT_HEADERS && !LEGACY_SENSITIVE_HEADERS,
        httpsPort: HTTPS_PORT > 0 ? HTTPS_PORT : null,
        mitm: MITM,
      }),
    )
    return
  }

  try {
    const body = await collectBody(req)
    forwardHttp(req, res, body, id, mitmHost)
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

server.on('error', (error) => {
  // HTTP 监听是代理的核心能力，失败时给出明确原因并以非零码退出。
  process.stderr.write(
    `[proxy] HTTP ${PORT} 监听失败：${error.message}\n`
    + '请关闭占用该端口的进程，或用 PORT 指定其它端口。\n',
  )
  process.exit(1)
})

server.on('connect', (req, socket, head) => {
  handleConnect(req, socket, head, requestId())
})

server.listen(PORT, '127.0.0.1', () => {
  logEvent({
    event: 'listening',
    port: PORT,
    targetBaseUrl: targetBase ? targetBase.toString() : null,
    logFile: LOG_FILE || null,
    logBody: LOG_BODY,
    redactHeaders: LOG_REDACT_HEADERS && !LEGACY_SENSITIVE_HEADERS,
    requestLimitBytes: MAX_REQUEST_BYTES,
    mitm: MITM,
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
      httpsServer.on('error', (error) => {
        // HTTPS 反向监听是可选能力：端口被占用（常见于 proxy-go 默认监听 8788）
        // 时只记录告警，不能让已经可用的 HTTP 代理跟着退出。
        logEvent({
          event: 'https_error',
          port: HTTPS_PORT,
          code: error.code || null,
          error: error.message,
        })
        if (error.code === 'EADDRINUSE') {
          process.stderr.write(
            `[proxy] HTTPS ${HTTPS_PORT} 已被占用，反向监听未启用；`
            + '请关闭占用进程或设置 HTTPS_PORT 为其它端口。\n',
          )
        }
      })
      // 该监听同样可作为「HTTPS 代理」使用：客户端先 TLS 到本端口，再发 CONNECT。
      httpsServer.on('connect', (req, socket, head) => {
        handleConnect(req, socket, head, requestId())
      })
      httpsServer.listen(HTTPS_PORT, '127.0.0.1', () => {
        logEvent({
          event: 'https_listening',
          port: HTTPS_PORT,
          targetBaseUrl: targetBase ? targetBase.toString() : null,
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
