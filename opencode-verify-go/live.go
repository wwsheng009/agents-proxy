package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const targetURL = "https://opencode.ai/zen/v1/chat/completions"

type liveResult struct {
	Name      string  `json:"name"`
	Session   string  `json:"session,omitempty"`
	Msg       string  `json:"msg,omitempty"`
	UA        string  `json:"userAgent"`
	Predicted verdict `json:"predicted"`
	Actual    int     `json:"actual"`
	Class     string  `json:"class"` // match / mismatch / inconclusive
	Body      string  `json:"bodySnippet,omitempty"`
}

// runLive 在线验证：真实重放用例，实际状态码 vs admit 预测。
// 429/401/5xx 归为 inconclusive（额度/系统，不构成准入证据）。
func runLive(cases []probeCase, payloadPath, outPath string, maxTokens int, timeout time.Duration) int {
	fmt.Println("⚠ 在线模式：向真实端点发探针，消耗免费额度（成功针按 -max-tokens 生成，失败针不产生生成费用）")

	payloadPath, err := resolveExisting(payloadPath, "data/replay/muc7umlx-1qdmbboy.json", filepath.Join("..", "data", "replay", "muc7umlx-1qdmbboy.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "payload:", err)
		return 2
	}
	outPath, err = resolveWritable(outPath, filepath.Join(filepath.Dir(payloadPath), "probe-matrix-go.json"))
	if err != nil {
		fmt.Fprintln(os.Stderr, "out:", err)
		return 2
	}
	body, err := loadPayload(payloadPath, maxTokens)
	if err != nil {
		fmt.Fprintln(os.Stderr, "load payload:", err)
		return 2
	}
	fmt.Printf("payload=%s (max_tokens=>%d) out=%s\n", payloadPath, maxTokens, outPath)

	client := &http.Client{Timeout: timeout}
	now := time.Now()
	results := make([]liveResult, 0, len(cases))
	match, mismatch, inconclusive := 0, 0, 0

	for _, c := range cases {
		h, err := buildHeaders(c, now)
		if err != nil {
			fmt.Printf("%-30s 生成ID失败: %v\n", c.Name, err)
			mismatch++
			continue
		}
		predicted := admit(h)

		req, err := http.NewRequest(http.MethodPost, targetURL, bytes.NewReader(body))
		if err != nil {
			fmt.Printf("%-30s 构造请求失败: %v\n", c.Name, err)
			mismatch++
			continue
		}
		for k, v := range h {
			req.Header.Set(k, v)
		}
		resp, err := client.Do(req)
		res := liveResult{Name: c.Name, UA: h["user-agent"], Predicted: predicted}
		if ses := getHeader(h, "x-opencode-session"); ses != "" {
			res.Session = ses
		}
		if msg := getHeader(h, "x-opencode-request"); msg != "" {
			res.Msg = msg
		}
		if err != nil {
			res.Class, res.Body = "inconclusive", fmt.Sprintf("transport: %v", err)
			inconclusive++
		} else {
			res.Actual = resp.StatusCode
			// 只读少量诊断文本即中止：不拉完整 SSE 流
			buf := make([]byte, 600)
			n, _ := resp.Body.Read(buf)
			resp.Body.Close()
			res.Body = cleanSnippet(buf[:n])
			switch {
			case res.Actual == predicted.Status:
				res.Class = "match"
				match++
			case res.Actual == 401 || res.Actual == 429 || res.Actual >= 500:
				res.Class = "inconclusive" // 配额/鉴权/系统错误，不构成准入证据
				inconclusive++
			default:
				res.Class = "mismatch"
				mismatch++
			}
		}
		mark := map[string]string{"match": "✓", "mismatch": "✗", "inconclusive": "?"}[res.Class]
		fmt.Printf("%-30s want=%-4d got=%-4d %s  %s\n", res.Name, predicted.Status, res.Actual, mark, res.Class)
		results = append(results, res)
	}

	if err := writeJSON(outPath, results); err != nil {
		fmt.Fprintln(os.Stderr, "write out:", err)
	}
	fmt.Println()
	fmt.Printf("合计 %d 匹配 / %d 不匹配 / %d 不确定 → %s\n", match, mismatch, inconclusive, outPath)
	if mismatch > 0 {
		return 1
	}
	return 0
}

// loadPayload 读基座 payload，可选把 max_tokens 压小（body 不参与准入，见文档 §7）
func loadPayload(path string, maxTokens int) ([]byte, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if maxTokens <= 0 {
		return raw, nil
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		return nil, fmt.Errorf("payload 非 JSON: %w", err)
	}
	m["max_tokens"] = maxTokens
	return json.Marshal(m)
}

var wsRe = regexp.MustCompile(`\s+`)

func cleanSnippet(b []byte) string {
	s := wsRe.ReplaceAllString(string(b), " ")
	if len(s) > 200 {
		s = s[:200]
	}
	return strings.TrimSpace(s)
}

func resolveExisting(flagVal string, candidates ...string) (string, error) {
	try := candidates
	if flagVal != "" {
		try = []string{flagVal}
	}
	for _, p := range try {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
	}
	return "", fmt.Errorf("未找到文件，试过: %s", strings.Join(try, ", "))
}

func resolveWritable(flagVal string, candidates ...string) (string, error) {
	try := candidates
	if flagVal != "" {
		try = []string{flagVal}
	}
	for _, p := range try {
		if dir := filepath.Dir(p); dirExists(dir) {
			return p, nil
		}
	}
	return "", fmt.Errorf("没有可写目录，试过: %s", strings.Join(try, ", "))
}

func dirExists(p string) bool {
	st, err := os.Stat(p)
	return err == nil && st.IsDir()
}

func writeJSON(path string, v any) error {
	data, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}
