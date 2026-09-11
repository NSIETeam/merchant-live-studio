import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findDatabase(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT 1").get(...values);
}
