import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findRevokedSessionsByIdAndExpiresAt(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT id FROM revoked_sessions WHERE id=? AND expires_at>?")
    .get(...values);
}
