import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { loadConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";

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
    MERCHANT_CREDENTIALS: JSON.stringify({ reviewer: token, other: token }),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      reviewer: { merchantId: "demo", role: "reviewer" },
    }),
  });
  const app = createApp(db, config);
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
    assert.equal(initial.checks[2].passed, true);
    assert.equal(
      (await call(room + "/admission", "GET", undefined, other)).status,
      404,
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
          facts: [],
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
