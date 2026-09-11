import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { createIdentity } from "../src/platform/identity/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import {
  HttpWeChatOAuthAdapter,
  type WeChatOAuthPort,
} from "../src/platform/adapters/public.js";

const secret = "wechat-app-secret-0123456789abcdef";
const oauthEnvironment = {
  DEMO_MODE: "true",
  APP_ORIGIN: "https://studio.example.test",
  APP_BASE_PATH: "/studio/",
  WECHAT_OAUTH_ENABLED: "true",
  WECHAT_APP_ID: "wx1234567890abcdef",
  WECHAT_APP_SECRET: secret,
  WECHAT_IDENTITY_SECRET: "wechat-identity-secret-0123456789abcdef",
  WECHAT_OAUTH_REDIRECT_URI:
    "https://studio.example.test/studio/api/channels/wechat/callback",
};

function cookie(response: Response, name: string) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith(`${name}=`));
}

test("WeChat OAuth configuration is explicit, same-origin and callback-exact", () => {
  const disabled = loadConfig({
    DEMO_MODE: "true",
    WECHAT_APP_ID: "wx1234567890abcdef",
  });
  assert.equal(disabled.wechatOAuth, null);
  const enabled = loadConfig(oauthEnvironment);
  assert.equal(enabled.wechatOAuth?.appId, "wx1234567890abcdef");
  assert.equal(enabled.wechatOAuth?.appSecret, secret);

  for (const changed of [
    { ...oauthEnvironment, WECHAT_APP_SECRET: "short" },
    { ...oauthEnvironment, WECHAT_IDENTITY_SECRET: "short" },
    {
      ...oauthEnvironment,
      WECHAT_OAUTH_REDIRECT_URI:
        "https://foreign.example.test/studio/api/channels/wechat/callback",
    },
    {
      ...oauthEnvironment,
      WECHAT_OAUTH_REDIRECT_URI:
        "https://studio.example.test/api/channels/wechat/callback",
    },
    { ...oauthEnvironment, APP_BASE_PATH: "/../" },
  ])
    assert.throws(() => loadConfig(changed));
  assert.throws(() =>
    loadConfig({
      ...oauthEnvironment,
      NODE_ENV: "production",
      APP_ORIGIN: "https://studio.example.test",
      WECHAT_OAUTH_REDIRECT_URI:
        "http://studio.example.test/studio/api/channels/wechat/callback",
      MERCHANT_CREDENTIALS: JSON.stringify({
        owner: "production-merchant-secret-0123456789",
      }),
      SESSION_SECRET: "production-session-secret-0123456789abcdef",
    }),
  );
});

test("channel capability and authorize endpoint stay unavailable when OAuth is disabled", async () => {
  const db = openDatabase(":memory:");
  try {
    const app = createApp(db, loadConfig({ DEMO_MODE: "true" }));
    const channels = (await (await app.request("/api/channels")).json()) as any;
    const wechat = channels.channels.find(
      (item: { channel: string }) => item.channel === "wechat",
    );
    assert.equal(wechat.viewerEntry, "not-configured");
    assert.equal(wechat.verifiedIdentity, false);
    const authorize = await app.request(
      "/api/channels/wechat/authorize?roomId=demo-room",
    );
    assert.equal(authorize.status, 503);
  } finally {
    db.close();
  }

  const configuredDb = openDatabase(":memory:");
  try {
    const app = createApp(configuredDb, loadConfig(oauthEnvironment));
    const channels = (await (await app.request("/api/channels")).json()) as any;
    const wechat = channels.channels.find(
      (item: { channel: string }) => item.channel === "wechat",
    );
    assert.equal(wechat.viewerEntry, "available");
    assert.equal(wechat.verifiedIdentity, true);
    assert.equal(wechat.signedSharing, false);
    assert.equal(wechat.realPayment, false);
  } finally {
    configuredDb.close();
  }
});

