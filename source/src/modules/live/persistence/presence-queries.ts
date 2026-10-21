import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findVisitsByRoomIdAndViewerId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT last_seen,watch_millis,session_watch_millis,active FROM visits WHERE room_id=? AND viewer_id=?",
    )
    .get(...values);
}

export function insertVisits(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO visits(room_id,viewer_id,first_seen,last_seen,watch_seconds,watch_millis,session_watch_millis,active) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(room_id,viewer_id) DO UPDATE SET last_seen=excluded.last_seen,watch_seconds=excluded.watch_seconds,watch_millis=excluded.watch_millis,session_watch_millis=excluded.session_watch_millis,active=excluded.active",
    )
    .run(...values);
}

export function insertPresence(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT OR IGNORE INTO presence VALUES(?,?,?)")
    .run(...values);
}
