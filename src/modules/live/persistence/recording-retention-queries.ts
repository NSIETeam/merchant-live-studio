import type { DB, SQLValue } from "../../../shared/persistence.js";

export function retentionRecording(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT r.*,rooms.status AS room_status FROM recordings r JOIN rooms ON rooms.id=r.room_id WHERE r.id=? AND r.merchant_id=?",
    )
    .get(...values);
}
export function retentionHoldByReceipt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM recording_retention_holds WHERE merchant_id=? AND idempotency_key=?",
    )
    .get(...values);
}
export function insertRetentionHold(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO recording_retention_holds VALUES(?,?,?,?,?,?,?,?)")
    .run(...values);
}
export function insertRetentionHoldEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO recording_retention_hold_events VALUES(?,?,?,?,?,?)")
    .run(...values);
}
export function retentionHold(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM recording_retention_holds WHERE id=? AND recording_id=? AND merchant_id=?",
    )
    .get(...values);
}
export function currentRetentionHoldEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,note,actor_id,created_at FROM recording_retention_hold_events WHERE hold_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(...values);
}
export function listRetentionHolds(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT h.id,h.kind,h.reason,h.created_by AS createdBy,h.created_at AS createdAt,
    e.version,e.state,e.note,e.actor_id AS actorId,e.created_at AS eventAt
    FROM recording_retention_holds h
    JOIN recording_retention_hold_events e ON e.hold_id=h.id
    WHERE h.recording_id=? AND e.version=(SELECT max(x.version) FROM recording_retention_hold_events x WHERE x.hold_id=h.id)
    ORDER BY h.created_at DESC,h.id DESC`,
    )
    .all(...values);
}
export function activeRetentionHoldCount(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM recording_retention_holds h
    WHERE h.recording_id=? AND (SELECT state FROM recording_retention_hold_events e WHERE e.hold_id=h.id ORDER BY version DESC LIMIT 1)='active'`,
    )
    .get(...values);
}
export function deletionRequestByReceipt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM recording_deletion_requests WHERE merchant_id=? AND idempotency_key=?",
    )
    .get(...values);
}
export function insertDeletionRequest(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO recording_deletion_requests VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}
export function insertDeletionEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO recording_deletion_events VALUES(?,?,?,?,?,?)")
    .run(...values);
}
export function deletionRequest(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM recording_deletion_requests WHERE id=? AND recording_id=? AND merchant_id=?",
    )
    .get(...values);
}
export function currentDeletionEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,note,actor_id,created_at FROM recording_deletion_events WHERE request_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(...values);
}
export function listDeletionRequests(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT r.id,r.reason,r.requested_by AS requestedBy,r.created_at AS createdAt,
    e.version,e.state,e.note,e.actor_id AS actorId,e.created_at AS eventAt
    FROM recording_deletion_requests r
    JOIN recording_deletion_events e ON e.request_id=r.id
    WHERE r.recording_id=? AND e.version=(SELECT max(x.version) FROM recording_deletion_events x WHERE x.request_id=r.id)
    ORDER BY r.created_at DESC,r.id DESC`,
    )
    .all(...values);
}
export function openDeletionRequestCount(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM recording_deletion_requests r
    WHERE r.recording_id=? AND (SELECT state FROM recording_deletion_events e WHERE e.request_id=r.id ORDER BY version DESC LIMIT 1) IN('requested','approved','deleting','failed')`,
    )
    .get(...values);
}
export function executingDeletionRequestCount(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM recording_deletion_requests r
    WHERE r.recording_id=? AND (SELECT state FROM recording_deletion_events e WHERE e.request_id=r.id ORDER BY version DESC LIMIT 1) IN('approved','deleting')`,
    )
    .get(...values);
}
export function deletedRecordingRequest(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT r.id FROM recording_deletion_requests r
    WHERE r.recording_id=? AND (SELECT state FROM recording_deletion_events e WHERE e.request_id=r.id ORDER BY version DESC LIMIT 1)='deleted' LIMIT 1`,
    )
    .get(...values);
}
