import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { HttpAgentBridge } from "../src/server/services/agent-bridge.js";
import { openAgentDatabase } from "../src/agent/db.js";
import { createAgentService } from "../src/agent/app.js";
import { loadAgentConfig } from "../src/agent/config.js";

async function fixture() {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const adb = openAgentDatabase(":memory:");
  const agent = createAgentService(adb, loadAgentConfig({}));
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "content-gateway-test-independent-32-characters",
  });
  const bridge = new HttpAgentBridge(config, async (url, init) =>
    agent.app.request(url, init),
  );
  const app = createApp(db, config, Date.now, bridge);
  let cookie = "";
  const request = async (p: string, m = "GET", b?: unknown) => {
    const res = await app.request("/api" + p, {
      method: m,
      headers: {
        cookie,
        ...(b === undefined ? {} : { "content-type": "application/json" }),
      },
      body: b === undefined ? undefined : JSON.stringify(b),
    });
    if (p === "/auth/demo")
      cookie = res.headers.get("set-cookie")!.split(";")[0];
    return { status: res.status, data: await res.json() };
  };
  await request("/auth/demo", "POST", {});
  const product = (
    await request("/merchant/content/products", "POST", {
      name: "蓝色卡片 · 合成测试",
      sku: "test-blue-card",
      category: "测试教具",
      facts: [
        {
          id: "color",
          text: "测试卡片为蓝色。",
          evidence: "原创测试素材说明",
          approved: true,
        },
      ],
    })
  ).data;
  const plan = (
    await request("/merchant/content/plans", "POST", {
      productId: product.product.id,
      name: "测试课程计划",
      audience: "开发验收",
      totalDays: 45,
    })
  ).data.plan;
  const course = (
    await request(`/merchant/content/plans/${plan.id}/courses`, "POST", {
      title: "第一课",
      dayIndex: 1,
      objective: "验证资料到播讲流程",
    })
  ).data.course;
  const scriptInput = {
    baseVersion: 0,
    productVersion: 1,
    changeNote: "原创测试材料",
    paragraphs: [
      {
        id: "intro",
        kind: "fact",
        text: "测试卡片为蓝色。",
        factIds: ["color"],
      },
    ],
  };
  const save = await request(
    `/merchant/content/courses/${course.id}/scripts`,
    "POST",
    scriptInput,
  );
  assert.equal(save.status, 201);
  assert.equal(
    (
      await request(
        `/merchant/content/courses/${course.id}/scripts/1/confirm`,
        "POST",
        { acknowledged: true, note: "人工核对原创测试素材" },
      )
    ).status,
    200,
  );
  return {
    request,
    product,
    course,
    scriptInput,
    close: async () => {
      await agent.close();
      adb.close();
      db.close();
    },
  };
}

test("approved course context crosses the HTTP Agent boundary and revisions invalidate old references", async () => {
  const f = await fixture();
  try {
    const before = (await f.request("/merchant/rooms/demo-room/agent/basis"))
      .data;
    assert.equal(before.contentBound, false);
    assert.equal(before.productName, "日常随行杯");
    assert.equal(
      (
        await f.request("/merchant/content/rooms/demo-room/binding", "POST", {
          courseId: f.course.id,
          scriptVersion: 1,
        })
      ).status,
      201,
    );
    const basis = (await f.request("/merchant/rooms/demo-room/agent/basis"))
      .data;
    assert.equal(basis.category, "测试教具");
    assert.equal(basis.contentBound, true);
    assert.match(basis.facts[0].id, /:v1:color$/);
    assert.equal(basis.facts.length, 1);
    const submitted = await f.request(
      "/merchant/rooms/demo-room/agent/runs",
      "POST",
      {
        profileId: "standard",
        mode: "rehearsal",
        idempotencyKey: "content-bridge-version-one",
        transcript: "请介绍已审核的商品资料",
      },
    );
    assert.equal(submitted.status, 202);
    let run = submitted.data.run;
    for (let i = 0; i < 80 && run.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 10));
      run = (await f.request(`/merchant/agent/runs/${run.id}`)).data.run;
    }
    assert.equal(run.status, "completed");
    assert.equal(run.result.provider, "grounded-rules");
    assert.ok(
      run.result.factIds.every((id: string) => id === basis.facts[0].id),
    );
    assert.ok(run.result.factIds.length > 0);
    const update = await f.request(
      `/merchant/content/products/${f.product.product.id}/versions`,
      "POST",
      {
        ...f.product.version,
        version: undefined,
        createdAt: undefined,
        baseVersion: 1,
        category: "另一测试类别",
      },
    );
    assert.equal(update.status, 201);
    const stale = (await f.request("/merchant/rooms/demo-room/agent/basis"))
      .data;
    assert.equal(stale.stale, true);
    assert.deepEqual(stale.facts, []);
    assert.equal(
      (await f.request(`/merchant/agent/runs/${run.id}`)).data.run.stale,
      true,
    );
    const newer = await f.request(
      `/merchant/content/courses/${f.course.id}/scripts`,
      "POST",
      { ...f.scriptInput, baseVersion: 1, productVersion: 2 },
    );
    assert.equal(newer.status, 201);
    await f.request(
      `/merchant/content/courses/${f.course.id}/scripts/2/confirm`,
      "POST",
      { acknowledged: true, note: "人工复核新类别" },
    );
    await f.request("/merchant/content/rooms/demo-room/binding", "POST", {
      courseId: f.course.id,
      scriptVersion: 2,
    });
    const rebound = (await f.request("/merchant/rooms/demo-room/agent/basis"))
      .data;
    assert.equal(rebound.category, "另一测试类别");
    assert.match(rebound.facts[0].id, /:v2:color$/);
    assert.equal(
      (await f.request(`/merchant/agent/runs/${run.id}`)).data.run.stale,
      true,
    );
    const publicData = (await f.request("/public/rooms/demo-room")).data;
    assert.ok(!JSON.stringify(publicData).includes("原创测试素材说明"));
    assert.ok(!JSON.stringify(publicData).includes("人工核对原创测试素材"));
  } finally {
    await f.close();
  }
});

