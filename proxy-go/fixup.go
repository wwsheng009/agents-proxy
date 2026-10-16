package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

// fixup.go —— opencode 免费道 body 兼容修正（可配置）。
//
// # v2 现行规则（mode=v2，默认）
//
// 2026-10-15 单变量实验（../scripts/experiments/bisect/bisect-body*.js / bisect-headers.js，
// 见 ../docs/分析-opencode-v2指纹与准入.md §三）证明 v2 只要求 body 满足：
//
//	① stream: true（stream:false → 403）
//	② tools 含一个 name="read" 的 opencode 工具（名称匹配即可，schema 可改、
//	   可与任意自有工具混用；缺 read 时外来工具再多也 403）
//
// 且 v2 对 system 内容**完全不校验**——1.x 的“门③模板注入 + 12 工具白名单”
// 已作废，注入模板只会拖慢并污染响应，故 v2 模式不再注入任何模板。
// 修正实现保持保序字节拼接：未触及的 key/value 字节原样，仅改 stream、
// 补/换 tools 数组（read 工具前插，调用方自有工具顺序不变）、归一化 effort。
//
// # 遗留 1.x 规则（mode=inject_template，仅存档）
//
// 2026-09-22 单变量判别（T1~T11，真实端点）证明：header 双门之外，上游还要求
// body 同时满足两个条件（并列，缺一 403；大小无关、user 内容无关）：
//
//	A. system 消息包含真实 opencode 模板内容
//	     真实模板+任意 user → 200（T1/T8/T11）；填充2100/3000B、短、无 system → 403（T4/T5/T9）
//	B. stream: true
//	     真模板但缺 stream/temperature/stream_options → 403（T10）；仅补 stream → 200（T11）
//
// mode=inject_template 时的修正（有序拼接，字节尽量保留）：
//
//	- messages[0] 缺模板 → 数组头部插入 role-first 的 {"role":"system","content":…}
//	  （直接 Go map 重序列化会让 key 变字母序、content 在前，实测 403——上游
//	   很可能对原始 body 字节/结构匹配，故必须 role-first 且保持原字节）
//	- stream != true → 顶层补/改为 "stream":true；若调用方原本非流式，
//	  代理会把上游 SSE 组装回 JSON 再回传（见 translate.go），对外契约不变
//
// 当请求携带 tools 时，修正还会切换到 agent 模板、合并 canonical 工具 schema，
// 并把 reasoning_effort 归一化为上游支持的四值枚举。
// 注意：无 tools 时注入的是“标题生成器”提示词，模型作答可能带模板风格；
// 对形态敏感的调用方请 mode: off 并自行构造 opencode 形态 body。
// 该模式对现行上游一律 403（../docs/分析-opencode-v2指纹与准入.md §一），保留仅供对照。

const (
	FixupModeOff            = "off"
	FixupModeV2             = "v2"
	FixupModeInjectTemplate = "inject_template"

	templateMarker = "You are a title generator" // 模板识别标记（取自抓包首行）
	maxBodyBytes   = 16 << 20                    // 注入模式下的 body 上限

	// v2 准入要求的工具名（名称匹配即可，schema 内容不校验）。
	readToolName = "read"
)

// LoadTemplate 读取 system 模板文件。
func LoadTemplate(path string) (string, error) {
	b, err := readAsset(path)
	if err != nil {
		return "", fmt.Errorf("读取模板 %s: %w", path, err)
	}
	s := string(b)
	if !strings.Contains(s, templateMarker) {
		return "", fmt.Errorf("模板 %s 缺少标记 %q，确认是抓包的真实 prompt", path, templateMarker)
	}
	return s, nil
}

// loadOptionalText reads a compatibility asset when it is configured.
func loadOptionalText(path string) string {
	if path == "" {
		return ""
	}
	b, err := readAsset(path)
	if err != nil {
		return ""
	}
	return string(b)
}

