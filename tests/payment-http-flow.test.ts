import assert from "node:assert/strict";
import test from "node:test";
import { createStudio } from "../src/composition/studio.js";
import {
  createPaymentProviderRegistry,
  type PaymentProvider,
} from "../src/modules/payments/public.js";
import type { WeChatOAuthPort } from "../src/platform/adapters/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";

const ownerToken = "owner-payment-test-token-123456789";
const oauthEnvironment = {
  DEMO_MODE: "false",
  SESSION_SECRET: "payment-http-session-secret-0123456789",
  MERCHANT_CREDENTIALS: JSON.stringify({ owner: ownerToken }),
  APP_ORIGIN: "https://studio.example.test",
  PAYMENT_PROVIDER: "wechat",
  WECHAT_OAUTH_ENABLED: "true",
  WECHAT_JS_SDK_ENABLED: "true",
  WECHAT_APP_ID: "wx1234567890abcdef",
  WECHAT_APP_SECRET: "wechat-app-secret-0123456789abcdef",
  WECHAT_IDENTITY_SECRET: "wechat-identity-secret-0123456789abcdef",
  WECHAT_OAUTH_REDIRECT_URI:
    "https://studio.example.test/api/channels/wechat/callback",
  WECHAT_TRANSFER_CONFIG_PATH:
    "/private/not-read-when-registry-is-injected.json",
  WECHAT_RECIPIENT_ENCRYPTION_KEY: "11".repeat(32),
};

function cookie(response: Response, name: string) {
  return (
    response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .find((value) => value.startsWith(`${name}=`)) || ""
  );
}

