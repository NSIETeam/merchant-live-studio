import type { PaymentProvider } from "./provider.js";
import type { TransferRow } from "./transfer-store.js";

export interface TransferStorePort {
  due(now: number, limit?: number): TransferRow[];
  markCreateAttempt(outBillNo: string, now: number): TransferRow;
  markQueryAttempt(outBillNo: string, now: number): TransferRow;
  recordFailure(
    outBillNo: string,
    code: string,
    now: number,
  ): TransferRow | undefined;
  applyReceipt(
    outBillNo: string,
    receipt: Awaited<ReturnType<PaymentProvider["queryTransfer"]>>,
    source: "create" | "query",
    now: number,
  ): TransferRow;
}

export interface PaymentRecipient {
  subject: string;
  recipientDigest: string;
}

/**
 * Claims a durable attempt before network I/O. Once creation may have been sent,
 * every retry queries the same merchant bill number instead of creating again.
 */
export function createTransferWorker(
  store: TransferStorePort,
  provider: PaymentProvider,
  recipientFor: (
    viewerClaimId: string,
    merchantId: string,
  ) => PaymentRecipient | null | Promise<PaymentRecipient | null>,
  clock: () => number = Date.now,
) {
  let active: Promise<{
    examined: number;
    advanced: number;
    deferred: number;
  }> | null = null;

  async function run(limit = 20) {
    const rows = store.due(clock(), limit);
    let advanced = 0;
    let deferred = 0;
    for (const row of rows) {
      const now = clock();
      try {
        if (row.state === "queued") {
          const recipient = await recipientFor(row.claimId, row.merchantId);
          if (!recipient) {
            store.recordFailure(row.outBillNo, "recipient_unavailable", now);
            deferred++;
            continue;
          }
          if (recipient.recipientDigest !== row.recipientDigest) {
            store.recordFailure(row.outBillNo, "recipient_mismatch", now);
            deferred++;
            continue;
          }
          store.markCreateAttempt(row.outBillNo, now);
          const receipt = await provider.createTransfer({
            merchantId: row.merchantId,
            outBillNo: row.outBillNo,
            amountCents: row.amountCents,
            verifiedRecipientId: recipient.subject,
          });
          store.applyReceipt(row.outBillNo, receipt, "create", clock());
          advanced++;
        } else {
          store.markQueryAttempt(row.outBillNo, now);
          const receipt = await provider.queryTransfer(
            row.merchantId,
            row.outBillNo,
          );
          store.applyReceipt(row.outBillNo, receipt, "query", clock());
          advanced++;
        }
      } catch {
        store.recordFailure(row.outBillNo, "provider_or_state_error", clock());
        deferred++;
      }
    }
    return { examined: rows.length, advanced, deferred };
  }

  return {
    process(limit = 20) {
      if (!active) active = run(limit).finally(() => (active = null));
      return active;
    },
  };
}
