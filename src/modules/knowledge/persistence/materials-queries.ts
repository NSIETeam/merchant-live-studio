import type { DB, SQLValue } from "../../../shared/persistence.js";

export function listMaterialImportsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM material_imports WHERE room_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50",
    )
    .all(...values);
}

export function findMaterialImportsByRoomIdAndIdempotencyKey(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM material_imports WHERE room_id=? AND idempotency_key=?",
    )
    .get(...values);
}

export function insertFacts(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO facts(id,room_id,text,evidence,approved) VALUES(?,?,?,?,0)",
    )
    .run(...values);
}

export function insertMaterialImports(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO material_imports VALUES(?,?,?,?,?,?,?,?,?,?,?)")
    .run(...values);
}
