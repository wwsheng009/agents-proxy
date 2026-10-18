package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

// Config 对应 config.yaml。字段零值在读文件前填默认值，
// 因此配置文件可以只写要覆盖的项。
type Config struct {
	Listen          string          `yaml:"listen"`
	Upstream        string          `yaml:"upstream"`
	DBPath          string          `yaml:"db_path"`
	StripPrefix     string          `yaml:"strip_prefix"`
	ZenCompat       bool            `yaml:"zen_compat"`
	Session         SessionConfig   `yaml:"session"`
	Message         MessageConfig   `yaml:"message"`
	UpstreamHeaders HeaderConfig    `yaml:"upstream_headers"`
	Proxy           ProxyConfig     `yaml:"proxy"`
	Forwarder       ForwarderConfig `yaml:"forwarder"`
	Log             LogConfig       `yaml:"log"`
	BodyFixup       BodyFixupConfig `yaml:"body_fixup"`
}

// ProxyConfig 上游出站代理（可选）。
//
// 作用对象是代理进程 → 上游（opencode.ai）这一段；入站客户端到本代理的
// 连接不受影响。支持 http / https / socks5 / socks5h（net/http 原生支持，
// 无额外依赖），认证可内嵌在 URL 里。
type ProxyConfig struct {
	// URL 代理地址，如 http://127.0.0.1:10810、socks5://user:pass@host:1080。
	// 留空 = 不使用显式代理（是否读环境变量见 from_env）。
	URL string `yaml:"url"`
	// NoProxy 直连名单，命中则绕过代理（仅 URL 非空时生效）。
	// 支持：*、域名（含子域，如 example.com / .internal）、host:port、
	// IP、CIDR（如 10.0.0.0/8）。
	NoProxy []string `yaml:"no_proxy"`
	// FromEnv 未配置 URL 时，是否回退读取 HTTP_PROXY/HTTPS_PROXY/NO_PROXY
	// 环境变量（历史默认行为）。URL 非空时忽略本项。
	FromEnv bool `yaml:"from_env"`
}

// ForwarderConfig 可选：把出站请求交给本地 Bun 转发 sidecar。
//
// 2026-10-18 起上游新增 Bun 1.3.14 TLS/HTTP2 指纹门：同样 headers/body，
// Bun 1.3.14 fetch = 200，Go/Python/Bun 1.4.x = 403 FreeTierError。
// 启用后 Go 代理用明文 HTTP 拨到 addr，由 Bun 1.3.14 完成到 opencode.ai 的 TLS。
type ForwarderConfig struct {
	// Addr 例如 "127.0.0.1:8898"；留空 = 不启用，仍由 Go 直接出站。
	Addr string `yaml:"addr"`
}

type SessionConfig struct {
	Headers           []string `yaml:"headers"`
	FallbackKey       string   `yaml:"fallback_key"`
	PassthroughNative bool     `yaml:"passthrough_native"` // 值已符合上游 ses_ 结构 → 原样透传
}

type MessageConfig struct {
	Headers           []string `yaml:"headers"`
	PassthroughNative bool     `yaml:"passthrough_native"` // 值已符合上游 msg_ 结构 → 原样透传
}

type HeaderConfig struct {
	UserAgent     string `yaml:"user_agent"`
	Authorization string `yaml:"authorization"`
	Client        string `yaml:"client"`
	Project       string `yaml:"project"`
}

type LogConfig struct {
	Requests bool `yaml:"requests"`
	KeepDays int  `yaml:"keep_days"`
}

// BodyFixupConfig body 兼容修正（见 fixup.go 头注释）。
type BodyFixupConfig struct {
	// off             —— 不改 body（调用方自带合规 body）
	// v2              —— 现行 v2 规则：强制 stream:true + tools 缺 read 时注入 + effort 映射
	// inject_template —— 遗留 1.x 规则（已失效，仅存档；见 ../docs/分析-opencode-v2指纹与准入.md §三）
	Mode              string `yaml:"mode"`
	TemplateFile      string `yaml:"template_file"`
	AgentTemplateFile string `yaml:"agent_template_file"`
	ToolsFile         string `yaml:"tools_file"`
}

