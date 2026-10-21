import { rewardQuery1, rewardQuery2, rewardQuery3, rewardQuery4, rewardQuery5, rewardQuery6, rewardQuery7, rewardQuery8, rewardQuery9, rewardQuery10, rewardQuery11, rewardQuery12, rewardQuery13, rewardQuery14, rewardQuery15, rewardQuery16, rewardQuery17, rewardQuery18, rewardQuery19, rewardQuery20, rewardQuery21, rewardQuery22, rewardQuery23, rewardQuery24, rewardQuery25, rewardQuery26 } from "./persistence/rewards-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID, randomBytes } from "node:crypto";
import { z } from "zod";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { LivePort } from "../../shared/live-ports.js";
const dayAt = (now: number) =>
  new Date(now + 8 * 3600000).toISOString().slice(0, 10);
function fail(message: string): never {
  throw new HTTPException(409, { message });
}
export function attachEngagement(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  live: Pick<LivePort, "room" | "owned" | "visit">,
  clock = Date.now,
) {
  const merchant = "/api/merchant/engagement",
    viewer = "/api/viewer/rooms/:id/engagement";
  const room = (id: string, owner?: string) => owner ? live.owned(id, owner) : live.room(id);
  function program(id: string) {
    return (
      rewardQuery1(db, id) || null
    );
  }
  function balance(tenant: string, user: string) {
    return Number(
      rewardQuery2(db, tenant, user)!.balance,
    );
  }
  function points(
    tenant: string,
    user: string,
    delta: number,
    reason: string,
    reference: string,
  ) {
    rewardQuery3(db, randomUUID(), tenant, user, delta, reason, reference, clock());
  }
  function gift(id: string, owner: string) {
    const g = rewardQuery4(db, id, owner);
    if (!g) throw new HTTPException(404, { message: "礼品不存在" });
    return g;
  }
  const gifts = (tenant: string) =>
    rewardQuery5(db, tenant);
  function event(id: string, state: string, actor: string, note: string) {
    rewardQuery6(db, randomUUID(), id, state, actor, note, clock());
  }
  function finish(
    id: string,
    tenant: string,
    user: string | undefined,
    state: "fulfilled" | "cancelled",
    actor: string,
    note: string,
    code?: string,
  ) {
    return transaction(db, () => {
      const r = rewardQuery7(db, id, tenant);
      if (!r || (user && r.viewer_id !== user))
        throw new HTTPException(404, { message: "兑换记录不存在" });
      if (state === "fulfilled" && r.code !== code) fail("领取码不匹配");
      if (r.state === state) return { ok: true, state };
      if (r.state !== "reserved") fail("此兑换已经结束，不能再次处理");
      if (state === "cancelled") {
        points(
          tenant,
          String(r.viewer_id),
          Number(r.points),
          "redemption_refund",
          id,
        );
        rewardQuery8(db, r.gift_id);
      }
      rewardQuery9(db, state, id);
      event(id, state, actor, note);
      return { ok: true, state };
    });
  }
  app.get(merchant + "/rooms/:id", (c) => {
    const r = room(z.string().parse(c.req.param("id")), c.get("merchantId"));
    return c.json({
      program: program(String(r.id)),
      day: dayAt(clock()),
      checkins: Number(
        rewardQuery10(db, r.id, dayAt(clock()))!.n,
      ),
    });
  });
  app.post(merchant + "/rooms/:id", async (c) => {
    const r = room(z.string().parse(c.req.param("id")), c.get("merchantId"));
    const input = z
      .object({
        previousVersion: z.number().int().min(0),
        enabled: z.boolean(),
        points: z.number().int().min(1).max(10000),
        minWatchSeconds: z.number().int().min(0).max(14400),
        dailyLimit: z.number().int().min(1).max(100000),
      })
      .strict()
      .parse(await c.req.json());
    transaction(db, () => {
      const current = program(String(r.id));
      if (Number(current?.version || 0) !== input.previousVersion)
        fail("配置已更新，请刷新后重试");
      rewardQuery11(db, r.id, input.previousVersion + 1, Number(input.enabled), input.points, input.minWatchSeconds, input.dailyLimit, c.get("actorId"), clock());
    });
    return c.json({ program: program(String(r.id)) }, 201);
  });
  app.get(merchant + "/gifts", (c) =>
    c.json({ gifts: gifts(c.get("merchantId")) }),
  );
  const giftSchema = z
    .object({
      title: z.string().trim().min(1).max(100),
      description: z.string().trim().min(1).max(500),
      points: z.number().int().min(1).max(1000000),
      stock: z.number().int().min(0).max(100000),
      enabled: z.boolean(),
    })
    .strict();
  app.post(merchant + "/gifts", async (c) => {
    const x = giftSchema.parse(await c.req.json()),
      id = randomUUID();
    transaction(db, () => {
      rewardQuery12(db, id, c.get("merchantId"), x.title, x.description, x.points, x.stock, Number(x.enabled), 1, clock());
      rewardQuery13(db, randomUUID(), id, 1, JSON.stringify(x), c.get("actorId"), clock());
    });
    return c.json({ id }, 201);
  });
  app.patch(merchant + "/gifts/:id", async (c) => {
    const x = giftSchema
      .extend({
        previousVersion: z.number().int().positive(),
        previousStock: z.number().int().min(0),
      })
      .parse(await c.req.json());
    transaction(db, () => {
      const g = gift(z.string().parse(c.req.param("id")), c.get("merchantId"));
      if (g.version !== x.previousVersion || g.stock !== x.previousStock)
        fail("礼品或库存已改变，请刷新");
      rewardQuery14(db, x.title, x.description, x.points, x.stock, Number(x.enabled), g.id);
      rewardQuery13(db, randomUUID(), g.id, x.previousVersion + 1, JSON.stringify(x), c.get("actorId"), clock());
    });
    return c.json({ ok: true });
  });
  app.get(merchant + "/redemptions", (c) => {
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse(c.req.query("before"));
    const rows = rewardQuery15(db, c.get("merchantId"), before || Number.MAX_SAFE_INTEGER);
    return c.json({
      redemptions: rows.slice(0, 100),
      nextBefore: rows.length > 100 ? rows[99].cursor : null,
    });
  });
  app.post(merchant + "/redemptions/:id/fulfill", async (c) => {
    const x = z
      .object({
        code: z.string().min(1).max(100),
        note: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      finish(
        z.string().parse(c.req.param("id")),
        c.get("merchantId"),
        undefined,
        "fulfilled",
        c.get("actorId"),
        x.note,
        x.code,
      ),
    );
  });
  app.post(merchant + "/redemptions/:id/cancel", async (c) => {
    const x = z
      .object({ note: z.string().trim().min(1).max(500) })
      .strict()
      .parse(await c.req.json());
    return c.json(
      finish(
        z.string().parse(c.req.param("id")),
        c.get("merchantId"),
        undefined,
        "cancelled",
        c.get("actorId"),
        x.note,
      ),
    );
  });
  app.get(merchant + "/redemptions/:id/history", (c) => {
    const r = rewardQuery16(db, z.string().parse(c.req.param("id")), c.get("merchantId"));
    if (!r) throw new HTTPException(404);
    return c.json({
      events: rewardQuery17(db, r.id),
    });
  });
  app.get(viewer, (c) => {
    const r = room(z.string().parse(c.req.param("id"))),
      tenant = String(r.merchant_id),
      user = c.get("viewerId");
    const checkin =
      rewardQuery18(db, r.id, user, dayAt(clock())) || null;
    const ledger = rewardQuery19(db, tenant, user);
    const records = rewardQuery20(db, tenant, user);
    return c.json({
      program: program(String(r.id)),
      day: dayAt(clock()),
      checkin,
      balance: balance(tenant, user),
      gifts: gifts(tenant).filter((g) => g.enabled),
      ledger,
      redemptions: records,
      identity: "anonymous",
      cashEquivalent: false,
    });
  });
  app.post(viewer + "/checkin", (c) => {
    const r = room(z.string().parse(c.req.param("id"))),
      user = c.get("viewerId"),
      day = dayAt(clock());
    return c.json(
      transaction(db, () => {
        const prior = rewardQuery21(db, r.id, user, day);
        if (prior) return { points: prior.points, alreadyCheckedIn: true };
        const p = program(String(r.id));
        if (!p?.enabled || r.status !== "live") fail("签到未开放");
        const v = live.visit(r.id, user);
        if (
          !v?.active ||
          clock() - Number(v.last_seen) > 20000 ||
          Number(v.session_watch_millis) < Number(p.minWatchSeconds) * 1000
        )
          fail("请保持观看并达到本场签到时长");
        const count = Number(
          rewardQuery10(db, r.id, day)!.n,
        );
        if (count >= Number(p.dailyLimit)) fail("今日签到名额已用完");
        const id = randomUUID();
        rewardQuery22(db, id, r.id, user, day, p.version, p.points, clock());
        points(String(r.merchant_id), user, Number(p.points), "checkin", id);
        return { points: p.points, alreadyCheckedIn: false };
      }),
    );
  });
  app.post(viewer + "/redeem", async (c) => {
    const r = room(z.string().parse(c.req.param("id"))),
      tenant = String(r.merchant_id),
      user = c.get("viewerId");
    const x = z
      .object({
        giftId: z.string().uuid(),
        idempotencyKey: z.string().min(1).max(100),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      transaction(db, () => {
        const old = rewardQuery23(db, tenant, user, x.idempotencyKey);
        if (old) {
          if (old.giftId !== x.giftId) fail("该请求编号已有不同礼品");
          return { redemption: old };
        }
        const g = gift(x.giftId, tenant);
        if (!g.enabled || Number(g.stock) < 1) fail("礼品已下架或无库存");
        if (balance(tenant, user) < Number(g.points)) fail("积分不足");
        const id = randomUUID(),
          code = randomBytes(12).toString("hex");
        rewardQuery24(db, g.id);
        rewardQuery25(db, id, tenant, user, g.id, g.title, g.points, code, "reserved", x.idempotencyKey, clock());
        points(tenant, user, -Number(g.points), "redemption", id);
        event(id, "reserved", user, "观众预留兑换");
        return {
          redemption: rewardQuery26(db, id),
        };
      }),
      201,
    );
  });
  app.post(viewer + "/redemptions/:redemptionId/cancel", (c) => {
    const r = room(z.string().parse(c.req.param("id")));
    return c.json(
      finish(
        z.string().parse(c.req.param("redemptionId")),
        String(r.merchant_id),
        c.get("viewerId"),
        "cancelled",
        c.get("viewerId"),
        "观众取消兑换",
      ),
    );
  });
}
