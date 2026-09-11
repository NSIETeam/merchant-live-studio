import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomUUID } from "node:crypto";
import { transaction } from "../../platform/infrastructure/public.js";
import type { EngagementPort, LivePort } from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import type { PaymentProvider } from "./provider.js";
import type { PaymentProviderRegistry } from "./registry.js";
import {
  findLedgerCursor,
  insertLedger,
  insertLedger2,
  insertPayoutJobs,
  listLedger,
  listPayoutJobs,
  updatePayoutJobsById,
} from "./persistence/settlement-queries.js";
import {
  terminalTransfers,
  transfersForCampaigns,
} from "./persistence/transfer-queries.js";
import { createTransferStore, type TransferRow } from "./transfer-store.js";
import {
  createTransferWorker,
  type PaymentRecipient,
} from "./transfer-worker.js";

type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
type PaymentMode = "simulation" | "wechat";

export interface PaymentRuntime {
  mode: PaymentMode;
  registry: PaymentProviderRegistry;
  recipientFor(viewerId: string, merchantId: string): PaymentRecipient | null;
}

export function createPayments(
  db: DB,
  engagement: EngagementPort,
  live: Pick<LivePort, "owned">,
  runtime: PaymentRuntime,
  clock: () => number = Date.now,
) {
  const owned = live.owned;
  const transfers = createTransferStore(db);
  const modeFor = (_merchantId: string): PaymentMode => runtime.mode;
  const entry = (
    id: string,
    campaign: string,
    claim: string | null,
    debit: string,
    credit: string,
    amount: number,
    now: number,
  ) => {
    insertLedger(db, id, campaign, claim, debit, credit, amount, now);
  };
  const budget = (
    campaign: string,
    merchantId: string,
    amount: number,
    paymentMode: PaymentMode,
    now: number,
  ) => {
    if (
      paymentMode === "wechat" &&
      (runtime.mode !== "wechat" || !runtime.registry.providerFor(merchantId))
    )
      throw new HTTPException(503, {
        message: "该商家的微信转账尚未配置，不能创建现金活动",
      });
    entry(
      randomUUID(),
      campaign,
      null,
      paymentMode === "wechat"
        ? "merchant_transfer_limit"
        : "simulation_budget",
      "campaign_reserved",
      amount,
      now,
    );
  };
  const reserve = (
    input: {
      campaignId: string;
      claimId: string;
      viewerId: string;
      merchantId: string;
      amountCents: number;
      paymentMode: PaymentMode;
    },
    now: number,
  ) => {
    entry(
      randomUUID(),
      input.campaignId,
      input.claimId,
      "campaign_reserved",
      "claim_reserved",
      input.amountCents,
      now,
    );
    if (input.paymentMode === "simulation") {
      insertPayoutJobs(db, randomUUID(), input.claimId, now);
      return;
    }
    if (
      runtime.mode !== "wechat" ||
      !runtime.registry.providerFor(input.merchantId)
    )
      throw new HTTPException(503, {
        message: "该商家的微信转账尚未配置",
      });
    const recipient = runtime.recipientFor(input.viewerId, input.merchantId);
    if (!recipient)
      throw new HTTPException(403, {
        message: "请先验证微信身份并授权本次商家的红包收款",
      });
    transfers.queue(
      {
        outBillNo: randomUUID().replaceAll("-", ""),
        claimId: input.claimId,
        campaignId: input.campaignId,
        merchantId: input.merchantId,
        recipientDigest: recipient.recipientDigest,
        amountCents: input.amountCents,
      },
      now,
    );
  };
  const returnBudget = (
    campaign: string,
    _merchantId: string,
    amount: number,
    paymentMode: PaymentMode,
    now: number,
  ) => {
    entry(
      randomUUID(),
      campaign,
      null,
      "campaign_reserved",
      paymentMode === "wechat"
        ? "merchant_transfer_limit_returned"
        : "simulation_budget_returned",
      amount,
      now,
    );
  };
  function processSimulationJobs(now = clock()): number {
    return transaction(db, () => {
      const jobs = listPayoutJobs(db);
      for (const job of jobs) {
        const claim = engagement.claimRecord(String(job.claim_id));
        if (!claim) throw new Error("Payout references a missing claim");
        insertLedger2(
          db,
          randomUUID(),
          claim.campaign_id,
          claim.id,
          "claim_reserved",
          "simulation_settled",
          claim.amount_cents,
          now,
        );
        engagement.markSimulated(claim.id);
        updatePayoutJobsById(db, job.id);
      }
      return jobs.length;
    });
  }

  const multiplexedProvider: PaymentProvider = {
    createTransfer(request) {
      const provider = runtime.registry.providerFor(request.merchantId);
      if (!provider) throw new Error("Payment merchant is not configured");
      return provider.createTransfer(request);
    },
    queryTransfer(merchantId, outBillNo) {
      const provider = runtime.registry.providerFor(merchantId);
      if (!provider) throw new Error("Payment merchant is not configured");
      return provider.queryTransfer(merchantId, outBillNo);
    },
    verifyAndDecodeNotification(headers, body) {
      return runtime.registry.verifyNotification(headers, body);
    },
  };
  const worker = createTransferWorker(
    transfers,
    multiplexedProvider,
    (claimId, merchantId) => {
      const claim = engagement.claimRecord(claimId);
      return claim ? runtime.recipientFor(claim.viewer_id, merchantId) : null;
    },
    clock,
  );

  function reconcileTerminalTransfers(now = clock()) {
    let reconciled = 0;
    for (const row of terminalTransfers(db, 500) as unknown as TransferRow[]) {
      const credit =
        row.state === "paid"
          ? "wechat_settled"
          : row.state === "cancelled"
            ? "wechat_cancelled_returned"
            : "wechat_failed_returned";
      const result = insertLedger2(
        db,
        `wechat:${row.outBillNo}:${row.state}`,
        row.campaignId,
        row.claimId,
        "claim_reserved",
        credit,
        row.amountCents,
        now,
      );
      reconciled += Number(result.changes);
    }
    return reconciled;
  }

  async function processTransferJobs() {
    if (runtime.mode !== "wechat")
      return { examined: 0, advanced: 0, deferred: 0, reconciled: 0 };
    const result = await worker.process();
    return { ...result, reconciled: reconcileTerminalTransfers() };
  }

  return {
    modeFor,
    budget,
    reserve,
    returnBudget,
    processSimulationJobs,
    processTransferJobs,
    attach(app: App) {
      app.get("/api/merchant/rooms/:id/ledger", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        const campaigns = JSON.stringify(
            engagement.campaignIds(c.req.param("id")),
          ),
          before = c.req.query("before");
        const cursor = before
          ? findLedgerCursor(db, campaigns, before)
          : undefined;
        if (before !== undefined && !cursor)
          return c.json({ error: "无效的账本分页位置" }, 400);
        const rows = listLedger(
          db,
          campaigns,
          Number(cursor?.created_at ?? Number.MAX_SAFE_INTEGER),
          String(cursor?.id ?? "~"),
        );
        const entries = rows.slice(0, 200);
        return c.json({
          entries,
          mode: runtime.mode,
          limit: 200,
          nextBefore: rows.length > 200 ? entries[199].id : null,
        });
      });
      app.get("/api/merchant/rooms/:id/transfers", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        const campaignIds = engagement.campaignIds(c.req.param("id"));
        return c.json({
          mode: runtime.mode,
          transfers: campaignIds.length
            ? transfersForCampaigns(db, JSON.stringify(campaignIds))
            : [],
        });
      });
      app.get("/api/viewer/claims/:id/transfer", (c) => {
        const claim = engagement.claimRecord(c.req.param("id"));
        if (!claim || claim.viewer_id !== c.get("viewerId"))
          throw new HTTPException(404, { message: "领取记录不存在" });
        const transfer = transfers.byClaim(claim.id);
        const clientConfig = transfer
          ? runtime.registry.clientConfigFor(transfer.merchantId)
          : null;
        return c.json({
          mode: runtime.mode,
          transfer: transfer
            ? {
                outBillNo: transfer.outBillNo,
                amountCents: transfer.amountCents,
                state: transfer.state,
                confirmationPackage: transfer.confirmationPackage,
                confirmation:
                  transfer.state === "wait_user_confirm" &&
                  transfer.confirmationPackage &&
                  clientConfig
                    ? {
                        ...clientConfig,
                        package: transfer.confirmationPackage,
                      }
                    : null,
                updatedAt: transfer.updatedAt,
              }
            : null,
        });
      });
      app.post("/api/payments/wechat/notify", async (c) => {
        if (runtime.mode !== "wechat" || !runtime.registry.enabled)
          return c.json(
            {
              error:
                "WeChat notification verification is not configured. No state was changed.",
            },
            501,
          );
        const rawBody = new Uint8Array(await c.req.arrayBuffer());
        const headers = Object.fromEntries(c.req.raw.headers.entries());
        let event;
        try {
          event = await runtime.registry.verifyNotification(headers, rawBody);
        } catch {
          return c.json({ code: "FAIL", message: "签名或通知内容无效" }, 400);
        }
        const current = transfers.byBill(event.receipt.outBillNo);
        const claim = current
          ? engagement.claimRecord(current.claimId)
          : undefined;
        const recipient =
          current && claim
            ? runtime.recipientFor(claim.viewer_id, current.merchantId)
            : null;
        if (
          !current ||
          !claim ||
          !recipient ||
          recipient.subject !== event.verifiedRecipientId
        )
          throw new Error("Verified notification has no matching recipient");
        transfers.applyNotification(
          event,
          createHash("sha256").update(rawBody).digest("hex"),
          recipient.recipientDigest,
          clock(),
        );
        reconcileTerminalTransfers();
        return c.json({ code: "SUCCESS", message: "成功" });
      });
    },
  };
}
