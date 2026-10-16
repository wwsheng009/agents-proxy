'use strict'

const http = require('node:http')
const https = require('node:https')
const net = require('node:net')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { URL } = require('node:url')

const PORT = Number(process.env.PORT || 8787)
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 0)
const TARGET_BASE_URL = process.env.TARGET_BASE_URL || 'https://opencode.ai'
const LOG_BODY = /^(1|true|yes)$/i.test(process.env.LOG_BODY || '')
const MAX_BODY_LOG_BYTES = Number(process.env.MAX_BODY_LOG_BYTES || 16 * 1024)
const MAX_PREVIEW_CHARS = Number(process.env.MAX_PREVIEW_CHARS || 4000)
// 非 UTF-8/二进制 body 是否附加 base64 原样副本（LOG_BODY=true 时生效）。
const LOG_BODY_BASE64 = /^(1|true|yes)$/i.test(process.env.LOG_BODY_BASE64 || '')
const TLS_KEY_FILE = process.env.TLS_KEY_FILE || ''
const TLS_CERT_FILE = process.env.TLS_CERT_FILE || ''
const LOG_FILE = process.env.LOG_FILE || ''
// 显式开关：默认脱敏；设为 true 后在日志中记录敏感 header 明文（仅用于本机学习/调试）。
const LOG_SENSITIVE_HEADERS = /^(1|true|yes)$/i.test(process.env.LOG_SENSITIVE_HEADERS || '')
// 控制台是否输出日志行（不含完整 body）。默认开；设为 false 后控制台完全静默，
// 日志只写 LOG_FILE。完整 body 永远只进文件，不进控制台。
const LOG_STDOUT = /^(1|true|yes)$/i.test(process.env.LOG_STDOUT ?? 'true')
// opencode.ai/zen 免费道的兼容层。默认开启，只在命中 zen 路径时改写。
const ZEN_COMPAT = /^(1|true|yes)$/i.test(process.env.ZEN_COMPAT || 'true')
// v2 指纹适配（见 docs/分析-opencode-v2指纹与准入.md）：新 UA 四段格式 + v2 会话/链路头。
const ZEN_USER_AGENT = process.env.ZEN_USER_AGENT || 'opencode/latest/2.0.29/cli'
const ZEN_TEMPLATE_FILE = process.env.ZEN_TEMPLATE_FILE || path.join(__dirname, 'opencode_system_prompt.txt')
const ZEN_AGENT_TEMPLATE_FILE = process.env.ZEN_AGENT_TEMPLATE_FILE || path.join(__dirname, 'opencode_agent_system_prompt.txt')
const ZEN_TOOLS_FILE = process.env.ZEN_TOOLS_FILE || path.join(__dirname, 'opencode_tools.json')

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

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const MESSAGE_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/
const ZEN_PATH_RE = /\/(?:zen\/v1|inference\/v1)\/(?:chat\/completions|responses|messages|models)\/?$/
const zenSessions = new Map()
let zenLastMs = 0
let zenCounter = 0
let zenTemplate
let zenAgentTemplate
let zenTools

/**
 * Mint the same identifier shape the zen gateway accepts.
 * v2 算法（packages/schema/src/identifier.ts）：current = ms*0x1000+counter；
 * ses_ 取 ~current 低 48 位 hex（时间降序），msg_ 取 current 低 48 位（升序）；
 * 随机段 14 字节 [0-9A-Za-z]。
 * Sessions use the descending time field; request ids use the ascending one.
 */
function mintZenId(prefix, descending) {
  const now = Date.now()
  if (now !== zenLastMs) {
    zenLastMs = now
    zenCounter = 0
  }
  zenCounter += 1
  const current = BigInt(now) * 0x1000n + BigInt(zenCounter)
  const value = descending ? ~current : current
  const mask = (1n << 48n) - 1n
  const hex = (value & mask).toString(16).padStart(12, '0')
  const bytes = crypto.randomBytes(14)
  let random = ''
  for (const byte of bytes) random += BASE62[byte % 62]
  return `${prefix}${hex}${random}`
}

