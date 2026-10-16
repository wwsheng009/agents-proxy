package main

import (
	"bufio"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync/atomic"
	"testing"
)

func TestObservabilityProxyVia(t *testing.T) {
	proxyAddr, _ := startHTTPProxy(t)

	// 配置了代理：响应头 X-Proxy-Via 应回显代理地址，healthz 同步暴露。
	ts, _ := newTestProxyCfg(t, func(c *Config) {
		c.Proxy = ProxyConfig{URL: proxyAddr}
	})
	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json"}, testBody)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if got := resp.Header.Get("X-Proxy-Via"); got != proxyAddr {
		t.Errorf("X-Proxy-Via = %q, want %q", got, proxyAddr)
	}

	hzResp, err := http.Get(ts.URL + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer hzResp.Body.Close()
	var hz map[string]any
	if err := json.NewDecoder(hzResp.Body).Decode(&hz); err != nil {
		t.Fatal(err)
	}
	if hz["proxy_configured"] != proxyAddr || hz["proxy_effective"] != proxyAddr {
		t.Errorf("healthz 代理字段不符: %v", hz)
	}

	// 未配置代理（且不读环境变量）：应回 direct。
	ts2, _ := newTestProxyCfg(t, func(c *Config) {
		c.Proxy = ProxyConfig{FromEnv: false}
	})
	resp2 := post(t, ts2.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json"}, testBody)
	io.Copy(io.Discard, resp2.Body)
	resp2.Body.Close()
	if got := resp2.Header.Get("X-Proxy-Via"); got != "direct" {
		t.Errorf("未配置代理时 X-Proxy-Via = %q, want direct", got)
	}
}

func TestParseProxyURL(t *testing.T) {
	ok := []struct {
		in     string
		scheme string
		host   string
	}{
		{"http://127.0.0.1:10810", "http", "127.0.0.1:10810"},
		{"https://proxy.local:8443", "https", "proxy.local:8443"},
		{"socks5://127.0.0.1:1080", "socks5", "127.0.0.1:1080"},
		{"socks5h://127.0.0.1:1080", "socks5h", "127.0.0.1:1080"},
		{"socks://127.0.0.1:1080", "socks5", "127.0.0.1:1080"}, // 别名
		{"127.0.0.1:10810", "http", "127.0.0.1:10810"},         // 省略 scheme
		{"http://user:pass@127.0.0.1:10810", "http", "127.0.0.1:10810"},
	}
	for _, tc := range ok {
		u, err := parseProxyURL(tc.in)
		if err != nil {
			t.Errorf("parseProxyURL(%q) 报错: %v", tc.in, err)
			continue
		}
		if u.Scheme != tc.scheme || u.Host != tc.host {
			t.Errorf("parseProxyURL(%q) = %s://%s, want %s://%s",
				tc.in, u.Scheme, u.Host, tc.scheme, tc.host)
		}
	}

	bad := []string{"", "ftp://127.0.0.1:21", "socks4://127.0.0.1:1080", "http://", "://x"}
	for _, in := range bad {
		if _, err := parseProxyURL(in); err == nil {
			t.Errorf("parseProxyURL(%q) 期望报错，实际通过", in)
		}
	}
}

func TestNoProxyMatcher(t *testing.T) {
	m, err := newNoProxyMatcher([]string{"localhost", ".internal", "example.com:8080", "10.0.0.0/8", "::1"})
	if err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		host string
		want bool
	}{
		{"localhost", true},
		{"localhost:443", true},
		{"LOCALHOST", true},
		{"foo.internal", true},
		{"internal", true}, // 后缀条目匹配裸域名
		{"example.com:8080", true},
		{"example.com:9090", false}, // 端口不符
		{"sub.example.com:8080", true},
		{"10.1.2.3:443", true},
		{"11.1.2.3:443", false},
		{"[::1]:8788", true},
		{"opencode.ai:443", false},
	}
	for _, tc := range cases {
		if got := m.Match(tc.host); got != tc.want {
			t.Errorf("Match(%q) = %v, want %v", tc.host, got, tc.want)
		}
	}

	star, err := newNoProxyMatcher([]string{"*"})
	if err != nil {
		t.Fatal(err)
	}
	if !star.Match("anything.example") {
		t.Error("通配 * 应匹配任意主机")
	}

	if _, err := newNoProxyMatcher([]string{"10.0.0.0/33"}); err == nil {
		t.Error("非法 CIDR 期望报错")
	}
}

func TestProxyFuncSelection(t *testing.T) {
	// 无 url + from_env=false → 直连（nil func）
	pf, err := proxyFunc(ProxyConfig{FromEnv: false})
	if err != nil {
		t.Fatal(err)
	}
	if pf != nil {
		t.Error("from_env=false 且无 url 时应返回 nil（直连）")
	}

	// 无 url + from_env=true → 跟随环境变量
	pf, err = proxyFunc(ProxyConfig{FromEnv: true})
	if err != nil || pf == nil {
		t.Fatalf("from_env=true 应返回非 nil proxy func: %v", err)
	}

	// 显式 url → 返回该代理
	pf, err = proxyFunc(ProxyConfig{URL: "http://127.0.0.1:10810"})
	if err != nil {
		t.Fatal(err)
	}
	req, _ := http.NewRequest(http.MethodGet, "https://opencode.ai/inference/v1/models", nil)
	u, err := pf(req)
	if err != nil || u == nil || u.Host != "127.0.0.1:10810" {
		t.Fatalf("显式代理未生效: u=%v err=%v", u, err)
	}

	// 非法 url 在构造阶段即报错
	if _, err := proxyFunc(ProxyConfig{URL: "ftp://x:1"}); err == nil {
		t.Error("非法 scheme 期望报错")
	}
}

