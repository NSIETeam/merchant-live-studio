import type { DB, SQLValue } from "../../../shared/persistence.js";
export function rewardQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT room_id AS roomId,version,enabled,points,min_watch_seconds AS minWatchSeconds,daily_limit AS dailyLimit FROM engagement_programs WHERE room_id=? ORDER BY version DESC LIMIT 1").get(...values); }
export function rewardQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT coalesce(sum(delta),0) AS balance FROM engagement_points WHERE merchant_id=? AND viewer_id=?").get(...values); }
export function rewardQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_points VALUES(?,?,?,?,?,?,?)").run(...values); }
export function rewardQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM engagement_gifts WHERE id=? AND merchant_id=?").get(...values); }
export function rewardQuery5(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,title,description,points,stock,enabled,version FROM engagement_gifts WHERE merchant_id=? ORDER BY created_at DESC,id").all(...values); }
export function rewardQuery6(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_events VALUES(?,?,?,?,?,?)").run(...values); }
export function rewardQuery7(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT * FROM engagement_redemptions WHERE id=? AND merchant_id=?").get(...values); }
export function rewardQuery8(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE engagement_gifts SET stock=stock+1 WHERE id=?").run(...values); }
export function rewardQuery9(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE engagement_redemptions SET state=? WHERE id=?").run(...values); }
export function rewardQuery10(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT count(*) AS n FROM engagement_checkins WHERE room_id=? AND day=?").get(...values); }
export function rewardQuery11(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_programs VALUES(?,?,?,?,?,?,?,?)").run(...values); }
export function rewardQuery12(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_gifts VALUES(?,?,?,?,?,?,?,?,?)").run(...values); }
export function rewardQuery13(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_gift_history VALUES(?,?,?,?,?,?)").run(...values); }
export function rewardQuery14(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE engagement_gifts SET title=?,description=?,points=?,stock=?,enabled=?,version=version+1 WHERE id=?").run(...values); }
export function rewardQuery15(db: DB, ...values: SQLValue[]) { return db.prepare(`SELECT rowid AS cursor,id,gift_id AS giftId,title,points,state,created_at AS createdAt FROM engagement_redemptions WHERE merchant_id=? AND rowid<? ORDER BY rowid DESC LIMIT 101`).all(...values); }
export function rewardQuery16(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id FROM engagement_redemptions WHERE id=? AND merchant_id=?").get(...values); }
export function rewardQuery17(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT state,actor_id AS actorId,note,created_at AS createdAt FROM engagement_events WHERE redemption_id=? ORDER BY created_at,rowid").all(...values); }
export function rewardQuery18(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT points,created_at AS createdAt FROM engagement_checkins WHERE room_id=? AND viewer_id=? AND day=?").get(...values); }
export function rewardQuery19(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT delta,reason,reference_id AS referenceId,created_at AS createdAt FROM engagement_points WHERE merchant_id=? AND viewer_id=? ORDER BY rowid DESC LIMIT 100").all(...values); }
export function rewardQuery20(db: DB, ...values: SQLValue[]) { return db.prepare(`SELECT id,gift_id AS giftId,title,points,code,state,created_at AS createdAt FROM engagement_redemptions WHERE merchant_id=? AND viewer_id=? ORDER BY rowid DESC LIMIT 100`).all(...values); }
export function rewardQuery21(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT points FROM engagement_checkins WHERE room_id=? AND viewer_id=? AND day=?").get(...values); }
export function rewardQuery22(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_checkins VALUES(?,?,?,?,?,?,?)").run(...values); }
export function rewardQuery23(db: DB, ...values: SQLValue[]) { return db.prepare(`SELECT id,gift_id AS giftId,title,points,code,state,created_at AS createdAt FROM engagement_redemptions WHERE merchant_id=? AND viewer_id=? AND idempotency_key=?`).get(...values); }
export function rewardQuery24(db: DB, ...values: SQLValue[]) { return db.prepare("UPDATE engagement_gifts SET stock=stock-1 WHERE id=?").run(...values); }
export function rewardQuery25(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO engagement_redemptions VALUES(?,?,?,?,?,?,?,?,?,?)").run(...values); }
export function rewardQuery26(db: DB, ...values: SQLValue[]) { return db.prepare(`SELECT id,gift_id AS giftId,title,points,code,state,created_at AS createdAt FROM engagement_redemptions WHERE id=?`).get(...values); }
