import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";

const valid = {
  operatorName: "合成测试平台运营企业",
  creditCode: "91310100MA12345678",
  address: "合成测试经营地址，仅用于软件验收",
  contact: "测试公开联系 00000000",
  complaintContact: "测试投诉联系 00000001",
  privacyContact: "测试隐私联系 privacy@example.test",
  effectiveDate: "2026-09-11",
  privacyPolicyUrl: "https://example.test/privacy",
  serviceTermsUrl: "https://example.test/terms",
};

test("platform compliance is public, explicit when missing, and strictly configured", async () => {
  const missingDb = openDatabase(":memory:");
  try {
    const app = createApp(missingDb, loadConfig({ DEMO_MODE: "true" }));
    const response = await app.request("/api/platform/compliance");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as any;
    assert.equal(body.configured, false);
    assert.equal(body.data, null);
    assert.ok(body.dataPractices.length >= 4);
    assert.equal(
      ((await (await app.request("/api/health")).json()) as any)
        .platformCompliance,
      false,
    );
  } finally {
    missingDb.close();
  }

  const db = openDatabase(":memory:");
  try {
    const app = createApp(
      db,
      loadConfig({
        DEMO_MODE: "true",
        PLATFORM_COMPLIANCE: JSON.stringify(valid),
      }),
    );
    const response = await app.request("/api/platform/compliance");
    const body = (await response.json()) as any;
    assert.equal(body.configured, true);
    assert.deepEqual(body.data, valid);
    assert.equal(JSON.stringify(body).includes("SESSION_SECRET"), false);
    assert.equal(
      ((await (await app.request("/api/health")).json()) as any)
        .platformCompliance,
      true,
    );
  } finally {
    db.close();
  }

  for (const changed of [
    { ...valid, creditCode: "invalid" },
    { ...valid, effectiveDate: "2026-02-30" },
    { ...valid, privacyPolicyUrl: "http://example.test/privacy" },
    { ...valid, extra: "not-allowed" },
  ])
    assert.throws(() =>
      loadConfig({
        DEMO_MODE: "true",
        PLATFORM_COMPLIANCE: JSON.stringify(changed),
      }),
    );
  assert.doesNotThrow(() =>
    loadConfig({
      DEMO_MODE: "true",
      PLATFORM_COMPLIANCE: JSON.stringify({
        ...valid,
        privacyPolicyUrl: "http://127.0.0.1:18968/privacy",
        serviceTermsUrl: "http://localhost:18968/terms",
      }),
    }),
  );
});
