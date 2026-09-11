import type { DB, SQLValue } from "../../../shared/persistence.js";
export function complaintQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT version,state,reply,created_at AS createdAt FROM complaint_events WHERE complaint_id=? ORDER BY version").all(...values); }
export function complaintQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM complaints WHERE room_id=? AND viewer_id=? AND id>? ORDER BY id LIMIT 51").all(...values); }
export function complaintQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM complaints WHERE room_id=? AND merchant_id=? AND id>? ORDER BY id LIMIT 51").all(...values); }
export function complaintQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM complaints WHERE viewer_id=? AND idempotency_key=?").get(...values); }
export function complaintQuery5(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT count(*) AS n FROM complaints WHERE viewer_id=? AND created_at>?").get(...values); }
export function complaintQuery6(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO complaints VALUES(?,?,?,?,?,?,?,?)").run(...values); }
export function complaintQuery7(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO complaint_events VALUES(?,?,?,?,?,?)").run(...values); }
export function complaintQuery8(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM complaints WHERE id=?").get(...values); }
export function complaintQuery9(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM complaints WHERE id=? AND merchant_id=?").get(...values); }
export function complaintQuery10(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT version FROM complaint_events WHERE complaint_id=? ORDER BY version DESC LIMIT 1").get(...values); }
