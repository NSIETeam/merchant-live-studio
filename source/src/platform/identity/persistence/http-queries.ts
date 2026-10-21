import type { DB, SQLValue } from "../../../shared/persistence.js";

export function deleteRevokedSessionsByExpiresAt(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("DELETE FROM revoked_sessions WHERE expires_at<?")
    .run(...values);
}

export function insertRevokedSessions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT OR IGNORE INTO revoked_sessions VALUES(?,?)")
    .run(...values);
}
