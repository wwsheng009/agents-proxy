package main

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

// 免费道路径判定（取自 proxy.js ZEN_PATH_RE / isZenChatTarget）。
// v2 起端点为 /inference/v1/*，v1 的 /zen/v1/* 仍在正则内以便自建镜像/重放。
var (
	zenLaneRe = regexp.MustCompile(`/(?:zen/v1|inference/v1)/(?:chat/completions|responses|messages|models)/?$`)
	zenChatRe = regexp.MustCompile(`/(?:zen/v1|inference/v1)/chat/completions/?$`)

	// OpenAI/Gemini 风格路径 → v2 inference 通道（同 proxy.js resolveTarget）。
	v1PathRe       = regexp.MustCompile(`^/v1(?:/|$)`)
	v1betaModelsRe = regexp.MustCompile(`^/v1beta/models/?$`)
	bareLaneRe     = regexp.MustCompile(`^/(?:chat/completions|responses|messages|models)/?$`)
)

// Proxy —— 独立转发服务：
//
//	入站任意程序请求（OpenAI 兼容） → 识别 session/message key
//	→ 稳定映射到 opencode 算法生成的上游 ses_/msg_（缓存 + SQLite）
//	→ 重写 header 后转发 → 响应（含 SSE 流）原样回放。
type Proxy struct {
	cfg               *Config
	store             *Store
	client            *http.Client
	upstream          *url.URL
	bodyTemplate      string
	bodyAgentTemplate string
	bodyTools         json.RawMessage
	bodyReadTool      json.RawMessage
}

func NewProxy(cfg *Config, store *Store) (*Proxy, error) {
	u, err := url.Parse(cfg.Upstream)
	if err != nil || u.Host == "" {
		return nil, fmt.Errorf("解析 upstream 失败: %q", cfg.Upstream)
	}
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 60 * time.Second // 只等响应头，不限制流式总时长
	p := &Proxy{
		cfg:      cfg,
		store:    store,
		client:   &http.Client{Transport: tr},
		upstream: u,
	}
	if cfg.BodyFixup.Mode == FixupModeInjectTemplate {
		tpl, err := LoadTemplate(cfg.BodyFixup.TemplateFile)
		if err != nil {
			return nil, err
		}
		p.bodyTemplate = tpl
		p.bodyAgentTemplate = loadOptionalText(cfg.BodyFixup.AgentTemplateFile)
		p.bodyTools = loadOptionalTools(cfg.BodyFixup.ToolsFile)
	} else if cfg.BodyFixup.Mode == FixupModeV2 {
		// v2 只需要 canonical 工具面里的 read 那一条（准入②）。
		p.bodyTools = loadOptionalTools(cfg.BodyFixup.ToolsFile)
		p.bodyReadTool = readToolFrom(p.bodyTools)
		if p.bodyReadTool == nil {
			slog.Warn("v2 模式未取到 read 工具，缺 read 的请求会被上游 403",
				"tools_file", cfg.BodyFixup.ToolsFile)
		}
	}
	return p, nil
}

// Handler 全部路由。
func (p *Proxy) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", p.healthz)
	mux.HandleFunc("/_sessions", p.sessions)
	mux.HandleFunc("/", p.forward)
	return mux
}

func (p *Proxy) healthz(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "upstream": p.cfg.Upstream})
}

// sessions 查看映射（本地调试用；默认只监听 127.0.0.1）。
func (p *Proxy) sessions(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	list, err := p.store.ListSessions(200)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"count": len(list), "sessions": list})
}

