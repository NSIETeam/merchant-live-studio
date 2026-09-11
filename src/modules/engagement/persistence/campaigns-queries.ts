import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findCampaignsById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM campaigns WHERE id=?").get(...values);
}

export function findClaimsByCampaignIdAndViewerId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM claims WHERE campaign_id=? AND viewer_id=?")
    .get(...values);
}

export function updateCampaignsById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE campaigns SET remaining_cents=remaining_cents-?,remaining_count=remaining_count-1 WHERE id=?",
    )
    .run(...values);
}

export function insertClaims(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO claims VALUES(?,?,?,?,'reserved',?)")
    .run(...values);
}

export function updateCampaignsById2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE campaigns SET status='closed',remaining_cents=0,remaining_count=0 WHERE id=?",
    )
    .run(...values);
}

export function listCampaignsByExpiresAt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT id FROM campaigns WHERE status='active' AND expires_at<=?")
    .all(...values);
}

export function findCampaignsByRoomIdAndExpiresAt(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM campaigns WHERE room_id=? AND status='active' AND expires_at>? ORDER BY opens_at LIMIT 1",
    )
    .get(...values);
}

export function listCampaignsByRoomIdAndExpiresAt(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM campaigns WHERE room_id=? AND status='active' AND expires_at>? ORDER BY opens_at LIMIT 20",
    )
    .all(...values);
}

export function listCampaignsByRoomId(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT id FROM campaigns WHERE room_id=?").all(...values);
}

export function listCampaignsByRoomId2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT id FROM campaigns WHERE room_id=? AND status='active'")
    .all(...values);
}

export function findClaimsById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM claims WHERE id=?").get(...values);
}

export function updateClaimsById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE claims SET status='simulated' WHERE id=? AND status='reserved'",
    )
    .run(...values);
}

export function findClaims(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS claims,coalesce(sum(amount_cents),0) AS reservedCents,coalesce(sum(CASE WHEN status='simulated' THEN amount_cents ELSE 0 END),0) AS simulatedCents FROM claims WHERE campaign_id IN (SELECT id FROM campaigns WHERE room_id=?)",
    )
    .get(...values);
}

export function findQuestionsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT count(*) AS n FROM questions WHERE room_id=?")
    .get(...values);
}

export function listCampaignsByRoomId3(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM campaigns WHERE room_id=? ORDER BY rowid DESC")
    .all(...values);
}

export function insertCampaigns(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO campaigns(id,room_id,total_cents,count,remaining_cents,remaining_count,min_watch_seconds,opens_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
    )
    .run(...values);
}

export function listQuestionsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT min(id) AS id,text,count(*) AS count FROM questions WHERE room_id=? GROUP BY text ORDER BY count DESC,max(created_at) DESC LIMIT 20",
    )
    .all(...values);
}

export function findQuestionsByRoomIdAndViewerId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT created_at FROM questions WHERE room_id=? AND viewer_id=? ORDER BY created_at DESC LIMIT 1",
    )
    .get(...values);
}

export function insertQuestions(db: DB, ...values: SQLValue[]) {
  return db.prepare("INSERT INTO questions VALUES(?,?,?,?,?)").run(...values);
}

export function findCampaignsById2(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT room_id FROM campaigns WHERE id=?").get(...values);
}

export function listClaimsByViewerId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM claims WHERE viewer_id=? AND campaign_id IN (SELECT id FROM campaigns WHERE room_id=?) ORDER BY created_at DESC",
    )
    .all(...values);
}
