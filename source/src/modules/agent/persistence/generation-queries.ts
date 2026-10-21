import type { DB, SQLValue } from "../../../shared/persistence.js";

export function initializeAgentGenerationJobs(db: DB) {
  return db.exec(
    "\n    CREATE TABLE IF NOT EXISTS agent_generation_jobs (\n      tenant_id TEXT NOT NULL,id TEXT NOT NULL,course_id TEXT NOT NULL,status TEXT NOT NULL,\n      idempotency_key TEXT NOT NULL,digest TEXT NOT NULL,input_json TEXT NOT NULL,\n      outline_json TEXT,chapters_json TEXT NOT NULL DEFAULT '[]',error TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,\n      PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,idempotency_key)\n    );\n    CREATE INDEX IF NOT EXISTS agent_generation_queue ON agent_generation_jobs(status,updated_at);\n    CREATE TRIGGER IF NOT EXISTS agent_generation_input_immutable BEFORE UPDATE OF tenant_id,id,course_id,idempotency_key,digest,input_json,created_at ON agent_generation_jobs\n      BEGIN SELECT RAISE(ABORT,'Generation input is immutable'); END;\n    CREATE TABLE IF NOT EXISTS agent_generation_attempts (\n      id TEXT PRIMARY KEY,tenant_id TEXT NOT NULL,job_id TEXT NOT NULL,stage INTEGER NOT NULL,provider TEXT NOT NULL,\n      result TEXT NOT NULL,error TEXT,created_at INTEGER NOT NULL,\n      FOREIGN KEY(tenant_id,job_id) REFERENCES agent_generation_jobs(tenant_id,id)\n    );\n    CREATE TRIGGER IF NOT EXISTS agent_generation_attempts_immutable_update BEFORE UPDATE ON agent_generation_attempts\n      BEGIN SELECT RAISE(ABORT,'Generation attempts are immutable'); END;\n    CREATE TRIGGER IF NOT EXISTS agent_generation_attempts_immutable_delete BEFORE DELETE ON agent_generation_attempts\n      BEGIN SELECT RAISE(ABORT,'Generation attempts are immutable'); END;\n  ",
  );
}

export function updateAgentGenerationJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status='failed',error='服务中断，已完成章节保留，可继续生成。',updated_at=? WHERE status='running'",
    )
    .run(...values);
}

export function findAgentGenerationJobsByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM agent_generation_jobs WHERE tenant_id=? AND id=?")
    .get(...values);
}

export function findAgentGenerationJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS total,sum(CASE WHEN tenant_id=? THEN 1 ELSE 0 END) AS owned FROM agent_generation_jobs WHERE status IN ('queued','running','waiting_configuration')",
    )
    .get(...values);
}

export function insertAgentGenerationAttempts(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_generation_attempts VALUES(?,?,?,?,?,?,?,?)")
    .run(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET outline_json=?,chapters_json=?,status=?,error=NULL,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId2(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status='failed',error=?,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function findAgentGenerationJobs2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM agent_generation_jobs WHERE status='queued' ORDER BY updated_at,id LIMIT 1",
    )
    .get(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId3(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status=?,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function findAgentGenerationJobsByTenantIdAndIdempotencyKey(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_generation_jobs WHERE tenant_id=? AND idempotency_key=?",
    )
    .get(...values);
}

export function insertAgentGenerationJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO agent_generation_jobs(tenant_id,id,course_id,status,idempotency_key,digest,input_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(...values);
}

export function listAgentGenerationJobsByTenantIdAndCourseIdAndRowid(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT rowid AS cursor,* FROM agent_generation_jobs WHERE tenant_id=? AND course_id=? AND rowid<? ORDER BY rowid DESC LIMIT 21",
    )
    .all(...values);
}

export function listAgentGenerationAttemptsByTenantIdAndJobId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT stage,provider,result,error,created_at AS createdAt FROM agent_generation_attempts WHERE tenant_id=? AND job_id=? ORDER BY rowid",
    )
    .all(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId4(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status='cancelled',error=NULL,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId5(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status='queued',error=NULL,updated_at=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function updateAgentGenerationJobsByTenantIdAndId6(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_generation_jobs SET status='failed',error='服务停止，已完成章节保留，可继续生成。',updated_at=? WHERE tenant_id=? AND id=? AND status='running'",
    )
    .run(...values);
}
