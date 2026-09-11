import type { DB, SQLValue } from "../../../shared/persistence.js";
export function complaintQuery1(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,reply,created_at AS createdAt FROM complaint_events WHERE complaint_id=? ORDER BY version",
    )
    .all(...values);
}
export function complaintQuery2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM complaints WHERE room_id=? AND viewer_id=? AND id>? ORDER BY id LIMIT 51",
    )
    .all(...values);
}
export function complaintQuery3(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM complaints WHERE room_id=? AND merchant_id=? AND id>? ORDER BY id LIMIT 51",
    )
    .all(...values);
}
export function complaintQuery4(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM complaints WHERE viewer_id=? AND idempotency_key=?")
    .get(...values);
}
export function complaintQuery5(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS n FROM complaints WHERE viewer_id=? AND created_at>?",
    )
    .get(...values);
}
export function complaintQuery6(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO complaints VALUES(?,?,?,?,?,?,?,?)")
    .run(...values);
}
export function complaintQuery7(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO complaint_events VALUES(?,?,?,?,?,?)")
    .run(...values);
}
export function complaintQuery8(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM complaints WHERE id=?").get(...values);
}
export function complaintQuery9(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM complaints WHERE id=? AND merchant_id=?")
    .get(...values);
}
export function complaintQuery10(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version FROM complaint_events WHERE complaint_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(...values);
}
export function currentComplaintEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,actor_id,created_at FROM complaint_events WHERE complaint_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(...values);
}
export function complaintAppealByComplaint(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM complaint_appeals WHERE complaint_id=?")
    .get(...values);
}
export function complaintAppealReceipt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM complaint_appeals WHERE viewer_id=? AND idempotency_key=?",
    )
    .get(...values);
}
export function insertComplaintAppeal(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO complaint_appeals VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}
export function complaintAppealByIdAndMerchant(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM complaint_appeals WHERE id=? AND merchant_id=?")
    .get(...values);
}
export function complaintAppealEvents(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,reply,created_at AS createdAt FROM complaint_appeal_events WHERE appeal_id=? ORDER BY version",
    )
    .all(...values);
}
export function currentComplaintAppealEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT version,state,actor_id,created_at FROM complaint_appeal_events WHERE appeal_id=? ORDER BY version DESC LIMIT 1",
    )
    .get(...values);
}
export function insertComplaintAppealEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO complaint_appeal_events VALUES(?,?,?,?,?,?)")
    .run(...values);
}
export function openComplaintDisputeCount(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT count(*) AS n FROM complaints c
       WHERE c.room_id=? AND c.merchant_id=? AND (
         (SELECT state FROM complaint_events e WHERE e.complaint_id=c.id ORDER BY version DESC LIMIT 1)<>'resolved'
         OR EXISTS(
           SELECT 1 FROM complaint_appeals a
           WHERE a.complaint_id=c.id AND
             (SELECT state FROM complaint_appeal_events ae WHERE ae.appeal_id=a.id ORDER BY version DESC LIMIT 1)<>'resolved'
         )
       )`,
    )
    .get(...values);
}
