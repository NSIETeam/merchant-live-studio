import type { DB, SQLValue } from "../../../shared/persistence.js";

export function listFactsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM facts WHERE room_id=? ORDER BY rowid")
    .all(...values);
}

export function insertFacts(db: DB, ...values: SQLValue[]) {
  return db.prepare("INSERT INTO facts VALUES(?,?,?,?,?)").run(...values);
}

export function findFactsById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT room_id FROM facts WHERE id=?").get(...values);
}

export function updateFactsById(db: DB, ...values: SQLValue[]) {
  return db.prepare("UPDATE facts SET approved=? WHERE id=?").run(...values);
}
