import assert from "node:assert/strict";
import { test } from "node:test";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { createAgentService } from "../src/modules/agent/app.js";
import { loadAgentConfig } from "../src/modules/agent/config.js";
import { openAgentDatabase } from "../src/modules/agent/persistence/database.js";
import { HttpAgentBridge } from "../src/platform/adapters/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";
import type {
  EvaluationCase,
  EvaluationReport,
} from "../src/shared/training.js";
async function fixture(clock: () => number = Date.now) {
  const db = openDatabase(":memory:");
  seedDemo(db, clock());
  const agentDb = openAgentDatabase(":memory:");
  const agent = createAgentService(agentDb, loadAgentConfig({}));
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "training-gateway-test-independent-32-characters",
  });
  const bridge = new HttpAgentBridge(config, async (url, init) =>
    agent.app.request(url, init),
  );
  const app = createApp(db, config, clock, bridge);
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const r = await app.request("/api" + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const cookie = (await call("/auth/demo", "POST", {})).cookie;
  return {
    db,
    agentDb,
    agent,
    call,
    request: (p: string, m = "GET", b?: unknown) => call(p, m, b, cookie),
    close: async () => {
      await agent.close();
      agentDb.close();
      db.close();
    },
  };
}
const sample: EvaluationCase = {
  id: "facts",
  title: "已核对事实",
  transcript: "第一步先介绍产品资料",
  expect: {
    mustCiteEvidence: true,
    alertCategories: ["claim"],
    decisionTypes: ["contextual_ordinal"],
    forbiddenPhrases: [],
  },
};
test("evaluation replay freezes away live countdowns but still rejects changed approved product facts", async () => {
  let now = Date.now();
  const f = await fixture(() => now);
  try {
    assert.equal(
      (
        await f.request("/merchant/rooms/demo-room/campaigns", "POST", {
          totalCents: 100,
          count: 1,
          minWatchSeconds: 0,
          delaySeconds: 60,
          durationSeconds: 60,
        })
      ).status,
      201,
    );
    const suite = (
      await f.request("/merchant/rooms/demo-room/agent/suites", "POST", {
        name: "倒计时变化后的幂等重试",
        cases: [sample],
      })
    ).data.suite;
    const payload = {
      suiteId: suite.id,
      variants: [{ profileId: "standard", version: 1 }],
      idempotencyKey: "countdown-replay-once",
    };
    const first = await f.request(
      "/merchant/rooms/demo-room/agent/evaluations",
      "POST",
      payload,
    );
    assert.equal(first.status, 202);
    now += 2000;
    const replay = await f.request(
      "/merchant/rooms/demo-room/agent/evaluations",
      "POST",
      payload,
    );
    assert.equal(
      replay.status,
      202,
      "retry after a lost response must not conflict just because countdown time advanced",
    );
    assert.equal(replay.data.evaluation.id, first.data.evaluation.id);
    assert.equal(
      f.agentDb.prepare("SELECT count(*) AS n FROM agent_runs").get()!.n,
      1,
    );
    const snapshot = JSON.parse(
      f.agentDb.prepare("SELECT input_json FROM agent_runs").get()!
        .input_json as string,
    );
    assert.equal(
      snapshot.context.campaignCue,
      undefined,
      "evaluation input excludes changing live activity state",
    );
    const approved = (
      await f.request("/merchant/rooms/demo-room/facts")
    ).data.facts.find((fact: { approved: boolean }) => fact.approved);
    assert.ok(approved);
    await f.request(`/merchant/facts/${approved.id}`, "PATCH", {
      approved: false,
    });
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/evaluations",
          "POST",
          payload,
        )
      ).status,
      409,
      "changed approved evidence still conflicts with the original request snapshot",
    );
    assert.equal(
      f.agentDb.prepare("SELECT count(*) AS n FROM agent_runs").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});
