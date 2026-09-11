import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findRoomTitle(db: DB, roomId: string) {
  return db.prepare("SELECT title FROM rooms WHERE id=?").get(roomId);
}

export function findRoomsByIdAndMerchantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT 1 FROM rooms WHERE id=? AND merchant_id=?")
    .get(...values);
}

export function findContentRoomBindingsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM content_room_bindings WHERE room_id=?")
    .get(...values);
}

export function listContentBindingHistoryByRoomIdAndId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT id,room_id AS roomId,course_id AS courseId,script_version AS scriptVersion,\n      bound_at AS boundAt,actor_id AS actorId,source,room_title AS roomTitle,course_title AS courseTitle,product_name AS productName\n      FROM content_binding_history WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 51",
    )
    .all(...values);
}

export function findContentRoomBindingsByRoomId2(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT course_id,script_version FROM content_room_bindings WHERE room_id=?",
    )
    .get(...values);
}

export function insertContentRoomBindings(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO content_room_bindings VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET course_id=excluded.course_id,script_version=excluded.script_version,bound_at=excluded.bound_at",
    )
    .run(...values);
}

export function insertContentBindingHistory(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO content_binding_history(room_id,course_id,script_version,bound_at,actor_id,source,room_title,course_title,product_name)\n        VALUES(?,?,?,?,?,'binding',?,?,?)",
    )
    .run(...values);
}
