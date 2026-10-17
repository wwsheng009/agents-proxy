package main

import (
	"flag"
	"fmt"
	"os"
	"strings"
	"time"
)

// opencode-verify-go：准入规则验证程序（Go 版）
//
//	离线（默认）：复刻的双门准入逻辑 × 24 针实测证据表逐条比对，零网络、零额度消耗。
//	在线（-live）：向真实端点重放同一组用例，比对实际状态码与预测（消耗免费额度）。
//
// 证据来源：../docs/分析-会话标识与免费额度校验.md §4/§5、data/replay/probe-matrix*.json。

func main() {
	live := flag.Bool("live", false, "在线模式：向真实端点发探针（⚠ 消耗免费额度）")
	only := flag.String("case", "", "只运行名称前缀匹配的用例，如 P23 或 P1（默认全部）")
	payload := flag.String("payload", "", "在线模式 payload 路径（默认自动探测 data/replay/muc7umlx-1qdmbboy.json）")
	out := flag.String("out", "", "在线模式 JSON 结果输出路径（默认自动探测 data/replay/probe-matrix-go.json）")
	maxTokens := flag.Int("max-tokens", 8, "在线模式把 payload 的 max_tokens 改小以省额度（0=原样）")
	timeout := flag.Duration("timeout", 30*time.Second, "在线模式单针超时")
	flag.Parse()

	cases := evidenceCases()
	if *only != "" {
		var sel []probeCase
		for _, c := range cases {
			if strings.HasPrefix(c.Name, *only) {
				sel = append(sel, c)
			}
		}
		if len(sel) == 0 {
			fmt.Fprintf(os.Stderr, "没有匹配 -case=%q 的用例\n", *only)
			os.Exit(2)
		}
		cases = sel
	}

	if *live {
		os.Exit(runLive(cases, *payload, *out, *maxTokens, *timeout))
	}
	os.Exit(runOffline(cases))
}

// runOffline 离线验证：admit(复刻规则)(用例头) == 用例期望(实测证据)
func runOffline(cases []probeCase) int {
	fmt.Println("离线验证：复刻双门准入规则 × 24 针实测证据表")
	fmt.Println("  门① x-opencode-session: ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$（先执行，P23）")
	fmt.Println("  门② user-agent: 子串解析 opencode/<semver> >= 1.18.0（失败403/过旧426，P8~P24）")
	fmt.Println("  不参与准入: x-opencode-request / x-opencode-client / x-opencode-project / body（P9/P15/P19）")
	fmt.Println("  期望值: data/replay/probe-matrix*.json 实测状态码 | 规则: opencode-verify-go/admit.go")
	fmt.Println()

	now := time.Now()
	pass, fail := 0, 0
	for _, c := range cases {
		h, err := buildHeaders(c, now)
		if err != nil {
			fmt.Printf("%-30s 生成ID失败: %v\n", c.Name, err)
			fail++
			continue
		}
		got := admit(h)
		if got == c.Want {
			pass++
			fmt.Printf("%-30s want=%-4d got=%-4d ✓  %s\n", c.Name, c.Want.Status, got.Status, c.Evidence)
		} else {
			fail++
			fmt.Printf("%-30s want=%-4d got=%-4d ✗  want=%+v got=%+v\n", c.Name, c.Want.Status, got.Status, c.Want, got)
		}
	}
	fmt.Println()
	if fail == 0 {
		fmt.Printf("合计 %d/%d 通过 —— 复刻规则与全部实测证据一致\n", pass, pass+fail)
		return 0
	}
	fmt.Printf("合计 %d 通过 / %d 失败 —— 复刻规则与证据不一致\n", pass, fail)
	return 1
}
