package main

import (
	"database/sql"
	"fmt"
	"sync"
	"time"

	_ "github.com/ncruces/go-sqlite3/driver" // 注册 database/sql 驱动 "sqlite3"
	_ "github.com/ncruces/go-sqlite3/embed"  // 内嵌 wasm 运行时（无 cgo）

	"log/slog"
)

// Store —— 会话/消息映射：内存缓存（读路径零延迟）+ SQLite（跨重启持久）。
//
//	session_map : incoming session key → 上游 ses_（1:1 稳定，同一 key 永远同一条）
//	message_map : (session key, message key) → 上游 msg_（可选稳定映射）
//	request_log : 每次转发的审计记录
type Store struct {
	db *sql.DB

	mu       sync.RWMutex
	sessions map[string]string // incoming → upstream ses_
	messages map[string]string // sessKey+"\x00"+msgKey → upstream msg_
}

func msgKey(sessionKey, messageKey string) string { return sessionKey + "\x00" + messageKey }

// OpenStore 打开/初始化 SQLite 并把已有映射预载进内存缓存。
func OpenStore(path string) (*Store, error) {
	db, err := sql.Open("sqlite3", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1) // 单写者：WAL 下最稳妥
	for _, pragma := range []string{
		"PRAGMA busy_timeout=5000",
		"PRAGMA journal_mode=WAL",
		"PRAGMA synchronous=NORMAL",
	} {
		if _, err := db.Exec(pragma); err != nil {
			db.Close()
			return nil, fmt.Errorf("%s: %w", pragma, err)
		}
	}
	schema := `
CREATE TABLE IF NOT EXISTS session_map (
	incoming_key    TEXT PRIMARY KEY,
	upstream_session TEXT NOT NULL UNIQUE,
	created_at_ms   INTEGER NOT NULL,
	last_seen_ms    INTEGER NOT NULL,
	hits            INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS message_map (
	session_key   TEXT NOT NULL,
	incoming_key  TEXT NOT NULL,
	upstream_message TEXT NOT NULL,
	created_at_ms INTEGER NOT NULL,
	hits          INTEGER NOT NULL DEFAULT 1,
	PRIMARY KEY (session_key, incoming_key)
);
CREATE TABLE IF NOT EXISTS request_log (
	id          INTEGER PRIMARY KEY AUTOINCREMENT,
	ts_ms       INTEGER NOT NULL,
	method      TEXT NOT NULL,
	path        TEXT NOT NULL,
	session_key TEXT NOT NULL,
	upstream_session TEXT NOT NULL,
	message_key TEXT,
	upstream_message TEXT NOT NULL,
	upstream_status INTEGER NOT NULL,
	duration_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_request_log_ts ON request_log(ts_ms);
`
	if _, err := db.Exec(schema); err != nil {
		db.Close()
		return nil, fmt.Errorf("create schema: %w", err)
	}

	s := &Store{
		db:       db,
		sessions: make(map[string]string),
		messages: make(map[string]string),
	}
	if err := s.preload(); err != nil {
		db.Close()
		return nil, err
	}
	return s, nil
}

func (s *Store) preload() error {
	rows, err := s.db.Query(`SELECT incoming_key, upstream_session FROM session_map`)
	if err != nil {
		return fmt.Errorf("preload sessions: %w", err)
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err != nil {
			return err
		}
		s.sessions[k] = v
	}
	if err := rows.Err(); err != nil {
		return err
	}

	mrows, err := s.db.Query(`SELECT session_key, incoming_key, upstream_message FROM message_map`)
	if err != nil {
		return fmt.Errorf("preload messages: %w", err)
	}
	defer mrows.Close()
	for mrows.Next() {
		var sess, k, v string
		if err := mrows.Scan(&sess, &k, &v); err != nil {
			return err
		}
		s.messages[msgKey(sess, k)] = v
	}
	return mrows.Err()
}

// MapSession 会话稳定映射：缓存 → DB → 生成新 ses_ 并落库。
func (s *Store) MapSession(key string) (string, error) { return s.MapSessionPreferred(key, "") }

