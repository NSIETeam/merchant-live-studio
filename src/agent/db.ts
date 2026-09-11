import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type AgentDB = DatabaseSync;

export function agentTransaction<T>(db: AgentDB, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openAgentDatabase(path: string): AgentDB {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try {
    db.exec(`
      PRAGMA foreign_keys=ON;
      PRAGMA journal_mode=WAL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS agent_profiles (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('standard','brand')),
        published_version INTEGER, latest_version INTEGER NOT NULL,
        created_at INTEGER NOT NULL, PRIMARY KEY(tenant_id,id)
      );
      CREATE TABLE IF NOT EXISTS agent_prompt_versions (
        tenant_id TEXT NOT NULL, profile_id TEXT NOT NULL, version INTEGER NOT NULL,
        content_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(tenant_id,profile_id,version),
        FOREIGN KEY(tenant_id,profile_id) REFERENCES agent_profiles(tenant_id,id)
      );
      CREATE TRIGGER IF NOT EXISTS agent_prompt_versions_immutable_update
        BEFORE UPDATE ON agent_prompt_versions BEGIN SELECT RAISE(ABORT,'Prompt versions are immutable'); END;
      CREATE TRIGGER IF NOT EXISTS agent_prompt_versions_immutable_delete
        BEFORE DELETE ON agent_prompt_versions BEGIN SELECT RAISE(ABORT,'Prompt versions are immutable'); END;
      CREATE TABLE IF NOT EXISTS agent_runs (
        tenant_id TEXT NOT NULL, id TEXT NOT NULL, room_id TEXT NOT NULL,
        profile_id TEXT NOT NULL, prompt_version INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('rehearsal','live')),
        status TEXT NOT NULL CHECK(status IN ('queued','running','completed','failed')),
        idempotency_key TEXT NOT NULL, request_digest TEXT NOT NULL,
        context_digest TEXT NOT NULL, input_json TEXT NOT NULL,
        result_json TEXT, error TEXT, feedback_json TEXT,
        created_at INTEGER NOT NULL, started_at INTEGER, completed_at INTEGER,
        PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,idempotency_key),
        FOREIGN KEY(tenant_id,profile_id,prompt_version)
          REFERENCES agent_prompt_versions(tenant_id,profile_id,version)
      );
      CREATE INDEX IF NOT EXISTS agent_runs_queue ON agent_runs(status,created_at);
      CREATE INDEX IF NOT EXISTS agent_runs_tenant_room ON agent_runs(tenant_id,room_id,created_at);
    `);
    db.prepare(
      "UPDATE agent_runs SET status='failed',error=?,completed_at=? WHERE status='running'",
    ).run(
      "Agent service restarted during execution; create a new run to retry.",
      Date.now(),
    );
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
