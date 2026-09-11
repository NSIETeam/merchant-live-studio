import type { DB, SQLValue } from "../../../shared/persistence.js";
export function recordingQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT merchant_id FROM rooms WHERE id=?").get(...values); }
export function recordingQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM recordings WHERE relative_path=?").get(...values); }
export function recordingQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?,?,?)").run(...values); }
export function recordingQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("DELETE FROM recording_ingest_errors WHERE receipt=?").run(...values); }
export function recordingQuery5(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO recording_ingest_errors(receipt,merchant_id,message,updated_at) VALUES(?,?,?,?) ON CONFLICT(receipt) DO UPDATE SET merchant_id=excluded.merchant_id,message=excluded.message,updated_at=excluded.updated_at").run(...values); }
export function recordingQuery6(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT count(*) AS n FROM recording_ingest_errors WHERE merchant_id=?").get(...values); }
export function recordingQuery7(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id FROM rooms WHERE id=? AND merchant_id=?").get(...values); }
export function recordingQuery8(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT started_at FROM recordings WHERE id=? AND room_id=?").get(...values); }
export function recordingQuery9(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,started_at AS startedAt,completed_at AS completedAt,duration_seconds AS durationSeconds,bytes,sha256,registered_at AS registeredAt FROM recordings WHERE room_id=? AND (started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT 51").all(...values); }
export function recordingQuery10(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM recordings WHERE id=? AND merchant_id=?").get(...values); }
