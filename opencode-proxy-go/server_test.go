package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"testing"
	"time"
)

type recorded struct {
	path          string
	headers       http.Header
	body          []byte
	contentLength int64
}

// fakeUpstream 模拟 opencode zen：JSON 回显 / SSE 流 / 403 拒绝。
// 路由改用 X-Test-Mode 头（道内路径形状固定为 /…/v1/chat/completions，
// 不能再靠 "/sse" 之类的后缀区分）。
type fakeUpstream struct {
	mu   sync.Mutex
	reqs []recorded
}

func (f *fakeUpstream) record(r *recorded) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.reqs = append(f.reqs, *r)
}

func (f *fakeUpstream) at(i int) recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqs[i]
}

func (f *fakeUpstream) handle(w http.ResponseWriter, r *http.Request) {
	body, _ := io.ReadAll(r.Body)
	f.record(&recorded{path: r.URL.Path, headers: r.Header.Clone(), body: body, contentLength: r.ContentLength})

	switch r.Header.Get("X-Test-Mode") {
	case "deny":
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		_, _ = io.WriteString(w, `{"error":{"type":"FreeTierError","message":"nope"}}`)
		return
	case "sse":
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		fl, _ := w.(http.Flusher)
		events := []string{
			`data: {"n":1,"ses":"` + r.Header.Get("X-OpenCode-Session") + `"}`,
			`data: {"n":2}`,
			`data: [DONE]`,
		}
		for _, ev := range events {
			fmt.Fprintf(w, "%s\n\n", ev)
			fl.Flush()
		}
		return
	}
	w.Header().Set("Content-Type", "application/json")
	fmt.Fprintf(w,
		`{"session":%q,"session_id":%q,"affinity":%q,"client":%q,"project":%q,"ua":%q,"path":%q,"body_len":%d,"request":%q}`,
		r.Header.Get("X-OpenCode-Session"), r.Header.Get("X-OpenCode-Session-Id"),
		r.Header.Get("X-Session-Affinity"), r.Header.Get("X-OpenCode-Client"),
		r.Header.Get("X-OpenCode-Project"), r.Header.Get("User-Agent"), r.URL.Path,
		len(body), r.Header.Get("X-OpenCode-Request"))
}

// newTestProxy 起假上游 + 真代理（httptest）。
func newTestProxy(t *testing.T) (*httptest.Server, *fakeUpstream) {
	return newTestProxyCfg(t, nil)
}

func newTestProxyCfg(t *testing.T, mutate func(*Config)) (*httptest.Server, *fakeUpstream) {
	t.Helper()
	fu := &fakeUpstream{}
	up := httptest.NewServer(http.HandlerFunc(fu.handle))
	t.Cleanup(up.Close)

	cfg := DefaultConfig()
	cfg.Upstream = up.URL + "/zen"
	cfg.DBPath = filepath.Join(t.TempDir(), "proxy.db")
	if mutate != nil {
		mutate(&cfg)
	}

	store, err := OpenStore(cfg.DBPath)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { store.Close() })

	p, err := NewProxy(&cfg, store)
	if err != nil {
		t.Fatal(err)
	}
	ts := httptest.NewServer(p.Handler())
	t.Cleanup(ts.Close)
	return ts, fu
}

var (
	sesRe = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	msgRe = regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
)

