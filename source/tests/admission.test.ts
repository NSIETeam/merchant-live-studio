import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { createAdmissionChecker } from "../src/modules/live/admission.js";

const platformCompliance = {
  operatorName: "合成测试平台运营企业",
  creditCode: "91310100MA12345678",
  address: "合成测试经营地址不用于经营",
  contact: "合成公开联系 00000000",
  complaintContact: "合成平台投诉联系 00000001",
  privacyContact: "合成隐私联系 privacy@example.test",
  effectiveDate: "2026-09-11",
  privacyPolicyUrl: "https://example.test/privacy",
  serviceTermsUrl: "https://example.test/terms",
};
const retentionPolicy = {
  effectiveDate: "2026-09-11",
  liveContentDays: 60,
  commerceRecordsMonths: 36,
  securityLogsMonths: 6,
  deletionReviewContact: "合成删除与争议保留联系 00000002",
};

test("production cannot disable reviewed live admission", () => {
  const config = loadConfig({
    NODE_ENV: "production",
    DEMO_MODE: "false",
    APP_ORIGIN: "https://example.test",
    SESSION_SECRET: "admission-production-test-session-secret",
    MERCHANT_CREDENTIALS: JSON.stringify({
      owner: "admission-production-test-owner-key",
    }),
    REQUIRE_REVIEWED_LIVE: "false",
  });
  assert.equal(config.requireReviewedLive, true);
  assert.equal(loadConfig({ DEMO_MODE: "true" }).requireReviewedLive, false);
});

test("reviewed admission exposes missing platform and retention configuration", () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db);
    const checker = createAdmissionChecker(
      db,
      loadConfig({ DEMO_MODE: "true", REQUIRE_REVIEWED_LIVE: "true" }),
      {
        disclosure: () => ({ published: true, version: 1, valid: true }),
        binding: () => null,
      },
    );
    const result = checker("demo-room", "demo", true);
    assert.equal(result.ready, false);
    assert.equal(
      result.checks.find((item) => item.code === "platform")?.passed,
      false,
    );
    assert.equal(
      result.checks.find((item) => item.code === "retention")?.passed,
      false,
    );
    assert.equal(result.basis.platformPolicyEffectiveDate, null);
    assert.equal(result.basis.retentionPolicyEffectiveDate, null);
  } finally {
    db.close();
  }
});