// forward 核心转发逻辑。
func (p *Proxy) forward(w http.ResponseWriter, r *http.Request) {
	setCORS(w, r)
	if r.Method == http.MethodOptions {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	start := time.Now()

	// 1) 识别入站 key：按 session.headers / message.headers 配置顺序取第一个非空
	//    （入口名单可配置，可把原生 x-opencode-session / x-opencode-request 配进来）
	sessionKey, _ := findKeySrc(r.Header, p.cfg.Session.Headers)
	if sessionKey == "" {
		sessionKey = p.cfg.Session.FallbackKey
	}
	messageKey, _ := findKeySrc(r.Header, p.cfg.Message.Headers) // 可为空

	// 2) 稳定映射：同一入站 session → 同一上游 ses_；message 同理（按会话分域）。
	//    passthrough_native 且值已符合上游结构 → 首次建立映射时优先按原值透传；
	//    既有映射永远优先（稳定性不变）。
	var preferSession, preferMessage string
	if p.cfg.Session.PassthroughNative && IsNativeSessionID(sessionKey) {
		preferSession = sessionKey
	}
	upSession, err := p.store.MapSessionPreferred(sessionKey, preferSession)
	if err != nil {
		slog.Error("map session", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "session map: " + err.Error()})
		return
	}
	var upMessage string
	if messageKey != "" {
		if p.cfg.Message.PassthroughNative && IsNativeMessageID(messageKey) {
			preferMessage = messageKey
		}
		upMessage, err = p.store.MapMessagePreferred(sessionKey, messageKey, preferMessage)
	} else {
		upMessage, err = p.store.NewMessageIDFresh()
	}
	if err != nil {
		slog.Error("map message", "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{"error": "message map: " + err.Error()})
		return
	}

	// 3) 判定免费道目标：v2 身份头与 body 修正只对道内端点生效（同 proxy.js）。
	target := p.resolveTarget(r)
	zen := p.isZenTarget(target)
	zenChat := zen && zenChatRe.MatchString(target.Path)

	// body 处理（mode=off 流式字节不动；v2 只对道内 chat 端点生效；
	// 遗留 inject_template 保持历史全局行为）+ 构造上游请求
	mode := p.cfg.BodyFixup.Mode
	if mode == FixupModeV2 && !zenChat {
		mode = FixupModeOff
	}
	bodyReader, bodyLen, translateResp, err := prepareBodyWith(
		r, mode, p.bodyTemplate, p.bodyAgentTemplate, p.bodyTools, p.bodyReadTool,
	)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		p.logRequest(r, sessionKey, upSession, messageKey, upMessage, http.StatusBadRequest, start)
		return
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target.String(), bodyReader)
	if err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"error": err.Error()})
		return
	}
	req.ContentLength = bodyLen // >0 保长度；-1 保持 chunked
	if zen {
		req.Header = buildUpstreamHeaders(r.Header, p.cfg, upSession)
		if r.Method == http.MethodPost && zenChat {
			req.Header.Set("Accept", "text/event-stream")
		}
	} else {
		req.Header = buildPassthroughHeaders(r.Header)
	}

	// 4) 发送
	resp, err := p.client.Do(req)
	if err != nil {
		slog.Error("upstream request failed", "target", target.String(), "err", err)
		writeJSON(w, http.StatusBadGateway, map[string]any{
			"error": map[string]string{"message": "upstream request failed: " + err.Error(), "type": "proxy_error"},
		})
		p.logRequest(r, sessionKey, upSession, messageKey, upMessage, http.StatusBadGateway, start)
		return
	}
	defer resp.Body.Close()

	// 5) 响应头（先复制上游，再盖代理观测头）
	copyResponseHeaders(w.Header(), resp.Header)
	w.Header().Set("X-Proxy-Session", upSession)
	w.Header().Set("X-Proxy-Request", upMessage)

	// 5.5) 非流式调用方 + 代理强制了上游流式 → SSE 组装回 JSON（对外契约不变）
	if translateResp && resp.StatusCode == http.StatusOK &&
		strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		all, readErr := io.ReadAll(resp.Body)
		if readErr == nil {
			w.Header().Del("Content-Length")
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusOK)
			_, _ = w.Write(assembleCompletion(all))
			p.logRequest(r, sessionKey, upSession, messageKey, upMessage, resp.StatusCode, start)
			return
		}
		// 读失败 → 降级走下方原流式回放
	}

	w.WriteHeader(resp.StatusCode)

	// 6) 流式回放（SSE 每块即写即刷）
	buf := make([]byte, 32*1024)
	for {
		n, readErr := resp.Body.Read(buf)
		if n > 0 {
			if _, writeErr := w.Write(buf[:n]); writeErr != nil {
				break // 客户端断开
			}
			if f, ok := w.(http.Flusher); ok {
				f.Flush()
			}
		}
		if readErr != nil {
			break
		}
	}

	p.logRequest(r, sessionKey, upSession, messageKey, upMessage, resp.StatusCode, start)
}

