import type { DB, SQLValue } from "../../../shared/persistence.js";

export function insertLedger(db: DB, ...values: SQLValue[]) {
  return db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)").run(...values);
}

export function insertPayoutJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT INTO payout_jobs(id,claim_id,created_at) VALUES(?,?,?)")
    .run(...values);
}

export function listPayoutJobs(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "SELECT id,claim_id FROM payout_jobs WHERE state='pending' LIMIT 100",
    )
    .all(...values);
}

export function insertLedger2(db: DB, ...values: SQLValue[]) {
  return db
    .prepare("INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)")
    .run(...values);
}

export function updatePayoutJobsById(db: DB, ...values: SQLValue[]) {
  return db
    .prepare(
      "UPDATE payout_jobs SET state='done', attempts=attempts+1 WHERE id=?",
    )
    .run(...values);
}

export function findLedgerCursor(db:DB,campaigns:string,id:string) { return db.prepare("SELECT id,created_at FROM ledger WHERE id=? AND campaign_id IN (SELECT value FROM json_each(?))").get(id,campaigns); }
export function listLedger(db:DB,campaigns:string,beforeTime:number,beforeId:string) { return db.prepare("SELECT id,campaign_id AS campaignId,claim_id AS claimId,debit,credit,amount_cents AS amountCents,created_at AS createdAt FROM ledger WHERE campaign_id IN (SELECT value FROM json_each(?)) AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC,id DESC LIMIT 201").all(campaigns,beforeTime,beforeTime,beforeId); }
