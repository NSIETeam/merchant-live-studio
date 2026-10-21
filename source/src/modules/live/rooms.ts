import { admissionQuery1, admissionQuery2, admissionQuery3, admissionQuery4 } from "./persistence/admission-queries.js";
import { createAdmissionChecker } from "./admission.js";
import { attachModeration, activeModerationHold } from "./moderation.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { equalSecret } from "../../platform/identity/public.js";
import {
  transaction,
  type Config,
} from "../../platform/infrastructure/public.js";
import type { ContentBinding } from "../../shared/content.js";
import type { Disclosure } from "../../shared/disclosure.js";
import type {
  EngagementPort,
  RoomRow,
  ViewingStats,
  VisitState,
} from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import type { Room } from "../../shared/types.js";
import { MediaController } from "./media-control.js";
import {
  findRoomsById,
  findRoomsById2,
  findVisitsByRoomId,
  findVisitsByRoomIdAndLastSeen,
  findVisitsByRoomIdAndViewerId,
  insertRooms,
  insertRooms2,
  listPresenceByRoomIdAndMinute,
  listRoomsByMerchantId,
  updateRoomsById,
  updateRoomsById2,
  updateVisitsByRoomId,
} from "./persistence/rooms-queries.js";
import { recordPresence } from "./presence.js";
import { createStreamAdapter } from "./stream.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function createLive(
  db: DB,
  config: Config,
  ports: {
    binding: (id: string, merchant: string, independent?: boolean) => ContentBinding | null;
    disclosure: (tenant:string, now:number) => {
      published:boolean;
      version:number|null;
      valid:boolean;
      data?:Disclosure;
      evidenceReference?:string;
      authoredBy?:string;
      authoredAt?:number;
      publication?:{actorId:string;note:string;createdAt:number};
    };
    syncAuthorization: (tenant:string) => Promise<void>;
    engagement: () => EngagementPort;
    seedFacts: (room: string) => void;
    recordAttribution: (room:string, viewer:string, code:string|undefined, now:number) => void;
  },
  clock: () => number = Date.now,
) {
  const admissionCheck = createAdmissionChecker(db, config, ports);
  async function controlForAdmission(r: RoomRow) {
    await ports.syncAuthorization(r.merchant_id);
    return media.readyForAdmission();
  }
  async function checkPublishAdmission(r: RoomRow) {
    if (activeModerationHold(db, r.id)) throw new HTTPException(403);
    if (!config.requireReviewedLive) return;
    const reachable = await controlForAdmission(r);
    const current = room(r.id);
    if (current.status !== "live" || current.stream_secret !== r.stream_secret)
      throw new HTTPException(403);
    const check = admissionCheck(
      r.id,
      r.merchant_id,
      reachable,
      clock(),
    );
    if (!check.ready)
      throw new HTTPException(403, {
        message: "开播资料或流媒体控制已失效，请返回工作台核对",
      });
  }

  const stream = createStreamAdapter(config),
    media = new MediaController(config);
  const roomDto = (r: RoomRow): Room => ({
    id: r.id,
    merchantId: r.merchant_id,
    title: r.title,
    productName:
      ({ name: ports.binding(r.id, r.merchant_id)?.productName }?.name as
        string | undefined) || r.product_name,
    status: r.status,
    createdAt: r.created_at,
    playbackUrl: stream.playbackUrl(r.id),
  });
  const room = (id: string) => {
    const r = findRoomsById(db, id) as RoomRow | undefined;
    if (!r) throw new HTTPException(404, { message: "直播间不存在" });
    return r;
  };
  const owned = (id: string, merchantId: string) => {
    const r = room(id);
    if (r.merchant_id !== merchantId)
      throw new HTTPException(404, { message: "直播间不存在" });
    return r;
  };
  const visit = (id: string, viewer: string) =>
    findVisitsByRoomIdAndViewerId(db, id, viewer) as unknown as
      VisitState | undefined;
  const viewingStats = (id: string): ViewingStats => {
    const visits = findVisitsByRoomId(db, id) as unknown as {
      uniqueViewers: number;
      totalWatchSeconds: number;
      averageWatchSeconds: number;
    };
    const online = findVisitsByRoomIdAndLastSeen(db, id, clock() - 30000)!;
    const timeline = listPresenceByRoomIdAndMinute(
      db,
      id,
      Math.floor(clock() / 60000) - 29,
    );
    return {
      ...visits,
      onlineViewers: Number(online.n),
      timeline: timeline.map((v) => ({
        minute: new Date(Number(v.minute) * 60000).toISOString(),
        viewers: Number(v.viewers),
      })),
    };
  };
  const seedDemo = (now = clock()) => {
    if (findRoomsById2(db, "demo-room")) return;
    transaction(db, () => {
      insertRooms(db, randomBytes(24).toString("hex"), now);
      ports.seedFacts("demo-room");
    });
  };
  return {
    room,
    owned,
    roomDto,
    visit,
    viewingStats,
    seedDemo,
    signal: (id: string) => media.status(id),
    mediaConfigured: media.configured,
    attach(app: App) {
      attachModeration(app, db, media, (room, now) => ports.engagement().closeRoom(room, now), clock);
app.get("/api/merchant/rooms/:id/admission", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const reachable = await controlForAdmission(r);
    return c.json(
      admissionCheck( r.id, r.merchant_id, reachable, clock()),
    );
  });
app.get("/api/merchant/rooms/:id/admission-report", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const reachable = await controlForAdmission(r);
    const generatedAt = clock();
    const report = {
      formatVersion: 1,
      scope: "live-technical-readiness",
      generatedAt,
      room: {
        id: r.id,
        title: r.title,
        productName: roomDto(r).productName,
        status: r.status,
      },
      admission: admissionCheck(r.id, r.merchant_id, reachable, generatedAt),
      limitations: [
        "本报告记录软件在生成时点的开播准备检查，不是行政许可、平台审核结果或法律意见。",
        "主体、资质、商品依据、人员身份、真实推流和直播现场仍需审核方查看原件并实际核验。",
        "报告不包含密钥、完整讲稿、商品事实正文、观众资料或资金记录。",
      ],
    };
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header("Content-Disposition", `attachment; filename="studio-admission-${r.id}.json"`);
    c.header("Cache-Control", "no-store");
    return c.body(JSON.stringify(report, null, 2));
  });
app.get("/api/merchant/rooms/:id/compliance-review-package", async (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const reachable = await controlForAdmission(r);
    const generatedAt = clock();
    const admission = admissionCheck(r.id, r.merchant_id, reachable, generatedAt);
    const disclosure = ports.disclosure(r.merchant_id, generatedAt);
    const binding = ports.binding(r.id, r.merchant_id, true);
    const currentBinding = binding && !binding.stale ? binding : null;
    const publishedDisclosure =
      disclosure.published && disclosure.valid && disclosure.data
        ? {
            version: disclosure.version,
            valid: true,
            data: disclosure.data,
            evidenceReference: disclosure.evidenceReference,
            authoredBy: disclosure.authoredBy,
            authoredAt: disclosure.authoredAt,
            publication: disclosure.publication,
          }
        : null;
    const report = {
      formatVersion: 1,
      scope: "live-compliance-review-package",
      generatedAt,
      readiness: {
        complete: admission.ready,
        missing: admission.checks
          .filter((item) => !item.passed)
          .map((item) => ({ code: item.code, label: item.label, detail: item.detail })),
      },
      room: {
        id: r.id,
        title: r.title,
        productName: roomDto(r).productName,
        status: r.status,
        createdAt: r.created_at,
      },
      platform: config.platformCompliance,
      retention: config.retentionPolicy,
      merchantDisclosure: publishedDisclosure,
      content: currentBinding
        ? {
            courseId: currentBinding.courseId,
            courseTitle: currentBinding.courseTitle,
            boundAt: currentBinding.boundAt,
            product: {
              id: currentBinding.productId,
              name: currentBinding.productName,
              sku: currentBinding.script.productSnapshot.sku,
              category: currentBinding.category,
              version: currentBinding.script.productSnapshot.version,
              facts: currentBinding.script.productSnapshot.facts.map((fact) => ({
                id: fact.id,
                text: fact.text,
                evidence: fact.evidence,
                approved: fact.approved,
              })),
            },
            script: {
              version: currentBinding.scriptVersion,
              createdAt: currentBinding.script.createdAt,
              ruleVersion: currentBinding.script.check.ruleVersion,
              check: {
                checkedAt: currentBinding.script.check.checkedAt,
                blockingCount: currentBinding.script.check.blockingCount,
                summary: currentBinding.script.check.summary,
                issues: currentBinding.script.check.issues,
              },
              independentReview: currentBinding.script.confirmation,
              paragraphs: currentBinding.script.paragraphs,
            },
          }
        : null,
      admission,
      limitations: [
        "本材料包汇总生成时点的软件记录，不是行政许可、平台审核结论或法律意见。",
        "证照、授权、商品依据和人员身份仍须审核方核对原件及适用范围。",
        "技术准入通过不证明实际直播画面、主播口播和后续变更持续合规。",
        "材料包不包含推流、登录、模型或支付密钥，也不包含观众、转写和资金记录。",
      ],
    };
    const body = JSON.stringify(report, null, 2);
    c.header("Content-Type", "application/json; charset=utf-8");
    c.header(
      "Content-Disposition",
      `attachment; filename="studio-review-package-${r.id}.json"`,
    );
    c.header("Cache-Control", "no-store");
    c.header("X-Content-SHA256", createHash("sha256").update(body).digest("hex"));
    return c.body(body);
  });
app.get("/api/merchant/rooms/:id/admissions", (c) => {
    const r = owned(c.req.param("id"), c.get("merchantId"));
    const before = z.coerce
      .number()
      .int()
      .positive()
      .parse(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    const rows = admissionQuery1(db, r.id, before);
    return c.json({
      items: rows.slice(0, 50).map((row) => ({
        id: row.id,
        actorId: row.actorId,
        createdAt: row.createdAt,
        basis: JSON.parse(String(row.basis_json)),
      })),
      nextBefore: rows.length > 50 ? rows[49].id : null,
    });
  });

      app.get("/api/merchant/rooms", (c) =>
        c.json({
          rooms: (
            listRoomsByMerchantId(
              db,
              c.get("merchantId"),
            ) as unknown as RoomRow[]
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
        insertRooms2(
          db,
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
    let r = owned(c.req.param("id"), c.get("merchantId"));
    const input = z
      .object({ status: z.enum(["draft", "live", "ended"]) })
      .parse(await c.req.json());
    let controlReachable = false;
    if (input.status === "live" && config.requireReviewedLive) {
      controlReachable = await controlForAdmission(r);
      r = owned(r.id, c.get("merchantId"));
    }
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
      if (input.status === "live" && activeModerationHold(db, r.id))
        throw new HTTPException(409, {
          message: "直播间因现场处置暂停，请由另一审核账号复核解除后再开播",
        });
      if (input.status === "live" && config.requireReviewedLive) {
        const check = admissionCheck(
          r.id,
          r.merchant_id,
          controlReachable,
          clock(),
        );
        if (!check.ready)
          throw new HTTPException(409, {
            message:
              "暂不能开播：" +
              check.checks
                .filter((item) => !item.passed)
                .map((item) => item.detail)
                .join("；"),
          });
        if (r.status !== "live")
          admissionQuery2(db, r.id, r.merchant_id, c.get("actorId"), JSON.stringify(check.basis), clock());
      }
      admissionQuery3(db, input.status, input.status === "live" && r.status !== "live"
          ? clock()
          : r.live_started_at, r.id);
      if (input.status === "live" && r.status !== "live")
        admissionQuery4(db, r.id);
      // Ended campaigns are closed separately to avoid nesting SQLite transactions.
    });
    if (input.status === "ended") ports.engagement().closeRoom(r.id, clock());
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
        updateRoomsById2(db, randomBytes(24).toString("hex"), r.id);
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
      app.get("/api/public/rooms/:id", async (c) => {
        const r = room(c.req.param("id"));
        const campaigns = ports.engagement().active(r.id, clock());
        // Stream publish secrets, merchant facts and copilot output never cross this boundary.
        const { merchantId: _merchantId, ...publicRoom } = roomDto(r);
        return c.json({
          room: { ...publicRoom, signal: await media.status(r.id) },
          requirePlayback: config.requirePlayback,
          campaigns,
          serverTime: clock(),
          paymentMode: ports.engagement().paymentModeFor(r.merchant_id),
        });
      });
      app.post("/api/viewer/rooms/:id/heartbeat", async (c) => {
        const r = room(c.req.param("id")),
          now = clock(),
          viewer = c.get("viewerId");
        const input = z
          .object({ visible: z.boolean(), playing: z.boolean().default(false), sourceCode: z.string().max(100).optional() })
          .parse(await c.req.json());
        const connected = config.requirePlayback
          ? (await media.status(r.id)).connected === true
          : false;
        return c.json(transaction(db, () => {
          const result = recordPresence(db,r,viewer,input,config.requirePlayback,connected,now);
          if(result.counting) ports.recordAttribution(r.id,viewer,input.sourceCode,now);
          return result;
        }));
      });
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
    await checkPublishAdmission(r);
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
    await checkPublishAdmission(r);
    return c.json({ code: 0 });
  });
    },
  };
}