func post(t *testing.T, url string, headers map[string]string, body string) *http.Response {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

const testBody = `{"model":"mimo-v2.5-free","messages":[{"role":"user","content":"hi"}],"stream":true}`

// 核心：session 稳定映射 + header 重写 + body/path 透传。
func TestForwardRewritesHeadersAndStableSession(t *testing.T) {
	ts, fu := newTestProxy(t)
	h := func(extra map[string]string) map[string]string {
		base := map[string]string{"Content-Type": "application/json"}
		for k, v := range extra {
			base[k] = v
		}
		return base
	}

	// alpha 会话两连发 + 客户端伪造 x-opencode-session 应被替换
	resp1 := post(t, ts.URL+"/v1/chat/completions", h(map[string]string{
		"X-Session-Id":       "alpha",
		"X-Message-Id":       "turn-1",
		"X-OpenCode-Session": "ses_intruder_0000000000abcdefghijklmn", // 伪造值必须被替换
		"X-Custom-Trace":     "abc",
	}), testBody)
	body1, _ := io.ReadAll(resp1.Body)
	resp1.Body.Close()
	if resp1.StatusCode != 200 {
		t.Fatalf("req1 status %d: %s", resp1.StatusCode, body1)
	}

	resp2 := post(t, ts.URL+"/v1/chat/completions", h(map[string]string{
		"X-Session-Id": "alpha",
		"X-Message-Id": "turn-1",
	}), testBody)
	io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()

	resp3 := post(t, ts.URL+"/v1/chat/completions", h(map[string]string{"X-Session-Id": "beta"}), testBody)
	io.Copy(io.Discard, resp3.Body)
	resp3.Body.Close()

	// 无 session 头 → fallback_key 桶
	resp4 := post(t, ts.URL+"/v1/chat/completions", h(nil), testBody)
	io.Copy(io.Discard, resp4.Body)
	resp4.Body.Close()
	resp5 := post(t, ts.URL+"/v1/chat/completions", h(nil), testBody)
	io.Copy(io.Discard, resp5.Body)
	resp5.Body.Close()

	r1, r2, r3, r4, r5 := fu.at(0), fu.at(1), fu.at(2), fu.at(3), fu.at(4)

	traceRe := regexp.MustCompile(`^00-[0-9a-f]{32}-[0-9a-f]{16}-01$`)
	for i, rec := range []recorded{r1, r2, r3, r4, r5} {
		s := rec.headers.Get("X-OpenCode-Session")
		if !sesRe.MatchString(s) {
			t.Errorf("req%d 上游 session 结构非法: %q", i+1, s)
		}
		if s == "ses_intruder_0000000000abcdefghijklmn" {
			t.Errorf("req%d 伪造 x-opencode-session 未被替换", i+1)
		}
		// v2 头组：会话 ID 同步到四个会话头；traceparent/b3 每请求新生成。
		for _, name := range []string{"X-OpenCode-Session-Id", "X-Session-Affinity", "X-Session-Id"} {
			if got := rec.headers.Get(name); got != s {
				t.Errorf("req%d %s=%q 与 session %q 不一致", i+1, name, got, s)
			}
		}
		if tp := rec.headers.Get("Traceparent"); !traceRe.MatchString(tp) {
			t.Errorf("req%d traceparent 结构非法: %q", i+1, tp)
		}
		if rec.headers.Get("B3") == "" {
			t.Errorf("req%d 缺 b3 头", i+1)
		}
		// v2 毒头：客户端发或不发，都绝不上行。
		if got := rec.headers.Get("X-OpenCode-Request"); got != "" {
			t.Errorf("req%d x-opencode-request 是毒头，不应上行: %q", i+1, got)
		}
		if rec.headers.Get("User-Agent") != DefaultConfig().UpstreamHeaders.UserAgent {
			t.Errorf("req%d UA 未被覆盖: %q", i+1, rec.headers.Get("User-Agent"))
		}
		if rec.headers.Get("Authorization") != "Bearer public" {
			t.Errorf("req%d authorization 错误: %q", i+1, rec.headers.Get("Authorization"))
		}
		if rec.headers.Get("X-OpenCode-Client") != "cli" || rec.headers.Get("X-OpenCode-Project") != "global" {
			t.Errorf("req%d client/project 缺失: %v", i+1, rec.headers)
		}
		// v2 body 修正：强制 stream:true + 补齐 read 工具（前插，保序）。
		var up struct {
			Stream bool `json:"stream"`
			Tools  []struct {
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if err := json.Unmarshal(rec.body, &up); err != nil {
			t.Fatalf("req%d 上游 body 非 JSON: %v\n%s", i+1, err, rec.body)
		}
		if !up.Stream {
			t.Errorf("req%d 上游 body 未强制 stream:true: %s", i+1, rec.body)
		}
		names := make([]string, 0, len(up.Tools))
		for _, tl := range up.Tools {
			names = append(names, tl.Function.Name)
		}
		if len(names) == 0 || names[0] != "read" {
			t.Errorf("req%d 上游 tools 未以 read 打头: %v", i+1, names)
		}
		if rec.contentLength != int64(len(rec.body)) {
			t.Errorf("req%d content-length 与实际 body 不符: %d vs %d", i+1, rec.contentLength, len(rec.body))
		}
		if rec.path != "/zen/v1/chat/completions" {
			t.Errorf("req%d 路径拼接错误: %s", i+1, rec.path)
		}
	}

	// 稳定性：alpha 两连发同 session；beta 不同；fallback 桶稳定
	if r1.headers.Get("X-OpenCode-Session") != r2.headers.Get("X-OpenCode-Session") {
		t.Errorf("同 key(alpha) 两次请求上游 session 不一致")
	}
	if r3.headers.Get("X-OpenCode-Session") == r1.headers.Get("X-OpenCode-Session") {
		t.Errorf("不同 key(alpha/beta) 映射到同一上游 session")
	}
	if r4.headers.Get("X-OpenCode-Session") != r5.headers.Get("X-OpenCode-Session") {
		t.Errorf("fallback 桶两次请求不一致")
	}
	// message 映射仍由代理内部维护（v2 不再上行 msg_ 头），经响应观测头验证。
	if got := resp1.Header.Get("X-Proxy-Request"); !msgRe.MatchString(got) {
		t.Errorf("X-Proxy-Request 结构非法: %q", got)
	}
	if resp2.Header.Get("X-Proxy-Request") != resp1.Header.Get("X-Proxy-Request") {
		t.Errorf("同 message key 两次请求上游 msg 不一致")
	}
	if resp3.Header.Get("X-Proxy-Request") == resp4.Header.Get("X-Proxy-Request") {
		t.Errorf("无 message key 的两次请求应生成不同 msg")
	}
	// 客户端自定义头透传
	if r1.headers.Get("X-Custom-Trace") != "abc" {
		t.Errorf("自定义头未透传")
	}
	// 响应观测头 = 上游实际 session
	if got := resp1.Header.Get("X-Proxy-Session"); got != r1.headers.Get("X-OpenCode-Session") {
		t.Errorf("X-Proxy-Session=%q 与上游 session %q 不一致", got, r1.headers.Get("X-OpenCode-Session"))
	}
	if strings.Contains(string(body1), r1.headers.Get("X-OpenCode-Session")) == false {
		t.Errorf("回显 body 未包含上游 session: %s", body1)
	}
}

// SSE 流式透传（字节原样、含 [DONE]）。
func TestSSERelay(t *testing.T) {
	ts, fu := newTestProxy(t)
	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"X-Session-Id": "sse-1", "X-Test-Mode": "sse"}, testBody)
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("content-type: %s", ct)
	}
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatal(err)
	}
	s := string(body)
	if !strings.Contains(s, `"n":1`) || !strings.Contains(s, "data: [DONE]") {
		t.Errorf("SSE 内容不完整: %q", s)
	}
	upSess := fu.at(0).headers.Get("X-OpenCode-Session")
	if !strings.Contains(s, upSess) {
		t.Errorf("SSE 事件未携带上游 session")
	}
}

