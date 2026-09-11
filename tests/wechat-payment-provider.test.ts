import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  WeChatPaymentProvider,
  type WeChatTransferConfig,
} from "../src/modules/payments/public.js";

const merchantKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const platformKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = (key: typeof merchantKeys.privateKey) =>
  key.export({ type: "pkcs8", format: "pem" }).toString();
const publicPem = (key: typeof merchantKeys.publicKey) =>
  key.export({ type: "spki", format: "pem" }).toString();

const config: WeChatTransferConfig = {
  merchantId: "demo",
  appId: "wx1234567890abcdef",
  mchId: "1900000001",
  apiV3Key: "12345678901234567890123456789012",
  merchantSerialNo: "A1B2C3D4E5F60708",
  merchantPrivateKeyPem: privatePem(merchantKeys.privateKey),
  wechatPaySerial: "PUB_KEY_ID_3000000001",
  wechatPayPublicKeyPem: publicPem(platformKeys.publicKey),
  transferSceneId: "1000",
  notifyUrl: "https://studio.example.com/studio/api/payments/wechat/notify",
  transferRemark: "直播互动奖励",
  sceneReportInfos: [
    { infoType: "活动名称", infoContent: "直播互动活动" },
    { infoType: "奖励说明", infoContent: "观看达标随机奖励" },
  ],
  userReceiveStyle: "RED_PACKET",
};

function signedHeaders(body: string, nonce = "responseNonce01") {
  const timestamp = "1800000000";
  const signature = sign(
    "RSA-SHA256",
    Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
    platformKeys.privateKey,
  ).toString("base64");
  return {
    "Wechatpay-Serial": config.wechatPaySerial,
    "Wechatpay-Signature": signature,
    "Wechatpay-Timestamp": timestamp,
    "Wechatpay-Nonce": nonce,
  };
}

function parseAuthorization(value: string) {
  const attributes = Object.fromEntries(
    [...value.matchAll(/([a-z_]+)="([^"]+)"/g)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  return attributes;
}

test("WeChat provider signs a fixed transfer request and verifies the response", async () => {
  const requests: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    requests.push({ url: String(url), init: init! });
    const body = JSON.stringify({
      out_bill_no: "Bill202609120001",
      transfer_bill_no: "WeChatTransfer01",
      state: "WAIT_USER_CONFIRM",
      package_info: "affffddafdfafddffda==",
    });
    return new Response(body, { status: 200, headers: signedHeaders(body) });
  }) as typeof fetch;
  const provider = new WeChatPaymentProvider(
    config,
    fetchImpl,
    () => 1_800_000_000_000,
    () => "requestNonce001",
  );
  const receipt = await provider.createTransfer({
    merchantId: "demo",
    outBillNo: "Bill202609120001",
    amountCents: 188,
    verifiedRecipientId: "oExample_OpenId-001",
  });
  assert.deepEqual(receipt, {
    outBillNo: "Bill202609120001",
    state: "wait_user_confirm",
    providerId: "WeChatTransfer01",
    confirmationPackage: "affffddafdfafddffda==",
  });
  assert.equal(
    requests[0].url,
    "https://api.mch.weixin.qq.com/v3/fund-app/mch-transfer/transfer-bills",
  );
  const requestBody = String(requests[0].init.body);
  const parsedBody = JSON.parse(requestBody);
  assert.equal(parsedBody.appid, config.appId);
  assert.equal(parsedBody.openid, "oExample_OpenId-001");
  assert.equal(parsedBody.transfer_amount, 188);
  assert.equal(parsedBody.user_recv_style.type, "RED_PACKET");
  const authorization = parseAuthorization(
    (requests[0].init.headers as Record<string, string>).Authorization,
  );
  assert.equal(authorization.mchid, config.mchId);
  assert.equal(authorization.serial_no, config.merchantSerialNo);
  assert.equal(authorization.timestamp, "1800000000");
  assert.equal(authorization.nonce_str, "requestNonce001");
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(
        `POST\n/v3/fund-app/mch-transfer/transfer-bills\n1800000000\nrequestNonce001\n${requestBody}\n`,
      ),
      merchantKeys.publicKey,
      Buffer.from(authorization.signature, "base64"),
    ),
    true,
  );
});

