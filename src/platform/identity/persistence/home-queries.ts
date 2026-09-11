import type { DB, SQLValue } from "../../../shared/persistence.js";
export function findHomePreferences(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT layout_json,version FROM home_preferences WHERE merchant_id=? AND actor_id=?").get(...values); }
export function findHomeVersion(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT version FROM home_preferences WHERE merchant_id=? AND actor_id=?").get(...values); }
export function upsertHomePreferences(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO home_preferences(merchant_id,actor_id,layout_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(merchant_id,actor_id) DO UPDATE SET layout_json=excluded.layout_json,version=excluded.version,updated_at=excluded.updated_at").run(...values); }