function validUserAgent(value) {
  // v2 四段格式 opencode/<channel>/<version>/<artifact> 与 1.x 两段 opencode/<version> 都接受；
  // 版本门槛保持 >= 1.18（v2 准入不在此层，但 426 语义保留）。
  const match = /opencode\/(?:[^/]+\/)?(\d+)\.(\d+)(?:\.(\d+))?(?:\/[a-z]+)?/i.exec(String(value || ''))
  if (!match) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return major > 1 || (major === 1 && minor >= 18)
}

// v2 链路头：W3C TraceContext + Zipkin B3（真实 v2 客户端每次请求生成新 trace）。
function traceHeaders() {
  const traceId = crypto.randomBytes(16).toString('hex')
  const spanId = crypto.randomBytes(8).toString('hex')
  return {
    traceparent: `00-${traceId}-${spanId}-01`,
    b3: `${traceId}-${spanId}-1-${spanId}`,
  }
}

function sessionForZen(headers) {
  const incoming = String(headers['x-opencode-session'] || '')
  if (SESSION_RE.test(incoming)) return incoming
  const key = String(headers['x-session-id'] || headers['x-session'] || incoming || 'default')
  let session = zenSessions.get(key)
  if (!session) {
    session = mintZenId('ses_', true)
    zenSessions.set(key, session)
  }
  return session
}

function requestForZen(headers) {
  const incoming = String(headers['x-opencode-request'] || '')
  return MESSAGE_RE.test(incoming) ? incoming : mintZenId('msg_', false)
}

function isZenTarget(target) {
  return ZEN_COMPAT && target.hostname === 'opencode.ai' && ZEN_PATH_RE.test(target.pathname)
}

function isZenChatTarget(target) {
  return isZenTarget(target) && /\/(?:zen\/v1|inference\/v1)\/chat\/completions\/?$/.test(target.pathname)
}

function loadZenTemplate() {
  if (zenTemplate !== undefined) return zenTemplate
  try {
    zenTemplate = fs.readFileSync(ZEN_TEMPLATE_FILE, 'utf8')
  } catch {
    zenTemplate = ''
  }
  return zenTemplate
}

function loadZenAgentTemplate() {
  if (zenAgentTemplate !== undefined) return zenAgentTemplate
  try {
    zenAgentTemplate = fs.readFileSync(ZEN_AGENT_TEMPLATE_FILE, 'utf8')
  } catch {
    zenAgentTemplate = ''
  }
  return zenAgentTemplate
}

function loadZenTools() {
  if (zenTools !== undefined) return zenTools
  let reason = ''
  try {
    const parsed = JSON.parse(fs.readFileSync(ZEN_TOOLS_FILE, 'utf8'))
    if (Array.isArray(parsed)) {
      zenTools = parsed
    } else {
      zenTools = []
      reason = 'tools json 顶层不是数组'
    }
  } catch (error) {
    zenTools = []
    reason = error?.code === 'ENOENT'
      ? '工具面文件不存在'
      : `工具面读取/解析失败：${error?.message || error}`
  }
  if (!zenTools.some(tool => toolName(tool) === 'read')) {
    // 与 proxy-go/server.go:69 对称：取不到 canonical read 工具时，缺 read 的调用会被上游
    // 403（v2 准入②）。此前这条路径完全静默 —— 裸 `node proxy.js` 启动时零提示，只能靠
    // diff 请求体才看得出 tools 变了（见 docs/过程与坑.md 坑 8）。zenTools 有缓存，
    // 因此该 warn 每个进程至多输出一次。
    logEvent({
      event: 'zen_tools_missing',
      msg: 'v2 未取到 read 工具，缺 read 的请求会被上游 403',
      toolsFile: ZEN_TOOLS_FILE,
      reason: reason || 'canonical 工具面里没有 read 条目',
    })
  }
  return zenTools
}

