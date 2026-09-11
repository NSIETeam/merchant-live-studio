import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY, merchant_id TEXT NOT NULL, title TEXT NOT NULL, product_name TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','live','ended')),
      stream_secret TEXT NOT NULL, created_at INTEGER NOT NULL, live_started_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS facts (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), text TEXT NOT NULL,
      evidence TEXT NOT NULL, approved INTEGER NOT NULL DEFAULT 0 CHECK(approved IN(0,1))
    );
    CREATE TABLE IF NOT EXISTS visits (
      room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL,
      first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, watch_seconds INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(room_id,viewer_id)
    );
    CREATE TABLE IF NOT EXISTS presence (
      room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL, minute INTEGER NOT NULL,
      PRIMARY KEY(room_id,viewer_id,minute)
    );
    CREATE TABLE IF NOT EXISTS campaigns (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), total_cents INTEGER NOT NULL CHECK(total_cents>0),
      count INTEGER NOT NULL CHECK(count>0), remaining_cents INTEGER NOT NULL CHECK(remaining_cents>=0),
      remaining_count INTEGER NOT NULL CHECK(remaining_count>=0), min_watch_seconds INTEGER NOT NULL,
      opens_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','closed'))
    );
    CREATE TABLE IF NOT EXISTS claims (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), viewer_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), status TEXT NOT NULL CHECK(status IN ('reserved','simulated')),
      created_at INTEGER NOT NULL, UNIQUE(campaign_id,viewer_id)
    );
    CREATE TABLE IF NOT EXISTS ledger (
      id TEXT PRIMARY KEY, campaign_id TEXT NOT NULL REFERENCES campaigns(id), claim_id TEXT REFERENCES claims(id),
      debit TEXT NOT NULL, credit TEXT NOT NULL, amount_cents INTEGER NOT NULL CHECK(amount_cents>0),
      created_at INTEGER NOT NULL, UNIQUE(claim_id,debit,credit)
    );
    CREATE TABLE IF NOT EXISTS payout_jobs (
      id TEXT PRIMARY KEY, claim_id TEXT NOT NULL UNIQUE REFERENCES claims(id), state TEXT NOT NULL DEFAULT 'pending',
      attempts INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, room_id TEXT NOT NULL REFERENCES rooms(id), viewer_id TEXT NOT NULL,
      text TEXT NOT NULL, created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS rooms_merchant ON rooms(merchant_id);
    CREATE INDEX IF NOT EXISTS campaigns_room ON campaigns(room_id);
    CREATE INDEX IF NOT EXISTS visits_room_seen ON visits(room_id,last_seen);
    CREATE INDEX IF NOT EXISTS questions_room ON questions(room_id);
    INSERT OR IGNORE INTO schema_migrations VALUES(1,unixepoch());
  `);
  return db;
}
export type DB = ReturnType<typeof openDatabase>;
export function transaction<T>(db: DB, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const value = action();
    db.exec("COMMIT");
    return value;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