// loadOptionalTools reads the canonical opencode tool surface. The bytes are
// compacted so injected tools stay single-line, and the payload must be a JSON
// array; invalid/missing assets simply disable normalization.
func loadOptionalTools(path string) json.RawMessage {
	if path == "" {
		return nil
	}
	b, err := readAsset(path)
	if err != nil {
		return nil
	}
	var compact bytes.Buffer
	if json.Compact(&compact, b) != nil {
		return nil
	}
	var list []json.RawMessage
	if json.Unmarshal(compact.Bytes(), &list) != nil {
		return nil
	}
	return json.RawMessage(compact.Bytes())
}

// toolNameOf 取 OpenAI 风格 tool.function.name，回退顶层 name（同 proxy.js toolName）。
func toolNameOf(raw json.RawMessage) string {
	var n struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
		Name string `json:"name"`
	}
	if json.Unmarshal(raw, &n) != nil {
		return ""
	}
	if n.Function.Name != "" {
		return n.Function.Name
	}
	return n.Name
}

// readToolFrom 从 canonical 工具面里取出 name="read" 的那一条（v2 准入必需）。
// 找不到（文件缺失/无该工具）返回 nil，此时 v2 修正无法补齐 read，
// 由启动期 warn 提示（见 server.go NewProxy）。
func readToolFrom(canonical json.RawMessage) json.RawMessage {
	if len(canonical) == 0 {
		return nil
	}
	var list []json.RawMessage
	if json.Unmarshal(canonical, &list) != nil {
		return nil
	}
	for _, item := range list {
		if toolNameOf(item) == readToolName {
			return item
		}
	}
	return nil
}

// readAsset accepts paths relative to either the working directory or its
// parent, so `go run .` works from proxy-go/ as well as from the repo root.
func readAsset(path string) ([]byte, error) {
	b, err := os.ReadFile(path)
	if err == nil || filepath.IsAbs(path) {
		return b, err
	}
	return os.ReadFile(filepath.Join("..", path))
}

// prepareBody 按配置处理请求体。返回的 translate 表示“上游将以 SSE 返回、
// 但调用方期望非流式”，响应侧需做 SSE→JSON 组装。
//
//	mode=off             → 原样流式透传（r.Body 直接用，字节零改动）
//	mode=v2              → 读入；非 JSON 原样；否则强制 stream + 补 read 工具
//	mode=inject_template → 遗留 1.x：注入 system 模板 + 12 工具白名单
func prepareBody(r *http.Request, mode, template string) (body io.Reader, contentLength int64, translate bool, err error) {
	return prepareBodyWith(r, mode, template, "", nil, nil)
}

// prepareBodyWith 按 mode 分派。readTool 是 v2 模式的 canonical read 工具
// （tools 文件里 name="read" 的那一条），由 NewProxy 预解析后传入。
func prepareBodyWith(r *http.Request, mode, template, agentTemplate string, tools, readTool json.RawMessage) (body io.Reader, contentLength int64, translate bool, err error) {
	switch mode {
	case FixupModeV2:
		return prepareBodyV2(r, readTool)
	case FixupModeInjectTemplate:
		if template == "" {
			return r.Body, r.ContentLength, false, nil
		}
	default:
		return r.Body, r.ContentLength, false, nil
	}
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, 0, false, fmt.Errorf("读取 body: %w", err)
	}
	if int64(len(raw)) > maxBodyBytes {
		return nil, 0, false, fmt.Errorf("body 超过 %d 字节", maxBodyBytes)
	}
	out, _, translate, err := injectOrderedWith(raw, template, agentTemplate, tools)
	if err != nil {
		return nil, 0, false, err
	}
	return bytes.NewReader(out), int64(len(out)), translate, nil
}

// injectOrdered 在原始 JSON 字节上做保序拼接：
// 顶层 key 顺序不变、未触及的 value 字节不变；注入 system / 强制 stream。
// 返回 (最终字节, 是否修改, 需要SSE→JSON组装, 错误)；解析失败 → (原字节,false,false,nil)。
func injectOrdered(raw []byte, template string) ([]byte, bool, bool, error) {
	return injectOrderedWith(raw, template, "", nil)
}

