import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { TransferReceipt, VerifiedTransferEvent } from "./provider.js";
import {
  dueTransfers,
  insertNotificationReceipt,
  insertTransfer,
  insertTransferEvent,
  notificationReceipt,
  recordTransferAttempt,
  recordTransferFailure,
  transferByBill,
  transferByClaim,
  transferEvents,
  updateTransferState,
} from "./persistence/transfer-queries.js";

export type TransferState =
  "queued" | "create_unknown" | TransferReceipt["state"];

export interface TransferRow {
  outBillNo: string;
  claimId: string;
  campaignId: string;
  merchantId: string;
  recipientDigest: string;
  amountCents: number;
  state: TransferState;
  providerId: string | null;
  confirmationPackage: string | null;
  attempts: number;
  nextAttemptAt: number;
  lastErrorCode: string;
  createdAt: number;
  updatedAt: number;
}

const terminal = new Set<TransferState>(["paid", "failed", "cancelled"]);
const allowed = new Map<TransferState, Set<TransferState>>([
  ["queued", new Set(["create_unknown"])],
  [
    "create_unknown",
    new Set(["pending", "wait_user_confirm", "paid", "failed", "cancelled"]),
  ],
  [
    "pending",
    new Set(["pending", "wait_user_confirm", "paid", "failed", "cancelled"]),
  ],
  [
    "wait_user_confirm",
    new Set(["wait_user_confirm", "paid", "failed", "cancelled"]),
  ],
  ["paid", new Set(["paid"])],
  ["failed", new Set(["failed"])],
  ["cancelled", new Set(["cancelled"])],
]);

function sameOrder(
  row: TransferRow,
  input: {
    outBillNo: string;
    claimId: string;
    campaignId: string;
    merchantId: string;
    recipientDigest: string;
    amountCents: number;
  },
) {
  return (
    row.outBillNo === input.outBillNo &&
    row.claimId === input.claimId &&
    row.campaignId === input.campaignId &&
    row.merchantId === input.merchantId &&
    row.recipientDigest === input.recipientDigest &&
    row.amountCents === input.amountCents
  );
}

function validateOrder(input: {
  outBillNo: string;
  claimId: string;
  campaignId: string;
  merchantId: string;
  recipientDigest: string;
  amountCents: number;
}) {
  if (!/^[A-Za-z0-9]{1,32}$/.test(input.outBillNo))
    throw new Error("Invalid transfer bill number");
  for (const value of [input.claimId, input.campaignId, input.merchantId])
    if (!value || value.length > 100)
      throw new Error("Invalid transfer ownership");
  if (!/^[a-f0-9]{64}$/.test(input.recipientDigest))
    throw new Error("Invalid recipient digest");
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0)
    throw new Error("Invalid transfer amount");
}

