package main

import (
	"crypto/rand"
	"fmt"
	"regexp"
	"sync"
	"time"
)

// identifier.go —— opencode `packages/schema/src/identifier.ts` 算法复刻：
//
//	ID = 前缀 + 12位hex(时间) + 14位base62(随机)
//	时间字段 = Date.now()*0x1000 + counter 的【低 48 位】：
//	  ses_ = 降序（低48位取反，时间越大值越小）
//	  msg_ = 正序
//	counter 为同毫秒内自增序号（起始 1，低12位承载，<4096）。
//
// 证据：opencode-verify-go 黄金向量（asc=0c4506c00001 / desc=f3baf93ffffe @ts=1790000000000）
// 与原 JS 实现逐字节一致；结构 ^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$ 为服务端门①。
// 服务端不校验注册/签名/新鲜度（../docs/分析-会话标识与免费额度校验.md §4/§5），
// 本地生成的结构合法 ID 即可通过准入。

const (
	base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	mask48      = uint64(1)<<48 - 1
	sesPrefix   = "ses_"
	msgPrefix   = "msg_"
)

// 同毫秒计数器（对齐 identifier.ts 的模块级 lastTimestamp/counter）
var (
	idMu      sync.Mutex
	lastMS    int64
	idCounter uint64
)

func nextCounter(ms int64) uint64 {
	if ms == lastMS {
		idCounter++
	} else {
		lastMS = ms
		idCounter = 1
	}
	// counter 占低 12 位：>4095 会污染时间字段，回绕保结构（单毫秒 >4096 次生成才会触发）
	if idCounter > 0xfff {
		idCounter = 1
	}
	return idCounter
}

// makeID 生成一条 ID；descending=true 为 ses_ 降序语义。
func makeID(prefix string, descending bool, ts time.Time) (string, error) {
	ms := ts.UnixMilli()
	idMu.Lock()
	current := uint64(ms)*0x1000 + nextCounter(ms)
	idMu.Unlock()

	v := current & mask48
	if descending {
		v = ^v & mask48
	}
	var rnd [14]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", fmt.Errorf("random: %w", err)
	}
	out := make([]byte, 0, len(prefix)+12+14)
	out = append(out, prefix...)
	out = append(out, fmt.Sprintf("%012x", v)...)
	for _, b := range rnd {
		out = append(out, base62Chars[int(b)%62])
	}
	return string(out), nil
}

// NewSessionID 上游会话 ID（ses_，降序）
func NewSessionID(ts time.Time) (string, error) { return makeID(sesPrefix, true, ts) }

// NewMessageID 上游消息 ID（msg_，正序）
func NewMessageID(ts time.Time) (string, error) { return makeID(msgPrefix, false, ts) }

// 原生 ID 结构判定（门①正则，见../docs/分析-会话标识与免费额度校验.md §5；
// msg_ 服务端不校验但与 ses_ 同构）。
var (
	sesIDRe = regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	msgIDRe = regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
)

// IsNativeSessionID / IsNativeMessageID：值本身已符合上游结构。
// 配置 passthrough_native=true 时此类值可原样透传，不必再走重映射。
func IsNativeSessionID(s string) bool { return sesIDRe.MatchString(s) }
func IsNativeMessageID(s string) bool { return msgIDRe.MatchString(s) }
