import type { DB, SQLValue } from "../../../shared/persistence.js";

export function listTenantPlanIds(db: DB, products: string) {
  return db
    .prepare(
      "SELECT id FROM content_plans WHERE product_id IN (SELECT value FROM json_each(?))",
    )
    .all(products);
}

export function findContentPlansById(db: DB, ...values: SQLValue[]) {
  return db.prepare("SELECT * FROM content_plans WHERE id=?").get(...values);
}

export function listContentPlansByProductId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT * FROM content_plans WHERE product_id IN (SELECT value FROM json_each(?)) AND (? IS NULL OR product_id=?) ORDER BY created_at DESC,rowid DESC",
    )
    .all(...values);
}

export function insertContentPlans(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_plans VALUES(?,?,?,?,?,?)")
    .run(...values);
}

export function updateContentPlansById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE content_plans SET name=?,audience=?,total_days=? WHERE id=?",
    )
    .run(...values);
}
