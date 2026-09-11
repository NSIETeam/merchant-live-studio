import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findContentGenerationImportsByMerchantIdAndJobId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT course_id AS courseId,script_version AS scriptVersion FROM content_generation_imports WHERE merchant_id=? AND job_id=?",
    )
    .get(...values);
}

export function insertContentGenerationImports(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_generation_imports VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}
