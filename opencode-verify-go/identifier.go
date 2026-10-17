package main

import (
	"crypto/rand"
	"fmt"
	"time"
)

// identifier.go —— 复刻 opencode `packages/schema/src/identifier.ts`（源码级算法）：
//
//	ID = 前缀 + 12位hex(时间) + 14位base62(随机)
//	time 字段 = Date.now()*0x1000 + counter 的【低 48 位】（4096=2^12 为 counter 留位，
//	            真实时间戳只低 36 位进入 ID，存在 2^36 ms 回绕）；
//	ses_  = descending（低48位取反，时间越大值越小 → 降序）；
//	msg_  = ascending （低48位原值，正序）。
//
// 交叉验证：Go 实现的黄金向量与原 JS 实现逐字节一致（见 admit_test.go），
// 且解码抓包原始 ID 得到的时间与 分析文档 §1 记录（05:11:00.447/.475Z）吻合。

const (
	base62Chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
	mask48      = uint64(1)<<48 - 1
	mask36      = uint64(1)<<36 - 1
)

const (
	sesPrefix = "ses_"
	msgPrefix = "msg_"
)

// MakeID 生成一条客户端 ID。counter 为同毫秒序号（生成器从 1 起）。
func MakeID(prefix string, descending bool, ts time.Time, counter uint64) (string, error) {
	current := uint64(ts.UnixMilli())*0x1000 + counter // Date.now()*0x1000 + counter
	v := current & mask48                              // 只取低 48 位（6 字节）
	if descending {
		v = ^v & mask48 // 取反 → 降序
	}
	var rnd [14]byte
	if _, err := rand.Read(rnd[:]); err != nil {
		return "", fmt.Errorf("random: %w", err)
	}
	out := make([]byte, 0, len(prefix)+12+14)
	out = append(out, prefix...)
	out = append(out, fmt.Sprintf("%012x", v)...)
	for _, b := range rnd {
		out = append(out, base62Chars[int(b)%62]) // 与 JS 实现同分布：byte % 62
	}
	return string(out), nil
}

// MakeSession / MakeMessage 便捷封装：ses 降序、msg 正序，counter=1（与实测一致）。
func MakeSession(ts time.Time) (string, error) { return MakeID(sesPrefix, true, ts, 1) }
func MakeMessage(ts time.Time) (string, error) { return MakeID(msgPrefix, false, ts, 1) }

// DecodeTimeLow36 从 ID 的 12 位 hex 时间段解回 epoch 毫秒的【低 36 位】。
// 原理：low48 = (ts*4096 + counter) mod 2^48，低 12 位恰为 counter（<4096），
//
//	减掉 counter 再 >>12 即 ts mod 2^36。descending 需先按低48位取反还原。
func DecodeTimeLow36(timeHex string, descending bool) (uint64, error) {
	if len(timeHex) != 12 {
		return 0, fmt.Errorf("time field must be 12 hex chars, got %d", len(timeHex))
	}
	var v uint64
	for i := 0; i < 12; i++ {
		c := timeHex[i]
		var d uint64
		switch {
		case c >= '0' && c <= '9':
			d = uint64(c - '0')
		case c >= 'a' && c <= 'f':
			d = uint64(c-'a') + 10
		default:
			return 0, fmt.Errorf("invalid hex char %q", c)
		}
		v = v<<4 | d
	}
	if descending {
		v = ^v & mask48
	}
	counter := v & 0xfff         // 低12位 = counter（起始1，恒<4096）
	tsLow := (v - counter) >> 12 // ts*4096 >> 12 = ts mod 2^36
	return tsLow & mask36, nil
}
