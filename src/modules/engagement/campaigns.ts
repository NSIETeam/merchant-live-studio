import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomInt, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  transaction,
  type Config,
} from "../../platform/infrastructure/public.js";
import type {
  CampaignRow,
  ClaimRow,
  LivePort,
  PaymentPort,
} from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import type { Campaign, Claim } from "../../shared/types.js";
import {
  findCampaignsById,
  findCampaignsById2,
  findCampaignsByRoomIdAndExpiresAt,
  findClaims,
  findClaimsByCampaignIdAndViewerId,
  findClaimsById,
  findQuestionsByRoomId,
  findQuestionsByRoomIdAndViewerId,
  insertCampaigns,
  insertClaims,
  insertQuestions,
  listCampaignsByExpiresAt,
  listCampaignsByRoomId,
  listCampaignsByRoomId2,
  listCampaignsByRoomId3,
  listCampaignsByRoomIdAndExpiresAt,
  listClaimsByViewerId,
  listQuestionsByRoomId,
  updateCampaignsById,
  updateCampaignsById2,
  updateClaimsById,
} from "./persistence/campaigns-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;

export function createEngagement(
  db: DB,
  live: LivePort,
  payments: () => PaymentPort,
  clock: () => number = Date.now,
) {
  const { owned, room } = live;
  const campaignOwned = (id: string, merchantId: string) => {
    const r = findCampaignsById(db, id) as CampaignRow | undefined;
    if (!r) throw new HTTPException(404, { message: "活动不存在" });
    owned(r.room_id, merchantId);
    return r;
  };
  const campaignDto = (r: CampaignRow): Campaign => ({
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
  const claimDto = (r: ClaimRow): Claim => ({
    id: r.id,
    campaignId: r.campaign_id,
    amountCents: r.amount_cents,
    status: r.status,
    createdAt: r.created_at,
  });
  function reserveClaim(
    campaignId: string,
    viewerId: string,
    now = Date.now(),
  ): Claim {
    return transaction(db, () => {
      const previous = findClaimsByCampaignIdAndViewerId(
        db,
        campaignId,
        viewerId,
      ) as ClaimRow | undefined;
      if (previous) return claimDto(previous);
      const row = findCampaignsById(db, campaignId) as CampaignRow | undefined;
      if (!row) throw new HTTPException(404, { message: "红包活动不存在" });
      if (
        row.status !== "active" ||
        now < row.opens_at ||
        now >= row.expires_at
      )
        throw new HTTPException(409, {
          message: now < row.opens_at ? "红包尚未开始" : "红包活动已结束",
        });
      const room = live.room(row.room_id) as { status: string };
      if (room.status !== "live")
        throw new HTTPException(409, { message: "直播尚未开始或已经结束" });
      const visit = live.visit(row.room_id, viewerId) as
        | { session_watch_millis: number; last_seen: number; active: number }
        | undefined;
      if (
        !visit ||
        now - visit.last_seen > 30000 ||
        !visit.active ||
        visit.session_watch_millis < row.min_watch_seconds * 1000
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
      updateCampaignsById(db, amount, campaignId);
      insertClaims(db, claimId, campaignId, viewerId, amount, now);
      payments().reserve(campaignId, claimId, amount, now);

      return {
        id: claimId,
        campaignId,
        amountCents: amount,
        status: "reserved",
        createdAt: now,
      };
    });
  }
  function closeCampaign(campaignId: string, now = Date.now()) {
    return transaction(db, () => {
      const row = findCampaignsById(db, campaignId) as unknown as CampaignRow;
      if (row.status === "closed") return;
      if (row.remaining_cents > 0)
        payments().returnBudget(campaignId, row.remaining_cents, now);
      updateCampaignsById2(db, campaignId);
    });
  }
  function expireCampaigns(now = Date.now()) {
    const rows = listCampaignsByExpiresAt(db, now) as { id: string }[];
    for (const row of rows) closeCampaign(row.id, now);
  }
  const nextCampaign = (id: string, now: number) =>
    findCampaignsByRoomIdAndExpiresAt(db, id, now) as unknown as
      CampaignRow | undefined;
  const active = (id: string, now: number) =>
    (
      listCampaignsByRoomIdAndExpiresAt(db, id, now) as unknown as CampaignRow[]
    ).map(campaignDto);
  const campaignIds = (id: string) =>
    listCampaignsByRoomId(db, id).map((r) => String(r.id));
  const closeRoom = (id: string, now: number) => {
    for (const row of listCampaignsByRoomId2(db, id))
      closeCampaign(String(row.id), now);
  };
  const claimRecord = (id: string) =>
    findClaimsById(db, id) as unknown as ClaimRow | undefined;
  const markSimulated = (id: string) => {
    updateClaimsById(db, id);
  };
  const summary = (id: string) => {
    const claims = findClaims(db, id) as unknown as {
      claims: number;
      reservedCents: number;
      simulatedCents: number;
    };
    return { ...claims, questions: Number(findQuestionsByRoomId(db, id)!.n) };
  };
  return {
    active,
    nextCampaign,
    campaignIds,
    closeRoom,
    claimRecord,
    markSimulated,
    summary,
    reserveClaim,
    closeCampaign,
    expireCampaigns,
    attach(app: App, config: Config) {
      app.get("/api/merchant/rooms/:id/campaigns", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        return c.json({
          serverTime: clock(),
          campaigns: (
            listCampaignsByRoomId3(
              db,
              c.req.param("id"),
            ) as unknown as CampaignRow[]
          ).map(campaignDto),
        });
      });
      app.post("/api/merchant/rooms/:id/campaigns", async (c) => {
        const r = owned(c.req.param("id"), c.get("merchantId"));
        if (r.status === "ended")
          throw new HTTPException(409, { message: "已结束的直播不能创建活动" });
        const input = z
          .object({
            totalCents: z.number().int().min(1).max(10000000),
            count: z.number().int().min(1).max(10000),
            minWatchSeconds: z.number().int().min(0).max(7200),
            delaySeconds: z.number().int().min(0).max(86400),
            durationSeconds: z.number().int().min(30).max(86400),
          })
          .refine((v) => v.totalCents >= v.count, {
            message: "每个红包至少为 1 分",
          })
          .parse(await c.req.json());
        const id = randomUUID(),
          opens = clock() + input.delaySeconds * 1000;
        transaction(db, () => {
          insertCampaigns(
            db,
            id,
            r.id,
            input.totalCents,
            input.count,
            input.totalCents,
            input.count,
            input.minWatchSeconds,
            opens,
            opens + input.durationSeconds * 1000,
          );
          payments().budget(id, input.totalCents, clock());
        });
        return c.json(
          {
            campaign: campaignDto(
              findCampaignsById(db, id) as unknown as CampaignRow,
            ),
          },
          201,
        );
      });
      app.post("/api/merchant/campaigns/:id/close", (c) => {
        campaignOwned(c.req.param("id"), c.get("merchantId"));
        closeCampaign(c.req.param("id"), clock());
        return c.json({ ok: true });
      });
      app.get("/api/merchant/rooms/:id/questions", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        return c.json({
          questions: listQuestionsByRoomId(db, c.req.param("id")),
        });
      });
      app.post("/api/viewer/rooms/:id/questions", async (c) => {
        const r = room(c.req.param("id"));
        if (r.status !== "live")
          throw new HTTPException(409, { message: "直播进行中才能提问" });
        const input = z
          .object({ text: z.string().trim().min(1).max(200) })
          .parse(await c.req.json());
        const last = findQuestionsByRoomIdAndViewerId(
          db,
          r.id,
          c.get("viewerId"),
        ) as { created_at: number } | undefined;
        if (last && clock() - last.created_at < 5000)
          throw new HTTPException(429, { message: "请稍后再提问" });
        insertQuestions(
          db,
          randomUUID(),
          r.id,
          c.get("viewerId"),
          input.text,
          clock(),
        );
        return c.json({ ok: true }, 201);
      });
      app.post("/api/viewer/campaigns/:id/claim", async (c) => {
        if (config.requirePlayback) {
          const campaign = findCampaignsById2(db, c.req.param("id")) as
            { room_id: string } | undefined;
          if (
            campaign &&
            (await live.signal(campaign.room_id)).connected !== true
          )
            throw new HTTPException(409, {
              message: "当前没有有效直播信号，请等待主播恢复推流",
            });
        }
        return c.json({
          claim: reserveClaim(c.req.param("id"), c.get("viewerId"), clock()),
          paymentMode: "simulation",
        });
      });
      app.get("/api/viewer/rooms/:id/claims", (c) => {
        room(c.req.param("id"));
        return c.json({
          claims: (
            listClaimsByViewerId(
              db,
              c.get("viewerId"),
              c.req.param("id"),
            ) as unknown as ClaimRow[]
          ).map(claimDto),
        });
      });
    },
  };
}