// 错误状态与 body 原样透传。
func TestStatusPassthrough(t *testing.T) {
	ts, _ := newTestProxy(t)
	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"X-Session-Id": "d1", "X-Test-Mode": "deny"}, testBody)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != http.StatusForbidden {
		t.Errorf("status: %d", resp.StatusCode)
	}
	if !strings.Contains(string(body), "FreeTierError") {
		t.Errorf("错误 body 未透传: %s", body)
	}
	if resp.Header.Get("X-Proxy-Session") == "" {
		t.Errorf("错误响应也应带 X-Proxy-Session")
	}
}

// CORS 预检。
func TestCORSPreflight(t *testing.T) {
	ts, _ := newTestProxy(t)
	req, _ := http.NewRequest(http.MethodOptions, ts.URL+"/v1/chat/completions", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Errorf("OPTIONS status: %d", resp.StatusCode)
	}
	if resp.Header.Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("CORS 头缺失")
	}
}

// strip_prefix + query 拼接。
func TestUpstreamURLJoin(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Upstream = "https://opencode.ai/zen/"
	cfg.StripPrefix = "/proxy"
	p, err := NewProxy(&cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest(http.MethodPost, "http://local/proxy/v1/chat/completions?foo=bar", nil)
	got := p.upstreamURL(r)
	want := "https://opencode.ai/zen/v1/chat/completions?foo=bar"
	if got != want {
		t.Errorf("upstreamURL: got %s want %s", got, want)
	}
}

// live catalog 的新推理地址必须反向重写回 Console 兼容层 /zen/*。
// 匿名免费道走 /inference/* 直连会被判 403 FreeTierError；兼容层会剥掉 Bearer public。
func TestUpstreamURLRewritesInferenceCompat(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Upstream = "https://opencode.ai"
	p, err := NewProxy(&cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct{ in, want string }{
		// opencode provider（live catalog: /inference/openai/v1）
		{"/inference/openai/v1/chat/completions", "https://opencode.ai/zen/v1/chat/completions"},
		{"/inference/openai/v1/responses", "https://opencode.ai/zen/v1/responses"},
		{"/inference/anthropic/v1/messages", "https://opencode.ai/zen/v1/messages"},
		{"/inference/systemone/v1/systemone", "https://opencode.ai/zen/v1/systemone"},
		{"/inference/google/v1beta/models/gemini-3:generateContent", "https://opencode.ai/zen/v1/models/gemini-3:generateContent"},
		// opencode-go provider（live catalog: /inference/go/openai/v1）
		{"/inference/go/openai/v1/chat/completions", "https://opencode.ai/zen/go/v1/chat/completions"},
		{"/inference/go/openai/v1/responses", "https://opencode.ai/zen/go/v1/responses"},
		{"/inference/go/anthropic/v1/messages", "https://opencode.ai/zen/go/v1/messages"},
		{"/inference/go/v1/models", "https://opencode.ai/zen/go/v1/models"},
		// 既有路径保持原样
		{"/zen/v1/chat/completions", "https://opencode.ai/zen/v1/chat/completions"},
		{"/zen/go/v1/chat/completions", "https://opencode.ai/zen/go/v1/chat/completions"},
		// 旧 /inference/v1/* 匿名直连已 403 → 也重写回兼容层
		{"/inference/v1/chat/completions", "https://opencode.ai/zen/v1/chat/completions"},
		{"/inference/v1/models", "https://opencode.ai/zen/v1/models"},
		// 裸 OpenAI 路径（客户端 baseURL /v1/chat/completions）→ 兼容层
		{"/v1/chat/completions", "https://opencode.ai/zen/v1/chat/completions"},
		{"/v1/models", "https://opencode.ai/zen/v1/models"},
		{"/v1beta/models", "https://opencode.ai/zen/v1/models"},
	}
	for _, c := range cases {
		r := httptest.NewRequest(http.MethodPost, "http://local"+c.in, nil)
		if got := p.upstreamURL(r); got != c.want {
			t.Errorf("resolveTarget(%s): got %s want %s", c.in, got, c.want)
		}
	}
}

// 新路径重写后必须被识别为免费道，否则不会注入 v2 身份头（UA/session/client/project/trace）。
func TestIsZenTargetInferenceCompat(t *testing.T) {
	cfg := DefaultConfig()
	cfg.Upstream = "https://opencode.ai"
	p, err := NewProxy(&cfg, nil)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/inference/openai/v1/chat/completions",
		"/inference/openai/v1/responses",
		"/inference/anthropic/v1/messages",
		"/inference/go/openai/v1/chat/completions",
		"/zen/go/v1/chat/completions",
		"/zen/v1/models/gemini-3:generateContent",
	} {
		r := httptest.NewRequest(http.MethodPost, "http://local"+path, nil)
		target := p.resolveTarget(r)
		if !p.isZenTarget(target) {
			t.Errorf("path %s -> %s 未识别为免费道", path, target.Path)
		}
		if strings.HasSuffix(target.Path, "/chat/completions") && !zenChatRe.MatchString(target.Path) {
			t.Errorf("path %s -> %s 未识别为 chat 修正目标", path, target.Path)
		}
	}
}

// 注入模式端到端：极简非流式调用方 → 代理注入模板 + 强制 stream →
// 假上游回 SSE → 代理组装回 JSON；断言上游 body 已合规、对外契约非流式。
func TestE2EFixupTranslatesSSEToJSON(t *testing.T) {
	ts, fu := newTestProxyCfg(t, func(cfg *Config) {
		cfg.BodyFixup = BodyFixupConfig{Mode: FixupModeInjectTemplate, TemplateFile: "opencode_system_prompt.txt"}
	})
	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"X-Session-Id": "fix-e2e", "X-Test-Mode": "sse"},
		`{"model":"m","messages":[{"role":"user","content":"hi"}]}`)
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)

	up := fu.at(0)
	if !strings.Contains(string(up.body), templateMarker) {
		t.Errorf("上游 body 未含模板: %.150s", up.body)
	}
	if !strings.Contains(string(up.body), `"stream":true`) {
		t.Errorf("上游 body 未强制 stream:true: %.150s", up.body)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("对外应为 JSON: %s", ct)
	}
	var parsed struct {
		Object  string `json:"object"`
		Cost    string `json:"cost"`
		Choices []any  `json:"choices"`
	}
	if err := json.Unmarshal(body, &parsed); err != nil {
		t.Fatalf("非 JSON 响应: %v %s", err, body)
	}
	if parsed.Object != "chat.completion" || len(parsed.Choices) == 0 {
		t.Errorf("组装结果异常: %s", body)
	}
	if resp.Header.Get("X-Proxy-Session") == "" {
		t.Errorf("缺 X-Proxy-Session")
	}
}

