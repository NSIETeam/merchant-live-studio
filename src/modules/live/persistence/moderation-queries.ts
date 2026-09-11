import type { DB, SQLValue } from "../../../shared/persistence.js";
export function moderationQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM moderation_actions WHERE room_id=? AND kind IN('stop','release') ORDER BY id DESC LIMIT 1").get(...values); }
export function moderationQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM rooms WHERE id=? AND merchant_id=?").get(...values); }
export function moderationQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,disconnected,message,actor_id AS actorId,created_at AS createdAt FROM moderation_results WHERE action_id=? ORDER BY id DESC LIMIT 1").get(...values); }
export function moderationQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO moderation_results(action_id,disconnected,message,actor_id,created_at) VALUES(?,?,?,?,?)").run(...values); }
export function moderationQuery5(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,kind,note,evidence_reference AS evidenceReference,actor_id AS actorId,created_at AS createdAt,hold_id AS holdId FROM moderation_actions WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 51").all(...values); }
export function moderationQuery6(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM moderation_actions WHERE merchant_id=? AND idempotency_key=?").get(...values); }
export function moderationQuery7(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO moderation_actions(room_id,merchant_id,actor_id,kind,note,evidence_reference,hold_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)").run(...values); }
export function moderationQuery8(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE rooms SET status='ended',stream_secret=? WHERE id=?").run(...values); }
export function moderationQuery9(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE visits SET active=0 WHERE room_id=?").run(...values); }