test("Chinese long scripts exceed 32 KiB safely while other API body limits remain unchanged", async () => {
  const f = await fixture();
  try {
    const input = {
      baseVersion: 1,
      productVersion: 1,
      changeNote: "较长中文稿件",
      paragraphs: Array.from({ length: 9 }, (_, i) => ({
        id: `paragraph-${i}`,
        kind: "transition",
        text: "欢迎来到今天的课堂。".repeat(120),
        factIds: [],
      })),
    };
    assert.ok(Buffer.byteLength(JSON.stringify(input)) > 32 * 1024);
    const saved = await f.request(
      `/merchant/content/courses/${f.course.id}/scripts`,
      "POST",
      input,
    );
    assert.equal(saved.status, 201);
    assert.equal(saved.data.script.paragraphs.length, 9);
    assert.equal(
      (
        await f.request("/merchant/rooms", "POST", {
          title: "x".repeat(40000),
          productName: "test",
        })
      ).status,
      413,
    );
    assert.equal(
      (
        await f.request("/merchant/content/products", "POST", {
          name: "x".repeat(140000),
        })
      ).status,
      413,
    );
  } finally {
    await f.close();
  }
});

test("empty-evidence evaluations become stale with their course binding and cannot accept historical review writes", async () => {
  const f = await fixture();
  try {
    const productInput = {
      name: f.product.version.name,
      sku: f.product.version.sku,
      category: f.product.version.category,
      facts: [],
    };
    const productPath = `/merchant/content/products/${f.product.product.id}/versions`;
    assert.equal(
      (
        await f.request(productPath, "POST", {
          ...productInput,
          baseVersion: 1,
        })
      ).status,
      201,
    );
    const scriptPath = `/merchant/content/courses/${f.course.id}/scripts`;
    const emptyEvidenceDraft = await f.request(scriptPath, "POST", {
      baseVersion: 1,
      productVersion: 2,
      changeNote: "只保留课堂开场，不宣称商品事实",
      paragraphs: [
        {
          id: "welcome",
          kind: "transition",
          text: "欢迎来到今天的课堂。",
          factIds: [],
        },
      ],
    });
    assert.equal(emptyEvidenceDraft.status, 201);
    assert.equal(emptyEvidenceDraft.data.script.check.blockingCount, 0);
    assert.equal(
      (
        await f.request(`${scriptPath}/2/confirm`, "POST", {
          acknowledged: true,
          note: "人工核对本次仅为开场过渡",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request("/merchant/content/rooms/demo-room/binding", "POST", {
          courseId: f.course.id,
          scriptVersion: 2,
        })
      ).status,
      201,
    );
    const suite = await f.request(
      "/merchant/rooms/demo-room/agent/suites",
      "POST",
      {
        name: "空资料时保持答复边界",
        cases: [
          {
            id: "missing-facts",
            title: "无资料先核实",
            transcript: "请介绍产品资料",
            expect: {
              mustCiteEvidence: false,
              abstained: true,
              alertCategories: [],
              forbiddenPhrases: [],
            },
          },
        ],
      },
    );
    assert.equal(suite.status, 201);
    const created = await f.request(
      "/merchant/rooms/demo-room/agent/evaluations",
      "POST",
      {
        suiteId: suite.data.suite.id,
        variants: [{ profileId: "standard", version: 1 }],
        idempotencyKey: "empty-course-evaluation-stale",
      },
    );
    assert.equal(created.status, 202);
    let report = created.data.evaluation;
    for (let i = 0; i < 80 && report.status !== "completed"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      report = (await f.request(`/merchant/agent/evaluations/${report.id}`))
        .data.evaluation;
    }
    assert.equal(report.status, "completed");
    assert.deepEqual(report.factSnapshot, []);
    assert.equal(report.stale, false);
    assert.equal(report.items[0].run.result.abstained, true);
    // Name, category and fact list deliberately stay identical. Only the bound
    // product revision changes, so field comparisons alone cannot detect this.
    assert.equal(
      (
        await f.request(productPath, "POST", {
          ...productInput,
          baseVersion: 2,
        })
      ).status,
      201,
    );
    const stale = (await f.request(`/merchant/agent/evaluations/${report.id}`))
      .data.evaluation;
    assert.deepEqual(stale.factSnapshot, []);
    assert.equal(stale.productName, report.productName);
    assert.equal(stale.category, report.category);
    assert.equal(stale.items[0].run.stale, true);
    assert.equal(stale.stale, true);
    assert.equal(
      (await f.request("/merchant/rooms/demo-room/agent/evaluations")).data
        .evaluations[0].stale,
      true,
    );
    const review = await f.request(
      `/merchant/agent/evaluations/${report.id}/items/${report.items[0].id}/review`,
      "POST",
      {
        style: 3,
        naturalness: 3,
        decision: "acceptable",
        note: "不应写入已经过期的评测",
      },
    );
    assert.equal(review.status, 409);
    assert.equal(
      (await f.request(`/merchant/agent/evaluations/${report.id}`)).data
        .evaluation.items[0].review,
      undefined,
    );
  } finally {
    await f.close();
  }
});