func injectOrderedWith(raw []byte, template, agentTemplate string, tools json.RawMessage) ([]byte, bool, bool, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	t, err := dec.Token()
	if err != nil {
		return raw, false, false, nil // 非 JSON / 截断：原样
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return raw, false, false, nil // 非对象：原样
	}

	out := make([]byte, 0, len(raw)+len(template)+64)
	out = append(out, '{')
	first := true
	changed := false
	streamSeen := false
	callerWantsStream := false
	hasTools := false
	hasAgentSystem := false

	// Inspect only the fields needed to choose the compatible template before
	// walking the original bytes; the output below still preserves key order.
	var probe map[string]json.RawMessage
	if json.Unmarshal(raw, &probe) == nil {
		if rawTools, ok := probe["tools"]; ok {
			var list []json.RawMessage
			hasTools = json.Unmarshal(rawTools, &list) == nil && len(list) > 0
		}
		if rawMessages, ok := probe["messages"]; ok {
			var list []json.RawMessage
			if json.Unmarshal(rawMessages, &list) == nil {
				for _, item := range list {
					var msg struct {
						Role    string `json:"role"`
						Content string `json:"content"`
					}
					if json.Unmarshal(item, &msg) == nil && msg.Role == "system" && strings.Contains(msg.Content, "You are opencode") {
						hasAgentSystem = true
						break
					}
				}
			}
		}
	}

	activeTemplate := template
	marker := templateMarker
	if hasTools && agentTemplate != "" && !hasAgentSystem {
		activeTemplate = agentTemplate
		marker = "You are opencode"
	}

	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, false, false, fmt.Errorf("解析 body key: %w", err)
		}
		key, ok := kt.(string)
		if !ok {
			return nil, false, false, fmt.Errorf("body 顶层 key 非字符串: %v", kt)
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, false, false, fmt.Errorf("解析 body value: %w", err)
		}
		switch key {
		case "messages":
			nv, ch, err := spliceMessages(val, activeTemplate, marker)
			if err != nil {
				return nil, false, false, err
			}
			if ch {
				changed = true
				val = nv
			}
		case "tools":
			if len(tools) > 0 {
				nv, ch, err := normalizeTools(val, tools)
				if err != nil {
					return nil, false, false, err
				}
				if ch {
					changed = true
					val = nv
				}
			}
		case "reasoning_effort":
			nv, ch, err := normalizeEffort(val)
			if err != nil {
				return nil, false, false, err
			}
			if ch {
				changed = true
				if nv == nil {
					// Unsupported values are omitted. Delay the append so a
					// dropped middle key cannot corrupt the surrounding commas.
					goto omitKey
				}
				val = nv
			}
		case "stream":
			streamSeen = true
			if bytes.Equal(bytes.TrimSpace(val), []byte("true")) {
				callerWantsStream = true
			} else {
				val = []byte("true") // 强制流式（门③-B）
				changed = true
			}
		}
		if !first {
			out = append(out, ',')
		}
		first = false
		out = strconv.AppendQuote(out, key)
		out = append(out, ':')
		out = append(out, val...)
	omitKey:
	}
	if _, err := dec.Token(); err != nil { // 收尾 '}'
		return nil, false, false, fmt.Errorf("解析 body 结尾: %w", err)
	}
	if !streamSeen {
		// 顶层补 stream:true（放在最后一个 key 后，保序）
		if !first {
			out = append(out, ',')
		}
		out = append(out, `"stream":true`...)
		changed = true
	}
	out = append(out, '}')
	if !changed {
		return raw, false, false, nil
	}
	return out, true, !callerWantsStream, nil
}

// prepareBodyV2 应用 v2 兼容规则（见文件头）：强制 stream:true，并保证 tools
// 数组含一个 name="read" 的工具。v2 不校验 system 内容，故不注入任何模板。
//
// readTool 为 nil（tools 文件缺失/无 read）时只强制 stream，read 无法补齐——
// 该情况由 NewProxy 启动期 warn 提示。
func prepareBodyV2(r *http.Request, readTool json.RawMessage) (body io.Reader, contentLength int64, translate bool, err error) {
	raw, err := io.ReadAll(io.LimitReader(r.Body, maxBodyBytes+1))
	if err != nil {
		return nil, 0, false, fmt.Errorf("读取 body: %w", err)
	}
	if int64(len(raw)) > maxBodyBytes {
		return nil, 0, false, fmt.Errorf("body 超过 %d 字节", maxBodyBytes)
	}
	out, _, translate, err := injectOrderedV2(raw, readTool)
	if err != nil {
		return nil, 0, false, err
	}
	return bytes.NewReader(out), int64(len(out)), translate, nil
}