test("WeChat provider queries the original bill and rejects mismatched or unsigned results", async () => {
  let mode: "valid" | "wrong-bill" | "bad-signature" = "valid";
  const fetchImpl = (async (
    url: string | URL | Request,
    init?: RequestInit,
  ) => {
    assert.equal(init?.method, "GET");
    assert.match(String(url), /out-bill-no\/Bill202609120001$/);
    const body = JSON.stringify({
      out_bill_no:
        mode === "wrong-bill" ? "Bill202609120002" : "Bill202609120001",
      transfer_bill_no: "WeChatTransfer01",
      state: "SUCCESS",
    });
    const headers = signedHeaders(body);
    if (mode === "bad-signature") headers["Wechatpay-Signature"] = "invalid";
    return new Response(body, { status: 200, headers });
  }) as typeof fetch;
  const provider = new WeChatPaymentProvider(
    config,
    fetchImpl,
    () => 1_800_000_000_000,
  );
  assert.equal(
    (await provider.queryTransfer("demo", "Bill202609120001")).state,
    "paid",
  );
  mode = "wrong-bill";
  await assert.rejects(provider.queryTransfer("demo", "Bill202609120001"));
  mode = "bad-signature";
  await assert.rejects(provider.queryTransfer("demo", "Bill202609120001"));
  await assert.rejects(provider.queryTransfer("other", "Bill202609120001"));
  await assert.rejects(provider.queryTransfer("demo", "bad-bill"));
});

function encryptedNotification(
  resource: Record<string, unknown>,
  eventId = "EV-202609120001",
) {
  const nonce = "0123456789ab";
  const associatedData = "mch_payment";
  const cipher = createCipheriv(
    "aes-256-gcm",
    Buffer.from(config.apiV3Key),
    Buffer.from(nonce),
  );
  cipher.setAAD(Buffer.from(associatedData));
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(resource)),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString("base64");
  const body = JSON.stringify({
    id: eventId,
    create_time: "2026-09-12T08:00:00+08:00",
    resource_type: "encrypt-resource",
    event_type: "MCHTRANSFER.BILL.FINISHED",
    summary: "商家转账单据终态通知",
    resource: {
      original_type: "mch_payment",
      algorithm: "AEAD_AES_256_GCM",
      ciphertext: encrypted,
      associated_data: associatedData,
      nonce,
    },
  });
  return { body, headers: signedHeaders(body, "notificationNonce01") };
}

test("WeChat provider verifies and decrypts only matching terminal notifications", async () => {
  const base = {
    out_bill_no: "Bill202609120001",
    transfer_bill_no: "WeChatTransfer01",
    state: "SUCCESS",
    mch_id: config.mchId,
    transfer_amount: 188,
    openid: "oExample_OpenId-001",
    create_time: "2026-09-12T08:00:00+08:00",
    update_time: "2026-09-12T08:01:00+08:00",
  };
  const provider = new WeChatPaymentProvider(
    config,
    fetch,
    () => 1_800_000_000_000,
  );
  const notification = encryptedNotification(base);
  assert.deepEqual(
    await provider.verifyAndDecodeNotification(
      notification.headers,
      Buffer.from(notification.body),
    ),
    {
      eventId: "EV-202609120001",
      merchantId: "demo",
      amountCents: 188,
      verifiedRecipientId: "oExample_OpenId-001",
      receipt: {
        outBillNo: "Bill202609120001",
        providerId: "WeChatTransfer01",
        state: "paid",
      },
    },
  );
  const wrongMerchant = encryptedNotification({
    ...base,
    mch_id: "1900000002",
  });
  await assert.rejects(
    provider.verifyAndDecodeNotification(
      wrongMerchant.headers,
      Buffer.from(wrongMerchant.body),
    ),
  );
  const nonTerminal = encryptedNotification({ ...base, state: "PROCESSING" });
  await assert.rejects(
    provider.verifyAndDecodeNotification(
      nonTerminal.headers,
      Buffer.from(nonTerminal.body),
    ),
  );
  await assert.rejects(
    provider.verifyAndDecodeNotification(
      { ...notification.headers, "Wechatpay-Signature": "invalid" },
      Buffer.from(notification.body),
    ),
  );
  const staleProvider = new WeChatPaymentProvider(
    config,
    fetch,
    () => 1_800_000_301_000,
  );
  await assert.rejects(
    staleProvider.verifyAndDecodeNotification(
      notification.headers,
      Buffer.from(notification.body),
    ),
  );
});

test("WeChat provider remains fail-closed without complete valid configuration", async () => {
  const provider = new WeChatPaymentProvider();
  await assert.rejects(
    provider.createTransfer({
      merchantId: "demo",
      outBillNo: "Bill202609120001",
      amountCents: 1,
      verifiedRecipientId: "oExample",
    }),
  );
  assert.throws(
    () => new WeChatPaymentProvider({ ...config, apiV3Key: "too-short" }),
  );
  assert.throws(
    () =>
      new WeChatPaymentProvider({
        ...config,
        notifyUrl: "http://studio.example.com/wechat/notify",
      }),
  );
  assert.throws(
    () => new WeChatPaymentProvider({ ...config, sceneReportInfos: [] }),
  );
});
