package main

import (
	"regexp"
	"strings"
)

// admit.go —— 复刻推断出的闭源 Console 免费额度【准入判定】，
// 与 ../docs/分析-会话标识与免费额度校验.md §5.1 伪代码行为级等价：
//
//	门① x-opencode-session 结构校验（先执行，P23 证明）：
//	    ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$  → 失败 403 FreeTierError
//	门② User-Agent 版本校验（子串、大小写不敏感）：
//	    解析不出 opencode/<semver>          → 403 FreeTierError
//	    版本 < 1.18.0                      → 426 UpgradeRequired
//	    其余（含 client/project/msg 头与 body）→ 不参与准入
//
// 其余三头（request/client/project）与 body 实测均不校验：P9/P15/P19 删除仍 200。

var (
	// session 结构：小写 hex 时间段 + base62 随机段（P4/P5/P7/P12/P13/P16/P25 证伪边界）
	sessionRe = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	// message 结构（服务端不校验，仅用于本地生成自检）
	messageRe = regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	// UA：大小写不敏感、子串搜索 opencode/<主>.<次>[.<修>]（P8/P10/P11/P17/P18/P20~P22/P24）
	uaRe = regexp.MustCompile(`(?i)opencode/(\d+)\.(\d+)(\.(\d+))?`)
)

// 免费额度最低版本门槛（P11/P17 → 426；P18 → 200 闭区间）
const minVersion = "1.18.0"

// verdict = 判定结果（与上游错误体对齐）
type verdict struct {
	Status  int    `json:"status"`            // 200 / 403 / 426
	ErrType string `json:"errType,omitempty"` // FreeTierError / UpgradeRequired（通过为空）
	Reason  string `json:"reason"`            // 本地中文说明
}

// 判定结果构造器（表驱动用；不走 admit 逻辑，避免同义反复）
func wantPass() verdict       { return verdict{200, "", "双门通过"} }
func wantSession403() verdict { return verdict{403, "FreeTierError", "门① session 结构"} }
func wantUA403() verdict      { return verdict{403, "FreeTierError", "门② UA 解析失败"} }
func wantUA426() verdict      { return verdict{426, "UpgradeRequired", "门② UA 版本<1.18.0"} }

// admit 按上述两道门判定一组 header（key 大小写不敏感）。
func admit(h map[string]string) verdict {
	// 门①（优先级最高，P23：非法 session + 旧 UA → 403 而非 426）
	if !sessionRe.MatchString(getHeader(h, "x-opencode-session")) {
		return wantSession403()
	}
	// 门②：UA 子串解析 + 版本比较
	m := uaRe.FindStringSubmatch(getHeader(h, "user-agent"))
	if m == nil {
		return wantUA403()
	}
	major := atoiOrZero(m[1])
	minor := atoiOrZero(m[2])
	// m[3]/m[4] = 可选第三段（缺省视为 0，P21）；预发布后缀在正则处截断（P20 不影响判定）
	// (major,minor) 与 (1,18) 比较即等价 >= 1.18.0（patch 恒 >=0）
	if major < 1 || (major == 1 && minor < 18) {
		return wantUA426() // P11(0.0.1)/P17(1.17.99) → 426
	}
	return wantPass() // P18(1.18.0 闭区间)/P20/P21/P22/P24
}

func getHeader(h map[string]string, name string) string {
	for k, v := range h {
		if strings.EqualFold(k, name) {
			return v
		}
	}
	return ""
}

func atoiOrZero(s string) int {
	n := 0
	for _, c := range s {
		if c < '0' || c > '9' {
			return n
		}
		n = n*10 + int(c-'0')
	}
	return n
}