test("signed one-time state creates a stable opaque WeChat viewer session", async () => {
  const config = loadConfig(oauthEnvironment);
  let now = 1_800_000_000_000;
  const seen: Array<{ code: string; state: string }> = [];
  const adapter: WeChatOAuthPort = {
    configured: true,
    createAuthorizationUrl: (state) =>
      `https://open.weixin.qq.com/connect/oauth2/authorize?state=${encodeURIComponent(state)}`,
    async verifyCallback(input) {
      seen.push(input);
      return {
        channel: "wechat",
        subject: "openid_private_subject_12345",
        verified: true,
      };
    },
  };
  const db = openDatabase(":memory:");
  const app = new Hono() as Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>;
  createIdentity(db, config, () => now, adapter).attach(app);
  try {
    const authorize = await app.request(
      "/api/channels/wechat/authorize?roomId=demo-room",
    );
    assert.equal(authorize.status, 200);
    const body = (await authorize.json()) as any;
    const state = new URL(body.authorizationUrl).searchParams.get("state");
    const stateCookie = cookie(authorize, "studio_wechat_state");
    assert.ok(state && stateCookie);
    assert.ok(state.length <= 128);
    assert.equal(body.authorizationUrl.includes(secret), false);
    assert.equal(
      body.authorizationUrl.includes("wechat-identity-secret"),
      false,
    );

    const callbackPath = `/api/channels/wechat/callback?code=valid-code&state=${encodeURIComponent(state)}`;
    const callback = await app.request(callbackPath, {
      headers: { Cookie: stateCookie },
    });
    assert.equal(callback.status, 302);
    assert.equal(
      callback.headers.get("location"),
      "/studio/watch/demo-room?channel=wechat",
    );
    const viewerCookie = cookie(callback, "studio_viewer");
    assert.ok(viewerCookie);
    assert.equal(viewerCookie.includes("openid_private_subject_12345"), false);
    assert.equal(seen.length, 1);

    const session = await app.request("/api/auth/viewer", {
      method: "POST",
      headers: {
        Cookie: viewerCookie,
        Origin: config.appOrigin,
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    const sessionBody = (await session.json()) as any;
    assert.equal(sessionBody.identity, "wechat");
    assert.equal(sessionBody.channel, "wechat");
    assert.equal(sessionBody.verified, true);
    assert.equal(sessionBody.canReceiveRealMoney, false);
    assert.match(sessionBody.viewerId, /^wechat_[a-zA-Z0-9_-]{32}$/);

    const replay = await app.request(callbackPath, {
      headers: { Cookie: stateCookie },
    });
    assert.equal(replay.status, 400);
    assert.equal(seen.length, 1);

    const expiring = await app.request(
      "/api/channels/wechat/authorize?roomId=demo-room",
    );
    const expiringBody = (await expiring.json()) as any;
    const expiringState = new URL(
      expiringBody.authorizationUrl,
    ).searchParams.get("state");
    assert.ok(expiringState);
    now += 10 * 60 * 1000 + 1;
    const expired = await app.request(
      `/api/channels/wechat/callback?code=late&state=${encodeURIComponent(expiringState)}`,
      { headers: { Cookie: cookie(expiring, "studio_wechat_state")! } },
    );
    assert.equal(expired.status, 400);
    assert.equal(seen.length, 1);
  } finally {
    db.close();
  }
});

test("HTTP adapter fixes the WeChat endpoint, bounds output and hides upstream details", async () => {
  const config = loadConfig(oauthEnvironment);
  let requested: URL | undefined;
  const adapter = new HttpWeChatOAuthAdapter(config, async (input) => {
    requested = new URL(input.toString());
    return new Response(
      JSON.stringify({
        access_token: "access-token-must-not-return",
        expires_in: 7200,
        openid: "openid_private_subject_12345",
        scope: "snsapi_base",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  });
  const url = adapter.createAuthorizationUrl("signed-state");
  assert.ok(url.startsWith("https://open.weixin.qq.com/"));
  assert.ok(url.endsWith("#wechat_redirect"));
  assert.equal(url.includes(secret), false);
  const identity = await adapter.verifyCallback({
    code: "valid-code",
    state: "signed-state",
  });
  assert.deepEqual(identity, {
    channel: "wechat",
    subject: "openid_private_subject_12345",
    verified: true,
  });
  assert.equal(requested?.origin, "https://api.weixin.qq.com");
  assert.equal(requested?.pathname, "/sns/oauth2/access_token");
  assert.equal(requested?.searchParams.get("appid"), "wx1234567890abcdef");
  assert.equal(requested?.searchParams.get("secret"), secret);
  assert.equal(requested?.searchParams.get("code"), "valid-code");

  const failed = new HttpWeChatOAuthAdapter(config, async () =>
    Response.json(
      { errcode: 40029, errmsg: "invalid code with upstream details" },
      { status: 200 },
    ),
  );
  await assert.rejects(
    () => failed.verifyCallback({ code: "bad", state: "state" }),
    (error: Error) =>
      error.message === "WeChat OAuth exchange failed" &&
      !error.message.includes("upstream details"),
  );
});

test("callback failure is generic, creates no viewer session and consumes state", async () => {
  const config = loadConfig(oauthEnvironment);
  const adapter: WeChatOAuthPort = {
    configured: true,
    createAuthorizationUrl: (state) =>
      `https://open.weixin.qq.com/connect/oauth2/authorize?state=${encodeURIComponent(state)}`,
    async verifyCallback() {
      throw new Error("upstream access token and private diagnostic");
    },
  };
  const db = openDatabase(":memory:");
  const app = new Hono() as Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>;
  createIdentity(db, config, Date.now, adapter).attach(app);
  try {
    const authorize = await app.request(
      "/api/channels/wechat/authorize?roomId=demo-room",
    );
    const authorizationUrl = ((await authorize.json()) as any).authorizationUrl;
    const state = new URL(authorizationUrl).searchParams.get("state");
    assert.ok(state);
    const path = `/api/channels/wechat/callback?code=failed&state=${encodeURIComponent(state)}`;
    const headers = {
      Cookie: cookie(authorize, "studio_wechat_state")!,
    };
    const failed = await app.request(path, { headers });
    assert.equal(failed.status, 502);
    const body = JSON.stringify(await failed.json());
    assert.ok(body.includes("微信身份服务暂时不可用"));
    assert.equal(body.includes("private diagnostic"), false);
    assert.equal(cookie(failed, "studio_viewer"), undefined);
    assert.equal((await app.request(path, { headers })).status, 400);
  } finally {
    db.close();
  }
});
