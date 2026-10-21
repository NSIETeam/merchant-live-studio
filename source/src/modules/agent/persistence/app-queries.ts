import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findAgentProfilesByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM agent_profiles WHERE tenant_id=? AND id=?")
    .get(...values);
}

export function findAgentPromptVersionsByTenantIdAndProfileIdAndVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_prompt_versions WHERE tenant_id=? AND profile_id=? AND version=?",
    )
    .get(...values);
}

export function findAgentRunsByTenantIdAndId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM agent_runs WHERE tenant_id=? AND id=?")
    .get(...values);
}

export function findAgentRuns(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS count FROM agent_runs WHERE status IN ('queued','running')",
    )
    .get(...values);
}

export function findAgentRunsByTenantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS count FROM agent_runs WHERE tenant_id=? AND status IN ('queued','running')",
    )
    .get(...values);
}

export function insertAgentRuns(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO agent_runs(tenant_id,id,room_id,profile_id,prompt_version,mode,status,idempotency_key,request_digest,context_digest,input_json,created_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)",
    )
    .run(...values);
}

export function findAgentProfilesByTenantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT 1 FROM agent_profiles WHERE tenant_id=? AND id='standard'")
    .get(...values);
}

export function insertAgentProfiles(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO agent_profiles VALUES(?,'standard',?,'standard',1,1,?)",
    )
    .run(...values);
}

export function insertAgentPromptVersions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_prompt_versions VALUES(?,'standard',1,?,?)")
    .run(...values);
}

export function listAgentRuns(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT status,count(*) AS count FROM agent_runs WHERE status IN ('queued','running') GROUP BY status",
    )
    .all(...values);
}

export function findAgentRuns2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM agent_runs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
    )
    .get(...values);
}

export function updateAgentRunsByTenantIdAndId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE agent_runs SET status='running',started_at=? WHERE tenant_id=? AND id=? AND status='queued'",
    )
    .run(...values);
}

export function updateAgentRunsByTenantIdAndId2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE agent_runs SET status='completed',result_json=?,completed_at=? WHERE tenant_id=? AND id=? AND status='running'",
    )
    .run(...values);
}

export function updateAgentRunsByTenantIdAndId3(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE agent_runs SET status='failed',error=?,completed_at=? WHERE tenant_id=? AND id=? AND status='running'",
    )
    .run(...values);
}

export function listAgentProfilesByTenantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM agent_profiles WHERE tenant_id=? ORDER BY CASE WHEN id='standard' THEN 0 ELSE 1 END,created_at,id",
    )
    .all(...values);
}

export function insertAgentProfiles2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_profiles VALUES(?,?,?, ?,NULL,1,?)")
    .run(...values);
}

export function insertAgentPromptVersions2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_prompt_versions VALUES(?,?,1,?,?)")
    .run(...values);
}

export function listAgentPromptVersionsByTenantIdAndProfileId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_prompt_versions WHERE tenant_id=? AND profile_id=? ORDER BY version DESC",
    )
    .all(...values);
}

export function insertAgentPromptVersions3(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_prompt_versions VALUES(?,?,?,?,?)")
    .run(...values);
}

export function updateAgentProfilesByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_profiles SET latest_version=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function updateAgentProfilesByTenantIdAndId2(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_profiles SET published_version=? WHERE tenant_id=? AND id=?",
    )
    .run(...values);
}

export function findAgentRunsByTenantIdAndIdempotencyKey(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM agent_runs WHERE tenant_id=? AND idempotency_key=?")
    .get(...values);
}

export function listAgentRunsByTenantIdAndRoomIdAndMode(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_runs WHERE tenant_id=? AND room_id=? AND (? IS NULL OR mode=?) ORDER BY created_at DESC,rowid DESC LIMIT ?",
    )
    .all(...values);
}

export function updateAgentRunsByTenantIdAndId4(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("UPDATE agent_runs SET feedback_json=? WHERE tenant_id=? AND id=?")
    .run(...values);
}
