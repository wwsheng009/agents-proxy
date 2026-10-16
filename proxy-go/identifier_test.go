package main

import (
	"regexp"
	"testing"
	"time"
)

// 黄金向量：与 verify-go / 原 JS 实现（identifier.ts 复刻）逐字节一致。
// ts=1790000000000, counter=1 → desc=f3baf93ffffe asc=0c4506c00001
func TestIDGoldenVectors(t *testing.T) {
	ts := time.UnixMilli(1790000000000)

	idMu.Lock()
	lastMS, idCounter = -1, 0 // 重置计数器，保证 counter=1
	idMu.Unlock()

	ses, err := NewSessionID(ts)
	if err != nil {
		t.Fatal(err)
	}
	if got := ses[4:16]; got != "f3baf93ffffe" {
		t.Errorf("ses 时间段黄金向量: got %s want f3baf93ffffe", got)
	}

	idMu.Lock()
	lastMS, idCounter = -1, 0
	idMu.Unlock()

	msg, err := NewMessageID(ts)
	if err != nil {
		t.Fatal(err)
	}
	if got := msg[4:16]; got != "0c4506c00001" {
		t.Errorf("msg 时间段黄金向量: got %s want 0c4506c00001", got)
	}
}

func TestIDStructureAndUniqueness(t *testing.T) {
	sesRe := regexp.MustCompile(`^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$`)
	msgRe := regexp.MustCompile(`^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$`)

	seen := make(map[string]bool, 512)
	now := time.Now()
	for i := 0; i < 256; i++ {
		s, err := NewSessionID(now)
		if err != nil {
			t.Fatal(err)
		}
		if !sesRe.MatchString(s) {
			t.Fatalf("session 结构非法: %s", s)
		}
		if seen[s] {
			t.Fatalf("session 重复: %s", s)
		}
		seen[s] = true

		m, err := NewMessageID(now)
		if err != nil {
			t.Fatal(err)
		}
		if !msgRe.MatchString(m) {
			t.Fatalf("message 结构非法: %s", m)
		}
		if seen[m] {
			t.Fatalf("message 重复: %s", m)
		}
		seen[m] = true
	}
}