// DefaultConfig 与 config.yaml 保持一致的默认值（文件缺失时也能启动）。
func DefaultConfig() Config {
	return Config{
		Listen:   "127.0.0.1:8788",
		Upstream: "https://opencode.ai",
		DBPath:   "proxy-go.db",
		// 命中 opencode.ai 时把 OpenAI 风格路径改写进 v2 inference 通道
		// （/v1/* → /inference/v1/*），见 server.go resolveUpstreamURL。
		ZenCompat: true,
		Session: SessionConfig{
			Headers:           []string{"x-session-id", "x-opencode-session", "x-session"},
			FallbackKey:       "default",
			PassthroughNative: true,
		},
		Message: MessageConfig{
			// v2 客户端不发 x-opencode-request（该头已列入毒头，见 headers.go）；
			// 保留为入口仅为兼容把 x-message-id 之外的旧调用方，映射结果不再注入上游。
			Headers:           []string{"x-message-id"},
			PassthroughNative: true,
		},
		UpstreamHeaders: HeaderConfig{
			// v2 四段格式 opencode/<channel>/<version>/<artifact>（v2.0.29 真实抓包值）。
			UserAgent:     "opencode/latest/2.0.29/cli",
			Authorization: "Bearer public",
			Client:        "cli",
			Project:       "global",
		},
		Proxy: ProxyConfig{
			// 默认不配置显式代理，但保留历史行为：跟随 HTTP_PROXY/HTTPS_PROXY 环境变量。
			URL:     "",
			FromEnv: true,
		},
		Forwarder: ForwarderConfig{
			Addr: "", // 留空 = 不启用 Bun sidecar
		},
		Log: LogConfig{Requests: true, KeepDays: 7},
		BodyFixup: BodyFixupConfig{
			Mode:              FixupModeV2,
			TemplateFile:      "opencode_system_prompt.txt",
			AgentTemplateFile: "opencode_agent_system_prompt.txt",
			ToolsFile:         "opencode_tools.json",
		},
	}
}

// LoadConfig 读取 YAML 配置；path 不存在且为默认路径时返回默认配置。
func LoadConfig(path string) (Config, error) {
	cfg := DefaultConfig()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, fmt.Errorf("read config: %w", err)
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, fmt.Errorf("parse config %s: %w", path, err)
	}
	// Asset paths are relative to the config file, not the process cwd, so the
	// proxy behaves the same when launched from the repo root or opencode-proxy-go/.
	base := filepath.Dir(path)
	cfg.BodyFixup.TemplateFile = resolveConfigPath(base, cfg.BodyFixup.TemplateFile)
	cfg.BodyFixup.AgentTemplateFile = resolveConfigPath(base, cfg.BodyFixup.AgentTemplateFile)
	cfg.BodyFixup.ToolsFile = resolveConfigPath(base, cfg.BodyFixup.ToolsFile)
	return cfg, nil
}

func resolveConfigPath(base, value string) string {
	if value == "" || filepath.IsAbs(value) {
		return value
	}
	return filepath.Join(base, value)
}

// Validate 启动前的配置自检。
func (c *Config) Validate() error {
	if c.Listen == "" {
		return fmt.Errorf("listen 不能为空")
	}
	if !strings.HasPrefix(c.Upstream, "http://") && !strings.HasPrefix(c.Upstream, "https://") {
		return fmt.Errorf("upstream 必须是 http(s) URL: %q", c.Upstream)
	}
	if c.DBPath == "" {
		return fmt.Errorf("db_path 不能为空")
	}
	if strings.TrimSpace(c.Proxy.URL) != "" {
		if _, err := parseProxyURL(c.Proxy.URL); err != nil {
			return fmt.Errorf("proxy.url 非法: %w", err)
		}
	}
	if _, err := newNoProxyMatcher(c.Proxy.NoProxy); err != nil {
		return fmt.Errorf("proxy.no_proxy 非法: %w", err)
	}
	if c.Session.FallbackKey == "" {
		return fmt.Errorf("session.fallback_key 不能为空")
	}
	if len(c.Session.Headers) == 0 {
		return fmt.Errorf("session.headers 至少一项")
	}
	for _, h := range c.Session.Headers {
		if strings.TrimSpace(h) == "" {
			return fmt.Errorf("session.headers 含空项")
		}
	}
	if len(c.Message.Headers) == 0 {
		return fmt.Errorf("message.headers 至少一项")
	}
	for _, h := range c.Message.Headers {
		if strings.TrimSpace(h) == "" {
			return fmt.Errorf("message.headers 含空项")
		}
	}
	switch c.BodyFixup.Mode {
	case "", FixupModeOff:
		c.BodyFixup.Mode = FixupModeOff
	case FixupModeV2:
		if c.BodyFixup.ToolsFile == "" {
			return fmt.Errorf("body_fixup.tools_file 不能为空（v2 模式需要 read 工具 schema）")
		}
	case FixupModeInjectTemplate:
		if c.BodyFixup.TemplateFile == "" {
			return fmt.Errorf("body_fixup.template_file 不能为空")
		}
	default:
		return fmt.Errorf("body_fixup.mode 只支持 off/v2/inject_template: %q", c.BodyFixup.Mode)
	}
	return nil
}