function hasSystemMatching(messages, marker) {
  return Array.isArray(messages) && messages.some(
    message => message && message.role === 'system'
      && typeof message.content === 'string' && message.content.includes(marker),
  )
}

function toolName(tool) {
  return String(tool?.function?.name || tool?.name || '')
}

/**
 * Keep the caller's tools, but make the zen-accepted surface explicit:
 * canonical opencode schemas replace same-named entries and every canonical
 * tool is present. This lets arbitrary OpenAI clients send their own tools
 * without tripping the free-tier tool gate.
 */
function normalizeZenTools(tools) {
  const canonical = loadZenTools()
  if (canonical.length === 0) return tools
  const canonicalByName = new Map(canonical.map(tool => [toolName(tool), tool]))
  const seen = new Set()
  const out = []
  for (const tool of Array.isArray(tools) ? tools : []) {
    const name = toolName(tool)
    if (canonicalByName.has(name)) {
      if (seen.has(name)) continue
      seen.add(name)
      out.push(canonicalByName.get(name))
      continue
    }
    out.push(tool)
  }
  for (const tool of canonical) {
    const name = toolName(tool)
    if (!seen.has(name)) {
      seen.add(name)
      out.push(tool)
    }
  }
  return out
}

function normalizeEffort(body) {
  if (!Object.hasOwn(body, 'reasoning_effort')) return
  const value = body.reasoning_effort
  if (value === 'none' || value === 'low' || value === 'medium' || value === 'high') return
  if (value === 'max' || value === 'xhigh') {
    body.reasoning_effort = 'high'
    return
  }
  if (value === 'minimal') {
    body.reasoning_effort = 'low'
    return
  }
  // The zen backend only accepts the legacy four-value enum; unknown values
  // surface as HTTP 500, so dropping the hint is safer than forwarding it.
  delete body.reasoning_effort
}

/**
 * Make an arbitrary OpenAI-shaped chat body acceptable to the free zen lane:
 * supply a system prompt when the caller omitted one, force the streaming wire
 * the gateway expects, and normalize unsupported effort values.
 */
function prepareZenBody(body, target) {
  if (!isZenChatTarget(target)) return { body, translate: false }
  let parsed
  try {
    parsed = JSON.parse(body.toString('utf8'))
  } catch {
    return { body, translate: false }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { body, translate: false }
  }
  const callerWantsStream = parsed.stream === true
  // v2 准入（实验证据：scripts/experiments/bisect/bisect-body*.js，见 docs/分析-opencode-v2指纹与准入.md §三）：
  //   ① stream:true 必须；② tools 必须含 opencode 的 "read" 工具（名称匹配，schema 可改，
  //   可与任意自有工具混用）。旧的 1.x 门③模板注入与 12 工具规范化不再需要，且模板注入
  //   会拖慢/污染响应，仅保留 effort 映射。
  const tools = Array.isArray(parsed.tools) ? parsed.tools : []
  const hasRead = tools.some(tool => toolName(tool) === 'read')
  if (!hasRead) {
    const canonical = loadZenTools()
    const readTool = canonical.find(tool => toolName(tool) === 'read')
    if (readTool) parsed.tools = [readTool, ...tools]
  }
  parsed.stream = true
  normalizeEffort(parsed)
  return {
    body: Buffer.from(JSON.stringify(parsed), 'utf8'),
    translate: !callerWantsStream,
  }
}

