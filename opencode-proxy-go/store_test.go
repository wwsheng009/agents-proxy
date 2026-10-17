package main

import (
	"path/filepath"
	"testing"
)

// 同一 key 稳定返回同一条上游 session；不同 key 不同。
func TestMapSessionStable(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	s, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	a1, err := s.MapSession("app-alpha")
	if err != nil {
		t.Fatal(err)
	}
	a2, _ := s.MapSession("app-alpha")
	if a1 != a2 {
		t.Errorf("同 key 映射不稳定: %s != %s", a1, a2)
	}
	b1, _ := s.MapSession("app-beta")
	if b1 == a1 {
		t.Errorf("不同 key 映射到同一 session: %s", a1)
	}
}

// 关闭后重新打开：映射从 SQLite 恢复（跨重启稳定）。
func TestMapSessionPersistsAcrossReopen(t *testing.T) {
	path := filepath.Join(t.TempDir(), "t.db")
	s1, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	before, _ := s1.MapSession("persist-key")
	s1.Close()

	s2, err := OpenStore(path)
	if err != nil {
		t.Fatal(err)
	}
	defer s2.Close()
	after, err := s2.MapSession("persist-key")
	if err != nil {
		t.Fatal(err)
	}
	if before != after {
		t.Errorf("重启后映射变化: %s != %s", before, after)
	}
}

// message 映射按会话分域：同 message key 不同会话 → 不同上游 msg_。
func TestMapMessageScopedBySession(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	mA1, _ := s.MapMessage("sess-A", "turn-1")
	mA2, _ := s.MapMessage("sess-A", "turn-1")
	if mA1 != mA2 {
		t.Errorf("同会话同 message key 不稳定: %s != %s", mA1, mA2)
	}
	mB, _ := s.MapMessage("sess-B", "turn-1")
	if mB == mA1 {
		t.Errorf("不同会话的相同 message key 未分域: %s", mB)
	}
	// 无 key 新生成：连续两次不同
	f1, _ := s.NewMessageIDFresh()
	f2, _ := s.NewMessageIDFresh()
	if f1 == f2 {
		t.Errorf("fresh msg 重复: %s", f1)
	}
}

func TestRequestLogAndList(t *testing.T) {
	s, err := OpenStore(filepath.Join(t.TempDir(), "t.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()

	sess, _ := s.MapSession("k")
	if err := s.LogRequest(RequestRecord{
		TS: 1700000000000, Method: "POST", Path: "/v1/chat/completions",
		SessionKey: "k", UpstreamSession: sess,
		UpstreamMessage: "msg_x", Status: 200, DurationMS: 12,
	}); err != nil {
		t.Fatal(err)
	}
	list, err := s.ListSessions(10)
	if err != nil || len(list) != 1 || list[0].Incoming != "k" {
		t.Errorf("ListSessions: %v %v", list, err)
	}
	if err := s.Prune(7); err != nil {
		t.Errorf("Prune: %v", err)
	}
}
