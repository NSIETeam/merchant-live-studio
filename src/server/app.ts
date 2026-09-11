import { attachAttribution, recordAttribution } from "./attribution.js";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { deleteCookie } from "hono/cookie";
import { randomBytes, randomUUID } from "node:crypto";
import { isIP } from "node:net";
import { MediaController } from "./services/media-control.js";
import { recordPresence } from "./services/presence.js";
import { z, ZodError } from "zod";
import type { Config } from "./config.js";
import { type DB, transaction } from "./db.js";
import { equalSecret, issueSession, readSession } from "./auth.js";
import {
  merchantIdentity,
  memberMayAccess,
  requiresIndependentReview,
} from "./permissions.js";
import { createStreamAdapter } from "./services/stream.js";
import {
  campaignDto,
  claimDto,
  closeCampaign,
  reserveClaim,
  type CampaignRow,
  type ClaimRow,
} from "./services/rewards.js";
import { HttpAgentBridge, type AgentBridge } from "./services/agent-bridge.js";
import { attachAgentGateway } from "./agent-gateway.js";
import { attachMaterials } from "./materials.js";
import { attachContent, getRoomContentBinding } from "./content.js";
import { channelCapabilities } from "../shared/channels.js";
import type { Analytics, Fact, Room } from "../shared/types.js";

type RoomRow = {
  id: string;
  merchant_id: string;
  title: string;
  product_name: string;
  status: Room["status"];
  stream_secret: string;
  created_at: number;
  live_started_at: number;
};
type FactRow = {
  id: string;
  room_id: string;
  text: string;
  evidence: string;
  approved: number;
};
const factsFor = (db: DB, id: string): Fact[] =>
  (
    db
      .prepare("SELECT * FROM facts WHERE room_id=? ORDER BY rowid")
      .all(id) as FactRow[]
  ).map((f) => ({
    id: f.id,
    roomId: f.room_id,
    text: f.text,
    evidence: f.evidence,
    approved: Boolean(f.approved),
  }));