function prepareZenHeaders(incoming, target, body) {
  const headers = { ...incoming }
  delete headers.host
  delete headers.connection
  delete headers['proxy-connection']
  delete headers['transfer-encoding']
  headers.host = target.host
  headers['content-length'] = String(body.length)
  headers['content-type'] = headers['content-type'] || 'application/json'
  headers.authorization = 'Bearer public'
  if (!validUserAgent(headers['user-agent'])) headers['user-agent'] = ZEN_USER_AGENT
  const session = sessionForZen(headers)
  headers['x-opencode-session'] = session
  // v2 抓包确认：真实 v2 客户端不发送 x-opencode-request；实测（scripts/experiments/bisect/bisect-headers.js）
  // 带 msg_ 头会被 403 拒绝。v2 新头组用 x-opencode-session-id 承担请求关联。
  delete headers['x-opencode-request']
  // v2 指纹（抓包 见 docs/分析-opencode-v2指纹与准入.md §二）：会话 ID 同步到新头组。
  headers['x-opencode-session-id'] = session
  headers['x-session-affinity'] = session
  headers['x-session-id'] = session
  headers['x-opencode-client'] = headers['x-opencode-client'] || 'cli'
  headers['x-opencode-project'] = headers['x-opencode-project'] || 'global'
  Object.assign(headers, traceHeaders())
  headers.accept = headers.accept || 'text/event-stream'
  // Keep the SSE body decodable for the non-streaming translation path.
  headers['accept-encoding'] = 'identity'
  return headers
}

/**
 * Assemble the zen SSE stream back into one OpenAI chat.completion document.
 * The proxy forces `stream:true` on the upstream wire for non-streaming
 * callers, so this keeps the caller-facing JSON contract unchanged.
 */
function assembleCompletion(raw) {
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw)
  const result = {
    id: '',
    object: 'chat.completion',
    created: 0,
    model: '',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '' },
      finish_reason: 'stop',
    }],
  }
  const tools = new Map()
  const order = []

  for (const line of text.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    let event
    try {
      event = JSON.parse(payload)
    } catch {
      continue
    }
    if (event.id) result.id = event.id
    if (event.created) result.created = event.created
    if (event.model) result.model = event.model
    if (event.usage) result.usage = event.usage
    if (event.cost !== undefined) result.cost = event.cost
    for (const choice of event.choices || []) {
      const delta = choice.delta || {}
      if (typeof delta.content === 'string') result.choices[0].message.content += delta.content
      if (typeof delta.reasoning === 'string') {
        result.choices[0].message.reasoning = (result.choices[0].message.reasoning || '') + delta.reasoning
      }
      if (choice.finish_reason) result.choices[0].finish_reason = choice.finish_reason
      for (const call of delta.tool_calls || []) {
        const index = call.index ?? 0
        let entry = tools.get(index)
        if (!entry) {
          entry = { index, id: '', type: '', function: { name: '', arguments: '' } }
          tools.set(index, entry)
          order.push(index)
        }
        if (call.id) entry.id = call.id
        if (call.type) entry.type = call.type
        if (call.function?.name) entry.function.name += call.function.name
        if (call.function?.arguments) entry.function.arguments += call.function.arguments
      }
    }
  }

  if (order.length > 0) {
    order.sort((a, b) => a - b)
    result.choices[0].message.tool_calls = order.map(index => tools.get(index))
    if (result.choices[0].finish_reason === 'stop') result.choices[0].finish_reason = 'tool_calls'
  }
  return Buffer.from(JSON.stringify(result), 'utf8')
}

function collectSseResponse(upstreamRes, res, id, upstreamHeaders) {
  const chunks = []
  let total = 0
  let capped = false

  upstreamRes.on('data', chunk => {
    total += chunk.length
    if (total <= 64 * 1024 * 1024) chunks.push(chunk)
    else if (!capped) {
      capped = true
      chunks.length = 0
    }
  })
  upstreamRes.on('error', error => {
    logEvent({ id, direction: 'error', error: error.message })
    if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: { type: 'proxy_error', message: error.message } }))
  })
  upstreamRes.on('end', () => {
    if (capped) {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { type: 'proxy_error', message: 'SSE response exceeds 64MB translation cap' } }))
      return
    }
    const headers = { ...upstreamHeaders }
    delete headers['content-length']
    delete headers['transfer-encoding']
    delete headers['content-encoding']
    headers['content-type'] = 'application/json'
    const assembled = assembleCompletion(Buffer.concat(chunks))
    res.writeHead(200, headers)
    res.end(assembled)
    logEvent({
      id,
      direction: 'response_body',
      status: 200,
      headers: redactHeaders(headers),
      body: summarizeBody(assembled, 'application/json'),
      translatedStream: true,
    })
  })
}

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

