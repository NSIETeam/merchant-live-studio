import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findContentScriptConfirmationsByCourseIdAndScriptVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM content_script_confirmations WHERE course_id=? AND script_version=?",
    )
    .get(...values);
}