test("verified viewer authorization drives one durable WeChat transfer and terminal ledger entry", async (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  let now = 1_800_000_000_000;
  let creates = 0;
  let queries = 0;
  const provider: PaymentProvider = {
    async createTransfer(request) {
      creates++;
      return {
        outBillNo: request.outBillNo,
        state: "pending",
        providerId: "wx-transfer-1",
      };
    },
    async queryTransfer(_merchantId, outBillNo) {
      queries++;
      return {
        outBillNo,
        state: "paid",
        providerId: "wx-transfer-1",
      };
    },
    async verifyAndDecodeNotification() {
      const transfer = db
        .prepare(
          "SELECT out_bill_no AS outBillNo,amount_cents AS amountCents FROM payment_transfers",
        )
        .get() as { outBillNo: string; amountCents: number };
      return {
        eventId: "notification-1",
        merchantId: "owner",
        amountCents: transfer.amountCents,
        verifiedRecipientId: "openid_verified_recipient_123",
        receipt: {
          outBillNo: transfer.outBillNo,
          state: "paid",
          providerId: "wx-transfer-1",
        },
      };
    },
  };
  const registry = createPaymentProviderRegistry([
    {
      merchantId: "owner",
      wechatPaySerial: "SERIAL1234",
      provider,
      clientConfig: {
        appId: "wx1234567890abcdef",
        mchId: "1234567890",
      },
    },
  ]);
  const oauth: WeChatOAuthPort = {
    configured: true,
    createAuthorizationUrl: (state) =>
      `https://open.weixin.qq.com/connect/oauth2/authorize?state=${encodeURIComponent(state)}`,
    async verifyCallback() {
      return {
        channel: "wechat",
        verified: true,
        subject: "openid_verified_recipient_123",
      };
    },
  };
  const studio = createStudio(
    db,
    loadConfig(oauthEnvironment),
    () => now,
    undefined,
    registry,
    oauth,
  );
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    requestCookie = "",
    headers: Record<string, string> = {},
  ) =>
    studio.app.request("/api" + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(requestCookie ? { cookie: requestCookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const login = await request("/auth/merchant", "POST", {
    merchantId: "owner",
    token: ownerToken,
  });
  const merchantCookie = cookie(login, "studio_merchant");
  assert.ok(merchantCookie);
  const createRoom = await request(
    "/merchant/rooms",
    "POST",
    { title: "微信转账验收直播", productName: "测试商品" },
    merchantCookie,
  );
  const roomId = ((await createRoom.json()) as any).room.id as string;
  assert.equal(
    (
      await request(
        `/merchant/rooms/${roomId}`,
        "PATCH",
        { status: "live" },
        merchantCookie,
      )
    ).status,
    200,
  );
  const campaignResponse = await request(
    `/merchant/rooms/${roomId}/campaigns`,
    "POST",
    {
      totalCents: 100,
      count: 1,
      minWatchSeconds: 0,
      delaySeconds: 0,
      durationSeconds: 600,
    },
    merchantCookie,
  );
  assert.equal(campaignResponse.status, 201);
  const campaign = ((await campaignResponse.json()) as any).campaign;
  assert.equal(campaign.mode, "wechat");
  assert.equal(
    ((await (await request(`/public/rooms/${roomId}`)).json()) as any)
      .paymentMode,
    "wechat",
  );

  const authorize = await request(
    `/channels/wechat/authorize?roomId=${roomId}`,
  );
  const stateCookie = cookie(authorize, "studio_wechat_state");
  const state = new URL(
    ((await authorize.json()) as any).authorizationUrl,
  ).searchParams.get("state")!;
  const callback = await request(
    `/channels/wechat/callback?code=verified&state=${encodeURIComponent(state)}`,
    "GET",
    undefined,
    stateCookie,
  );
  assert.equal(callback.status, 302);
  const viewerCookie = cookie(callback, "studio_viewer");
  assert.ok(viewerCookie);
  assert.deepEqual(
    await (
      await request(
        `/viewer/rooms/${roomId}/payment-recipient`,
        "GET",
        undefined,
        viewerCookie,
      )
    ).json(),
    {
      configured: true,
      identity: "wechat",
      authorized: false,
      authorizedAt: null,
      staged: true,
    },
  );
  await request(
    `/viewer/rooms/${roomId}/heartbeat`,
    "POST",
    { visible: true, playing: true },
    viewerCookie,
  );
  const rejected = await request(
    `/viewer/campaigns/${campaign.id}/claim`,
    "POST",
    {},
    viewerCookie,
  );
  assert.equal(rejected.status, 403);
  assert.equal(db.prepare("SELECT count(*) AS n FROM claims").get()!.n, 0);
  assert.equal(
    db.prepare("SELECT remaining_cents FROM campaigns").get()!.remaining_cents,
    100,
  );

  const recipientAuthorization = await request(
    `/viewer/rooms/${roomId}/payment-recipient/authorize`,
    "POST",
    {},
    viewerCookie,
  );
  assert.equal(recipientAuthorization.status, 200);
  assert.deepEqual(await recipientAuthorization.json(), {
    configured: true,
    authorized: true,
    replayed: false,
  });
  const claimResponse = await request(
    `/viewer/campaigns/${campaign.id}/claim`,
    "POST",
    {},
    viewerCookie,
  );
  assert.equal(claimResponse.status, 200);
  const claimBody = (await claimResponse.json()) as any;
  assert.equal(claimBody.paymentMode, "wechat");
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM payment_transfers").get()!.n,
    1,
  );
  assert.equal(db.prepare("SELECT count(*) AS n FROM payout_jobs").get()!.n, 0);

  assert.deepEqual(await studio.processTransferJobs(), {
    examined: 1,
    advanced: 1,
    deferred: 0,
    reconciled: 0,
  });
  assert.equal(creates, 1);
  now += 31_000;
  assert.deepEqual(await studio.processTransferJobs(), {
    examined: 1,
    advanced: 1,
    deferred: 0,
    reconciled: 1,
  });
  assert.equal(creates, 1);
  assert.equal(queries, 1);
  assert.equal(
    db.prepare("SELECT state FROM payment_transfers").get()!.state,
    "paid",
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM ledger WHERE credit='wechat_settled'")
      .get()!.n,
    1,
  );

  const ownTransfer = await request(
    `/viewer/claims/${claimBody.claim.id}/transfer`,
    "GET",
    undefined,
    viewerCookie,
  );
  assert.equal(ownTransfer.status, 200);
  assert.equal(((await ownTransfer.json()) as any).transfer.state, "paid");
  const anonymousViewer = await request("/auth/viewer", "POST", {});
  assert.equal(
    (
      await request(
        `/viewer/claims/${claimBody.claim.id}/transfer`,
        "GET",
        undefined,
        cookie(anonymousViewer, "studio_viewer"),
      )
    ).status,
    404,
  );

  for (let attempt = 0; attempt < 2; attempt++) {
    const notification = await request(
      "/payments/wechat/notify",
      "POST",
      { id: "notification-1" },
      "",
      { "Wechatpay-Serial": "SERIAL1234" },
    );
    assert.equal(notification.status, 200);
  }
  assert.equal(
    db.prepare("SELECT count(*) AS n FROM payment_notification_receipts").get()!
      .n,
    1,
  );
  assert.equal(
    db
      .prepare("SELECT count(*) AS n FROM ledger WHERE credit='wechat_settled'")
      .get()!.n,
    1,
  );

  const revoke = await request(
    `/viewer/rooms/${roomId}/payment-recipient/revoke`,
    "POST",
    {},
    viewerCookie,
  );
  assert.equal(revoke.status, 200);
  assert.equal(
    (
      (await (
        await request(
          `/viewer/rooms/${roomId}/payment-recipient`,
          "GET",
          undefined,
          viewerCookie,
        )
      ).json()) as any
    ).authorized,
    false,
  );
});