function summarizeBody(buffer, contentType) {
  if (!buffer || buffer.length === 0) {
    return { bytes: 0 }
  }

  const summary = {
    bytes: buffer.length,
  }
  if (contentType) summary.contentType = contentType

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
  // 控制台只输出紧凑摘要（不打完整 body，避免 22KB 级请求体刷屏）；
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
  const target = /^https?:\/\//i.test(req.url || '')
    ? new URL(req.url)
    : new URL(req.url || '/', targetBase)

  // Accept the usual OpenAI-compatible spellings from local clients and place
  // them under the zen namespace. A target that already includes /zen is left
  // untouched, as is a non-opencode host. Bare OpenAI-style paths route to the v2
  // inference endpoint (live catalog api = https://opencode.ai/inference/v1).
  if (ZEN_COMPAT && target.hostname === 'opencode.ai' && !target.pathname.startsWith('/zen/') && !target.pathname.startsWith('/inference/')) {
    if (/^\/v1(?:\/|$)/.test(target.pathname)) {
      target.pathname = `/inference${target.pathname}`
    } else if (/^\/v1beta\/models\/?$/.test(target.pathname)) {
      // Gemini-style discovery: serve the OpenAI-shaped model list from the inference lane.
      target.pathname = `/inference/v1/models`
    } else if (/^\/(?:chat\/completions|responses|messages|models)\/?$/.test(target.pathname)) {
      target.pathname = `/inference/v1${target.pathname.replace(/\/$/, '')}`
    }
  }
  return target
}

function forwardHttp(req, res, body, id) {
  const target = resolveTarget(req)
  const isHttps = target.protocol === 'https:'
  const transport = isHttps ? https : http
  const prepared = isZenTarget(target) && req.method === 'POST'
    ? prepareZenBody(body, target)
    : { body, translate: false }
  const headers = isZenTarget(target)
    ? prepareZenHeaders(req.headers, target, prepared.body)
    : { ...req.headers }
  if (req.method === 'POST' && isZenChatTarget(target)) {
    headers.accept = 'text/event-stream'
  }

  if (!isZenTarget(target)) {
    delete headers.host
    delete headers.connection
    delete headers['proxy-connection']
    delete headers['transfer-encoding']
    headers.host = target.host
    headers['content-length'] = String(body.length)
  }

  logEvent({
    id,
    direction: 'request',
    method: req.method,
    target: target.toString(),
    headers: redactHeaders(headers),
    body: summarizeBody(prepared.body, headers['content-type'] || ''),
    ...(prepared.translate ? { translatedStream: true } : {}),
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

      if (prepared.translate && upstreamRes.statusCode === 200
        && String(upstreamRes.headers['content-type'] || '').includes('text/event-stream')) {
        collectSseResponse(upstreamRes, res, id, upstreamRes.headers)
        return
      }

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
      upstreamRes.on('data', (chunk) => {
        total += chunk.length
        if (!capped && total <= 64 * 1024 * 1024) {
          chunks.push(chunk)
        } else if (!capped) {
          capped = true
          chunks.length = 0
        }
      })
      upstreamRes.on('end', () => {
        const body = capped
          ? { bytes: total, truncated: true, reason: 'response_body exceeds 64MB log cap' }
          : summarizeBody(Buffer.concat(chunks), upstreamRes.headers['content-type'] || '')
        logEvent({
          id,
          direction: 'response_body',
          status: upstreamRes.statusCode,
          headers: redactHeaders(upstreamRes.headers),
          body,
        })
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

  upstream.end(prepared.body)
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
