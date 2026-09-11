import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findAgentEvaluationSuitesByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM agent_evaluation_suites WHERE tenant_id=? AND id=?")
    .get(...values);
}

export function findAgentEvaluationsByTenantIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM agent_evaluations WHERE tenant_id=? AND id=?")
    .get(...values);
}

export function listAgentEvaluationItemsByTenantIdAndEvaluationId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_evaluation_items WHERE tenant_id=? AND evaluation_id=? ORDER BY variant_index,rowid",
    )
    .all(...values);
}

export function findAgentExampleImportsByTenantIdAndProfileIdAndIdempotencyKey(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT request_digest,receipt_json FROM agent_example_imports WHERE tenant_id=? AND profile_id=? AND idempotency_key=?",
    )
    .get(...values);
}

export function insertAgentPromptVersions(db: DB, ...values: SQLValue[]) {
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

export function insertAgentExampleImports(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_example_imports VALUES(?,?,?,?,?,?,?,?)")
    .run(...values);
}

export function listAgentExampleImportsByTenantIdAndProfileId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT receipt_json FROM agent_example_imports WHERE tenant_id=? AND profile_id=? ORDER BY created_at DESC,rowid DESC",
    )
    .all(...values);
}

export function listAgentEvaluationSuitesByTenantIdAndRoomId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM agent_evaluation_suites WHERE tenant_id=? AND room_id=? ORDER BY created_at DESC,rowid DESC",
    )
    .all(...values);
}

export function findAgentEvaluationSuitesByTenantIdAndRoomIdAndName(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT COALESCE(MAX(revision),0)+1 AS next FROM agent_evaluation_suites WHERE tenant_id=? AND room_id=? AND name=?",
    )
    .get(...values);
}

export function insertAgentEvaluationSuites(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_evaluation_suites VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}

export function findAgentEvaluationsByTenantIdAndIdempotencyKey(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT id,request_digest FROM agent_evaluations WHERE tenant_id=? AND idempotency_key=?",
    )
    .get(...values);
}

export function insertAgentEvaluations(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(...values);
}

export function insertAgentEvaluationItems(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO agent_evaluation_items VALUES(?,?,?,?,?,?,NULL)")
    .run(...values);
}

export function listAgentEvaluationsByTenantIdAndRoomId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT id FROM agent_evaluations WHERE tenant_id=? AND room_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
    )
    .all(...values);
}

export function updateAgentEvaluationItemsByTenantIdAndEvaluationIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "UPDATE agent_evaluation_items SET review_json=? WHERE tenant_id=? AND evaluation_id=? AND id=?",
    )
    .run(...values);
}
