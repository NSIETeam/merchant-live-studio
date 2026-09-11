import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import {
  HttpWeChatJsSdkAdapter,
  type WeChatJsSdkPort,
} from "../src/platform/adapters/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { attachWeChatSharing } from "../src/platform/operations/public.js";

const baseEnvironment = {
  DEMO_MODE: "true",
  APP_ORIGIN: "https://studio.example.test",
  APP_BASE_PATH: "/studio/",
  WECHAT_OAUTH_ENABLED: "true",
  WECHAT_APP_ID: "wx1234567890abcdef",
  WECHAT_APP_SECRET: "wechat-app-secret-0123456789abcdef",
  WECHAT_IDENTITY_SECRET: "wechat-identity-secret-0123456789abcdef",
  WECHAT_OAUTH_REDIRECT_URI:
    "https://studio.example.test/studio/api/channels/wechat/callback",
};

test("WeChat signed sharing is explicit and fails closed", async () => {
  assert.throws(() =>
    loadConfig({ DEMO_MODE: "true", WECHAT_JS_SDK_ENABLED: "true" }),
  );
  const disabled = loadConfig(baseEnvironment);
  assert.equal(disabled.wechatJsSdkEnabled, false);
  const enabled = loadConfig({
    ...baseEnvironment,
    WECHAT_JS_SDK_ENABLED: "true",
  });
  assert.equal(enabled.wechatJsSdkEnabled, true);

  const enabledDb = openDatabase(":memory:");
  try {
    const app = createApp(enabledDb, enabled);
    const channels = (await (await app.request("/api/channels")).json()) as any;
    const wechat = channels.channels.find(
      (channel: { channel: string }) => channel.channel === "wechat",
    );
    assert.equal(wechat.viewerEntry, "available");
    assert.equal(wechat.verifiedIdentity, true);
    assert.equal(wechat.signedSharing, true);
    assert.equal(wechat.realPayment, false);
  } finally {
    enabledDb.close();
  }

  const db = openDatabase(":memory:");
  try {
    const app = createApp(db, disabled);
    const channels = (await (await app.request("/api/channels")).json()) as any;
    assert.equal(
      channels.channels.find(
        (channel: { channel: string }) => channel.channel === "wechat",
      ).signedSharing,
      false,
    );
    const signature = await app.request(
      "/api/channels/wechat/share-signature?roomId=demo-room&url=https%3A%2F%2Fstudio.example.test%2Fstudio%2Fwatch%2Fdemo-room",
    );
    assert.equal(signature.status, 503);
  } finally {
    db.close();
  }
});

test("sharing route signs only the matching same-origin watch URL", async () => {
  const config = loadConfig({
    ...baseEnvironment,
    WECHAT_JS_SDK_ENABLED: "true",
  });
  const signed: string[] = [];
  const adapter: WeChatJsSdkPort = {
    configured: true,
    async signUrl(url) {
      signed.push(url);
      return {
        appId: "wx1234567890abcdef",
        timestamp: 1800000000,
        nonceStr: "0123456789abcdef0123456789abcdef",
        signature: "a".repeat(40),
        jsApiList: ["updateAppMessageShareData", "updateTimelineShareData"],
      };
    },
  };
  const app = new Hono() as Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>;
  attachWeChatSharing(app, config, adapter);
  const goodUrl =
    "https://studio.example.test/studio/watch/demo-room?source=campaign-a";
  const good = await app.request(
    `/api/channels/wechat/share-signature?roomId=demo-room&url=${encodeURIComponent(goodUrl)}`,
  );
  assert.equal(good.status, 200);
  assert.deepEqual(signed, [goodUrl]);
  assert.equal(good.headers.get("cache-control"), "no-store");

  for (const malformed of [
    "/api/channels/wechat/share-signature",
    "/api/channels/wechat/share-signature?roomId=bad%2Froom&url=not-a-url",
  ]) {
    const response = await app.request(malformed);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "直播间或分享地址格式不正确",
    });
  }

  for (const candidate of [
    "https://foreign.example.test/studio/watch/demo-room",
    "https://studio.example.test/studio/watch/other-room",
    "https://studio.example.test/studio/watch/demo-room#private-fragment",
    "https://user:password@studio.example.test/studio/watch/demo-room",
  ]) {
    const response = await app.request(
      `/api/channels/wechat/share-signature?roomId=demo-room&url=${encodeURIComponent(candidate)}`,
    );
    assert.equal(response.status, 400);
  }
  assert.equal(signed.length, 1);

  const failing = new Hono() as Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>;
  attachWeChatSharing(failing, config, {
    configured: true,
    async signUrl() {
      throw new Error("private access token and upstream diagnostic");
    },
  });
  const failed = await failing.request(
    `/api/channels/wechat/share-signature?roomId=demo-room&url=${encodeURIComponent(goodUrl)}`,
  );
  assert.equal(failed.status, 502);
  const failedBody = JSON.stringify(await failed.json());
  assert.ok(failedBody.includes("微信签名服务暂时不可用"));
  assert.equal(failedBody.includes("private access token"), false);
});

