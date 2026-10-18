import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { Config } from "./config"
import { makeId, SESSION_ID_RE } from "./identifier"

export class SessionStore {
  private readonly db: Database
  private readonly passthroughNative: boolean
  private readonly getStmt
  private readonly insertStmt
  private readonly touchStmt

  constructor(config: Config) {
    this.passthroughNative = config.session.passthroughNative
    if (config.dbPath !== ":memory:") {
      const dir = dirname(config.dbPath)
      if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true })
    }
    this.db = new Database(config.dbPath, { create: true })
    this.db.exec("PRAGMA journal_mode=WAL;")
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_map (
        incoming_key     TEXT PRIMARY KEY,
        upstream_session TEXT NOT NULL UNIQUE,
        created_at_ms    INTEGER NOT NULL,
        last_seen_ms     INTEGER NOT NULL,
        hits             INTEGER NOT NULL DEFAULT 1
      );
    `)
    this.getStmt = this.db.query(
      "SELECT upstream_session FROM session_map WHERE incoming_key = ?",
    )
    this.insertStmt = this.db.query(
      "INSERT INTO session_map (incoming_key, upstream_session, created_at_ms, last_seen_ms, hits) VALUES (?, ?, ?, ?, 1)",
    )
    this.touchStmt = this.db.query(
      "UPDATE session_map SET hits = hits + 1, last_seen_ms = ? WHERE incoming_key = ?",
    )
  }

  map(key: string): string {
    if (this.passthroughNative && SESSION_ID_RE.test(key)) return key

    const row = this.getStmt.get(key) as { upstream_session: string } | null
    if (row) {
      this.touchStmt.run(Date.now(), key)
      return row.upstream_session
    }

    const session = makeId("ses_", true)
    const now = Date.now()
    this.insertStmt.run(key, session, now, now)
    return session
  }

  count(): number {
    const row = this.db.query("SELECT COUNT(*) AS count FROM session_map").get() as {
      count: number
    }
    return row.count
  }

  close(): void {
    this.db.close()
  }
}
