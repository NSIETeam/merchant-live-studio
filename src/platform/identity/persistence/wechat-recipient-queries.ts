import type { DB, SQLValue } from "../../../shared/persistence.js";

export function currentRecipientAuthorization(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT state,recipient_ciphertext AS recipientCiphertext,
        recipient_digest AS recipientDigest,created_at AS createdAt
       FROM wechat_recipient_authorization_events
       WHERE viewer_id=? AND merchant_id=? ORDER BY id DESC LIMIT 1`,
    )
    .get(...values);
}

export function insertRecipientAuthorization(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `INSERT INTO wechat_recipient_authorization_events(
        viewer_id,merchant_id,state,recipient_ciphertext,recipient_digest,created_at
      ) VALUES(?,?,?,?,?,?)`,
    )
    .run(...values);
}