// resolveTarget = upstream base.Path +（去前缀后的）入站 path + 原样 query，
// 并在 zen_compat 下把裸 OpenAI/Gemini 风格路径改写到 v2 inference 通道
// （同 proxy.js resolveTarget：已带 /zen/ 或 /inference/ 命名空间的路径原样保留）。
func (p *Proxy) resolveTarget(r *http.Request) *url.URL {
	path := r.URL.Path
	if sp := p.cfg.StripPrefix; sp != "" && strings.HasPrefix(path, sp) {
		path = strings.TrimPrefix(path, sp)
		if path == "" || path[0] != '/' {
			path = "/" + path
		}
	}
	u := *p.upstream
	u.Path = strings.TrimSuffix(u.Path, "/") + path
	u.RawPath = ""
	u.RawQuery = r.URL.RawQuery

	// 仅对 opencode.ai 主机做通道改写，避免把别的上游的 /v1/* 也搬进 inference。
	if p.cfg.ZenCompat && u.Hostname() == "opencode.ai" &&
		!strings.HasPrefix(u.Path, "/zen/") && !strings.HasPrefix(u.Path, "/inference/") {
		switch {
		case v1PathRe.MatchString(u.Path):
			u.Path = "/inference" + u.Path
		case v1betaModelsRe.MatchString(u.Path):
			u.Path = "/inference/v1/models"
		case bareLaneRe.MatchString(u.Path):
			u.Path = "/inference/v1" + strings.TrimSuffix(u.Path, "/")
		}
	}
	return &u
}

func (p *Proxy) upstreamURL(r *http.Request) string {
	return p.resolveTarget(r).String()
}

// isZenTarget 判定最终上游 URL 是否走 opencode 免费道。
// Node 版另要求 host==opencode.ai；Go 版把“道内路径”本身作为判据，
// 使指向自建镜像/重放的 upstream 也能复用同一套 v2 身份头与 body 修正。
func (p *Proxy) isZenTarget(u *url.URL) bool {
	return p.cfg.ZenCompat && zenLaneRe.MatchString(u.Path)
}

func (p *Proxy) logRequest(r *http.Request, sessKey, upSess, msgKey, upMsg string, status int, start time.Time) {
	dur := time.Since(start)
	sessionVia, _ := findKeySrc(r.Header, p.cfg.Session.Headers)
	messageVia, _ := findKeySrc(r.Header, p.cfg.Message.Headers)
	slog.Info("proxy",
		"method", r.Method, "path", r.URL.Path, "status", status,
		"session", sessKey, "session_via", sessionVia, "upstream_session", upSess,
		"message", msgKey, "message_via", messageVia, "upstream_message", upMsg,
		"duration_ms", dur.Milliseconds())
	if !p.cfg.Log.Requests {
		return
	}
	if err := p.store.LogRequest(RequestRecord{
		TS:              start.UnixMilli(),
		Method:          r.Method,
		Path:            r.URL.Path,
		SessionKey:      sessKey,
		UpstreamSession: upSess,
		MessageKey:      msgKey,
		UpstreamMessage: upMsg,
		Status:          status,
		DurationMS:      dur.Milliseconds(),
	}); err != nil {
		slog.Error("write request_log", "err", err)
	}
}

// setCORS 允许任意本地/局域网程序（浏览器工具）直连。
func setCORS(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "*")
	w.Header().Set("Access-Control-Expose-Headers", "X-Proxy-Session, X-Proxy-Request")
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
