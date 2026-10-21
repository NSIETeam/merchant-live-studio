import { randomUUID } from "node:crypto";
import { transaction, type DB } from "../db.js";
/** Future provider contract. Never accept OpenID or payment status from an anonymous viewer. */
export interface TransferRequest {
  merchantId: string;
  outBillNo: string;
  amountCents: number;
  verifiedRecipientId: string;
}
export interface TransferReceipt {
  outBillNo: string;
  state: "pending" | "wait_user_confirm" | "paid" | "failed" | "cancelled";
  providerId?: string;
  confirmationPackage?: string;
}
export interface VerifiedTransferEvent {
  eventId: string;
  merchantId: string;
  amountCents: number;
  verifiedRecipientId: string;
  receipt: TransferReceipt;
}
export interface PaymentProvider {
  createTransfer(request: TransferRequest): Promise<TransferReceipt>;
  queryTransfer(
    merchantId: string,
    outBillNo: string,
  ): Promise<TransferReceipt>;
  verifyAndDecodeNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent>;
}
/** Explicit fail-closed boundary. Setting WeChat environment values does NOT enable payment. */
export class WeChatPaymentProvider implements PaymentProvider {
  async createTransfer(_request: TransferRequest): Promise<TransferReceipt> {
    throw new Error("WeChat transfer integration is not implemented");
  }
  async queryTransfer(
    _merchantId: string,
    _outBillNo: string,
  ): Promise<TransferReceipt> {
    throw new Error("WeChat transfer integration is not implemented");
  }
  async verifyAndDecodeNotification(
    _headers: Record<string, string>,
    _rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent> {
    throw new Error("WeChat notification verification is not implemented");
  }
}
/** Durable local simulation outbox. A simulated claim is never marked as paid. */
export function processSimulationJobs(db: DB, now = Date.now()): number {
  return transaction(db, () => {
    const jobs = db
      .prepare(
        `SELECT j.id,j.claim_id,c.campaign_id,c.amount_cents FROM payout_jobs j JOIN claims c ON c.id=j.claim_id WHERE j.state='pending' LIMIT 100`,
      )
      .all() as {
      id: string;
      claim_id: string;
      campaign_id: string;
      amount_cents: number;
    }[];
    for (const job of jobs) {
      db.prepare(`INSERT OR IGNORE INTO ledger VALUES(?,?,?,?,?,?,?)`).run(
        randomUUID(),
        job.campaign_id,
        job.claim_id,
        "claim_reserved",
        "simulation_settled",
        job.amount_cents,
        now,
      );
      db.prepare(
        `UPDATE claims SET status='simulated' WHERE id=? AND status='reserved'`,
      ).run(job.claim_id);
      db.prepare(
        `UPDATE payout_jobs SET state='done', attempts=attempts+1 WHERE id=?`,
      ).run(job.id);
    }
    return jobs.length;
  });
}
