package main

import (
	"testing"
	"time"
)

// 1) 核心：复刻 admit() × 24 针证据表（离线一致性验证）
func TestEvidenceCasesMatchAdmission(t *testing.T) {
	now := time.Now()
	for _, c := range evidenceCases() {
		t.Run(c.Name, func(t *testing.T) {
			h, err := buildHeaders(c, now)
			if err != nil {
				t.Fatalf("buildHeaders: %v", err)
			}
			got := admit(h)
			if got != c.Want {
				t.Errorf("admit=%+v want=%+v（证据: %s）", got, c.Want, c.Evidence)
			}
		})
	}
}

// 2) 门① session 结构边界
func TestSessionStructure(t *testing.T) {
	valid, err := MakeSession(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	tests := []struct {
		ses  string
		pass bool
	}{
		{origSes, true},              // 抓包原值
		{valid, true},                // 本地生成
		{"", false},                  // P7 缺失
		{"ses_curl_test_001", false}, // P4 过短
		{"ses_zzzzzzzzzzzz00000000000000", false}, // P5 非 hex 时间段
		{"ses_f384a621fffeaaaaaaaaaaaaa", false},  // P12 随机段 13 位
		{"ses_f384a621fffeabcdef0123456-", false}, // P13 随机段含 -
		{"ses_F384A621FFFEabcdef01234567", false}, // P16 时间段大写
		{"SES_f384a621fffeabcdef01234567", false}, // P25 前缀大写
	}
	for _, tc := range tests {
		h := map[string]string{
			"x-opencode-session": tc.ses,
			"user-agent":         baseUA, // 放行合法 UA，使门① 结构结果可直接观察
		}
		v := admit(h)
		if tc.pass && v.Status != 200 {
			t.Errorf("ses=%q 结构应通过, got %+v", tc.ses, v)
		}
		if !tc.pass && v.Status != 403 {
			t.Errorf("ses=%q 应被门①拒绝, got %+v", tc.ses, v)
		}
	}
	// 结构通过的直接正则复核（避免与 UA 门混淆）
	if !sessionRe.MatchString(valid) {
		t.Errorf("生成的 session 未通过结构正则: %s", valid)
	}
	if !messageRe.MatchString(mustMessage(t)) {
		t.Errorf("生成的 message 未通过结构正则")
	}
}

// 3) 门② UA 版本矩阵（子串/大小写/缺段/边界）
func TestUAAdmission(t *testing.T) {
	validSes := origSes
	tests := []struct {
		ua     string
		status int
	}{
		{baseUA, 200},                        // 基线
		{"curl/8.4.0", 403},                  // P8
		{"opencode-fake", 403},               // P10
		{"opencode/0.0.1 test", 426},         // P11
		{"opencode/1.17.99 test", 426},       // P17
		{"opencode/1.18.0 test", 200},        // P18 闭区间
		{"opencode/1.19.0-beta.1 test", 200}, // P20 预发布
		{"opencode/1.18 test", 200},          // P21 两段
		{"curl/8.4.0 opencode/1.18.32", 200}, // P22 子串
		{"OpenCode/1.18.32 test", 200},       // P24 大小写不敏感
		{"", 403},                            // UA 缺失
	}
	for _, tc := range tests {
		h := map[string]string{
			"x-opencode-session": validSes,
			"user-agent":         tc.ua,
		}
		if v := admit(h); v.Status != tc.status {
			t.Errorf("ua=%q want %d got %+v", tc.ua, tc.status, v)
		}
	}
}

// 4) 校验顺序：非法 session + 旧 UA → 403（门① 先于 门②，P23）
func TestAdmissionOrder(t *testing.T) {
	h := map[string]string{
		"x-opencode-session": "ses_curl_test_001",
		"user-agent":         "opencode/0.0.1 test",
	}
	v := admit(h)
	if v.Status != 403 || v.ErrType != "FreeTierError" {
		t.Errorf("P23 期望 403 FreeTierError（session 先判）, got %+v", v)
	}
}

//  5. 生成器黄金向量：与原 JS 实现（identifier.ts 复刻脚本）逐字节一致
//     ts=1790000000000, counter=1 → asc=0c4506c00001 desc=f3baf93ffffe
func TestMakeIDGoldenVectors(t *testing.T) {
	ts := time.UnixMilli(1790000000000)
	ses, err := MakeSession(ts)
	if err != nil {
		t.Fatal(err)
	}
	if got := ses[4:16]; got != "f3baf93ffffe" {
		t.Errorf("descending 时间段黄金向量不符: got %s want f3baf93ffffe", got)
	}
	msg, err := MakeMessage(ts)
	if err != nil {
		t.Fatal(err)
	}
	if got := msg[4:16]; got != "0c4506c00001" {
		t.Errorf("ascending 时间段黄金向量不符: got %s want 0c4506c00001", got)
	}
	if !sessionRe.MatchString(ses) {
		t.Errorf("生成 session 不符结构: %s", ses)
	}
	if !messageRe.MatchString(msg) {
		t.Errorf("生成 message 不符结构: %s", msg)
	}
	// 生成 → 解码 round-trip（低36位回绕空间内）
	dec, err := DecodeTimeLow36(ses[4:16], true)
	if err != nil {
		t.Fatal(err)
	}
	if want := uint64(ts.UnixMilli()) & mask36; dec != want {
		t.Errorf("round-trip: decode=%d want %d", dec, want)
	}
}

// 6) 抓包原始 ID 解码：与分析文档 §1 记录的时间戳吻合（2026-09-22T05:11:00.447/.475Z）
func TestDecodeCapturedIDs(t *testing.T) {
	sesLow, err := DecodeTimeLow36("f3879bba0ffe", true) // ses_ descending
	if err != nil {
		t.Fatal(err)
	}
	if sesLow != 3347465311 {
		t.Errorf("session 时间解码: got %d want 3347465311", sesLow)
	}
	msgLow, err := DecodeTimeLow36("0c786447b001", false) // msg_ ascending
	if err != nil {
		t.Fatal(err)
	}
	if msgLow != 3347465339 {
		t.Errorf("message 时间解码: got %d want 3347465339", msgLow)
	}
	// 与 UTC 时间戳互证（低36位）
	if want := uint64(time.Date(2026, 9, 22, 5, 11, 0, 447*int(time.Millisecond), time.UTC).UnixMilli()) & mask36; want != sesLow {
		t.Errorf("session 时间与 05:11:00.447Z 不符: %d != %d", sesLow, want)
	}
	if want := uint64(time.Date(2026, 9, 22, 5, 11, 0, 475*int(time.Millisecond), time.UTC).UnixMilli()) & mask36; want != msgLow {
		t.Errorf("message 时间与 05:11:00.475Z 不符: %d != %d", msgLow, want)
	}
	// 会话与首条消息相差 28ms（语义吻合）
	if msgLow-sesLow != 28 {
		t.Errorf("session→message 应相差 28ms, got %d", msgLow-sesLow)
	}
}

func mustMessage(t *testing.T) string {
	t.Helper()
	m, err := MakeMessage(time.Now())
	if err != nil {
		t.Fatal(err)
	}
	return m
}
