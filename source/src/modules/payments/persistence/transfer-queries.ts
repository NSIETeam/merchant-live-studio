import type { DB, SQLValue } from "../../../shared/persistence.js";

export function transferByBill(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT out_bill_no AS outBillNo,claim_id AS claimId,campaign_id AS campaignId,
        merchant_id AS merchantId,recipient_digest AS recipientDigest,amount_cents AS amountCents,
        state,provider_id AS providerId,confirmation_package AS confirmationPackage,
        attempts,next_attempt_at AS nextAttemptAt,last_error_code AS lastErrorCode,
        created_at AS createdAt,updated_at AS updatedAt
       FROM payment_transfers WHERE out_bill_no=?`,
    )
    .get(...values);
}

export function transferByClaim(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT out_bill_no AS outBillNo,claim_id AS claimId,campaign_id AS campaignId,
        merchant_id AS merchantId,recipient_digest AS recipientDigest,amount_cents AS amountCents,
        state,provider_id AS providerId,confirmation_package AS confirmationPackage,
        attempts,next_attempt_at AS nextAttemptAt,last_error_code AS lastErrorCode,
        created_at AS createdAt,updated_at AS updatedAt
       FROM payment_transfers WHERE claim_id=?`,
    )
    .get(...values);
}

export function insertTransfer(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `INSERT INTO payment_transfers(
        out_bill_no,claim_id,campaign_id,merchant_id,recipient_digest,amount_cents,state,
        next_attempt_at,created_at,updated_at
      ) VALUES(?,?,?,?,?,?,'queued',?,?,?)`,
    )
    .run(...values);
}

export function updateTransferState(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `UPDATE payment_transfers
       SET state=?,provider_id=?,confirmation_package=?,next_attempt_at=?,
         last_error_code='',updated_at=?
       WHERE out_bill_no=? AND state=?`,
    )
    .run(...values);
}

export function dueTransfers(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT out_bill_no AS outBillNo,claim_id AS claimId,campaign_id AS campaignId,
        merchant_id AS merchantId,recipient_digest AS recipientDigest,amount_cents AS amountCents,
        state,provider_id AS providerId,confirmation_package AS confirmationPackage,
        attempts,next_attempt_at AS nextAttemptAt,last_error_code AS lastErrorCode,
        created_at AS createdAt,updated_at AS updatedAt
       FROM payment_transfers
       WHERE state NOT IN('paid','failed','cancelled') AND next_attempt_at<=?
       ORDER BY next_attempt_at,out_bill_no LIMIT ?`,
    )
    .all(...values);
}

export function terminalTransfers(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT out_bill_no AS outBillNo,claim_id AS claimId,
        campaign_id AS campaignId,merchant_id AS merchantId,
        recipient_digest AS recipientDigest,amount_cents AS amountCents,
        state,provider_id AS providerId,confirmation_package AS confirmationPackage,
        attempts,next_attempt_at AS nextAttemptAt,last_error_code AS lastErrorCode,
        created_at AS createdAt,updated_at AS updatedAt
       FROM payment_transfers t
       WHERE state IN('paid','failed','cancelled')
         AND NOT EXISTS (
           SELECT 1 FROM ledger l
           WHERE l.id='wechat:' || t.out_bill_no || ':' || t.state
         )
       ORDER BY updated_at LIMIT ?`,
    )
    .all(...values);
}

export function transfersForCampaigns(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT out_bill_no AS outBillNo,claim_id AS claimId,
        campaign_id AS campaignId,amount_cents AS amountCents,state,
        provider_id AS providerId,confirmation_package AS confirmationPackage,
        attempts,last_error_code AS lastErrorCode,created_at AS createdAt,
        updated_at AS updatedAt
       FROM payment_transfers
       WHERE campaign_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at DESC,out_bill_no DESC LIMIT 500`,
    )
    .all(...values);
}

export function recordTransferAttempt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `UPDATE payment_transfers SET state=?,attempts=attempts+1,next_attempt_at=?,
        last_error_code='',updated_at=? WHERE out_bill_no=? AND state=?`,
    )
    .run(...values);
}

export function recordTransferFailure(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `UPDATE payment_transfers SET next_attempt_at=?,last_error_code=?,updated_at=?
       WHERE out_bill_no=? AND state NOT IN('paid','failed','cancelled')`,
    )
    .run(...values);
}

export function insertTransferEvent(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `INSERT INTO payment_transfer_events(out_bill_no,source,state,provider_id,created_at)
       VALUES(?,?,?,?,?)`,
    )
    .run(...values);
}

export function transferEvents(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT id,source,state,provider_id AS providerId,created_at AS createdAt
       FROM payment_transfer_events WHERE out_bill_no=? ORDER BY id`,
    )
    .all(...values);
}

export function notificationReceipt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `SELECT event_id AS eventId,payload_sha256 AS payloadSha256,out_bill_no AS outBillNo,
        received_at AS receivedAt FROM payment_notification_receipts WHERE event_id=?`,
    )
    .get(...values);
}

export function insertNotificationReceipt(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      `INSERT INTO payment_notification_receipts(event_id,payload_sha256,out_bill_no,received_at)
       VALUES(?,?,?,?)`,
    )
    .run(...values);
}
