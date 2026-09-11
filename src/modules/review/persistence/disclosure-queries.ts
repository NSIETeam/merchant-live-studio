import type { DB, SQLValue } from "../../../shared/persistence.js";
export function disclosureQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT version,data_json,evidence_reference AS evidenceReference,author_id AS authorId,created_at AS createdAt FROM disclosure_versions WHERE merchant_id=? ORDER BY version DESC LIMIT 1").get(...values); }
export function disclosureQuery2(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,version,action,actor_id AS actorId,note,created_at AS createdAt FROM disclosure_events WHERE merchant_id=? ORDER BY id DESC LIMIT 1").get(...values); }
export function disclosureQuery3(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,version,action,actor_id AS actorId,note,created_at AS createdAt FROM disclosure_events WHERE merchant_id=? ORDER BY id DESC LIMIT 100").all(...values); }
export function disclosureQuery4(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO disclosure_versions VALUES(?,?,?,?,?,?,?)").run(...values); }
export function disclosureQuery5(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT 1 FROM disclosure_events WHERE merchant_id=? AND version=?").get(...values); }
export function disclosureQuery6(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO disclosure_events(merchant_id,version,action,actor_id,note,created_at) VALUES(?,?,?,?,?,?)").run(...values); }
export function disclosureQuery7(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT data_json FROM disclosure_versions WHERE merchant_id=? AND version=?").get(...values); }
