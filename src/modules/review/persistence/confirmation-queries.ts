import type { DB, SQLValue } from "../../../shared/persistence.js";

export function insertContentScriptConfirmations(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("INSERT INTO content_script_confirmations VALUES(?,?,?,?,?)")
    .run(...values);
}
