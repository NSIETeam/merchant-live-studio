import { createHmac, randomBytes } from "node:crypto";
import type { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { WeChatOAuthPort } from "../adapters/public.js";
import type { Config } from "../infrastructure/public.js";
import { equalSecret, issueSession } from "./auth.js";

type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
const stateCookie = "studio_wechat_state";
const stateLifetimeMs = 10 * 60 * 1000;

export function attachWeChatIdentity(
  app: App,
  config: Config,
  adapter: WeChatOAuthPort,
  clock: () => number = Date.now,
  onVerified?: (input: {
    viewerId: string;
    roomId: string;
    subject: string;
  }) => void | Promise<void>,
) {
  const pending = new Map<string, { roomId: string; expiresAt: number }>();
  const sign = (payload: string) =>
    createHmac("sha256", config.sessionSecret)
      .update(`wechat-oauth:${payload}`)
      .digest("base64url");
  const stateFor = (nonce: string) => `${nonce}.${sign(nonce)}`;
  const readState = (value: string) => {
    const [nonce, signature, ...rest] = value.split(".");
    if (
      !nonce ||
      !signature ||
      rest.length ||
      !/^[a-zA-Z0-9_-]{32,100}$/.test(nonce) ||
      !equalSecret(signature, sign(nonce))
    )
      return null;
    return nonce;
  };
  const clearStateCookie = (c: Parameters<typeof getCookie>[0]) =>
    deleteCookie(c, stateCookie, { path: config.basePath });

  app.get("/api/channels/wechat/authorize", (c) => {
    if (!adapter.configured || !config.wechatOAuth)
      return c.json({ error: "微信观众身份尚未配置" }, 503);
    const roomId = z
      .string()
      .regex(/^[a-zA-Z0-9_-]{1,100}$/)
      .parse(c.req.query("roomId"));
    const nonce = randomBytes(32).toString("base64url");
    const now = clock();
    for (const [key, value] of pending)
      if (value.expiresAt <= now) pending.delete(key);
    if (pending.size >= 10_000)
      return c.json({ error: "微信身份验证请求较多，请稍后重试" }, 503);
    const expiresAt = now + stateLifetimeMs;
    pending.set(nonce, { roomId, expiresAt });
    const state = stateFor(nonce);
    setCookie(c, stateCookie, nonce, {
      httpOnly: true,
      secure: config.production,
      sameSite: "Lax",
      path: config.basePath,
      maxAge: stateLifetimeMs / 1000,
    });
    c.header("Cache-Control", "no-store");
    return c.json({
      configured: true,
      authorizationUrl: adapter.createAuthorizationUrl(state),
      expiresAt,
    });
  });

  app.get("/api/channels/wechat/callback", async (c) => {
    const oauth = config.wechatOAuth;
    if (!adapter.configured || !oauth)
      return c.json({ error: "微信观众身份尚未配置" }, 503);
    const query = z
      .object({
        code: z.string().min(1).max(256),
        state: z.string().min(1).max(2048),
      })
      .parse({ code: c.req.query("code"), state: c.req.query("state") });
    const cookieNonce = getCookie(c, stateCookie) || "";
    clearStateCookie(c);
    const nonce = readState(query.state);
    const state = nonce ? pending.get(nonce) : undefined;
    if (nonce) pending.delete(nonce);
    const now = clock();
    if (
      !state ||
      state.expiresAt <= now ||
      !nonce ||
      !equalSecret(cookieNonce, nonce)
    )
      return c.json({ error: "微信身份验证已失效，请重新发起" }, 400);
    let identity;
    try {
      identity = await adapter.verifyCallback(query);
    } catch {
      return c.json({ error: "微信身份服务暂时不可用，请重新尝试" }, 502);
    }
    if (
      identity.channel !== "wechat" ||
      !identity.verified ||
      !/^[a-zA-Z0-9_-]{10,128}$/.test(identity.subject)
    )
      return c.json({ error: "微信身份验证失败" }, 502);
    const viewerId = `wechat_${createHmac("sha256", oauth.identitySecret)
      .update(`wechat-subject:${identity.subject}`)
      .digest("base64url")
      .slice(0, 32)}`;
    try {
      await onVerified?.({
        viewerId,
        roomId: state.roomId,
        subject: identity.subject,
      });
    } catch {
      return c.json(
        { error: "微信收款身份暂时无法保存，请重新发起身份验证" },
        503,
      );
    }
    issueSession(c, config, "viewer", viewerId);
    return c.redirect(
      `${config.basePath}watch/${encodeURIComponent(state.roomId)}?channel=wechat`,
      302,
    );
  });
}
