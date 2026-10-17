package main

import (
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// buildTransport 构造发往上游的 HTTP transport。
//
// 代理支持 http / https / socks5 / socks5h —— 这几种 scheme 由 net/http
// 的 Transport 原生实现（socks5 与 socks5h 等价，均为代理端解析域名），
// 因此无需引入 golang.org/x/net/proxy 之类的额外依赖。
// 其余连接池参数沿用 http.DefaultTransport。
// 同时返回生效的代理判定函数（nil = 直连），供可观测性使用
// （X-Proxy-Via 响应头 / 请求日志 / healthz）。
func buildTransport(cfg *Config) (*http.Transport, func(*http.Request) (*url.URL, error), error) {
	tr := http.DefaultTransport.(*http.Transport).Clone()
	tr.ResponseHeaderTimeout = 60 * time.Second // 只等响应头，不限制流式总时长

	pf, err := proxyFunc(cfg.Proxy)
	if err != nil {
		return nil, nil, err
	}
	tr.Proxy = pf
	return tr, pf, nil
}

// proxyFunc 依据配置返回 Transport.Proxy：
//
//	proxy.url 非空            → 走显式代理（no_proxy 命中时直连）
//	proxy.url 空 且 from_env  → 读 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（历史默认行为）
//	两者都不满足              → 直连（显式置 nil，避免继承进程环境变量）
func proxyFunc(pc ProxyConfig) (func(*http.Request) (*url.URL, error), error) {
	if strings.TrimSpace(pc.URL) == "" {
		if pc.FromEnv {
			return http.ProxyFromEnvironment, nil
		}
		return nil, nil
	}
	u, err := parseProxyURL(pc.URL)
	if err != nil {
		return nil, err
	}
	if len(pc.NoProxy) == 0 {
		return http.ProxyURL(u), nil
	}
	m, err := newNoProxyMatcher(pc.NoProxy)
	if err != nil {
		return nil, err
	}
	return func(req *http.Request) (*url.URL, error) {
		if m.Match(req.URL.Host) {
			return nil, nil // 命中直连名单
		}
		return u, nil
	}, nil
}

// parseProxyURL 解析并校验代理地址。
// 允许省略 scheme（默认 http://）；socks 作为 socks5 的别名。
// 认证信息可内嵌：http://user:pass@host:port、socks5://user:pass@host:port。
func parseProxyURL(raw string) (*url.URL, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, fmt.Errorf("代理地址为空")
	}
	if !strings.Contains(raw, "://") {
		raw = "http://" + raw
	}
	u, err := url.Parse(raw)
	if err != nil {
		return nil, fmt.Errorf("解析代理地址 %q 失败: %w", raw, err)
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https", "socks5", "socks5h":
		// 原生支持
	case "socks":
		u.Scheme = "socks5" // 别名
	default:
		return nil, fmt.Errorf("不支持的代理 scheme %q（可用 http/https/socks5/socks5h）", u.Scheme)
	}
	if u.Host == "" || u.Hostname() == "" {
		return nil, fmt.Errorf("代理地址缺少主机: %q", raw)
	}
	return u, nil
}

// noProxyMatcher 实现 no_proxy 直连名单匹配（不支持时自行实现，
// 语义对齐常见约定：* / 域名（含子域）/ host:port / IP / CIDR）。
type noProxyMatcher struct {
	all     bool
	entries []noProxyEntry
}

type noProxyEntry struct {
	host   string     // 归一化主机：域名小写；IP 为 net.IP.String()
	port   string     // 非空则要求端口一致
	suffix bool       // 域名后缀匹配（匹配该域名及其子域）
	ipnet  *net.IPNet // CIDR 条目
}

func newNoProxyMatcher(patterns []string) (*noProxyMatcher, error) {
	m := &noProxyMatcher{}
	for _, raw := range patterns {
		p := strings.TrimSpace(raw)
		if p == "" {
			continue
		}
		if p == "*" {
			m.all = true
			continue
		}
		entry := noProxyEntry{}

		// CIDR
		if strings.Contains(p, "/") {
			_, ipnet, err := net.ParseCIDR(p)
			if err != nil {
				return nil, fmt.Errorf("no_proxy 条目 %q 不是合法 CIDR: %w", raw, err)
			}
			entry.ipnet = ipnet
			m.entries = append(m.entries, entry)
			continue
		}

		host, port := splitHostPortLoose(p)

		// 前导点表示后缀匹配：".example.com" 与 "example.com" 语义一致
		if strings.HasPrefix(host, ".") {
			entry.suffix = true
			host = strings.TrimPrefix(host, ".")
		}

		// IP 条目（去掉可能的方括号）
		if ip := net.ParseIP(strings.Trim(host, "[]")); ip != nil {
			entry.host = ip.String()
		} else {
			entry.host = strings.ToLower(host)
			// 裸域名按“含子域”匹配，便于 no_proxy: example.com 覆盖 a.example.com
			if !entry.suffix {
				entry.suffix = true
			}
		}
		entry.port = port
		if entry.host == "" {
			return nil, fmt.Errorf("no_proxy 条目 %q 无法解析主机", raw)
		}
		m.entries = append(m.entries, entry)
	}
	return m, nil
}

// Match 判断目标 host（形如 "example.com:443" 或 "10.0.0.1"）是否直连。
func (m *noProxyMatcher) Match(hostport string) bool {
	if m == nil {
		return false
	}
	if m.all {
		return true
	}
	host, port := splitHostPortLoose(hostport)
	host = strings.ToLower(strings.Trim(host, "[]"))
	if host == "" {
		return false
	}
	ip := net.ParseIP(host)
	for _, e := range m.entries {
		if e.port != "" && e.port != port {
			continue
		}
		if e.ipnet != nil {
			if ip != nil && e.ipnet.Contains(ip) {
				return true
			}
			continue
		}
		if e.suffix {
			if host == e.host || strings.HasSuffix(host, "."+e.host) {
				return true
			}
			continue
		}
		if host == e.host {
			return true
		}
	}
	return false
}

// splitHostPortLoose 拆分 host[:port]，容忍缺失端口、IPv6 无方括号等情况。
func splitHostPortLoose(s string) (host, port string) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", ""
	}
	if h, p, err := net.SplitHostPort(s); err == nil {
		return h, p
	}
	// 无端口，或 IPv6 字面量（可能带方括号）
	return strings.Trim(s, "[]"), ""
}