test("HTTP signer fixes upstream endpoints, deduplicates credentials and returns verifiable signatures", async () => {
  const config = loadConfig({
    ...baseEnvironment,
    WECHAT_JS_SDK_ENABLED: "true",
  });
  const requests: URL[] = [];
  const adapter = new HttpWeChatJsSdkAdapter(
    config,
    async (input) => {
      const url = new URL(input.toString());
      requests.push(url);
      if (url.pathname === "/cgi-bin/token")
        return Response.json({
          access_token: "private-access-token-12345",
          expires_in: 7200,
        });
      if (url.pathname === "/cgi-bin/ticket/getticket")
        return Response.json({
          errcode: 0,
          errmsg: "ok",
          ticket: "private-jsapi-ticket-12345",
          expires_in: 7200,
        });
      return Response.json({ errcode: -1 }, { status: 500 });
    },
    () => 1_800_000_000_000,
  );
  const url = "https://studio.example.test/studio/watch/demo-room?source=a";
  const [first, second] = await Promise.all([
    adapter.signUrl(url),
    adapter.signUrl(url),
  ]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].origin, "https://api.weixin.qq.com");
  assert.equal(requests[0].pathname, "/cgi-bin/token");
  assert.equal(requests[0].searchParams.get("grant_type"), "client_credential");
  assert.equal(
    requests[0].searchParams.get("appid"),
    config.wechatOAuth?.appId,
  );
  assert.equal(
    requests[0].searchParams.get("secret"),
    config.wechatOAuth?.appSecret,
  );
  assert.equal(requests[1].pathname, "/cgi-bin/ticket/getticket");
  assert.equal(requests[1].searchParams.get("type"), "jsapi");
  assert.equal(
    requests[1].searchParams.get("access_token"),
    "private-access-token-12345",
  );
  for (const result of [first, second]) {
    assert.equal(result.appId, "wx1234567890abcdef");
    assert.equal(result.timestamp, 1_800_000_000);
    assert.match(result.nonceStr, /^[a-f0-9]{32}$/);
    assert.equal(
      result.signature,
      createHash("sha1")
        .update(
          `jsapi_ticket=private-jsapi-ticket-12345&noncestr=${result.nonceStr}&timestamp=${result.timestamp}&url=${url}`,
        )
        .digest("hex"),
    );
    const publicBody = JSON.stringify(result);
    assert.equal(publicBody.includes("private-access-token"), false);
    assert.equal(publicBody.includes("private-jsapi-ticket"), false);
    assert.equal(publicBody.includes("wechat-app-secret"), false);
  }
});

test("upstream errors are normalized and never cached as success", async () => {
  const config = loadConfig({
    ...baseEnvironment,
    WECHAT_JS_SDK_ENABLED: "true",
  });
  let calls = 0;
  const adapter = new HttpWeChatJsSdkAdapter(config, async () => {
    calls++;
    return Response.json({
      errcode: 40013,
      errmsg: "invalid appid private upstream detail",
    });
  });
  await assert.rejects(
    () => adapter.signUrl("https://studio.example.test/studio/watch/demo-room"),
    (error: Error) =>
      !error.message.includes("private upstream detail") &&
      !error.message.includes(config.wechatOAuth!.appSecret),
  );
  await assert.rejects(() =>
    adapter.signUrl("https://studio.example.test/studio/watch/demo-room"),
  );
  assert.equal(calls, 2);
});
