import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { transaction } from "../../platform/infrastructure/public.js";
import type { EngagementPort, LivePort } from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import {
  insertLedger,
  insertLedger2,
  insertPayoutJobs,
  listLedger,
  listPayoutJobs,
  updatePayoutJobsById,
} from "./persistence/settlement-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;

export function createPayments(
  db: DB,
  engagement: EngagementPort,
  live: Pick<LivePort, "owned">,
  clock: () => number = Date.now,
) {
  const owned = live.owned;
  const entry = (
    campaign: string,
    claim: string | null,
    debit: string,
    credit: string,
    amount: number,
    now: number,
  ) => {
    insertLedger(db, randomUUID(), campaign, claim, debit, credit, amount, now);
  };
  const budget = (campaign: string, amount: number, now: number) => {
    entry(
      campaign,
      null,
      "simulation_budget",
      "campaign_reserved",
      amount,
      now,
    );
  };
  const reserve = (
    campaign: string,
    claim: string,
    amount: number,
    now: number,
  ) => {
    entry(campaign, claim, "campaign_reserved", "claim_reserved", amount, now);
    insertPayoutJobs(db, randomUUID(), claim, now);
  };
  const returnBudget = (campaign: string, amount: number, now: number) => {
    entry(
      campaign,
      null,
      "campaign_reserved",
      "simulation_budget_returned",
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
  return {
    budget,
    reserve,
    returnBudget,
    processSimulationJobs,
    attach(app: App) {
      app.get("/api/merchant/rooms/:id/ledger", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        const entries = listLedger(
          db,
          JSON.stringify(engagement.campaignIds(c.req.param("id"))),
        );
        return c.json({ entries, mode: "simulation", limit: 200 });
      });
      app.post("/api/payments/wechat/notify", (c) =>
        c.json(
          {
            error:
              "WeChat notification verification is not implemented. No state was changed.",
          },
          501,
        ),
      );
    },
  };
}
