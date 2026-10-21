import type { DB, SQLValue } from "../../../shared/persistence.js";
export function disclosureStateQuery1(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,action,actor_id AS actorId,note,created_at AS createdAt FROM disclosure_events WHERE merchant_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(...values);
}
export function disclosureStateQuery2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT data_json,evidence_reference AS evidenceReference,author_id AS authorId,created_at AS createdAt FROM disclosure_versions WHERE merchant_id=? AND version=?",
    )
    .get(...values);
}
