package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

const testTemplate = "You are a title generator. Output ONLY a title. <rules>apply</rules>"

func bodyReq(body string) *http.Request {
	return httptest.NewRequest(http.MethodPost, "http://x/", strings.NewReader(body))
}

// mode=off：字节零改动、长度沿用、不触发翻译（流式透传语义）。
func TestPrepareBodyOffPassthrough(t *testing.T) {
	raw := `{"model":"m","messages":[{"role":"user","content":"hi"}]}`
	r := bodyReq(raw)
	body, n, translate, err := prepareBody(r, FixupModeOff, testTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if translate {
		t.Errorf("off 模式不应触发翻译")
	}
	got, _ := io.ReadAll(body)
	if string(got) != raw {
		t.Errorf("off 模式 body 被改动")
	}
	if n != int64(len(raw)) {
		t.Errorf("content-length: got %d want %d", n, len(raw))
	}
}

// inject 模式 + 无 system、无 stream → 注入 role-first 模板 + 顶层补 stream:true，
// 顶层 key 顺序保留，调用方字段/消息原样；translate=true（调用方原本非流式）。
func TestPrepareBodyInjectsTemplateAndStream(t *testing.T) {
	raw := `{"model":"mimo","max_tokens":8,"messages":[{"role":"user","content":"hi"}]}`
	r := bodyReq(raw)
	body, n, translate, err := prepareBody(r, FixupModeInjectTemplate, testTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if !translate {
		t.Errorf("调用方无 stream 应触发 SSE→JSON 翻译")
	}
	got, _ := io.ReadAll(body)
	if int64(len(got)) != n {
		t.Errorf("返回长度与 ContentLength 不一致: %d vs %d", len(got), n)
	}
	out := string(got)
	// 顶层保序 + 模板 role-first 注入 + 尾部补 stream
	wantPrefix := `{"model":"mimo","max_tokens":8,"messages":[{"role":"system","content":"`
	if !strings.HasPrefix(out, wantPrefix) {
		t.Errorf("顶层顺序/role-first 结构不符: %s", out[:min(len(out), 160)])
	}
	if !strings.Contains(out, templateMarker) {
		t.Errorf("模板未注入")
	}
	if !strings.HasSuffix(out, `,"stream":true}`) {
		t.Errorf("未强制 stream:true: %s", out[len(out)-40:])
	}
	if !strings.Contains(out, `{"role":"user","content":"hi"}`) {
		t.Errorf("调用方消息丢失: %s", out)
	}
}

// 已含模板 + stream:true → 原字节返回、不翻译。
func TestPrepareBodyAlreadyCompliant(t *testing.T) {
	raw := `{"model":"m","messages":[{"role":"system","content":"` + templateMarker + ` x"},{"role":"user","content":"q"}],"stream":true}`
	r := bodyReq(raw)
	body, _, translate, err := prepareBody(r, FixupModeInjectTemplate, testTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if translate {
		t.Errorf("调用方已流式不应翻译")
	}
	got, _ := io.ReadAll(body)
	if string(got) != raw {
		t.Errorf("已合规仍被改动: %s", got)
	}
}

// 已含模板但 stream:false → 只改 stream 值（messages 字节不动）+ 触发翻译。
func TestPrepareBodyForcesStream(t *testing.T) {
	raw := `{"messages":[{"role":"system","content":"` + templateMarker + `"}],"stream":false}`
	r := bodyReq(raw)
	body, _, translate, err := prepareBody(r, FixupModeInjectTemplate, testTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if !translate {
		t.Errorf("stream:false 被强制为 true 应触发翻译")
	}
	got, _ := io.ReadAll(body)
	if string(got) != `{"messages":[{"role":"system","content":"`+templateMarker+`"}],"stream":true}` {
		t.Errorf("stream 替换结果不符: %s", got)
	}
}

// 非 JSON body：inject 模式也原样透传、不翻译。
func TestPrepareBodyNonJSONPassthrough(t *testing.T) {
	raw := "not-json-at-all"
	r := bodyReq(raw)
	body, _, translate, err := prepareBody(r, FixupModeInjectTemplate, testTemplate)
	if err != nil {
		t.Fatal(err)
	}
	if translate {
		t.Errorf("非 JSON 不应翻译")
	}
	got, _ := io.ReadAll(body)
	if string(got) != raw {
		t.Errorf("非 JSON 被改动")
	}
}

// Arbitrary OpenAI clients may carry custom tools and unsupported effort
// values; the compatibility layer must add the accepted tool surface and map
// the effort without breaking JSON structure.
func TestPrepareBodyNormalizesToolsAndEffort(t *testing.T) {
	// opencode_agent_system_prompt.txt 是第三方转储，被 .gitignore 排除
	// （proprietary prompt dumps 段），且 v2 起模板注入已废弃——模板文件缺失是
	// 受支持的常态（README：1.x 模板已不再注入，加载函数无调用点）。因此它不是
	// 测试前置条件：转储缺失时用含 fixup.go 判定 marker 的合成模板兜底，让全新
	// clone 也能跑满同一批断言，而不是在没有本地转储的机器上整条测试失败。
	agent := "You are opencode. <synthetic agent template for tests>"
	if rawAgent, err := os.ReadFile("../opencode_agent_system_prompt.txt"); err == nil {
		agent = string(rawAgent)
	} else {
		t.Logf("未找到本地转储 ../opencode_agent_system_prompt.txt，改用合成模板: %v", err)
	}
	canonical, err := os.ReadFile("../opencode_tools.json")
	if err != nil {
		t.Fatal(err)
	}
	raw := `{"model":"m","reasoning_effort":"max","messages":[{"role":"user","content":"hi"}],"tools":[{"type":"function","function":{"name":"custom","parameters":{"type":"object"}}}],"stream":false}`
	body, _, translate, err := prepareBodyWith(bodyReq(raw), FixupModeInjectTemplate, testTemplate, agent, json.RawMessage(canonical), nil)
	if err != nil {
		t.Fatal(err)
	}
	if !translate {
		t.Errorf("非流式调用应触发翻译")
	}
	got, _ := io.ReadAll(body)
	var parsed struct {
		Stream   bool             `json:"stream"`
		Effort   string           `json:"reasoning_effort"`
		Messages []map[string]any `json:"messages"`
		Tools    []struct {
			Function struct {
				Name string `json:"name"`
			} `json:"function"`
		} `json:"tools"`
	}
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("规范化后不是合法 JSON: %v\n%s", err, got)
	}
	if !parsed.Stream || parsed.Effort != "high" {
		t.Errorf("stream/effort: stream=%v effort=%q", parsed.Stream, parsed.Effort)
	}
	if len(parsed.Messages) == 0 || !strings.Contains(fmt.Sprint(parsed.Messages[0]["content"]), "You are opencode") {
		t.Errorf("未注入 agent system 模板: %s", got)
	}
	names := make([]string, 0, len(parsed.Tools))
	for _, tool := range parsed.Tools {
		names = append(names, tool.Function.Name)
	}
	joined := strings.Join(names, ",")
	set := make(map[string]bool, len(names))
	for _, n := range names {
		set[n] = true
	}
	if !set["custom"] {
		t.Errorf("调用方工具被丢弃: %s", joined)
	}
	// canonical 里的每一条都必须被合并进来。断言不硬编码具体工具名：仓库根的
	// opencode_tools.json 是「满足准入的最小版」（只含 read），而本地可覆盖成完整
	// 12 工具转储——两种情况下该断言都成立，且换成完整转储时自动覆盖更多条目。
	var canonicalList []struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
	}
	if err := json.Unmarshal(canonical, &canonicalList); err != nil || len(canonicalList) == 0 {
		t.Fatalf("canonical 工具面不可解析: %v", err)
	}
	for _, c := range canonicalList {
		if c.Function.Name == "" {
			continue
		}
		if !set[c.Function.Name] {
			t.Errorf("canonical 工具 %q 未合并: %s", c.Function.Name, joined)
		}
	}
}

// An unknown effort value must be dropped as a whole key, including its comma,
// so the resulting body remains parseable.
func TestPrepareBodyDropsUnknownEffort(t *testing.T) {
	raw := `{"reasoning_effort":"bogus","model":"m","messages":[{"role":"user","content":"hi"}],"stream":true}`
	body, _, _, err := prepareBodyWith(bodyReq(raw), FixupModeInjectTemplate, testTemplate, "", nil, nil)
	if err != nil {
		t.Fatal(err)
	}
	got, _ := io.ReadAll(body)
	var parsed map[string]any
	if err := json.Unmarshal(got, &parsed); err != nil {
		t.Fatalf("移除 effort 后 JSON 损坏: %v\n%s", err, got)
	}
	if _, ok := parsed["reasoning_effort"]; ok {
		t.Errorf("未知 effort 仍被转发: %s", got)
	}
}

// 真实模板文件：存在且含标记。
func TestLoadRealTemplate(t *testing.T) {
	s, err := LoadTemplate("opencode_system_prompt.txt")
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(s, templateMarker) || len(s) < 1000 {
		t.Errorf("模板异常: len=%d", len(s))
	}
	if _, err := LoadTemplate("no-such-file.txt"); err == nil {
		t.Errorf("缺失文件应报错")
	}
}

// SSE→JSON 组装：优先用真实抓包流（resp-body.sse，含 usage/length/cost/[DONE]）。
func TestAssembleCompletionFromFixture(t *testing.T) {
	raw, err := os.ReadFile("../data/replay/resp-body.sse")
	if err != nil {
		t.Skip("fixture 不存在:", err)
	}
	out := assembleCompletion(raw)
	var parsed struct {
		Object  string `json:"object"`
		Choices []struct {
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Usage struct {
			TotalTokens int `json:"total_tokens"`
		} `json:"usage"`
		Cost string `json:"cost"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatalf("组装结果非 JSON: %v\n%s", err, out)
	}
	if parsed.Object != "chat.completion" {
		t.Errorf("object: %s", parsed.Object)
	}
	if len(parsed.Choices) == 0 || parsed.Choices[0].FinishReason != "length" {
		t.Errorf("finish_reason: %+v", parsed.Choices)
	}
	if parsed.Usage.TotalTokens != 594 {
		t.Errorf("usage.total_tokens: %d want 594", parsed.Usage.TotalTokens)
	}
	if parsed.Cost != "0" {
		t.Errorf("cost: %q want 0", parsed.Cost)
	}
}

// 合成流：content 累积 + tool_calls 增量合并。
func TestAssembleCompletionSynthetic(t *testing.T) {
	sse := strings.Join([]string{
		`data: {"id":"c1","model":"m","choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"}}]}`,
		`data: {"choices":[{"index":0,"delta":{"content":"lo"}}]}`,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"t1","type":"function","function":{"name":"f","arguments":"{\"a\""}}]},"finish_reason":null}]}`,
		`data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]},"finish_reason":"tool_calls"}]}`,
		`data: [DONE]`,
		`data: {"choices":[],"cost":"0"}`,
		"",
	}, "\n")
	out := assembleCompletion([]byte(sse))
	var parsed struct {
		ID      string `json:"id"`
		Choices []struct {
			Message struct {
				Content   string `json:"content"`
				ToolCalls []struct {
					Function struct {
						Arguments string `json:"arguments"`
					} `json:"function"`
				} `json:"tool_calls"`
			} `json:"message"`
			FinishReason string `json:"finish_reason"`
		} `json:"choices"`
		Cost string `json:"cost"`
	}
	if err := json.Unmarshal(out, &parsed); err != nil {
		t.Fatal(err)
	}
	if parsed.ID != "c1" || parsed.Cost != "0" {
		t.Errorf("id/cost: %+v", parsed)
	}
	if parsed.Choices[0].Message.Content != "Hello" {
		t.Errorf("content: %q", parsed.Choices[0].Message.Content)
	}
	if parsed.Choices[0].FinishReason != "tool_calls" {
		t.Errorf("finish: %s", parsed.Choices[0].FinishReason)
	}
	tc := parsed.Choices[0].Message.ToolCalls
	if len(tc) != 1 || tc[0].Function.Arguments != `{"a":1}` {
		t.Errorf("tool_calls 合并: %+v", tc)
	}
}
