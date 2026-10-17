package main

import "time"

// cases.go —— 24 针证据表（与 scripts/probe-session.js 的探针一一对应，
// 期望值取自 data/replay/probe-matrix*.json 的实测状态码）。
//
// 每条用例只描述“改了哪个变量 + 实测期望”，由 main/admit 复算判定并比对，
// 从而验证复刻规则与证据表逐条一致（离线，不发网络请求、不耗额度）。

const (
	origSes = "ses_f3879bba0ffenHU9GSFayBniAm" // 抓包原始 session（P0 基座）
	origMsg = "msg_0c786447b001WfBuPbap1t1GGY" // 抓包原始 msg
	baseUA  = "opencode/1.18.32 ai-sdk/provider-utils/4.0.23 runtime/bun/1.3.14"
)

// ID 占位符：运行时用 MakeID 生成（老 ID 固定回拨 86h，覆盖 3.58 天回绕窗口）
const (
	freshSes = "@fresh-ses"
	oldSes   = "@old-ses"
	freshMsg = "@fresh-msg"
	oldMsg   = "@old-msg"
)

type probeCase struct {
	Name     string
	Ses      string // ""=不发送头；占位符=运行时生成；否则字面值
	Msg      string // 同上
	UA       string // ""=基线 UA；否则覆盖
	Client   string // ""/"@base"=cli；"@none"=删除头；否则覆盖
	Project  string // 同上
	Want     verdict
	Evidence string // 证据出处
}

const oldOffset = 86 * time.Hour // 与 probe-session.js DAY 一致

// resolveIDs 把占位符解析为具体 ID（离线/在线共用）
func resolveIDs(c probeCase, now time.Time) (ses, msg string, err error) {
	ses = c.Ses
	msg = c.Msg
	if ses == freshSes {
		ses, err = MakeSession(now.Add(-2 * time.Millisecond))
		if err != nil {
			return "", "", err
		}
	} else if ses == oldSes {
		ses, err = MakeSession(now.Add(-oldOffset))
		if err != nil {
			return "", "", err
		}
	}
	if msg == freshMsg {
		msg, err = MakeMessage(now)
		if err != nil {
			return "", "", err
		}
	} else if msg == oldMsg {
		msg, err = MakeMessage(now.Add(-oldOffset + 2*time.Millisecond))
		if err != nil {
			return "", "", err
		}
	}
	return ses, msg, nil
}

// buildHeaders 组装单针请求头（在线模式直接 POST；离线模式喂给 admit）
func buildHeaders(c probeCase, now time.Time) (map[string]string, error) {
	ses, msg, err := resolveIDs(c, now)
	if err != nil {
		return nil, err
	}
	h := map[string]string{
		"content-type":  "application/json",
		"user-agent":    baseUA,
		"authorization": "Bearer public",
	}
	if c.UA != "" {
		h["user-agent"] = c.UA
	}
	client := c.Client
	if client == "" {
		client = "@base"
	}
	project := c.Project
	if project == "" {
		project = "@base"
	}
	if client != "@none" && client != "@base" {
		h["x-opencode-client"] = client
	} else if client == "@base" {
		h["x-opencode-client"] = "cli"
	}
	if project != "@none" && project != "@base" {
		h["x-opencode-project"] = project
	} else if project == "@base" {
		h["x-opencode-project"] = "global"
	}
	if ses != "" {
		h["x-opencode-session"] = ses
	}
	if msg != "" {
		h["x-opencode-request"] = msg
	}
	return h, nil
}

