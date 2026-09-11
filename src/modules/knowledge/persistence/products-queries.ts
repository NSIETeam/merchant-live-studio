import type { DB, SQLValue } from "../../../shared/persistence.js";

export function findContentProductsByIdAndMerchantId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT * FROM content_products WHERE id=? AND merchant_id=?")
    .get(...values);
}

export function findContentProductVersionsByProductIdAndVersion(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT snapshot_json FROM content_product_versions WHERE product_id=? AND version=?",
    )
    .get(...values);
}

export function listContentProductsByMerchantId(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("SELECT id FROM content_products WHERE merchant_id=?")
    .all(...values);
}

export function listContentProductsByMerchantId2(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT * FROM content_products WHERE merchant_id=? ORDER BY updated_at DESC,rowid DESC",
    )
    .all(...values);
}

export function findContentProductsByMerchantIdAndSku(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare("SELECT 1 FROM content_products WHERE merchant_id=? AND sku=?")
    .get(...values);
}

export function insertContentProducts(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_products VALUES(?,?,?,?,?,1,?,?)")
    .run(...values);
}

export function insertContentProductVersions(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_product_versions VALUES(?,1,?,?)")
    .run(...values);
}

export function listContentProductVersionsByProductId(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT snapshot_json FROM content_product_versions WHERE product_id=? ORDER BY version DESC",
    )
    .all(...values);
}

export function findContentProductsByMerchantIdAndSku2(
  db: DB,
  ...values: SQLValue[]
) {
  return db
    .prepare(
      "SELECT 1 FROM content_products WHERE merchant_id=? AND sku=? AND id<>?",
    )
    .get(...values);
}

export function insertContentProductVersions2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO content_product_versions VALUES(?,?,?,?)")
    .run(...values);
}

export function updateContentProductsById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE content_products SET name=?,sku=?,category=?,latest_version=?,updated_at=? WHERE id=?",
    )
    .run(...values);
}
