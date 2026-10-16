package main

import (
	"crypto/rand"
	"encoding/hex"
	"net/http"
	"regexp"
	"strconv"
	"strings"
)

// headers.go —— 上游身份头重写（v2 指纹）。
//
// v2 真实抓包（../docs/分析-opencode-v2指纹与准入.md §二）与单变量实验（§三）确认：
//
//	必需：Authorization: Bearer public、UA opencode/<channel>/<version>/<artifact>、
//	      x-opencode-session（v2 算法铸造的 ses_）、body.stream=true、body.tools 含 read
//	禁止：x-opencode-request（msg_ 毒头，带上即 403，真实 v2 客户端也不发）
//	不校验：x-opencode-project / traceparent / b3 / system 内容
//
// v2 新增头组（会话 ID 同步到全部会话头，见 proxy.js prepareZenHeaders）：
//
//	x-opencode-session / x-opencode-session-id / x-session-affinity / x-session-id
//	traceparent（W3C TraceContext）+ b3（Zipkin B3），每请求新生成
//
// 注意：message/msg_ 映射仍保留在 store 与审计里（响应头 X-Proxy-Request、request_log），
// 但 v2 不再把它注入上游——这是 v1.x 与 v2 的关键差异之一。

// hop-by-hop 头（RFC 7230 §6.1）：只属于单跳连接，不得随转发复制。
var hopByHop = map[string]bool{
	"connection":          true,
	"keep-alive":          true,
	"proxy-authenticate":  true,
	"proxy-authorization": true,
	"te":                  true,
	"trailer":             true,
	"transfer-encoding":   true,
	"upgrade":             true,
}

// v2 毒头：带上即 403，入站一律丢弃且绝不注入。
var poisonHeaders = map[string]bool{
	"x-opencode-request": true,
}

// findKeySrc 按配置顺序取第一个非空 header，返回值与其来源名（小写）；
// 未命中时 source 为空。名称大小写不敏感由 http.Header.Get 处理。
func findKeySrc(h http.Header, names []string) (value, source string) {
	for _, n := range names {
		if v := strings.TrimSpace(h.Get(n)); v != "" {
			return v, strings.ToLower(n)
		}
	}
	return "", ""
}

// userAgentRe 同时接受 v2 四段 opencode/<channel>/<version>/<artifact>
// 与 1.x 两段 opencode/<version>（版本门槛 >= 1.18，与 proxy.js validUserAgent 一致）。
var userAgentRe = regexp.MustCompile(`(?i)opencode/(?:[^/]+/)?(\d+)\.(\d+)(?:\.(\d+))?(?:/[a-z]+)?`)

func validUserAgent(value string) bool {
	m := userAgentRe.FindStringSubmatch(value)
	if m == nil {
		return false
	}
	major, _ := strconv.Atoi(m[1])
	minor, _ := strconv.Atoi(m[2])
	return major > 1 || (major == 1 && minor >= 18)
}

// traceHeaders 生成 v2 链路头：W3C TraceContext + Zipkin B3，
// 与真实 v2 客户端一致——每次请求新 trace（proxy.js traceHeaders）。
func traceHeaders() (traceparent, b3 string) {
	var traceBytes [16]byte
	var spanBytes [8]byte
	_, _ = rand.Read(traceBytes[:])
	_, _ = rand.Read(spanBytes[:])
	traceID := hex.EncodeToString(traceBytes[:])
	spanID := hex.EncodeToString(spanBytes[:])
	return "00-" + traceID + "-" + spanID + "-01",
		traceID + "-" + spanID + "-1-" + spanID
}

// buildUpstreamHeaders 由入站请求构造 v2 上游请求头：
//   - 复制常规头（content-type / accept / 调用方自有头）
//   - 丢弃 hop-by-hop、host、content-length、user-agent、accept-encoding
//   - 丢弃客户端自带的一切 x-opencode-*（伪造/过期值）与 v2 毒头
//   - 注入 opencode v2 身份头：authorization / UA / 四个会话头 / traceparent + b3
//   - accept-encoding: identity（保证 SSE 原样字节流，不做透明解压）
//
// messageID 仅用于审计与响应观测头，不再注入上游（v2 禁 msg_ 头）。
func buildUpstreamHeaders(in http.Header, cfg *Config, sessionID string) http.Header {
	out := make(http.Header, len(in)+12)
	for k, vs := range in {
		lk := strings.ToLower(k)
		switch {
		case lk == "host" || lk == "content-length":
			continue
		case hopByHop[lk]:
			continue
		case poisonHeaders[lk]:
			continue // v2 毒头：带上即 403
		case strings.HasPrefix(lk, "x-opencode-"):
			continue // 客户端伪造/过期值一律丢弃，由代理统一生成
		case strings.HasPrefix(lk, "x-session-") || lk == "x-session-id":
			continue // 会话头由代理统一生成（避免调用方语义泄漏到上游头组）
		case lk == "user-agent":
			continue
		case lk == "accept-encoding":
			continue
		case lk == "traceparent" || lk == "b3":
			continue // 每次请求新生成
		}
		for _, v := range vs {
			out.Add(k, v)
		}
	}

	// UA：调用方自带合法 opencode UA 则保留，否则用配置值（同 proxy.js）。
	ua := in.Get("User-Agent")
	if !validUserAgent(ua) {
		ua = cfg.UpstreamHeaders.UserAgent
	}
	out.Set("User-Agent", ua)
	if cfg.UpstreamHeaders.Authorization != "" {
		out.Set("Authorization", cfg.UpstreamHeaders.Authorization)
	}
	if out.Get("Content-Type") == "" {
		out.Set("Content-Type", "application/json")
	}
	out.Set("Accept-Encoding", "identity")

	out.Set("X-OpenCode-Session", sessionID)
	out.Set("X-OpenCode-Session-Id", sessionID)
	out.Set("X-Session-Affinity", sessionID)
	out.Set("X-Session-Id", sessionID)
	out.Set("X-OpenCode-Client", cfg.UpstreamHeaders.Client)
	out.Set("X-OpenCode-Project", cfg.UpstreamHeaders.Project)

	traceparent, b3 := traceHeaders()
	out.Set("Traceparent", traceparent)
	out.Set("B3", b3)
	return out
}

// buildPassthroughHeaders 非免费道上游（普通转发）：只清 hop-by-hop 与
// host/content-length，其余头（含 authorization、x-*）原样透传。
// 与 proxy.js 的 `{ ...req.headers }` 分支一致。
func buildPassthroughHeaders(in http.Header) http.Header {
	out := make(http.Header, len(in))
	for k, vs := range in {
		lk := strings.ToLower(k)
		if lk == "host" || lk == "content-length" || hopByHop[lk] {
			continue
		}
		for _, v := range vs {
			out.Add(k, v)
		}
	}
	return out
}

// copyResponseHeaders 过滤 hop-by-hop 后复制上游响应头。
func copyResponseHeaders(dst http.Header, src http.Header) {
	for k, vs := range src {
		if hopByHop[strings.ToLower(k)] {
			continue
		}
		for _, v := range vs {
			dst.Add(k, v)
		}
	}
}