// evidenceCases 24 针证据表（顺序与 probe-session.js 一致）
func evidenceCases() []probeCase {
	return []probeCase{
		// —— 主矩阵 P0~P3：新鲜度/注册维度 ——
		{Name: "P0_control_orig", Ses: origSes, Msg: origMsg, Want: wantPass(), Evidence: "原始包原样重放 200"},
		{Name: "P1_fresh_both", Ses: freshSes, Msg: freshMsg, Want: wantPass(), Evidence: "本地全新 ID 200（无注册/签名）"},
		{Name: "P2_ses_now_msg_orig", Ses: freshSes, Msg: origMsg, Want: wantPass(), Evidence: "混搭 200（无时间相关性）"},
		{Name: "P3_both_3d_old", Ses: oldSes, Msg: oldMsg, Want: wantPass(), Evidence: "3.58天前 ID 200（无新鲜度）"},

		// —— extra：session 结构边界 ——
		{Name: "P4_malformed_short", Ses: "ses_curl_test_001", Msg: origMsg, Want: wantSession403(), Evidence: "结构非法 403"},
		{Name: "P5_bad_hex_length_ok", Ses: "ses_zzzzzzzzzzzz" + "00000000000000", Msg: origMsg, Want: wantSession403(), Evidence: "时间段非 hex 403"},
		{Name: "P7_missing_header", Ses: "", Msg: origMsg, Want: wantSession403(), Evidence: "整头缺失 403"},

		// —— extra2：UA 维度 + client ——
		{Name: "P8_fresh_ses_curl_ua", Ses: freshSes, Msg: origMsg, UA: "curl/8.4.0", Want: wantUA403(), Evidence: "curl UA 403"},
		{Name: "P9_fresh_ses_no_client_hdr", Ses: freshSes, Msg: origMsg, Client: "@none", Want: wantPass(), Evidence: "删 client 头仍 200"},

		// —— extra3：UA 解析边界 ——
		{Name: "P10_ses_ua_opencode_fake", Ses: freshSes, Msg: origMsg, UA: "opencode-fake", Want: wantUA403(), Evidence: "无 /版本 403"},
		{Name: "P11_ses_ua_opencode_slash", Ses: freshSes, Msg: origMsg, UA: "opencode/0.0.1 test", Want: wantUA426(), Evidence: "过旧 426"},

		// —— extra4：session 长度/字符集 + msg ——
		{Name: "P12_short_random", Ses: "ses_f384a621fffe" + "aaaaaaaaaaaaa", Msg: origMsg, Want: wantSession403(), Evidence: "随机段13位 403"},
		{Name: "P13_bad_random_charset", Ses: "ses_f384a621fffe" + "abcdef0123456-", Msg: origMsg, Want: wantSession403(), Evidence: "随机段含- 403"},
		{Name: "P15_missing_msg_header", Ses: freshSes, Msg: "", Want: wantPass(), Evidence: "删 msg 头仍 200"},

		// —— extra5：hex 大小写 + UA 版本矩阵 + project ——
		{Name: "P16_upper_hex", Ses: "ses_F384A621FFFE" + "abcdef01234567", Msg: origMsg, Want: wantSession403(), Evidence: "时间段大写 403"},
		{Name: "P17_ua_1_17_99", Ses: freshSes, Msg: origMsg, UA: "opencode/1.17.99 test", Want: wantUA426(), Evidence: "门槛下 426"},
		{Name: "P18_ua_1_18_0", Ses: freshSes, Msg: origMsg, UA: "opencode/1.18.0 test", Want: wantPass(), Evidence: "闭区间 200"},
		{Name: "P19_no_project_hdr", Ses: freshSes, Msg: origMsg, Project: "@none", Want: wantPass(), Evidence: "删 project 头仍 200"},
		{Name: "P20_ua_prerelease", Ses: freshSes, Msg: origMsg, UA: "opencode/1.19.0-beta.1 test", Want: wantPass(), Evidence: "预发布 200"},
		{Name: "P21_ua_two_part_ver", Ses: freshSes, Msg: origMsg, UA: "opencode/1.18 test", Want: wantPass(), Evidence: "两段版本 200"},

		// —— extra6：子串/大小写/顺序/前缀 ——
		{Name: "P22_ua_contains", Ses: freshSes, Msg: origMsg, UA: "curl/8.4.0 opencode/1.18.32", Want: wantPass(), Evidence: "UA 子串 200"},
		{Name: "P23_bad_ses_old_ua", Ses: "ses_curl_test_001", Msg: origMsg, UA: "opencode/0.0.1 test", Want: wantSession403(), Evidence: "403 而非 426 → session 先判"},
		{Name: "P24_ua_uppercase", Ses: freshSes, Msg: origMsg, UA: "OpenCode/1.18.32 test", Want: wantPass(), Evidence: "大小写不敏感 200"},
		{Name: "P25_ses_prefix_upper", Ses: "SES_f384a621fffe" + "abcdef01234567", Msg: origMsg, Want: wantSession403(), Evidence: "前缀大写 403"},
	}
}
