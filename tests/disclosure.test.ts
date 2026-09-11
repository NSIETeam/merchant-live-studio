import test from "node:test";
import assert from "node:assert/strict";
import {
  disclosureDeadline,
  disclosureInDate,
} from "../src/shared/disclosure.js";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
test("public disclosure requires independent review, isolates drafts and revokes without deleting history", async () => {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const token = "disclosure-local-test-key-long-enough";
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "disclosure-test-session-secret-long-enough",
      MERCHANT_CREDENTIALS: JSON.stringify({
        editor: token,
        reviewer: token,
        other: token,
      }),
      MERCHANT_MEMBERSHIPS: JSON.stringify({
        editor: { merchantId: "demo", role: "editor" },
        reviewer: { merchantId: "demo", role: "reviewer" },
      }),
    }),
  );
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const r = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      data: (await r.json()) as any,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const login = async (merchantId: string) =>
    (await call("/auth/merchant", "POST", { merchantId, token })).cookie;
  try {
    const owner = (await call("/auth/demo", "POST", {})).cookie,
      editor = await login("editor"),
      reviewer = await login("reviewer"),
      other = await login("other");
    const base = "/merchant/disclosure",
      pub = "/public/rooms/demo-room/disclosure";
    const business = {
      name: "合成测试企业",
      creditCode: "91310100MA12345678",
      address: "合成测试地址仅供验收",
      contact: "测试联系 00000000",
      licenses: "合成许可说明，不用于真实经营",
    };
    const draft = {
      previousVersion: 0,
      data: {
        operator: business,
        seller: business,
        validThrough: "2099-12-31",
        complaintContact: "测试售后服务联系方式",
      },
      evidenceReference: "private-evidence-only",
    };
    assert.equal((await call(pub)).data.disclosure, null);
    assert.equal((await call(base, "POST", draft)).status, 401);
    assert.equal((await call(base, "POST", draft, reviewer)).status, 403);
    assert.equal((await call(base, "POST", draft, owner)).status, 201);
    const approval = {
      action: "publish",
      note: "已核对合成资料，仅验证软件流程。",
      acknowledged: true,
    };
    assert.equal(
      (await call(base + "/1/review", "POST", approval, owner)).status,
      403,
    );
    assert.equal(
      (await call(base + "/1/review", "POST", approval, other)).status,
      409,
    );
    assert.equal(
      (await call(base + "/1/review", "POST", approval, editor)).status,
      403,
    );
    assert.equal((await call(pub)).data.disclosure, null);
    assert.equal(
      (await call(base + "/1/review", "POST", approval, reviewer)).status,
      200,
    );
    const published = await call(pub);
    assert.equal(published.data.disclosure.version, 1);
    assert.equal(
      JSON.stringify(published.data).includes("private-evidence-only"),
      false,
    );
    assert.equal(JSON.stringify(published.data).includes("authorId"), false);
    assert.equal((await call(base, "POST", draft, editor)).status, 409);
    assert.equal(
      (await call(base, "POST", { ...draft, previousVersion: 1 }, editor))
        .status,
      201,
    );
    assert.equal((await call(pub)).data.disclosure.version, 1);
    assert.equal(
      (await call(base + "/1/review", "POST", approval, reviewer)).status,
      409,
    );
    assert.equal(
      (await call(base + "/2/review", "POST", approval, reviewer)).status,
      200,
    );
    assert.equal(
      (
        await call(
          base + "/1/review",
          "POST",
          { ...approval, action: "withdraw" },
          reviewer,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          base + "/2/review",
          "POST",
          { ...approval, action: "withdraw" },
          reviewer,
        )
      ).status,
      200,
    );
    assert.equal((await call(pub)).data.disclosure, null);
    assert.equal(
      (await call(base + "/2/review", "POST", approval, reviewer)).status,
      409,
    );
    assert.equal((await call(base, "GET", undefined, other)).data.latest, null);
    assert.throws(() => db.exec("DELETE FROM disclosure_versions"));
    assert.throws(() => db.exec("UPDATE disclosure_events SET note='fake'"));
    assert.equal(
      (await call(base, "GET", undefined, reviewer)).data.events.length,
      3,
    );
    const expired = {
      ...draft,
      previousVersion: 2,
      data: { ...draft.data, validThrough: "2000-01-01" },
    };
    assert.equal((await call(base, "POST", expired, owner)).status, 201);
    assert.equal(
      (await call(base + "/3/review", "POST", approval, reviewer)).status,
      409,
    );
  } finally {
    db.close();
  }
});

test("disclosure dates reject missing and invalid dates and expire at Beijing midnight", () => {
  for (const value of [undefined, "", "2026-02-29", "2026-13-01", "2026-9-1"])
    assert.equal(disclosureDeadline(value), null);
  assert.equal(disclosureInDate({}), false);
  assert.notEqual(disclosureDeadline("2028-02-29"), null);
  const boundary = Date.parse("2026-09-11T16:00:00Z");
  assert.equal(
    disclosureInDate({ validThrough: "2026-09-11" }, boundary - 1),
    true,
  );
  assert.equal(
    disclosureInDate({ validThrough: "2026-09-11" }, boundary),
    false,
  );
});
