import type { DB, SQLValue } from "../../../shared/persistence.js";
export function insertProfileRevocation(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT OR IGNORE INTO content_profile_revocations VALUES(?,?,?,?,?)").run(...values); }
export function listProfileRevocations(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT p.profile_id AS profile,p.reason,c.verified_at AS checked FROM content_profile_revocations p LEFT JOIN content_authorization_checks c ON c.merchant_id=p.merchant_id AND c.profile_id=p.profile_id WHERE p.merchant_id=?").all(...values); }
export function listAuthorizationChecks(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT profile_id AS profile,verified_at AS checked FROM content_authorization_checks WHERE merchant_id=?").all(...values); }
export function clearAuthorizationChecks(db: DB, ...values: SQLValue[]) { return db.prepare("DELETE FROM content_authorization_checks WHERE merchant_id=?").run(...values); }
export function insertAuthorizationCheck(db: DB, ...values: SQLValue[]) { return db.prepare("INSERT INTO content_authorization_checks VALUES(?,?,?)").run(...values); }