// MapSessionPreferred 同 MapSession；prefer 非空（原生透传）时首次建立映射优先使用它。
// 既有映射永远优先——「同一 key 永远同一条上游 ses_」的稳定性不变；
// prefer 撞 UNIQUE（该 ses_ 已属于其它 key）时本次直接采用 prefer、不落库（下次幂等重试）。
func (s *Store) MapSessionPreferred(key, prefer string) (string, error) {
	now := time.Now().UnixMilli()

	s.mu.RLock()
	v, ok := s.sessions[key]
	s.mu.RUnlock()
	if ok {
		_, _ = s.db.Exec(`UPDATE session_map SET hits=hits+1, last_seen_ms=? WHERE incoming_key=?`, now, key)
		return v, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	// double-check（并发下另一协程可能刚插入）
	if v, ok := s.sessions[key]; ok {
		return v, nil
	}
	var existing string
	err := s.db.QueryRow(`SELECT upstream_session FROM session_map WHERE incoming_key=?`, key).Scan(&existing)
	switch {
	case err == nil:
		s.sessions[key] = existing
		_, _ = s.db.Exec(`UPDATE session_map SET hits=hits+1, last_seen_ms=? WHERE incoming_key=?`, now, key)
		return existing, nil
	case err != sql.ErrNoRows:
		return "", fmt.Errorf("select session: %w", err)
	}

	up := prefer
	if up == "" {
		if up, err = NewSessionID(time.Now()); err != nil {
			return "", err
		}
	}
	if _, err := s.db.Exec(
		`INSERT INTO session_map (incoming_key, upstream_session, created_at_ms, last_seen_ms) VALUES (?,?,?,?)`,
		key, up, now, now,
	); err != nil {
		if prefer != "" {
			slog.Warn("session passthrough conflict, using preferred value without persist",
				"incoming", key, "upstream", prefer, "err", err)
			return prefer, nil
		}
		return "", fmt.Errorf("insert session: %w", err)
	}
	s.sessions[key] = up
	slog.Info("session mapped", "incoming", key, "upstream", up, "preferred", prefer != "")
	return up, nil
}

// MapMessage 消息稳定映射（按会话分域）；未落库过则生成新 msg_。
func (s *Store) MapMessage(sessionKey, messageKey string) (string, error) {
	return s.MapMessagePreferred(sessionKey, messageKey, "")
}

// MapMessagePreferred 同 MapMessage；prefer 非空（原生 msg_ 透传）时首次建立优先用它，
// 既有映射永远优先（按会话分域的稳定性不变）。
func (s *Store) MapMessagePreferred(sessionKey, messageKey, prefer string) (string, error) {
	mk := msgKey(sessionKey, messageKey)
	now := time.Now().UnixMilli()

	s.mu.RLock()
	v, ok := s.messages[mk]
	s.mu.RUnlock()
	if ok {
		_, _ = s.db.Exec(`UPDATE message_map SET hits=hits+1 WHERE session_key=? AND incoming_key=?`, sessionKey, messageKey)
		return v, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if v, ok := s.messages[mk]; ok {
		return v, nil
	}
	var existing string
	err := s.db.QueryRow(
		`SELECT upstream_message FROM message_map WHERE session_key=? AND incoming_key=?`,
		sessionKey, messageKey,
	).Scan(&existing)
	switch {
	case err == nil:
		s.messages[mk] = existing
		_, _ = s.db.Exec(`UPDATE message_map SET hits=hits+1 WHERE session_key=? AND incoming_key=?`, sessionKey, messageKey)
		return existing, nil
	case err != sql.ErrNoRows:
		return "", fmt.Errorf("select message: %w", err)
	}

	up := prefer
	if up == "" {
		if up, err = NewMessageID(time.Now()); err != nil {
			return "", err
		}
	}
	if _, err := s.db.Exec(
		`INSERT INTO message_map (session_key, incoming_key, upstream_message, created_at_ms) VALUES (?,?,?,?)`,
		sessionKey, messageKey, up, now,
	); err != nil {
		return "", fmt.Errorf("insert message: %w", err)
	}
	s.messages[mk] = up
	return up, nil
}

// NewMessageIDFresh 无 message key 时每请求新生成（不落 message_map）。
func (s *Store) NewMessageIDFresh() (string, error) { return NewMessageID(time.Now()) }

// LogRequest 审计写入（log.requests=false 时由调用方跳过）。
func (s *Store) LogRequest(rec RequestRecord) error {
	_, err := s.db.Exec(
		`INSERT INTO request_log
		 (ts_ms, method, path, session_key, upstream_session, message_key, upstream_message, upstream_status, duration_ms)
		 VALUES (?,?,?,?,?,?,?,?,?)`,
		rec.TS, rec.Method, rec.Path, rec.SessionKey, rec.UpstreamSession,
		nullIfEmpty(rec.MessageKey), rec.UpstreamMessage, rec.Status, rec.DurationMS,
	)
	return err
}

type RequestRecord struct {
	TS              int64
	Method          string
	Path            string
	SessionKey      string
	UpstreamSession string
	MessageKey      string
	UpstreamMessage string
	Status          int
	DurationMS      int64
}

func nullIfEmpty(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// SessionMappings 供 /_sessions 查看。
type SessionMappings struct {
	Incoming    string `json:"incoming"`
	Upstream    string `json:"upstream"`
	CreatedAtMs int64  `json:"created_at_ms"`
	LastSeenMs  int64  `json:"last_seen_ms"`
	Hits        int64  `json:"hits"`
}

func (s *Store) ListSessions(limit int) ([]SessionMappings, error) {
	rows, err := s.db.Query(
		`SELECT incoming_key, upstream_session, created_at_ms, last_seen_ms, hits
		 FROM session_map ORDER BY last_seen_ms DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []SessionMappings{}
	for rows.Next() {
		var m SessionMappings
		if err := rows.Scan(&m.Incoming, &m.Upstream, &m.CreatedAtMs, &m.LastSeenMs, &m.Hits); err != nil {
			return nil, err
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// Prune 清理过期审计（keep_days<=0 不清理）。
func (s *Store) Prune(keepDays int) error {
	if keepDays <= 0 {
		return nil
	}
	cutoff := time.Now().Add(-time.Duration(keepDays) * 24 * time.Hour).UnixMilli()
	_, err := s.db.Exec(`DELETE FROM request_log WHERE ts_ms < ?`, cutoff)
	return err
}

func (s *Store) Close() error { return s.db.Close() }
