import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import test from "node:test";
import {
  createPaymentProviderRegistry,
  loadPaymentProviderRegistry,
  type PaymentProvider,
} from "../src/modules/payments/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";

const noNetworkProvider: PaymentProvider = {
  async createTransfer() {
    throw new Error("not called");
  },
  async queryTransfer() {
    throw new Error("not called");
  },
  async verifyAndDecodeNotification() {
    throw new Error("not called");
  },
};

test("private multi-merchant configuration builds an exact tenant and serial registry", () => {
  const root = mkdtempSync(join(tmpdir(), "payment-registry-"));
  try {
    const merchant = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const wechat = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privatePath = join(root, "merchant.pem");
    const publicPath = join(root, "wechat.pem");
    const configPath = join(root, "payments.json");
    writeFileSync(
      privatePath,
      merchant.privateKey.export({ type: "pkcs8", format: "pem" }),
      { mode: 0o600 },
    );
    writeFileSync(
      publicPath,
      wechat.publicKey.export({ type: "spki", format: "pem" }),
      { mode: 0o600 },
    );
    writeFileSync(
      configPath,
      JSON.stringify({
        merchants: [
          {
            merchantId: "owner",
            appId: "wx1234567890abcdef",
            mchId: "1234567890",
            apiV3Key: "0123456789abcdef0123456789abcdef",
            merchantSerialNo: "AABBCCDD",
            merchantPrivateKeyPath: privatePath,
            wechatPaySerial: "PUB_KEY_ID_1",
            wechatPayPublicKeyPath: publicPath,
            transferSceneId: "1000",
            notifyUrl: "https://studio.example.test/api/payments/wechat/notify",
            transferRemark: "直播互动红包",
            sceneReportInfos: [
              { infoType: "活动名称", infoContent: "直播互动" },
            ],
            userReceiveStyle: "RED_PACKET",
          },
        ],
      }),
      { mode: 0o600 },
    );
    const registry = loadPaymentProviderRegistry(
      configPath,
      true,
      "wx1234567890abcdef",
    );
    assert.equal(registry.enabled, true);
    assert.ok(registry.providerFor("owner"));
    assert.equal(registry.providerFor("foreign"), null);
    assert.deepEqual(registry.clientConfigFor("owner"), {
      appId: "wx1234567890abcdef",
      mchId: "1234567890",
    });

    chmodSync(configPath, 0o644);
    assert.throws(() =>
      loadPaymentProviderRegistry(configPath, true, "wx1234567890abcdef"),
    );
    assert.throws(() =>
      loadPaymentProviderRegistry("payments.json", false, "wx1234567890abcdef"),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("registry and application configuration reject ambiguous payment routing", () => {
  assert.throws(() =>
    createPaymentProviderRegistry([
      {
        merchantId: "one",
        wechatPaySerial: "SERIAL",
        clientConfig: { appId: "wx1234567890abcdef", mchId: "123456" },
        provider: noNetworkProvider,
      },
      {
        merchantId: "two",
        wechatPaySerial: "SERIAL",
        clientConfig: { appId: "wx1234567890abcdef", mchId: "654321" },
        provider: noNetworkProvider,
      },
    ]),
  );
  const complete = {
    DEMO_MODE: "false",
    PAYMENT_PROVIDER: "wechat",
    APP_ORIGIN: "https://studio.example.test",
    SESSION_SECRET: "payment-config-session-secret-0123456789",
    WECHAT_OAUTH_ENABLED: "true",
    WECHAT_APP_ID: "wx1234567890abcdef",
    WECHAT_APP_SECRET: "wechat-app-secret-0123456789abcdef",
    WECHAT_IDENTITY_SECRET: "wechat-identity-secret-0123456789abcdef",
    WECHAT_OAUTH_REDIRECT_URI:
      "https://studio.example.test/api/channels/wechat/callback",
    WECHAT_TRANSFER_CONFIG_PATH: "/private/payments.json",
    WECHAT_RECIPIENT_ENCRYPTION_KEY: "22".repeat(32),
  };
  assert.throws(() => loadConfig(complete));
  const valid = loadConfig({ ...complete, WECHAT_JS_SDK_ENABLED: "true" });
  assert.equal(valid.paymentProvider, "wechat");
  assert.equal(valid.wechatTransferConfigPath, "/private/payments.json");
});