test("admission blocks missing or revoked basis, records successful starts, and rechecks publish after awaits", async () => {
  let control = "ok",
    race: (() => void) | undefined;
  const media = createServer((req, res) => {
    if (req.url === "/v3/info") {
      race?.();
      race = undefined;
      if (control === "ok") {
        res.setHeader("content-type", "application/json");
        res.end(
          JSON.stringify({
            version: "v1.21.0",
            started: new Date().toISOString(),
          }),
        );
      } else {
        res.statusCode = control === "missing" ? 404 : 500;
        res.end("{}");
      }
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  media.listen(0, "127.0.0.1");
  await once(media, "listening");
  const port = (media.address() as any).port;
  const db = openDatabase(":memory:");
  seedDemo(db);
  const token = "admission-test-credential-long-enough";
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "admission-test-session-secret-long-enough",
    REQUIRE_REVIEWED_LIVE: "true",
    STREAM_AUTH_SECRET: "local-callback-test",
    MEDIA_CONTROL_URL: `http://127.0.0.1:${port}`,
    MERCHANT_CREDENTIALS: JSON.stringify({
      reviewer: token,
      presenter: token,
      other: token,
    }),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      reviewer: { merchantId: "demo", role: "reviewer" },
      presenter: { merchantId: "demo", role: "presenter" },
    }),
    PLATFORM_COMPLIANCE: JSON.stringify(platformCompliance),
    DATA_RETENTION_POLICY: JSON.stringify(retentionPolicy),
  });
  let now = Date.now();
  const app = createApp(db, config, () => now);
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
      data: r.status === 204 ? null : ((await r.json()) as any),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  try {
    const owner = (await call("/auth/demo", "POST", {})).cookie,
      reviewer = (
        await call("/auth/merchant", "POST", { merchantId: "reviewer", token })
      ).cookie,
      presenter = (
        await call("/auth/merchant", "POST", {
          merchantId: "presenter",
          token,
        })
      ).cookie,
      other = (
        await call("/auth/merchant", "POST", { merchantId: "other", token })
      ).cookie;
    const room = "/merchant/rooms/demo-room",
      start = () => call(room, "PATCH", { status: "live" }, owner);
    assert.equal((await start()).status, 409);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM live_admissions").get()!.n,
      0,
    );
    const initial = (await call(room + "/admission", "GET", undefined, owner))
      .data;
    assert.equal(initial.enforced, true);
    assert.equal(initial.ready, false);
    assert.equal(
      initial.checks.find((item: any) => item.code === "media").passed,
      true,
    );
    assert.equal(
      (await call(room + "/admission", "GET", undefined, other)).status,
      404,
    );
    const reportResponse = await app.request(`/api${room}/admission-report`, {
      headers: { cookie: owner },
    });
    assert.equal(reportResponse.status, 200);
    assert.equal(reportResponse.headers.get("cache-control"), "no-store");
    assert.equal(
      reportResponse.headers.get("content-disposition"),
      'attachment; filename="studio-admission-demo-room.json"',
    );
    const report = (await reportResponse.json()) as any;
    assert.equal(report.formatVersion, 1);
    assert.equal(report.scope, "live-technical-readiness");
    assert.deepEqual(report.room, {
      id: "demo-room",
      title: "秋日好物 · 品牌直播间",
      productName: "日常随行杯",
      status: "draft",
    });
    assert.equal(report.admission.ready, false);
    assert.ok(report.limitations.length >= 3);
    const reportText = JSON.stringify(report);
    assert.equal(reportText.includes(config.sessionSecret), false);
    assert.equal(reportText.includes("stream_secret"), false);
    assert.equal(
      (
        await app.request(`/api${room}/admission-report`, {
          headers: { cookie: other },
        })
      ).status,
      404,
    );
    const incompletePackageResponse = await app.request(
      `/api${room}/compliance-review-package`,
      { headers: { cookie: owner } },
    );
    assert.equal(incompletePackageResponse.status, 200);
    const incompletePackage = (await incompletePackageResponse.json()) as any;
    assert.equal(incompletePackage.scope, "live-compliance-review-package");
    assert.equal(incompletePackage.readiness.complete, false);
    assert.equal(incompletePackage.merchantDisclosure, null);
    assert.equal(incompletePackage.content, null);
    assert.equal(
      incompletePackage.platform.operatorName,
      platformCompliance.operatorName,
    );
    assert.equal(
      JSON.stringify(incompletePackage).includes(config.sessionSecret),
      false,
    );
    assert.equal(
      (
        await app.request(`/api${room}/compliance-review-package`, {
          headers: { cookie: other },
        })
      ).status,
      404,
    );
    assert.equal(
      (
        await app.request(`/api${room}/compliance-review-package`, {
          headers: { cookie: reviewer },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await app.request(`/api${room}/compliance-review-package`, {
          headers: { cookie: presenter },
        })
      ).status,
      403,
    );
    const business = {
      name: "合成测试企业",
      creditCode: "91310100MA12345678",
      address: "合成验收地址不用于经营",
      contact: "合成联系 00000000",
      licenses: "合成许可说明",
    };
    await call(
      "/merchant/disclosure",
      "POST",
      {
        previousVersion: 0,
        data: {
          operator: business,
          seller: business,
          validThrough: "2099-12-31",
          complaintContact: "测试售后服务联系",
        },
        evidenceReference: "合成测试证据位置",
      },
      owner,
    );
    const publish = {
      action: "publish",
      note: "核对合成数据用于流程测试",
      acknowledged: true,
    };
    assert.equal(
      (await call("/merchant/disclosure/1/review", "POST", publish, reviewer))
        .status,
      200,
    );
    const content = "/merchant/content";
    const product = (
      await call(
        content + "/products",
        "POST",
        {
          name: "合成测试资料",
          sku: "admission",
          category: "测试资料",
          facts: [
            {
              id: "fact-capacity",
              text: "容量为 500 mL",
              evidence: "合成商品标签第 1 页",
              approved: true,
            },
          ],
        },
        owner,
      )
    ).data.product;
    const plan = (
      await call(
        content + "/plans",
        "POST",
        {
          productId: product.id,
          name: "测试计划",
          audience: "测试人员",
          totalDays: 45,
        },
        owner,
      )
    ).data.plan;
    const course = (
      await call(
        content + `/plans/${plan.id}/courses`,
        "POST",
        { title: "准入测试课", dayIndex: 1, objective: "核对开播流程" },
        owner,
      )
    ).data.course;
    const script = content + `/courses/${course.id}/scripts`;
    assert.equal(
      (
        await call(
          script,
          "POST",
          {
            baseVersion: 0,
            productVersion: 1,
            paragraphs: [
              {
                id: "p1",
                kind: "transition",
                text: "欢迎来到本次测试课堂。",
                factIds: [],
              },
              {
                id: "p2",
                kind: "fact",
                text: "容量为 500 mL。",
                factIds: ["fact-capacity"],
              },
            ],
            changeNote: "合成测试稿件",
          },
          owner,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await call(
          script + "/1/submit",
          "POST",
          { note: "提交独立审核" },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          script + "/1/review",
          "POST",
          {
            decision: "approved",
            note: "核对合成测试稿件",
            acknowledged: true,
          },
          reviewer,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          content + "/rooms/demo-room/binding",
          "POST",
          { courseId: course.id, scriptVersion: 1 },
          owner,
        )
      ).status,
      201,
    );
    const completePackageResponse = await app.request(
      `/api${room}/compliance-review-package`,
      { headers: { cookie: owner } },
    );
    assert.equal(completePackageResponse.status, 200);
    assert.equal(
      completePackageResponse.headers.get("cache-control"),
      "no-store",
    );
    assert.equal(
      completePackageResponse.headers.get("content-disposition"),
      'attachment; filename="studio-review-package-demo-room.json"',
    );
    const completePackageBody = await completePackageResponse.text();
    assert.equal(
      completePackageResponse.headers.get("x-content-sha256"),
      createHash("sha256").update(completePackageBody).digest("hex"),
    );
    const completePackage = JSON.parse(completePackageBody);
    assert.equal(completePackage.readiness.complete, true);
    assert.equal(completePackage.readiness.missing.length, 0);
    assert.equal(completePackage.merchantDisclosure.version, 1);
    assert.equal(
      completePackage.merchantDisclosure.evidenceReference,
      "合成测试证据位置",
    );
    assert.equal(completePackage.content.product.id, product.id);
    assert.deepEqual(completePackage.content.product.facts, [
      {
        id: "fact-capacity",
        text: "容量为 500 mL",
        evidence: "合成商品标签第 1 页",
        approved: true,
      },
    ]);
    assert.equal(completePackage.content.script.version, 1);
    assert.equal(
      completePackage.content.script.independentReview.confirmedBy,
      "reviewer",
    );
    assert.equal(
      completePackage.content.script.paragraphs[0].text,
      "欢迎来到本次测试课堂。",
    );
    const packageText = JSON.stringify(completePackage);
    assert.equal(packageText.includes("stream_secret"), false);
    assert.equal(packageText.includes(config.streamAuthSecret), false);
    assert.equal(packageText.includes(token), false);
    control = "missing";
    assert.equal((await start()).status, 409);
    control = "error";
    assert.equal((await start()).status, 409);
    control = "ok";
    assert.equal((await start()).status, 200);
    assert.equal((await start()).status, 200);
    const history = (await call(room + "/admissions", "GET", undefined, owner))
      .data;
    assert.equal(history.items.length, 1);
    assert.equal(history.items[0].basis.disclosureVersion, 1);
    assert.equal(history.items[0].basis.scriptVersion, 1);
    assert.equal(
      history.items[0].basis.platformPolicyEffectiveDate,
      "2026-09-11",
    );
    assert.equal(
      history.items[0].basis.retentionPolicyEffectiveDate,
      "2026-09-11",
    );
    assert.throws(() => db.exec("DELETE FROM live_admissions"));
    const secret = db
      .prepare("SELECT stream_secret FROM rooms WHERE id='demo-room'")
      .get()!.stream_secret;
    const hook = () =>
      call("/streams/mediamtx/auth?secret=local-callback-test", "POST", {
        action: "publish",
        path: "live/demo-room",
        query: `token=${secret}`,
      });
    assert.equal((await hook()).status, 204);
    const realNow = now;
    const deadline = Date.parse("2099-12-31T16:00:00Z");
    now = deadline - 1;
    assert.equal((await hook()).status, 204);
    now = deadline;
    const expired = (await call(room + "/admission", "GET", undefined, owner))
      .data;
    assert.equal(expired.ready, false);
    assert.equal(
      expired.checks.find((item: any) => item.code === "disclosure").passed,
      false,
    );
    assert.equal((await hook()).status, 403);
    assert.equal((await start()).status, 409);
    const visible = (await call("/public/rooms/demo-room/disclosure")).data;
    assert.equal(visible.disclosure.version, 1);
    now = realNow;
    assert.equal((await hook()).status, 204);
    // Expiry during the media-control await must also reject the new publisher.
    race = () => {
      now = deadline;
    };
    assert.equal((await hook()).status, 403);
    now = realNow;
    race = () =>
      db.prepare("UPDATE rooms SET status='ended' WHERE id='demo-room'").run();
    assert.equal((await hook()).status, 403);
    await call(room, "PATCH", { status: "draft" }, owner);
    assert.equal((await start()).status, 200);
    assert.equal(
      (
        await call(
          content + `/products/${product.id}/versions`,
          "POST",
          {
            baseVersion: 1,
            name: "更新后的测试资料",
            sku: "admission",
            category: "测试资料",
            facts: [],
          },
          owner,
        )
      ).status,
      201,
    );
    const changed = (await call(room + "/admission", "GET", undefined, owner))
      .data;
    assert.equal(
      changed.checks.find((item: any) => item.code === "disclosure").passed,
      true,
    );
    assert.equal(
      changed.checks.find((item: any) => item.code === "script").passed,
      false,
    );
    assert.equal((await hook()).status, 403);
    assert.equal(
      (
        await call(
          "/merchant/disclosure/1/review",
          "POST",
          { ...publish, action: "withdraw" },
          reviewer,
        )
      ).status,
      200,
    );
    assert.equal((await hook()).status, 403);
    control = "error";
    assert.equal(
      (await call(room, "PATCH", { status: "ended" }, owner)).status,
      200,
    );
    await call(room, "PATCH", { status: "draft" }, owner);
    assert.equal((await start()).status, 409);
  } finally {
    db.close();
    media.close();
    await once(media, "close");
  }
});