// startHTTPProxy 起一个最小 HTTP 正向代理（绝对 URI 转发），返回地址与命中计数。
func startHTTPProxy(t *testing.T) (string, *atomic.Int32) {
	t.Helper()
	var hits atomic.Int32
	rt := &http.Transport{Proxy: nil} // 代理自身直连，避免回环
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		outReq, err := http.NewRequest(r.Method, r.URL.String(), r.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		outReq.Header = r.Header.Clone()
		resp, err := rt.RoundTrip(outReq)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for k, vs := range resp.Header {
			for _, v := range vs {
				w.Header().Add(k, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
	}))
	t.Cleanup(ts.Close)
	return ts.URL, &hits
}

func TestHTTPProxyRouting(t *testing.T) {
	proxyAddr, hits := startHTTPProxy(t)

	ts, fu := newTestProxyCfg(t, func(c *Config) {
		c.Proxy = ProxyConfig{URL: proxyAddr}
	})

	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json", "X-Session-Id": "via-proxy"}, testBody)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("经 HTTP 代理转发失败 status=%d body=%s", resp.StatusCode, body)
	}
	if hits.Load() == 0 {
		t.Fatal("HTTP 代理未被命中，请求没有走代理")
	}
	if len(fu.reqs) != 1 || fu.at(0).path != "/zen/v1/chat/completions" {
		t.Fatalf("上游未收到经代理的请求: %+v", fu.reqs)
	}
}

func TestNoProxyBypassesProxy(t *testing.T) {
	proxyAddr, hits := startHTTPProxy(t)

	ts, fu := newTestProxyCfg(t, func(c *Config) {
		// 上游是 127.0.0.1，列入直连名单 → 不应经过代理
		c.Proxy = ProxyConfig{URL: proxyAddr, NoProxy: []string{"127.0.0.1"}}
	})

	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json"}, testBody)
	io.Copy(io.Discard, resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("直连转发失败 status=%d", resp.StatusCode)
	}
	if hits.Load() != 0 {
		t.Fatalf("no_proxy 命中却仍走了代理（hits=%d）", hits.Load())
	}
	if len(fu.reqs) != 1 {
		t.Fatalf("上游未收到直连请求: %+v", fu.reqs)
	}
}

func TestSOCKS5ProxyRouting(t *testing.T) {
	proxyAddr := startSOCKS5Proxy(t)

	ts, fu := newTestProxyCfg(t, func(c *Config) {
		c.Proxy = ProxyConfig{URL: "socks5://" + proxyAddr}
	})

	resp := post(t, ts.URL+"/v1/chat/completions",
		map[string]string{"Content-Type": "application/json", "X-Session-Id": "via-socks"}, testBody)
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("经 SOCKS5 代理转发失败 status=%d body=%s", resp.StatusCode, body)
	}
	if len(fu.reqs) != 1 || fu.at(0).path != "/zen/v1/chat/completions" {
		t.Fatalf("上游未收到经 SOCKS5 的请求: %+v", fu.reqs)
	}
}

// startSOCKS5Proxy 起一个最小 SOCKS5 服务端（无认证，仅 CONNECT），返回地址。
func startSOCKS5Proxy(t *testing.T) string {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return
			}
			go handleSOCKS5Conn(c)
		}
	}()
	return ln.Addr().String()
}

func handleSOCKS5Conn(c net.Conn) {
	defer c.Close()
	br := bufio.NewReader(c)

	// 握手：VER, NMETHODS, METHODS…
	greet := make([]byte, 2)
	if _, err := io.ReadFull(br, greet); err != nil || greet[0] != 0x05 {
		return
	}
	if _, err := io.ReadFull(br, make([]byte, int(greet[1]))); err != nil {
		return
	}
	if _, err := c.Write([]byte{0x05, 0x00}); err != nil { // 无需认证
		return
	}

	// 请求：VER, CMD, RSV, ATYP, DST.ADDR, DST.PORT
	head := make([]byte, 4)
	if _, err := io.ReadFull(br, head); err != nil || head[1] != 0x01 { // 仅 CONNECT
		return
	}
	var host string
	switch head[3] {
	case 0x01: // IPv4
		b := make([]byte, 4)
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = net.IP(b).String()
	case 0x03: // 域名
		l := make([]byte, 1)
		if _, err := io.ReadFull(br, l); err != nil {
			return
		}
		b := make([]byte, int(l[0]))
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = string(b)
	case 0x04: // IPv6
		b := make([]byte, 16)
		if _, err := io.ReadFull(br, b); err != nil {
			return
		}
		host = net.IP(b).String()
	default:
		return
	}
	pb := make([]byte, 2)
	if _, err := io.ReadFull(br, pb); err != nil {
		return
	}
	port := int(pb[0])<<8 | int(pb[1])

	target, err := net.Dial("tcp", net.JoinHostPort(host, strconv.Itoa(port)))
	if err != nil {
		_, _ = c.Write([]byte{0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0}) // 连接失败
		return
	}
	defer target.Close()
	if _, err := c.Write([]byte{0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0}); err != nil {
		return
	}

	done := make(chan struct{}, 2)
	go func() { _, _ = io.Copy(target, br); done <- struct{}{} }()
	go func() { _, _ = io.Copy(c, target); done <- struct{}{} }()
	<-done
}
