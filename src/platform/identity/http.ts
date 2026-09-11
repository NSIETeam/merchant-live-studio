import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie } from "hono/cookie";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { isIP } from "node:net";
import { z, ZodError } from "zod";
import { type Config } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import { equalSecret, issueSession, readSession } from "./auth.js";
import { memberMayAccess, merchantIdentity } from "./permissions.js";
import {
  deleteRevokedSessionsByExpiresAt,
  insertRevokedSessions,
} from "./persistence/http-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function createIdentity(
  db: DB,
  config: Config,
  clock: () => number = Date.now,
) {
  return {
    cleanup() {
      deleteRevokedSessionsByExpiresAt(db, clock());
    },
    attach(app: App) {
      const buckets = new Map<string, { count: number; reset: number }>();
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
      app.use("/api/*", async (c, next) => {
        // Single-instance guard; do not trust arbitrary X-Forwarded-For headers.
        let remote =
          (c.env as { incoming?: { socket?: { remoteAddress?: string } } })
            ?.incoming?.socket?.remoteAddress || "local";
        const forwarded = c.req.header("x-real-ip");
        if (
          config.trustedProxyIps.includes(remote) &&
          forwarded &&
          isIP(forwarded)
        )
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
          throw new HTTPException(401, {
            message: "观看会话已过期，请刷新页面",
          });
        c.set("viewerId", session.id);
        await next();
      });
      app.get("/api/auth/me", (c) =>
        c.json({
          ...(readSession(c, config, "merchant", db)
            ? merchantIdentity(
                config,
                readSession(c, config, "merchant", db)!.id,
              )
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
          .object({
            merchantId: z.string().max(50),
            token: z.string().max(256),
          })
          .parse(await c.req.json());
        const expected = config.merchantCredentials[input.merchantId];
        if (!expected || !equalSecret(expected, input.token))
          throw new HTTPException(401, { message: "商家编号或访问密钥错误" });
        issueSession(c, config, "merchant", input.merchantId);
        return c.json(merchantIdentity(config, input.merchantId));
      });
      app.post("/api/auth/logout", (c) => {
        const session = readSession(c, config, "merchant", db);
        if (session) insertRevokedSessions(db, session.sid, session.expires);
        deleteCookie(c, "studio_merchant", { path: config.basePath });
        return c.json({ ok: true });
      });
      app.post("/api/auth/viewer", (c) => {
        const session =
          readSession(c, config, "viewer", db) ||
          issueSession(c, config, "viewer");
        return c.json({
          viewerId: session.id,
          identity: "anonymous",
          canReceiveRealMoney: false,
        });
      });
    },
  };
}