export function createTransferStore(db: DB) {
  const atomic = <T>(action: () => T) =>
    (db as DB & { isTransaction?: boolean }).isTransaction
      ? action()
      : transaction(db, action);
  const byBill = (outBillNo: string) =>
    transferByBill(db, outBillNo) as unknown as TransferRow | undefined;
  const byClaim = (claimId: string) =>
    transferByClaim(db, claimId) as unknown as TransferRow | undefined;

  const apply = (
    outBillNo: string,
    receipt: TransferReceipt,
    source: "create" | "query" | "notify",
    now: number,
  ) => {
    const current = byBill(outBillNo);
    if (!current || receipt.outBillNo !== outBillNo)
      throw new Error("Transfer receipt does not match a known bill");
    if (!allowed.get(current.state)?.has(receipt.state))
      throw new Error("Invalid transfer state transition");
    if (
      current.providerId &&
      receipt.providerId &&
      current.providerId !== receipt.providerId
    )
      throw new Error("Transfer provider id cannot change");
    const providerId = receipt.providerId || current.providerId;
    const confirmationPackage =
      receipt.state === "wait_user_confirm"
        ? receipt.confirmationPackage || current.confirmationPackage
        : null;
    if (receipt.state === "wait_user_confirm" && !confirmationPackage)
      throw new Error(
        "User confirmation transfer is missing package information",
      );
    const changed =
      current.state !== receipt.state ||
      current.providerId !== providerId ||
      current.confirmationPackage !== confirmationPackage;
    if (changed) {
      const nextAttemptAt = terminal.has(receipt.state)
        ? Number.MAX_SAFE_INTEGER
        : now + 30_000;
      const result = updateTransferState(
        db,
        receipt.state,
        providerId,
        confirmationPackage,
        nextAttemptAt,
        now,
        outBillNo,
        current.state,
      );
      if (Number(result.changes) !== 1)
        throw new Error("Transfer state changed concurrently");
      insertTransferEvent(
        db,
        outBillNo,
        source,
        receipt.state,
        providerId,
        now,
      );
    }
    return byBill(outBillNo)!;
  };

  return {
    byBill,
    byClaim,
    events(outBillNo: string) {
      return transferEvents(db, outBillNo);
    },
    queue(
      input: {
        outBillNo: string;
        claimId: string;
        campaignId: string;
        merchantId: string;
        recipientDigest: string;
        amountCents: number;
      },
      now: number,
    ) {
      validateOrder(input);
      return atomic(() => {
        const previous = byClaim(input.claimId);
        if (previous) {
          if (!sameOrder(previous, input))
            throw new Error("Claim already belongs to a different transfer");
          return { transfer: previous, replayed: true };
        }
        if (byBill(input.outBillNo))
          throw new Error("Transfer bill number already exists");
        insertTransfer(
          db,
          input.outBillNo,
          input.claimId,
          input.campaignId,
          input.merchantId,
          input.recipientDigest,
          input.amountCents,
          now,
          now,
          now,
        );
        insertTransferEvent(
          db,
          input.outBillNo,
          "reserve",
          "queued",
          null,
          now,
        );
        return { transfer: byBill(input.outBillNo)!, replayed: false };
      });
    },
    markCreateAttempt(outBillNo: string, now: number) {
      return atomic(() => {
        const current = byBill(outBillNo);
        if (!current) throw new Error("Transfer bill does not exist");
        if (current.state === "create_unknown") return current;
        if (current.state !== "queued")
          throw new Error("Only a queued transfer can start creation");
        const result = recordTransferAttempt(
          db,
          "create_unknown",
          now + 5_000,
          now,
          outBillNo,
          "queued",
        );
        if (Number(result.changes) !== 1)
          throw new Error("Transfer state changed concurrently");
        insertTransferEvent(
          db,
          outBillNo,
          "create_attempt",
          "create_unknown",
          null,
          now,
        );
        return byBill(outBillNo)!;
      });
    },
    due(now: number, limit = 20) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
        throw new Error("Invalid transfer batch size");
      return dueTransfers(db, now, limit) as unknown as TransferRow[];
    },
    markQueryAttempt(outBillNo: string, now: number) {
      return atomic(() => {
        const current = byBill(outBillNo);
        if (
          !current ||
          !["create_unknown", "pending", "wait_user_confirm"].includes(
            current.state,
          )
        )
          throw new Error("Transfer is not queryable");
        const result = recordTransferAttempt(
          db,
          current.state,
          now + 30_000,
          now,
          outBillNo,
          current.state,
        );
        if (Number(result.changes) !== 1)
          throw new Error("Transfer state changed concurrently");
        return byBill(outBillNo)!;
      });
    },
    recordFailure(outBillNo: string, code: string, now: number) {
      if (!/^[a-z_]{1,40}$/.test(code))
        throw new Error("Invalid transfer failure code");
      return atomic(() => {
        const current = byBill(outBillNo);
        if (!current || terminal.has(current.state)) return current;
        const delay = Math.min(
          5 * 60_000,
          5_000 * 2 ** Math.min(current.attempts, 6),
        );
        recordTransferFailure(db, now + delay, code, now, outBillNo);
        return byBill(outBillNo)!;
      });
    },
    applyReceipt(
      outBillNo: string,
      receipt: TransferReceipt,
      source: "create" | "query",
      now: number,
    ) {
      return atomic(() => apply(outBillNo, receipt, source, now));
    },
    applyNotification(
      event: VerifiedTransferEvent,
      payloadSha256: string,
      recipientDigest: string,
      now: number,
    ) {
      if (!/^[a-f0-9]{64}$/.test(payloadSha256))
        throw new Error("Invalid notification digest");
      return atomic(() => {
        const previous = notificationReceipt(db, event.eventId) as
          { payloadSha256: string; outBillNo: string } | undefined;
        if (previous) {
          if (
            previous.payloadSha256 !== payloadSha256 ||
            previous.outBillNo !== event.receipt.outBillNo
          )
            throw new Error(
              "Notification id was reused with different content",
            );
          return { transfer: byBill(previous.outBillNo)!, replayed: true };
        }
        const current = byBill(event.receipt.outBillNo);
        if (
          !current ||
          current.merchantId !== event.merchantId ||
          current.amountCents !== event.amountCents ||
          current.recipientDigest !== recipientDigest ||
          !terminal.has(event.receipt.state)
        )
          throw new Error("Notification does not match the stored transfer");
        insertNotificationReceipt(
          db,
          event.eventId,
          payloadSha256,
          event.receipt.outBillNo,
          now,
        );
        return {
          transfer: apply(
            event.receipt.outBillNo,
            event.receipt,
            "notify",
            now,
          ),
          replayed: false,
        };
      });
    },
  };
}