export function createApp(
  db: DB,
  config: Config,
  clock = Date.now,
  agentBridge: AgentBridge = new HttpAgentBridge(config),
) {
  const app = new Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>();
  const stream = createStreamAdapter(config);
  const media = new MediaController(config);
  const roomDto = (r: RoomRow): Room => ({
    id: r.id,
    merchantId: r.merchant_id,
    title: r.title,
    productName:
      (db
        .prepare(
          `SELECT json_extract(v.product_snapshot_json,'$.name') AS name
      FROM content_room_bindings b JOIN content_script_versions v
      ON v.course_id=b.course_id AND v.version=b.script_version WHERE b.room_id=?`,
        )
        .get(r.id)?.name as string | undefined) || r.product_name,
    status: r.status,
    createdAt: r.created_at,
    playbackUrl: stream.playbackUrl(r.id),
  });
  const room = (id: string) => {
    const r = db.prepare("SELECT * FROM rooms WHERE id=?").get(id) as
      RoomRow | undefined;
    if (!r) throw new HTTPException(404, { message: "直播间不存在" });
    return r;
  };
  const owned = (id: string, merchantId: string) => {
    const r = room(id);
    if (r.merchant_id !== merchantId)
      throw new HTTPException(404, { message: "直播间不存在" });
    return r;
  };
  const campaignOwned = (id: string, merchantId: string) => {
    const r = db.prepare("SELECT * FROM campaigns WHERE id=?").get(id) as
      CampaignRow | undefined;
    if (!r) throw new HTTPException(404, { message: "活动不存在" });
    owned(r.room_id, merchantId);
    return r;
  };
  app.use("*", secureHeaders());
  app.use("/api/*", (c, next) =>
    bodyLimit({
      maxSize: c.req.path.startsWith("/api/merchant/content/")
        ? 128 * 1024
        : 32 * 1024,
      onError: (c) => c.json({ error: "请求内容过大" }, 413),
    })(c, next),
  );
  app.use("/api/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    if (
      !["GET", "HEAD", "OPTIONS"].includes(c.req.method) &&
      !c.req.path.startsWith("/api/streams/") &&
      c.req.path !== "/api/payments/wechat/notify"
    ) {
      const origin = c.req.header("origin");
      if (origin && origin !== config.appOrigin)
        return c.json({ error: "不允许跨站操作" }, 403);
      if (c.req.header("sec-fetch-site") === "cross-site")
        return c.json({ error: "不允许跨站操作" }, 403);
      if (!c.req.header("content-type")?.startsWith("application/json"))
        return c.json({ error: "需要 application/json 请求" }, 415);
    }
    await next();
  });
  const buckets = new Map<string, { count: number; reset: number }>();
  app.use("/api/*", async (c, next) => {
    // Single-instance guard; do not trust arbitrary X-Forwarded-For headers.
    let remote =
      (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
        ?.incoming?.socket?.remoteAddress || "local";
    const forwarded = c.req.header("x-real-ip");
    if (config.trustedProxyIps.includes(remote) && forwarded && isIP(forwarded))
      remote = forwarded;
    const group =
      c.req.path === "/api/auth/viewer"
        ? "viewer-auth"
        : c.req.path.startsWith("/api/auth/")
          ? "merchant-auth"
          : c.req.method === "GET"
            ? "read"
            : "write";
    const role = c.req.path.startsWith("/api/merchant/")
      ? "merchant"
      : "viewer";
    const session = readSession(c, config, role, db);
    const engine =
      c.req.path.startsWith("/api/streams/") &&
      config.streamAuthSecret &&
      equalSecret(c.req.query("secret") || "", config.streamAuthSecret);
    const identity =
      group === "merchant-auth"
        ? `login:${remote}`
        : engine
          ? "engine"
          : session
            ? `${role}:${session.id}`
            : `anonymous:${remote}`;
    const key = `${identity}:${group}`,
      now = clock();
    if (buckets.size > 10000)
      for (const [k, b] of buckets) if (b.reset <= now) buckets.delete(k);
    let b = buckets.get(key);
    if (!b || b.reset <= now) {
      b = { count: 0, reset: now + 60000 };
      buckets.set(key, b);
    }
    const limit =
      group === "merchant-auth"
        ? 60
        : group === "viewer-auth"
          ? 600
          : group === "read"
            ? 1200
            : 300;
    if (++b.count > limit) {
      c.header("Retry-After", "60");
      return c.json({ error: "请求过于频繁，请稍后重试" }, 429);
    }
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException)
      return c.json({ error: error.message }, error.status);
    if (error instanceof ZodError)
      return c.json(
        {
          error: error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; "),
        },
        400,
      );
    if (error instanceof SyntaxError)
      return c.json({ error: "请求 JSON 格式不正确" }, 400);
    console.error(
      "Request failed:",
      error instanceof Error ? error.message : "unknown",
    );
    return c.json({ error: "服务暂时不可用" }, 500);
  });
  app.get("/api/health", (c) => {
    db.prepare("SELECT 1").get();
    return c.json({
      status: "ok",
      demoMode: config.demoMode,
      payments: "simulation",
      copilot: "agent-service",
      agentIndependent: true,
      streamProvider: config.streamProvider,
      mediaControl: media.configured,
      requirePlayback: config.requirePlayback,
    });
  });
  app.get("/api/channels", (c) => c.json({ channels: channelCapabilities }));
  app.get("/api/auth/me", (c) =>
    c.json({
      ...(readSession(c, config, "merchant", db)
        ? merchantIdentity(config, readSession(c, config, "merchant", db)!.id)
        : { merchantId: null }),
      demoMode: config.demoMode,
    }),
  );
  app.post("/api/auth/demo", (c) => {
    if (!config.demoMode) throw new HTTPException(404);
    issueSession(c, config, "merchant", "demo");
    return c.json({ merchantId: "demo" });
  });
  app.post("/api/auth/merchant", async (c) => {
    const input = z
      .object({ merchantId: z.string().max(50), token: z.string().max(256) })
      .parse(await c.req.json());
    const expected = config.merchantCredentials[input.merchantId];
    if (!expected || !equalSecret(expected, input.token))
      throw new HTTPException(401, { message: "商家编号或访问密钥错误" });
    issueSession(c, config, "merchant", input.merchantId);
    return c.json(merchantIdentity(config, input.merchantId));
  });
  app.post("/api/auth/logout", (c) => {
    const session = readSession(c, config, "merchant", db);
    if (session)
      db.prepare("INSERT OR IGNORE INTO revoked_sessions VALUES(?,?)").run(
        session.sid,
        session.expires,
      );
    deleteCookie(c, "studio_merchant", { path: config.basePath });
    return c.json({ ok: true });
  });
  app.post("/api/auth/viewer", (c) => {
    const session =
      readSession(c, config, "viewer", db) || issueSession(c, config, "viewer");
    return c.json({
      viewerId: session.id,
      identity: "anonymous",
      canReceiveRealMoney: false,
    });
  });
  app.use("/api/merchant/*", async (c, next) => {
    const session = readSession(c, config, "merchant", db);
    if (!session)
      throw new HTTPException(401, { message: "请先登录商家工作台" });
    const identity = merchantIdentity(config, session.id);
    c.set("merchantId", identity.merchantId);
    c.set("actorId", identity.actorId);
    c.set("memberRole", identity.memberRole);
    c.set("requireIndependentReview", identity.requiresIndependentReview);
    if (!memberMayAccess(identity.memberRole, c.req.method, c.req.path))
      throw new HTTPException(403, { message: "当前角色没有此操作权限" });
    await next();
  });
  app.use("/api/viewer/*", async (c, next) => {
    const session = readSession(c, config, "viewer", db);
    if (!session)
      throw new HTTPException(401, { message: "观看会话已过期，请刷新页面" });
    c.set("viewerId", session.id);
    await next();
  });
  app.get("/api/merchant/rooms", (c) =>
    c.json({
      rooms: (
        db
          .prepare(
            "SELECT * FROM rooms WHERE merchant_id=? ORDER BY created_at DESC",
          )
          .all(c.get("merchantId")) as RoomRow[]
      ).map(roomDto),
    }),
  );
  app.post("/api/merchant/rooms", async (c) => {
    const input = z
      .object({
        title: z.string().trim().min(2).max(100),
        productName: z.string().trim().min(1).max(100),
      })
      .parse(await c.req.json());
    const id = randomUUID();
    db.prepare(
      "INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at) VALUES(?,?,?,?,?,?)",
    ).run(
      id,
      c.get("merchantId"),
      input.title,
      input.productName,
      randomBytes(24).toString("hex"),
      clock(),
    );
    return c.json({ room: roomDto(room(id)) }, 201);
  });
  app.patch("/api/merchant/rooms/:id", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const input = z
      .object({ status: z.enum(["draft", "live", "ended"]) })
      .parse(await c.req.json());
    const legal: Record<string, string[]> = {
      draft: ["draft", "live"],
      live: ["live", "ended"],
      ended: ["ended", "draft"],
    };
    if (!legal[r.status].includes(input.status))
      throw new HTTPException(409, {
        message: "请先结束当前直播，或将已结束直播重置为待开播",
      });
    transaction(db, () => {
      db.prepare("UPDATE rooms SET status=?,live_started_at=? WHERE id=?").run(
        input.status,
        input.status === "live" && r.status !== "live"
          ? clock()
          : r.live_started_at,
        r.id,
      );
      if (input.status === "live" && r.status !== "live")
        db.prepare(
          "UPDATE visits SET session_watch_millis=0,active=0 WHERE room_id=?",
        ).run(r.id);
      // Ended campaigns are closed separately to avoid nesting SQLite transactions.
    });
    if (input.status === "ended")
      for (const row of db
        .prepare(`SELECT id FROM campaigns WHERE room_id=? AND status='active'`)
        .all(r.id) as { id: string }[])
        closeCampaign(db, row.id, clock());
    const streamAction =
      input.status === "ended" ? await media.disconnect(r.id) : undefined;
    return c.json({ room: roomDto(room(r.id)), streamAction });
  });
  app.get("/api/merchant/rooms/:id/stream", (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    return c.json(stream.configuration(r.id, r.stream_secret));
  });
  app.post("/api/merchant/rooms/:id/stream/rotate", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    db.prepare("UPDATE rooms SET stream_secret=? WHERE id=?").run(
      randomBytes(24).toString("hex"),
      r.id,
    );
    return c.json({ ok: true, streamAction: await media.disconnect(r.id) });
  });
  app.get("/api/merchant/rooms/:id/signal", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    return c.json(await media.status(r.id));
  });
  app.post("/api/merchant/rooms/:id/stream/disconnect", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    return c.json(await media.disconnect(r.id));
  });
  app.get("/api/merchant/rooms/:id/facts", (c) => {
    owned(c.req.param("id"), c.get("merchantId"));
    return c.json({ facts: factsFor(db, c.req.param("id")) });
  });
  app.post("/api/merchant/rooms/:id/facts", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const input = z
      .object({
        text: z.string().trim().min(1).max(400),
        evidence: z.string().trim().min(1).max(500),
        approved: z.boolean().default(false),
      })
      .parse(await c.req.json());
    db.prepare("INSERT INTO facts VALUES(?,?,?,?,?)").run(
      randomUUID(),
      r.id,
      input.text,
      input.evidence,
      Number(input.approved),
    );
    return c.json({ facts: factsFor(db, r.id) }, 201);
  });
  app.patch("/api/merchant/facts/:id", async (c) => {
    const f = db
      .prepare("SELECT room_id FROM facts WHERE id=?")
      .get(c.req.param("id")) as { room_id: string } | undefined;
    if (!f) throw new HTTPException(404);
    owned(f.room_id, c.get("merchantId"));
    const input = z.object({ approved: z.boolean() }).parse(await c.req.json());
    db.prepare("UPDATE facts SET approved=? WHERE id=?").run(
      Number(input.approved),
      c.req.param("id"),
    );
    return c.json({ ok: true });
  });
  attachMaterials(app, db, owned, (roomId) => factsFor(db, roomId), clock);
  attachContent(app, db, clock, agentBridge);
  attachAttribution(app, db, owned, clock);
  const agentBasis = (roomId: string, tenant: string) => {
    const r = owned(roomId, tenant);
    const binding = getRoomContentBinding(
      db,
      roomId,
      tenant,
      requiresIndependentReview(config, tenant),
    );
    if (!binding)
      return {
        productName: r.product_name,
        category: undefined,
        facts: factsFor(db, roomId)
          .filter((f) => f.approved && f.evidence.trim())
          .map(({ id, text, evidence, approved }) => ({
            id,
            text,
            evidence,
            approved,
          })),
        contentBound: false,
        stale: false,
      };
    return {
      productName: binding.productName,
      category: binding.category,
      // Namespace references by product revision so re-binding cannot make an
      // old Agent result appear current merely because a fact id was reused.
      facts: binding.stale
        ? []
        : binding.script.productSnapshot.facts
            .filter((f) => f.approved && f.evidence.trim())
            .map((f) => ({
              ...f,
              id: `${binding.productId}:v${binding.script.productSnapshot.version}:${f.id}`,
            })),
      contentBound: true,
      stale: binding.stale,
    };
  };
  app.get("/api/merchant/rooms/:id/agent/basis", (c) => {
    const basis = agentBasis(c.req.param("id"), c.get("merchantId"));
    return c.json(
      basis.contentBound
        ? basis
        : {
            ...basis,
            facts: factsFor(db, c.req.param("id")),
          },
    );
  });
  attachAgentGateway(
    app,
    agentBridge,
    (roomId, tenant, input) => {
      const r = owned(roomId, tenant);
      const basis = agentBasis(roomId, tenant);
      const campaign = db
        .prepare(
          `SELECT * FROM campaigns WHERE room_id=? AND status='active' AND expires_at>? ORDER BY opens_at LIMIT 1`,
        )
        .get(r.id, clock()) as CampaignRow | undefined;
      const cue = campaign
        ? `演示红包：观看满 ${campaign.min_watch_seconds} 秒可参与。${clock() < campaign.opens_at ? Math.ceil((campaign.opens_at - clock()) / 1000) + " 秒后开启" : "现已开启"}；不发生实际转账。`
        : undefined;
      return {
        transcript: input.transcript,
        question: input.question,
        roomId: r.id,
        productName: basis.productName,
        category: basis.category,
        facts: basis.facts,
        campaignCue: cue,
      };
    },
    (tenant, run) => {
      const current = owned(run.roomId, tenant);
      const basis = agentBasis(run.roomId, tenant);
      const approved = new Set(
        basis.facts
          .filter((f) => f.approved && f.evidence.trim())
          .map((f) => f.id),
      );
      const evidenceChanged = run.result?.factIds.some(
        (id) => !approved.has(id),
      );
      const expired =
        run.mode === "live" &&
        (current.status !== "live" ||
          current.live_started_at > run.createdAt ||
          clock() - run.createdAt > 120000);
      return {
        ...run,
        stale: Boolean(basis.stale || evidenceChanged || expired),
        staleReason: basis.stale
          ? "本场定稿的商品依据已变化，请先复核课程讲稿。"
          : evidenceChanged
            ? "引用的事实已撤回，请重新生成。"
            : expired
              ? "直播场次或时间已变化，请重新生成当前建议。"
              : undefined,
      };
    },
  );
  app.get("/api/merchant/rooms/:id/campaigns", (c) => {
    owned(c.req.param("id"), c.get("merchantId"));
    return c.json({
      serverTime: clock(),
      campaigns: (
        db
          .prepare(
            "SELECT * FROM campaigns WHERE room_id=? ORDER BY rowid DESC",
          )
          .all(c.req.param("id")) as unknown as CampaignRow[]
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
      db.prepare(
        "INSERT INTO campaigns(id,room_id,total_cents,count,remaining_cents,remaining_count,min_watch_seconds,opens_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
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
      db.prepare("INSERT INTO ledger VALUES(?,?,?,?,?,?,?)").run(
        randomUUID(),
        id,
        null,
        "simulation_budget",
        "campaign_reserved",
        input.totalCents,
        clock(),
      );
    });
    return c.json(
      {
        campaign: campaignDto(
          db
            .prepare("SELECT * FROM campaigns WHERE id=?")
            .get(id) as unknown as CampaignRow,
        ),
      },
      201,
    );
  });
  app.post("/api/merchant/campaigns/:id/close", (c) => {
    campaignOwned(c.req.param("id"), c.get("merchantId"));
    closeCampaign(db, c.req.param("id"), clock());
    return c.json({ ok: true });
  });
  app.get("/api/merchant/rooms/:id/ledger", (c) => {
    owned(c.req.param("id"), c.get("merchantId"));
    const entries = db
      .prepare(
        `SELECT l.id,l.campaign_id AS campaignId,l.claim_id AS claimId,l.debit,l.credit,l.amount_cents AS amountCents,l.created_at AS createdAt FROM ledger l JOIN campaigns c ON c.id=l.campaign_id WHERE c.room_id=? ORDER BY l.created_at DESC LIMIT 200`,
      )
      .all(c.req.param("id"));
    return c.json({ entries, mode: "simulation", limit: 200 });
  });
  app.get("/api/merchant/rooms/:id/analytics", (c) => {
    const id = c.req.param("id");
    owned(id, c.get("merchantId"));
    const visits = db
      .prepare(
        "SELECT count(*) AS uniqueViewers,coalesce(sum(watch_seconds),0) AS totalWatchSeconds,coalesce(avg(watch_seconds),0) AS averageWatchSeconds FROM visits WHERE room_id=?",
      )
      .get(id) as {
      uniqueViewers: number;
      totalWatchSeconds: number;
      averageWatchSeconds: number;
    };
    const online = db
      .prepare(
        "SELECT count(*) AS n FROM visits WHERE room_id=? AND last_seen>?",
      )
      .get(id, clock() - 30000) as { n: number };
    const claims = db
      .prepare(
        `SELECT count(*) AS claims,coalesce(sum(amount_cents),0) AS reservedCents,coalesce(sum(CASE WHEN status='simulated' THEN amount_cents ELSE 0 END),0) AS simulatedCents FROM claims WHERE campaign_id IN (SELECT id FROM campaigns WHERE room_id=?)`,
      )
      .get(id) as {
      claims: number;
      reservedCents: number;
      simulatedCents: number;
    };
    const questions = db
      .prepare("SELECT count(*) AS n FROM questions WHERE room_id=?")
      .get(id) as { n: number };
    const timeline = db
      .prepare(
        `SELECT minute,count(*) AS viewers FROM presence WHERE room_id=? AND minute>=? GROUP BY minute ORDER BY minute`,
      )
      .all(id, Math.floor(clock() / 60000) - 29) as {
      minute: number;
      viewers: number;
    }[];
    const result: Analytics = {
      ...visits,
      ...claims,
      onlineViewers: online.n,
      questions: questions.n,
      timeline: timeline.map((v) => ({
        minute: new Date(v.minute * 60000).toISOString(),
        viewers: v.viewers,
      })),
    };
    return c.json(result);
  });
  app.get("/api/merchant/rooms/:id/questions", (c) => {
    owned(c.req.param("id"), c.get("merchantId"));
    return c.json({
      questions: db
        .prepare(
          "SELECT min(id) AS id,text,count(*) AS count FROM questions WHERE room_id=? GROUP BY text ORDER BY count DESC,max(created_at) DESC LIMIT 20",
        )
        .all(c.req.param("id")),
    });
  });
  app.get("/api/public/rooms/:id", async (c) => {
    const r = room(c.req.param("id"));
    const campaigns = (
      db
        .prepare(
          `SELECT * FROM campaigns WHERE room_id=? AND status='active' AND expires_at>? ORDER BY opens_at LIMIT 20`,
        )
        .all(r.id, clock()) as unknown as CampaignRow[]
    ).map(campaignDto);
    // Stream publish secrets, merchant facts and copilot output never cross this boundary.
    const { merchantId: _merchantId, ...publicRoom } = roomDto(r);
    return c.json({
      room: { ...publicRoom, signal: await media.status(r.id) },
      requirePlayback: config.requirePlayback,
      campaigns,
      serverTime: clock(),
      paymentMode: "simulation",
    });
  });
  app.post("/api/viewer/rooms/:id/heartbeat", async (c) => {
    const r = room(c.req.param("id")),
      now = clock(),
      viewer = c.get("viewerId");
    const input = z
      .object({
        visible: z.boolean(),
        playing: z.boolean().default(false),
        sourceCode: z.string().max(100).optional(),
      })
      .parse(await c.req.json());
    const connected = config.requirePlayback
      ? (await media.status(r.id)).connected === true
      : false;
    return c.json(
      transaction(db, () => {
        const result = recordPresence(
          db,
          r,
          viewer,
          input,
          config.requirePlayback,
          connected,
          now,
        );
        if (result.counting)
          recordAttribution(db, r.id, viewer, input.sourceCode, now);
        return result;
      }),
    );
  });
  app.post("/api/viewer/rooms/:id/questions", async (c) => {
    const r = room(c.req.param("id"));
    if (r.status !== "live")
      throw new HTTPException(409, { message: "直播进行中才能提问" });
    const input = z
      .object({ text: z.string().trim().min(1).max(200) })
      .parse(await c.req.json());
    const last = db
      .prepare(
        "SELECT created_at FROM questions WHERE room_id=? AND viewer_id=? ORDER BY created_at DESC LIMIT 1",
      )
      .get(r.id, c.get("viewerId")) as { created_at: number } | undefined;
    if (last && clock() - last.created_at < 5000)
      throw new HTTPException(429, { message: "请稍后再提问" });
    db.prepare("INSERT INTO questions VALUES(?,?,?,?,?)").run(
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
      const campaign = db
        .prepare("SELECT room_id FROM campaigns WHERE id=?")
        .get(c.req.param("id")) as { room_id: string } | undefined;
      if (campaign && (await media.status(campaign.room_id)).connected !== true)
        throw new HTTPException(409, {
          message: "当前没有有效直播信号，请等待主播恢复推流",
        });
    }
    return c.json({
      claim: reserveClaim(db, c.req.param("id"), c.get("viewerId"), clock()),
      paymentMode: "simulation",
    });
  });
  app.get("/api/viewer/rooms/:id/claims", (c) => {
    room(c.req.param("id"));
    return c.json({
      claims: (
        db
          .prepare(
            "SELECT * FROM claims WHERE viewer_id=? AND campaign_id IN (SELECT id FROM campaigns WHERE room_id=?) ORDER BY created_at DESC",
          )
          .all(c.get("viewerId"), c.req.param("id")) as unknown as ClaimRow[]
      ).map(claimDto),
    });
  });

  // HTTP authentication hooks. Engine configuration is required; these are not a proxy for video.
  app.post("/api/streams/mediamtx/auth", async (c) => {
    if (
      !config.streamAuthSecret ||
      !equalSecret(c.req.query("secret") || "", config.streamAuthSecret)
    )
      throw new HTTPException(403);
    const input = z
      .object({
        action: z.string(),
        path: z.string(),
        query: z.string().optional(),
      })
      .parse(await c.req.json());
    if (!input.path.startsWith("live/")) throw new HTTPException(403);
    if (["read", "playback"].includes(input.action)) {
      const r = room(input.path.slice(5));
      if (r.status !== "live") throw new HTTPException(403);
      return c.body(null, 204);
    }
    if (input.action !== "publish") throw new HTTPException(403);
    const r = room(input.path.replace(/^live\//, ""));
    const token = new URLSearchParams(input.query || "").get("token") || "";
    if (r.status !== "live" || !equalSecret(token, r.stream_secret))
      throw new HTTPException(403);
    return c.body(null, 204);
  });
  app.post("/api/streams/srs/publish", async (c) => {
    if (
      !config.streamAuthSecret ||
      !equalSecret(c.req.query("secret") || "", config.streamAuthSecret)
    )
      return c.json({ code: 403 }, 403);
    const input = z
      .object({
        action: z.literal("on_publish"),
        stream: z.string(),
        param: z.string().optional(),
        app: z.string(),
      })
      .parse(await c.req.json());
    const r = room(input.stream);
    const token = new URLSearchParams(input.param || "").get("token") || "";
    if (
      input.app !== "live" ||
      r.status !== "live" ||
      !equalSecret(token, r.stream_secret)
    )
      return c.json({ code: 403 }, 403);
    return c.json({ code: 0 });
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
  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  return app;
}

export function seedDemo(db: DB, now = Date.now()) {
  if (db.prepare("SELECT id FROM rooms WHERE id=?").get("demo-room")) return;
  transaction(db, () => {
    db.prepare(
      `INSERT INTO rooms(id,merchant_id,title,product_name,status,stream_secret,created_at) VALUES('demo-room','demo','秋日好物 · 品牌直播间','日常随行杯','draft',?,?)`,
    ).run(randomBytes(24).toString("hex"), now);
    db.prepare("INSERT INTO facts VALUES(?,?,?,?,?)").run(
      randomUUID(),
      "demo-room",
      "容量为 500 mL",
      "演示产品标签（示例数据，非真实商品凭证）",
      1,
    );
    db.prepare("INSERT INTO facts VALUES(?,?,?,?,?)").run(
      randomUUID(),
      "demo-room",
      "杯盖采用旋拧结构",
      "演示产品说明书（示例数据，非真实商品凭证）",
      1,
    );
    db.prepare("INSERT INTO facts VALUES(?,?,?,?,?)").run(
      randomUUID(),
      "demo-room",
      "保温时长可达 12 小时",
      "待补充检测报告：暂未审核",
      0,
    );
  });
}