test("material review and authorized style import connect to paired evaluation with historical evidence freshness", async () => {
  const f = await fixture();
  try {
    await f.request("/merchant/agent/profiles");
    const imported = await f.request(
      "/merchant/agent/profiles/standard/examples/import",
      "POST",
      {
        sourceName: "原创测试样例",
        authorization: "owned",
        baseVersion: 1,
        idempotencyKey: "style-evaluation-one",
        examples: [
          { situation: "介绍商品", response: "把核实过的资料说明白。" },
        ],
      },
    );
    assert.equal(imported.status, 201);
    assert.equal(imported.data.version.version, 2);
    const profiles = (await f.request("/merchant/agent/profiles")).data
      .profiles;
    assert.equal(profiles[0].publishedVersion, 1);
    const suite = (
      await f.request("/merchant/rooms/demo-room/agent/suites", "POST", {
        name: "演示比较",
        cases: [sample],
      })
    ).data.suite;
    const payload = {
      suiteId: suite.id,
      variants: [
        { profileId: "standard", version: 1 },
        { profileId: "standard", version: 2 },
      ],
      idempotencyKey: "evaluation-gateway-one",
    };
    const started = await f.request(
      "/merchant/rooms/demo-room/agent/evaluations",
      "POST",
      payload,
    );
    assert.equal(started.status, 202);
    let report: EvaluationReport = started.data.evaluation;
    for (let i = 0; i < 100 && report.status !== "completed"; i++) {
      await new Promise((r) => setTimeout(r, 5));
      report = (await f.request("/merchant/agent/evaluations/" + report.id))
        .data.evaluation;
    }
    assert.equal(report.status, "completed");
    assert.equal(report.items.length, 2);
    assert.equal(report.stale, false);
    assert.ok(
      report.items.every(
        (i) =>
          i.run.mode === "rehearsal" &&
          i.run.result?.provider === "grounded-rules",
      ),
    );
    assert.ok(
      report.items.every((item) =>
        item.checks.some(
          (check) =>
            check.name === "主张识别：contextual_ordinal" && check.passed,
        ),
      ),
    );
    assert.equal(
      (await f.request("/merchant/rooms/demo-room/agent/latest")).data.run,
      null,
    );
    const item = report.items[0];
    assert.equal(
      (
        await f.request(
          `/merchant/agent/evaluations/${report.id}/items/${item.id}/review`,
          "POST",
          {
            style: 3,
            naturalness: 4,
            decision: "revise",
            note: "本地规则不能判断风格训练效果",
          },
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.request("/merchant/rooms/demo-room/agent/evaluations")).data
        .evaluations[0].items[0].review.style,
      3,
    );
    const material = (
      await f.request("/merchant/rooms/demo-room/materials/import", "POST", {
        sourceName: "测试资料",
        format: "json",
        content: JSON.stringify([
          { text: "测试新增事实", evidence: "测试来源" },
        ]),
        idempotencyKey: "eval-material-one",
      })
    ).data.batch;
    assert.equal(
      (await f.request("/merchant/agent/evaluations/" + report.id)).data
        .evaluation.stale,
      false,
      "pending facts cannot alter trusted context",
    );
    await f.request("/merchant/facts/" + material.factIds[0], "PATCH", {
      approved: true,
    });
    assert.equal(
      (await f.request("/merchant/agent/evaluations/" + report.id)).data
        .evaluation.stale,
      true,
    );
    assert.equal(
      (await f.request("/merchant/rooms/demo-room/agent/evaluations")).data
        .evaluations[0].stale,
      true,
    );
    const feedback = await f.request(
      `/merchant/agent/evaluations/${report.id}/items/${item.id}/review`,
      "POST",
      { style: 3, naturalness: 3, decision: "revise", note: "历史结果保留" },
    );
    assert.equal(feedback.status, 409);
    // Reusing the same key with different current approved context is a conflict, never stale success.
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/evaluations",
          "POST",
          payload,
        )
      ).status,
      409,
    );
  } finally {
    await f.close();
  }
});
test("training gateway forbids foreign rooms, forged context, missing sample rights and invalid manual scores", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.call("/merchant/rooms/demo-room/agent/suites")).status,
      401,
    );
    f.db
      .prepare(
        "INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("foreign-room", "foreign", "other", "other", "other-secret", 0);
    for (const suffix of ["suites", "evaluations"])
      assert.equal(
        (await f.request("/merchant/rooms/foreign-room/agent/" + suffix))
          .status,
        404,
      );
    assert.equal(
      (
        await f.request("/merchant/rooms/demo-room/agent/evaluations", "POST", {
          suiteId: "x",
          variants: [{ profileId: "standard", version: 1 }],
          idempotencyKey: "injected-facts",
          context: { facts: [{ approved: true }] },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/agent/profiles/standard/examples/import",
          "POST",
          {
            sourceName: "unknown",
            baseVersion: 1,
            idempotencyKey: "no-rights-test",
            examples: [{ situation: "x", response: "y" }],
          },
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/agent/evaluations/fake/items/fake/review",
          "POST",
          { style: 10, naturalness: 4, decision: "acceptable", note: "" },
        )
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});
