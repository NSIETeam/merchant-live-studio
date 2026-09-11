import type { DB, SQLValue } from "../../../shared/persistence.js";
export function admissionQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,actor_id AS actorId,basis_json,created_at AS createdAt FROM live_admissions WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 51").all(...values); }
export function admissionQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO live_admissions(room_id,merchant_id,actor_id,basis_json,created_at) VALUES(?,?,?,?,?)").run(...values); }
export function admissionQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE rooms SET status=?,live_started_at=? WHERE id=?").run(...values); }
export function admissionQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE visits SET session_watch_millis=0,active=0 WHERE room_id=?").run(...values); }