// injectOrderedV2 在原始 JSON 字节上做保序拼接，只动 v2 准入相关字段：
// stream 强制 true（准入①）；tools 缺 read 时前插 canonical read 工具（准入②）；
// reasoning_effort 归一化。未触及的 key/value 字节原样。
// 返回 (最终字节, 是否修改, 需要SSE→JSON组装, 错误)；非 JSON/非对象 → 原样。
func injectOrderedV2(raw []byte, readTool json.RawMessage) ([]byte, bool, bool, error) {
	dec := json.NewDecoder(bytes.NewReader(raw))
	t, err := dec.Token()
	if err != nil {
		return raw, false, false, nil // 非 JSON / 截断：原样
	}
	if d, ok := t.(json.Delim); !ok || d != '{' {
		return raw, false, false, nil // 非对象：原样
	}

	out := make([]byte, 0, len(raw)+len(readTool)+32)
	out = append(out, '{')
	first := true
	changed := false
	streamSeen := false
	callerWantsStream := false
	toolsSeen := false

	for dec.More() {
		kt, err := dec.Token()
		if err != nil {
			return nil, false, false, fmt.Errorf("解析 body key: %w", err)
		}
		key, ok := kt.(string)
		if !ok {
			return nil, false, false, fmt.Errorf("body 顶层 key 非字符串: %v", kt)
		}
		var val json.RawMessage
		if err := dec.Decode(&val); err != nil {
			return nil, false, false, fmt.Errorf("解析 body value: %w", err)
		}
		switch key {
		case "tools":
			toolsSeen = true
			if len(readTool) > 0 {
				nv, ch := ensureReadTool(val, readTool)
				if ch {
					changed = true
					val = nv
				}
			}
		case "reasoning_effort":
			nv, ch, err := normalizeEffort(val)
			if err != nil {
				return nil, false, false, err
			}
			if ch {
				changed = true
				if nv == nil {
					// 不支持的 effort 值直接丢弃；延后追加，避免中间删 key 破坏逗号。
					goto omitKey
				}
				val = nv
			}
		case "stream":
			streamSeen = true
			if bytes.Equal(bytes.TrimSpace(val), []byte("true")) {
				callerWantsStream = true
			} else {
				val = []byte("true") // 强制流式（v2 准入①：stream:false → 403）
				changed = true
			}
		}
		if !first {
			out = append(out, ',')
		}
		first = false
		out = strconv.AppendQuote(out, key)
		out = append(out, ':')
		out = append(out, val...)
	omitKey:
	}
	if _, err := dec.Token(); err != nil { // 收尾 '}'
		return nil, false, false, fmt.Errorf("解析 body 结尾: %w", err)
	}
	if !toolsSeen && len(readTool) > 0 {
		// 调用方没带 tools：补一个只含 read 的工具面（v2 准入②）
		if !first {
			out = append(out, ',')
		}
		first = false
		out = append(out, `"tools":[`...)
		out = append(out, readTool...)
		out = append(out, ']')
		changed = true
	}
	if !streamSeen {
		if !first {
			out = append(out, ',')
		}
		out = append(out, `"stream":true`...)
		changed = true
	}
	out = append(out, '}')
	if !changed {
		return raw, false, false, nil
	}
	return out, true, !callerWantsStream, nil
}

// ensureReadTool 检查调用方 tools 数组是否已含 name="read"；缺失则把 canonical
// read 工具前插，调用方自有工具字节与顺序保持不变（同 proxy.js：只认名字）。
// tools 非数组时不改动。
func ensureReadTool(val, readTool json.RawMessage) (json.RawMessage, bool) {
	var list []json.RawMessage
	if json.Unmarshal(val, &list) != nil {
		return val, false
	}
	for _, item := range list {
		if toolNameOf(item) == readToolName {
			return val, false
		}
	}
	out := make([]byte, 0, len(val)+len(readTool)+2)
	out = append(out, '[')
	out = append(out, readTool...)
	for _, item := range list {
		out = append(out, ',')
		out = append(out, item...)
	}
	out = append(out, ']')
	return out, true
}

