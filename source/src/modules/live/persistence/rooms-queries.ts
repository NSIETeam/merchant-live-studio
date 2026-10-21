import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findRoomsById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM rooms WHERE id=?").get(...values);
}

export function findVisitsByRoomIdAndViewerId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT session_watch_millis,last_seen,active FROM visits WHERE room_id=? AND viewer_id=?",
    )
    .get(...values);
}

export function findVisitsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT count(*) AS uniqueViewers,coalesce(sum(watch_seconds),0) AS totalWatchSeconds,coalesce(avg(watch_seconds),0) AS averageWatchSeconds FROM visits WHERE room_id=?",
    )
    .get(...values);
}

export function findVisitsByRoomIdAndLastSeen(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT count(*) AS n FROM visits WHERE room_id=? AND last_seen>?")
    .get(...values);
}

export function listPresenceByRoomIdAndMinute(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT minute,count(*) AS viewers FROM presence WHERE room_id=? AND minute>=? GROUP BY minute ORDER BY minute",
    )
    .all(...values);
}

export function findRoomsById2(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT id FROM rooms WHERE id=?").get(...values);
}

export function insertRooms(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO rooms(id,merchant_id,title,product_name,status,stream_secret,created_at) VALUES('demo-room','demo','秋日好物 · 品牌直播间','日常随行杯','draft',?,?)",
    )
    .run(...values);
}

export function listRoomsByMerchantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT * FROM rooms WHERE merchant_id=? ORDER BY created_at DESC")
    .all(...values);
}

export function insertRooms2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at) VALUES(?,?,?,?,?,?)",
    )
    .run(...values);
}

export function updateRoomsById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("UPDATE rooms SET status=?,live_started_at=? WHERE id=?")
    .run(...values);
}

export function updateVisitsByRoomId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE visits SET session_watch_millis=0,active=0 WHERE room_id=?",
    )
    .run(...values);
}

export function updateRoomsById2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("UPDATE rooms SET stream_secret=? WHERE id=?")
    .run(...values);
}
