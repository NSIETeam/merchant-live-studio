import { randomInt, randomUUID } from "node:crypto";
import { HTTPException } from "hono/http-exception";
import { transaction, type DB } from "../db.js";
import type { Campaign, Claim } from "../../shared/types.js";
export interface CampaignRow {
  id: string;
  room_id: string;
  total_cents: number;
  count: number;
  remaining_cents: number;
  remaining_count: number;
  min_watch_seconds: number;
  opens_at: number;
  expires_at: number;
  status: string;
}
export const campaignDto = (r: CampaignRow): Campaign => ({
  id: r.id,
  roomId: r.room_id,
  totalCents: r.total_cents,
  count: r.count,
  remainingCents: r.remaining_cents,
  remainingCount: r.remaining_count,
  minWatchSeconds: r.min_watch_seconds,
  opensAt: r.opens_at,
  expiresAt: r.expires_at,
  status: r.status,
  mode: "simulation",
});
export interface ClaimRow {
  id: string;
  campaign_id: string;
  amount_cents: number;
  status: "reserved" | "simulated";
  created_at: number;
}
export const claimDto = (r: ClaimRow): Claim => ({
  id: r.id,
  campaignId: r.campaign_id,
  amountCents: r.amount_cents,
  status: r.status,
  createdAt: r.created_at,
});
export function reserveClaim(
  db: DB,
  campaignId: string,
  viewerId: string,
  now = Date.now(),
): Claim {
  return transaction(db, () => {
    const previous = db
      .prepare("SELECT * FROM claims WHERE campaign_id=? AND viewer_id=?")
      .get(campaignId, viewerId) as ClaimRow | undefined;
    if (previous) return claimDto(previous);
    const row = db
      .prepare("SELECT * FROM campaigns WHERE id=?")
      .get(campaignId) as CampaignRow | undefined;
    if (!row) throw new HTTPException(404, { message: "红包活动不存在" });
    if (row.status !== "active" || now < row.opens_at || now >= row.expires_at)
      throw new HTTPException(409, {
        message: now < row.opens_at ? "红包尚未开始" : "红包活动已结束",
      });
    const room = db
      .prepare("SELECT status FROM rooms WHERE id=?")
      .get(row.room_id) as { status: string };
    if (room.status !== "live")
      throw new HTTPException(409, { message: "直播尚未开始或已经结束" });
    const visit = db
      .prepare(
        "SELECT watch_seconds,last_seen FROM visits WHERE room_id=? AND viewer_id=?",
      )
      .get(row.room_id, viewerId) as
      { watch_seconds: number; last_seen: number } | undefined;
    if (
      !visit ||
      now - visit.last_seen > 30000 ||
      visit.watch_seconds < row.min_watch_seconds
    )
      throw new HTTPException(403, {
        message: "观看时长尚未达到要求，请保持直播页打开",
      });
    if (row.remaining_count === 0)
      throw new HTTPException(409, { message: "红包已领完" });
    const maximum = Math.min(
      row.remaining_cents - row.remaining_count + 1,
      Math.floor((row.remaining_cents / row.remaining_count) * 2),
    );
    const amount =
      row.remaining_count === 1
        ? row.remaining_cents
        : randomInt(1, maximum + 1);
    const claimId = randomUUID();
    db.prepare(
      "UPDATE campaigns SET remaining_cents=remaining_cents-?,remaining_count=remaining_count-1 WHERE id=?",
    ).run(amount, campaignId);
    db.prepare(`INSERT INTO claims VALUES(?,?,?,?,'reserved',?)`).run(
      claimId,
      campaignId,
      viewerId,
      amount,
      now,
    );
    db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)").run(
      randomUUID(),
      campaignId,
      claimId,
      "campaign_reserved",
      "claim_reserved",
      amount,
      now,
    );
    db.prepare(
      `INSERT INTO payout_jobs(id,claim_id,created_at) VALUES(?,?,?)`,
    ).run(randomUUID(), claimId, now);
    return {
      id: claimId,
      campaignId,
      amountCents: amount,
      status: "reserved",
      createdAt: now,
    };
  });
}
export function closeCampaign(db: DB, campaignId: string, now = Date.now()) {
  return transaction(db, () => {
    const row = db
      .prepare("SELECT * FROM campaigns WHERE id=?")
      .get(campaignId) as unknown as CampaignRow;
    if (row.status === "closed") return;
    if (row.remaining_cents > 0)
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)").run(
        randomUUID(),
        campaignId,
        null,
        "campaign_reserved",
        "simulation_budget_returned",
        row.remaining_cents,
        now,
      );
    db.prepare(
      `UPDATE campaigns SET status='closed',remaining_cents=0,remaining_count=0 WHERE id=?`,
    ).run(campaignId);
  });
}
export function expireCampaigns(db: DB, now = Date.now()) {
  const rows = db
    .prepare(`SELECT id FROM campaigns WHERE status='active' AND expires_at<=?`)
    .all(now) as { id: string }[];
  for (const row of rows) closeCampaign(db, row.id, now);
}