// 原生入口透传：结构合法的 x-opencode-session 原样到达上游（不重映射），
// 第二发仍稳定同一值；x-opencode-request 是 v2 毒头，绝不上行。
func TestNativeSessionPassthrough(t *testing.T) {
	ts, fu := newTestProxy(t)
	ses, err := NewSessionID(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := NewMessageID(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	h := map[string]string{
		"Content-Type":       "application/json",
		"X-OpenCode-Session": ses,
		"X-OpenCode-Request": msg,
	}
	resp := post(t, ts.URL+"/v1/chat/completions", h, testBody)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if got := fu.at(0).headers.Get("X-OpenCode-Session"); got != ses {
		t.Errorf("原生 session 未透传: got %q want %q", got, ses)
	}
	// v2：毒头必须剥离——客户端带了也不能上行。
	if got := fu.at(0).headers.Get("X-OpenCode-Request"); got != "" {
		t.Errorf("x-opencode-request 毒头不应上行: got %q", got)
	}
	// 代理内部仍为该请求维护 msg，经响应观测头暴露。
	if got := resp.Header.Get("X-Proxy-Request"); !msgRe.MatchString(got) {
		t.Errorf("X-Proxy-Request 结构非法: %q", got)
	}
	if got := resp.Header.Get("X-Proxy-Session"); got != ses {
		t.Errorf("X-Proxy-Session=%q want %q", got, ses)
	}

	resp2 := post(t, ts.URL+"/v1/chat/completions", h, testBody)
	io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()
	if got := fu.at(1).headers.Get("X-OpenCode-Session"); got != ses {
		t.Errorf("第二发 session 漂移: %q", got)
	}
}

// 入口优先级：配置顺序决定——x-session-id 先于 x-opencode-session，
// 后者即使结构合法也不被采用（优先级只看顺序，不看值）。
func TestInboundHeaderPrecedence(t *testing.T) {
	ts, fu := newTestProxy(t)
	ses, err := NewSessionID(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	resp := post(t, ts.URL+"/v1/chat/completions", map[string]string{
		"Content-Type":       "application/json",
		"X-Session-Id":       "prec-key",
		"X-OpenCode-Session": ses,
	}, testBody)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	up := fu.at(0).headers.Get("X-OpenCode-Session")
	if up == ses {
		t.Errorf("应按配置顺序取 x-session-id 并重映射，而不是采用原生头值")
	}
	if !sesRe.MatchString(up) {
		t.Errorf("上游 session 结构非法: %q", up)
	}

	resp2 := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json", "X-Session-Id": "prec-key"}, testBody)
	io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()
	if fu.at(1).headers.Get("X-OpenCode-Session") != up {
		t.Errorf("同 key 稳定映射被原生头破坏")
	}
}

// passthrough_native=false → 原生头值结构合法也一律重映射。
func TestNativePassthroughDisabled(t *testing.T) {
	ts, fu := newTestProxyCfg(t, func(cfg *Config) {
		cfg.Session.PassthroughNative = false
		cfg.Message.PassthroughNative = false
	})
	ses, err := NewSessionID(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	msg, err := NewMessageID(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	resp := post(t, ts.URL+"/v1/chat/completions", map[string]string{
		"Content-Type":       "application/json",
		"X-OpenCode-Session": ses,
		"X-OpenCode-Request": msg,
	}, testBody)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if got := fu.at(0).headers.Get("X-OpenCode-Session"); got == ses || !sesRe.MatchString(got) {
		t.Errorf("passthrough 关闭时 session 应重映射: got %q", got)
	}
	// v2 毒头一律剥离，无法从上游头观测 msg；改用响应观测头。
	if got := fu.at(0).headers.Get("X-OpenCode-Request"); got != "" {
		t.Errorf("x-opencode-request 毒头不应上行: got %q", got)
	}
	if got := resp.Header.Get("X-Proxy-Request"); got == msg || !msgRe.MatchString(got) {
		t.Errorf("passthrough 关闭时 message 应重映射: got %q", got)
	}
}
