package main

import (
	"encoding/json"
	"strings"
)

// translate.go —— 上游 SSE → OpenAI 非流式 chat.completion JSON 组装。
//
// 场景：门③-B 要求 stream:true，但调用方原本请求非流式（或未带 stream）。
// 代理强制上游流式后，在响应侧把 SSE 事件流组装回单个 JSON，
// 保持“调用方非流式 → 收到 JSON”的对外契约。
//
// 覆盖：content / reasoning / tool_calls（按 index 合并、arguments 增量拼接）/
// finish_reason / usage / cost（[DONE] 后的费用块）/ id、created、model。

type sseChunk struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index int `json:"index"`
		Delta struct {
			Role      string `json:"role"`
			Content   string `json:"content"`
			Reasoning string `json:"reasoning"`
			ToolCalls []struct {
				Index    int    `json:"index"`
				ID       string `json:"id"`
				Type     string `json:"type"`
				Function struct {
					Name      string `json:"name"`
					Arguments string `json:"arguments"`
				} `json:"function"`
			} `json:"tool_calls"`
		} `json:"delta"`
		FinishReason *string `json:"finish_reason"`
	} `json:"choices"`
	Usage json.RawMessage `json:"usage"`
	Cost  string          `json:"cost"`
}

type assembledTool struct {
	Index    int    `json:"index"`
	ID       string `json:"id,omitempty"`
	Type     string `json:"type,omitempty"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type assembledResp struct {
	ID      string `json:"id"`
	Object  string `json:"object"`
	Created int64  `json:"created"`
	Model   string `json:"model"`
	Choices []struct {
		Index   int `json:"index"`
		Message struct {
			Role      string          `json:"role"`
			Content   string          `json:"content"`
			Reasoning string          `json:"reasoning,omitempty"`
			ToolCalls []assembledTool `json:"tool_calls,omitempty"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	} `json:"choices"`
	Usage json.RawMessage `json:"usage,omitempty"`
	Cost  string          `json:"cost,omitempty"`
}

// assembleCompletion 解析上游 SSE 字节流，组装成 chat.completion JSON。
func assembleCompletion(raw []byte) []byte {
	out := assembledResp{Object: "chat.completion", Model: "", Choices: make([]struct {
		Index   int `json:"index"`
		Message struct {
			Role      string          `json:"role"`
			Content   string          `json:"content"`
			Reasoning string          `json:"reasoning,omitempty"`
			ToolCalls []assembledTool `json:"tool_calls,omitempty"`
		} `json:"message"`
		FinishReason string `json:"finish_reason"`
	}, 1)}
	out.Choices[0].Message.Role = "assistant"
	out.Choices[0].FinishReason = "stop"

	tools := map[int]*assembledTool{}
	toolOrder := []int{}

	for _, line := range strings.Split(string(raw), "\n") {
		line = strings.TrimSpace(line)
		if !strings.HasPrefix(line, "data:") {
			continue
		}
		payload := strings.TrimSpace(strings.TrimPrefix(line, "data:"))
		if payload == "" || payload == "[DONE]" {
			continue
		}
		var ch sseChunk
		if err := json.Unmarshal([]byte(payload), &ch); err != nil {
			continue
		}
		if ch.ID != "" {
			out.ID = ch.ID
		}
		if ch.Created != 0 {
			out.Created = ch.Created
		}
		if ch.Model != "" {
			out.Model = ch.Model
		}
		if len(ch.Usage) > 0 && string(ch.Usage) != "null" {
			out.Usage = ch.Usage
		}
		if ch.Cost != "" {
			out.Cost = ch.Cost
		}
		for _, c := range ch.Choices {
			d := c.Delta
			if d.Content != "" {
				out.Choices[0].Message.Content += d.Content
			}
			if d.Reasoning != "" {
				out.Choices[0].Message.Reasoning += d.Reasoning
			}
			if c.FinishReason != nil && *c.FinishReason != "" {
				out.Choices[0].FinishReason = *c.FinishReason
			}
			for _, tc := range d.ToolCalls {
				t, ok := tools[tc.Index]
				if !ok {
					t = &assembledTool{Index: tc.Index}
					tools[tc.Index] = t
					toolOrder = append(toolOrder, tc.Index)
				}
				if tc.ID != "" {
					t.ID = tc.ID
				}
				if tc.Type != "" {
					t.Type = tc.Type
				}
				if tc.Function.Name != "" {
					t.Function.Name = tc.Function.Name
				}
				t.Function.Arguments += tc.Function.Arguments
			}
		}
	}
	// tool_calls 按 index 升序
	for i := 0; i < len(toolOrder); i++ {
		for j := i + 1; j < len(toolOrder); j++ {
			if toolOrder[j] < toolOrder[i] {
				toolOrder[i], toolOrder[j] = toolOrder[j], toolOrder[i]
			}
		}
	}
	for _, idx := range toolOrder {
		out.Choices[0].Message.ToolCalls = append(out.Choices[0].Message.ToolCalls, *tools[idx])
	}

	b, err := json.Marshal(out)
	if err != nil {
		return []byte(`{"error":{"message":"assemble failed","type":"proxy_error"}}`)
	}
	return b
}