// spliceMessages 需要时在数组头部插入 role-first 模板；其余元素原字节保留。
func spliceMessages(val json.RawMessage, template, marker string) (json.RawMessage, bool, error) {
	var arr []json.RawMessage
	if err := json.Unmarshal(val, &arr); err != nil {
		return val, false, nil // messages 非数组：不动
	}
	if len(arr) == 0 {
		return val, false, nil
	}
	var firstMsg struct {
		Role    string `json:"role"`
		Content string `json:"content"`
	}
	if err := json.Unmarshal(arr[0], &firstMsg); err == nil &&
		firstMsg.Role == "system" && strings.Contains(firstMsg.Content, marker) {
		return val, false, nil // 已含模板
	}

	q, err := json.Marshal(template)
	if err != nil {
		return nil, false, fmt.Errorf("序列化模板: %w", err)
	}
	inj := append([]byte(`{"role":"system","content":`), q...)
	inj = append(inj, '}')

	buf := make([]byte, 0, len(val)+len(inj)+1)
	buf = append(buf, '[')
	buf = append(buf, inj...)
	for _, m := range arr {
		buf = append(buf, ',')
		buf = append(buf, m...)
	}
	buf = append(buf, ']')
	return buf, true, nil
}

// normalizeTools keeps caller tools and merges in the canonical opencode
// schemas, replacing same-named entries so the upstream whitelist sees real
// schemas rather than arbitrary client definitions.
func normalizeTools(val, canonical json.RawMessage) (json.RawMessage, bool, error) {
	var incoming []json.RawMessage
	if json.Unmarshal(val, &incoming) != nil {
		return val, false, nil
	}
	var accepted []json.RawMessage
	if json.Unmarshal(canonical, &accepted) != nil || len(accepted) == 0 {
		return val, false, nil
	}
	type named struct {
		Function struct {
			Name string `json:"name"`
		} `json:"function"`
		Name string `json:"name"`
	}
	nameOf := func(raw json.RawMessage) string {
		var n named
		if json.Unmarshal(raw, &n) != nil {
			return ""
		}
		if n.Function.Name != "" {
			return n.Function.Name
		}
		return n.Name
	}
	acceptedNames := make(map[string]json.RawMessage, len(accepted))
	for _, item := range accepted {
		if name := nameOf(item); name != "" {
			acceptedNames[name] = item
		}
	}
	seen := make(map[string]bool, len(incoming)+len(accepted))
	out := make([]json.RawMessage, 0, len(incoming)+len(accepted))
	changed := false
	for _, item := range incoming {
		name := nameOf(item)
		if replacement, ok := acceptedNames[name]; ok {
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			out = append(out, replacement)
			changed = changed || !bytes.Equal(item, replacement)
			continue
		}
		out = append(out, item)
	}
	for _, item := range accepted {
		name := nameOf(item)
		if name == "" || seen[name] {
			continue
		}
		seen[name] = true
		out = append(out, item)
		changed = true
	}
	if !changed {
		return val, false, nil
	}
	b, err := json.Marshal(out)
	if err != nil {
		return nil, false, fmt.Errorf("序列化 tools: %w", err)
	}
	return b, true, nil
}

// normalizeEffort maps the legacy four-value enum accepted by the zen backend.
// Unknown values are removed instead of being forwarded as an HTTP 500.
func normalizeEffort(val json.RawMessage) (json.RawMessage, bool, error) {
	var value string
	if json.Unmarshal(val, &value) != nil {
		return nil, true, nil
	}
	switch value {
	case "none", "low", "medium", "high":
		return val, false, nil
	case "max", "xhigh":
		return json.RawMessage(`"high"`), true, nil
	case "minimal":
		return json.RawMessage(`"low"`), true, nil
	default:
		return nil, true, nil
	}
}
