import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createAgentService,
  type AgentServiceOptions,
} from "../src/modules/agent/app.js";
import {
  loadAgentConfig,
  type AgentConfig,
} from "../src/modules/agent/config.js";
import { runAgent } from "../src/modules/agent/core/index.js";
import { openAgentDatabase } from "../src/modules/agent/persistence/database.js";
import type {
  AgentContext,
  AgentExecutionInput,
  AgentResult,
} from "../src/shared/agent.js";
import type {
  EvaluationCase,
  EvaluationReport,
} from "../src/shared/training.js";

const token = "evaluation-test-private-service-token-32-characters";
const content = {
  systemPrompt: "只介绍有出处的商品事实。",
  styleGuide: "自然、简短。",
  audience: "家庭用户",
  examples: [],
};
const context: AgentContext = {
  roomId: "room-a",
  productName: "家用水杯",
  transcript: "不得覆盖评测题",
  question: "不得保留原问题",
  facts: [
    {
      id: "capacity",
      text: "容量350毫升",
      evidence: "测试商品标签，仅用于测试",
      approved: true,
    },
  ],
};
const sample: EvaluationCase = {
  id: "capacity-case",
  title: "只说可核实容量",
  transcript: "介绍这款水杯的容量",
  expect: {
    mustCiteEvidence: true,
    abstained: false,
    alertCategories: [],
    forbiddenPhrases: ["天下第一"],
  },
};
const resultFor = (input: AgentExecutionInput): AgentResult => ({
  provider: "grounded-rules",
  modelConfigured: false,
  suggestion: input.context.facts[0]?.text || "资料不足，暂不能确认。",
  factIds: input.context.facts.map((f) => f.id),
  evidence: input.context.facts.map((f) => f.evidence),
  alerts: [],
  nextCue: "核对商品标签",
  needsReview: true,
  abstained: !input.context.facts.length,
  profileId: input.profile.id,
  promptVersion: input.prompt.version,
  stages: [],
  decisionSummary: ["仅测试规则"],
});
const exampleBody = (key = "examples-one", baseVersion = 1) => ({
  sourceName: "自有口播样例",
  authorization: "owned",
  baseVersion,
  idempotencyKey: key,
  examples: [
    { situation: "介绍容量", response: "咱们先看标签，容量350毫升。" },
    { situation: "介绍容量", response: "咱们先看标签，容量350毫升。" },
  ],
});
const evaluationBody = (suiteId: string, extra = {}) => ({
  suiteId,
  variants: [{ profileId: "standard", version: 1 }],
  context,
  idempotencyKey: "evaluation-one",
  ...extra,
});
const review = {
  style: 4,
  naturalness: 3,
  decision: "revise",
  note: "事实有据；停顿和节奏需要主播再试读。",
};
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail("Evaluation did not reach the expected state");
}
function fixture(
  options: AgentServiceOptions = {},
  override: Partial<AgentConfig> = {},
  path = ":memory:",
) {
  const db = openAgentDatabase(path),
    config = {
      ...loadAgentConfig({ AGENT_SERVICE_TOKEN: token }),
      ...override,
    };
  const service = createAgentService(db, config, {
    autoStart: false,
    execute: async (input) => resultFor(input),
    ...options,
  });
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    tenant = "merchant-a",
  ) => {
    const response = await service.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        "x-studio-tenant": tenant,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const brand = async () => {
    const response = await call("/v1/profiles", "POST", {
      name: "测试品牌",
      kind: "brand",
      ...content,
    });
    assert.equal(response.status, 201);
    return response.data.profile;
  };
  const suite = async (cases = [sample], name = "品牌回归题") => {
    const response = await call("/v1/suites", "POST", {
      roomId: context.roomId,
      name,
      cases,
    });
    assert.equal(response.status, 201);
    return response.data.suite;
  };
  const dispose = async () => {
    await service.close({ timeoutMs: 20 });
    db.close();
  };
  return { db, service, call, brand, suite, dispose };
}

test("Example imports append immutable drafts, deduplicate, retain provenance and replay without changing publication", async () => {
  const f = fixture();
  try {
    const p = await f.brand();
    await f.call(`/v1/profiles/${p.id}/versions/1/publish`, "POST", {});
    const path = `/v1/profiles/${p.id}/examples/import`,
      body = exampleBody();
    const first = await f.call(path, "POST", body);
    assert.equal(first.status, 201);
    assert.equal(first.data.receipt.version, 2);
    assert.equal(first.data.receipt.importedCount, 1);
    assert.equal(first.data.version.examples.length, 1);
    assert.equal(first.data.version.systemPrompt, content.systemPrompt);
    assert.deepEqual((await f.call(path, "POST", body)).data, first.data);
    assert.equal(
      (await f.call(path, "POST", { ...body, sourceName: "changed" })).status,
      409,
    );
    assert.equal(
      (await f.call(path, "POST", exampleBody("stale-base"))).status,
      409,
    );
    const second = await f.call(
      path,
      "POST",
      exampleBody("duplicate-on-v2", 2),
    );
    assert.equal(second.data.receipt.version, 3);
    assert.equal(second.data.receipt.importedCount, 0);
    const profile = (await f.call("/v1/profiles")).data.profiles.find(
      (item: any) => item.id === p.id,
    );
    assert.equal(profile.publishedVersion, 1);
    assert.equal(profile.latestVersion, 3);
    const versions = (await f.call(`/v1/profiles/${p.id}/versions`)).data
      .versions;
    assert.equal(versions.at(-1).examples.length, 0);
    const imports = (await f.call(`/v1/profiles/${p.id}/example-imports`)).data
      .imports;
    assert.equal(imports.length, 2);
    assert.equal(imports[1].sourceName, body.sourceName);
    assert.equal(imports[1].authorization, "owned");
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE agent_example_imports SET receipt_json='{}'")
          .run(),
      /immutable/,
    );
  } finally {
    await f.dispose();
  }
});

test("Imports reject missing rights, stale drafts, oversized merged examples and cross-tenant access without partial changes", async () => {
  const f = fixture();
  try {
    const p = await f.brand(),
      path = `/v1/profiles/${p.id}/examples/import`;
    assert.equal(
      (
        await f.call(path, "POST", {
          ...exampleBody(),
          authorization: undefined,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(path, "POST", {
          ...exampleBody(),
          authorization: "unknown",
        })
      ).status,
      400,
    );
    assert.equal(
      (await f.call(path, "POST", { ...exampleBody(), examples: [] })).status,
      400,
    );
    assert.equal(
      (await f.call(path, "POST", exampleBody(), "merchant-b")).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          `/v1/profiles/${p.id}/example-imports`,
          "GET",
          undefined,
          "merchant-b",
        )
      ).status,
      404,
    );
    const examples = Array.from({ length: 12 }, (_, i) => ({
      situation: `情境${i}`,
      response: `表达${i}`,
    }));
    const filled = await f.call(path, "POST", { ...exampleBody(), examples });
    assert.equal(filled.status, 201);
    assert.equal(
      (
        await f.call(path, "POST", {
          ...exampleBody("overflow", 2),
          examples: [{ situation: "new", response: "new" }],
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.call(`/v1/profiles/${p.id}/versions`)).data.versions.length,
      2,
    );
    assert.equal(
      (await f.call(`/v1/profiles/${p.id}/example-imports`)).data.imports
        .length,
      1,
    );
  } finally {
    await f.dispose();
  }
});

test("Suites validate bounded cases and preserve immutable revisions rather than editing older scenarios", async () => {
  const f = fixture();
  try {
    const original = await f.suite();
    const next = await f.suite([{ ...sample, title: "新题目标题" }]);
    assert.notEqual(original.id, next.id);
    assert.equal(original.revision, 1);
    assert.equal(next.revision, 2);
    const suites = (await f.call("/v1/suites?roomId=room-a")).data.suites;
    assert.equal(suites[1].cases[0].title, sample.title);
    assert.deepEqual(
      (await f.call("/v1/suites?roomId=room-a", "GET", undefined, "merchant-b"))
        .data.suites,
      [],
    );
    for (const cases of [
      [],
      [sample, sample],
      Array.from({ length: 9 }, (_, i) => ({ ...sample, id: `case-${i}` })),
      [{ ...sample, transcript: "a".repeat(1001) }],
      [{ ...sample, question: "a".repeat(201) }],
      [{ ...sample, facts: context.facts }],
      [
        {
          ...sample,
          expect: { ...sample.expect, alertCategories: ["claim", "claim"] },
        },
      ],
      [{ ...sample, expect: { ...sample.expect, alertCategories: ["legal"] } }],
      [
        {
          ...sample,
          expect: { ...sample.expect, forbiddenPhrases: Array(9).fill("x") },
        },
      ],
    ]) {
      assert.equal(
        (
          await f.call("/v1/suites", "POST", {
            roomId: "room-a",
            name: "invalid",
            cases,
          })
        ).status,
        400,
      );
    }
    assert.throws(
      () =>
        f.db
          .prepare("UPDATE agent_evaluation_suites SET cases_json='[]'")
          .run(),
      /immutable/,
    );
  } finally {
    await f.dispose();
  }
});

test("Evaluation batches share the durable queue and retain case, product, prompt and approved fact snapshots", async () => {
  const seen: AgentExecutionInput[] = [],
    f = fixture({
      execute: async (input) => {
        seen.push(input);
        return resultFor(input);
      },
    });
  try {
    const p = await f.brand();
    const scenarios = [
      sample,
      {
        ...sample,
        id: "question-case",
        title: "回答容量问题",
        question: "水杯容量多少？",
      },
    ];
    const suite = await f.suite(scenarios),
      body = evaluationBody(suite.id, {
        variants: [
          { profileId: "standard", version: 1 },
          { profileId: p.id, version: 1 },
        ],
      });
    const created = await f.call("/v1/evaluations", "POST", body);
    assert.equal(created.status, 202);
    const report = created.data.evaluation as EvaluationReport;
    assert.equal(report.status, "queued");
    assert.equal(report.items.length, 4);
    assert.equal(f.service.status().queued, 4);
    assert.ok(
      report.items.every(
        (item) => item.run.mode === "rehearsal" && item.outcome === "pending",
      ),
    );
    assert.deepEqual(report.factSnapshot, context.facts);
    assert.equal(report.productName, context.productName);
    await f.call(`/v1/profiles/${p.id}/versions`, "POST", {
      ...content,
      systemPrompt: "后来修改的提示",
    });
    await f.suite([{ ...sample, transcript: "后来修改的题目" }]);
    assert.equal(
      (await f.call("/v1/evaluations", "POST", body)).data.evaluation.id,
      report.id,
    );
    assert.equal(
      (
        await f.call("/v1/evaluations", "POST", {
          ...body,
          context: { ...context, productName: "changed" },
        })
      ).status,
      409,
    );
    assert.equal(f.service.status().queued, 4);
    assert.equal(
      (
        await f.call(
          `/v1/evaluations/${report.id}/items/${report.items[0].id}/review`,
          "POST",
          review,
        )
      ).status,
      409,
    );
    f.service.start();
    await until(
      async () =>
        (await f.call(`/v1/evaluations/${report.id}`)).data.evaluation
          .status === "completed",
    );
    const completed = (await f.call(`/v1/evaluations/${report.id}`)).data
      .evaluation as EvaluationReport;
    assert.ok(completed.items.every((item) => item.outcome === "passed"));
    assert.equal(completed.suite.revision, 1);
    assert.equal(completed.suite.cases[0].transcript, sample.transcript);
    assert.equal(seen.length, 4);
    assert.ok(
      seen.every(
        (input) =>
          input.context.productName === context.productName &&
          input.context.facts[0].evidence === context.facts[0].evidence,
      ),
    );
    assert.equal(
      seen.filter((input) => input.context.question === undefined).length,
      2,
    );
    assert.equal(
      seen.filter((input) => input.profile.id === p.id)[0].prompt.systemPrompt,
      content.systemPrompt,
    );
    const reviewed = (
      await f.call(
        `/v1/evaluations/${report.id}/items/${report.items[0].id}/review`,
        "POST",
        review,
      )
    ).data.evaluation;
    assert.deepEqual(reviewed.items[0].review, review);
    assert.equal(
      reviewed.items[0].outcome,
      "passed",
      "human revise decision is separate from deterministic checks",
    );
    assert.equal(
      (
        await f.call(
          `/v1/evaluations/${report.id}/items/${report.items[0].id}/review`,
          "POST",
          { ...review, naturalness: 6 },
        )
      ).status,
      400,
    );
    assert.equal(
      (await f.call("/v1/evaluations?roomId=room-a")).data.evaluations[0].id,
      report.id,
    );
    assert.equal(
      (await f.call("/v1/evaluations?roomId=room-a&limit=21")).status,
      400,
    );
  } finally {
    await f.dispose();
  }
});

test("Evaluation reservation atomically rejects tenant/global overflow and rolls back jobs when persistence fails", async () => {
  const f = fixture({}, { queueLimit: 4, tenantQueueLimit: 3 });
  try {
    const s = await f.suite([sample, { ...sample, id: "second-case" }]);
    const p = await f.brand();
    const tooLarge = evaluationBody(s.id, {
      variants: [
        { profileId: "standard", version: 1 },
        { profileId: p.id, version: 1 },
      ],
    });
    assert.equal(
      (await f.call("/v1/evaluations", "POST", tooLarge)).status,
      429,
    );
    assert.equal(f.service.status().queued, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_evaluations").get()!.n,
      0,
    );
    const body = evaluationBody(s.id);
    f.db.exec(
      "CREATE TRIGGER reject_evaluation_item BEFORE INSERT ON agent_evaluation_items BEGIN SELECT RAISE(ABORT,'test item persistence error'); END",
    );
    assert.equal((await f.call("/v1/evaluations", "POST", body)).status, 503);
    assert.equal(f.service.status().queued, 0);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_evaluations").get()!.n,
      0,
    );
    f.db.exec("DROP TRIGGER reject_evaluation_item");
    const first = await f.call("/v1/evaluations", "POST", body);
    assert.equal(first.status, 202);
    assert.equal(
      (
        await f.call("/v1/runs", "POST", {
          profileId: "standard",
          context,
          mode: "rehearsal",
          idempotencyKey: "normal",
        })
      ).status,
      202,
    );
    assert.equal(
      (
        await f.call("/v1/evaluations", "POST", {
          ...body,
          idempotencyKey: "overflow",
        })
      ).status,
      429,
    );
    assert.equal(
      (await f.call("/v1/evaluations", "POST", body)).data.evaluation.id,
      first.data.evaluation.id,
      "same request is replayable when queue is full",
    );
    const tenantB = await f.call(
      "/v1/suites",
      "POST",
      {
        roomId: "room-a",
        name: "B",
        cases: [sample, { ...sample, id: "second" }],
      },
      "merchant-b",
    );
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(tenantB.data.suite.id),
          "merchant-b",
        )
      ).status,
      429,
    );
    assert.equal(f.service.status().queued, 3);
  } finally {
    await f.dispose();
  }
});

test("All evaluation routes isolate tenants and reject wrong rooms, missing versions and duplicate variants before reserving work", async () => {
  const f = fixture();
  try {
    const s = await f.suite(),
      p = await f.brand();
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id),
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id, { context: { ...context, roomId: "other" } }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id, {
            variants: [
              { profileId: "standard", version: 1 },
              { profileId: p.id, version: 9 },
            ],
          }),
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id, {
            variants: [
              { profileId: "standard", version: 1 },
              { profileId: "standard", version: 1 },
            ],
          }),
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id, {
            context: {
              ...context,
              facts: [context.facts[0], context.facts[0]],
            },
          }),
        )
      ).status,
      400,
    );
    assert.equal(f.service.status().queued, 0);
    const report = (
      await f.call("/v1/evaluations", "POST", evaluationBody(s.id))
    ).data.evaluation as EvaluationReport;
    assert.equal(
      (
        await f.call(
          `/v1/evaluations/${report.id}`,
          "GET",
          undefined,
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          `/v1/evaluations/${report.id}/items/${report.items[0].id}/review`,
          "POST",
          review,
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.deepEqual(
      (
        await f.call(
          "/v1/evaluations?roomId=room-a",
          "GET",
          undefined,
          "merchant-b",
        )
      ).data.evaluations,
      [],
    );
    assert.throws(
      () =>
        f.db.prepare("UPDATE agent_evaluations SET context_json='{}'").run(),
      /immutable/,
    );
  } finally {
    await f.dispose();
  }
});

test("Rubric checks evidence, forbidden output, abstention and risk categories; failures and model fallback never pass automatically", async () => {
  const cases: EvaluationCase[] = [
    sample,
    ...[
      "bad-evidence",
      "forbidden",
      "abstained",
      "missing-alert",
      "fallback",
      "throw",
    ].map((id) => ({
      ...sample,
      id,
      transcript: id,
      expect: {
        ...sample.expect,
        ...(id === "missing-alert"
          ? { alertCategories: ["emotion" as const] }
          : {}),
      },
    })),
  ];
  const f = fixture({
    execute: async (input) => {
      const output = resultFor(input);
      if (input.context.transcript === "bad-evidence")
        output.evidence = ["未经核实的出处"];
      if (input.context.transcript === "forbidden")
        output.suggestion += " 天 下 第 一";
      if (input.context.transcript === "abstained") {
        output.abstained = true;
        output.factIds = [];
        output.evidence = [];
      }
      if (input.context.transcript === "fallback")
        output.modelConfigured = true;
      if (input.context.transcript === "throw")
        throw new Error("upstream secret=must-not-leak");
      return output;
    },
  });
  try {
    const s = await f.suite(cases),
      report = (await f.call("/v1/evaluations", "POST", evaluationBody(s.id)))
        .data.evaluation as EvaluationReport;
    f.service.start();
    await until(
      async () =>
        (await f.call(`/v1/evaluations/${report.id}`)).data.evaluation
          .status === "completed",
    );
    const finished = (await f.call(`/v1/evaluations/${report.id}`)).data
      .evaluation as EvaluationReport;
    assert.equal(finished.items[0].outcome, "passed");
    assert.ok(
      finished.items.slice(1).every((item) => item.outcome === "failed"),
    );
    assert.equal(finished.items.at(-1)!.run.status, "failed");
    assert.ok(!JSON.stringify(finished).includes("must-not-leak"));
    assert.equal(
      (
        await f.call(
          `/v1/evaluations/${report.id}/items/${finished.items.at(-1)!.id}/review`,
          "POST",
          review,
        )
      ).status,
      409,
    );
  } finally {
    await f.dispose();
  }
});

test("Real local Agent results are evaluated honestly and evidence-free abstention can pass its declared case", async () => {
  const f = fixture({ execute: runAgent });
  try {
    const s = await f.suite(),
      first = (
        await f.call(
          "/v1/evaluations",
          "POST",
          evaluationBody(s.id, {
            context: { ...context, question: undefined },
          }),
        )
      ).data.evaluation as EvaluationReport;
    const missing = await f.suite(
      [
        {
          ...sample,
          id: "missing",
          transcript: "这个水杯有什么治疗作用？",
          expect: {
            mustCiteEvidence: false,
            abstained: true,
            alertCategories: ["claim"],
            forbiddenPhrases: ["治好"],
          },
        },
      ],
      "资料不足",
    );
    const second = (
      await f.call(
        "/v1/evaluations",
        "POST",
        evaluationBody(missing.id, {
          idempotencyKey: "missing-facts",
          context: { ...context, facts: [] },
        }),
      )
    ).data.evaluation as EvaluationReport;
    f.service.start();
    await until(
      async () =>
        (await f.call(`/v1/evaluations/${second.id}`)).data.evaluation
          .status === "completed",
    );
    for (const id of [first.id, second.id]) {
      const item = (await f.call(`/v1/evaluations/${id}`)).data.evaluation
        .items[0];
      assert.equal(item.outcome, "passed");
      assert.equal(item.run.result.modelConfigured, false);
      assert.equal(item.run.result.provider, "grounded-rules");
      assert.match(item.checks[0].detail, /未调用真实模型/);
    }
  } finally {
    await f.dispose();
  }
});

test("Restart preserves imports, evaluation snapshots, reviews and idempotency; interrupted runs fail without being counted as passed", async () => {
  const folder = mkdtempSync(join(tmpdir(), "evaluation-persistence-")),
    path = join(folder, "agent.sqlite");
  const before = fixture({}, {}, path);
  let after: ReturnType<typeof fixture> | undefined;
  try {
    const p = await before.brand();
    const importPath = `/v1/profiles/${p.id}/examples/import`,
      imported = await before.call(importPath, "POST", exampleBody());
    const s = await before.suite([
      sample,
      { ...sample, id: "interrupted" },
      { ...sample, id: "queued" },
    ]);
    const body = evaluationBody(s.id),
      report = (await before.call("/v1/evaluations", "POST", body)).data
        .evaluation as EvaluationReport;
    const runIds = report.items.map((item) => item.run.id);
    const saved = JSON.parse(
      before.db
        .prepare("SELECT input_json FROM agent_runs WHERE id=?")
        .get(runIds[0])!.input_json as string,
    ) as AgentExecutionInput;
    before.db
      .prepare(
        "UPDATE agent_runs SET status='completed',result_json=?,completed_at=? WHERE id=?",
      )
      .run(JSON.stringify(resultFor(saved)), Date.now(), runIds[0]);
    await before.call(
      `/v1/evaluations/${report.id}/items/${report.items[0].id}/review`,
      "POST",
      review,
    );
    before.db
      .prepare("UPDATE agent_runs SET status='running' WHERE id=?")
      .run(runIds[1]);
    await before.dispose();
    let calls = 0;
    after = fixture(
      {
        execute: async (input) => {
          calls++;
          return resultFor(input);
        },
      },
      {},
      path,
    );
    assert.deepEqual(
      (await after.call(importPath, "POST", exampleBody())).data,
      imported.data,
    );
    assert.equal(
      (await after.call("/v1/evaluations", "POST", body)).data.evaluation.id,
      report.id,
    );
    const restored = (await after.call(`/v1/evaluations/${report.id}`)).data
      .evaluation as EvaluationReport;
    assert.deepEqual(restored.items[0].review, review);
    assert.equal(restored.items[1].run.status, "failed");
    assert.equal(restored.items[1].outcome, "failed");
    assert.equal(restored.items[2].run.status, "queued");
    after.service.start();
    await until(
      async () =>
        (await after!.call(`/v1/evaluations/${report.id}`)).data.evaluation
          .status === "completed",
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      (await after.call(`/v1/evaluations/${report.id}`)).data.evaluation
        .factSnapshot,
      context.facts,
    );
  } finally {
    if (after) await after.dispose();
    else {
      try {
        await before.dispose();
      } catch {}
    }
    rmSync(folder, { recursive: true, force: true });
  }
});

test("importing authorized examples preserves the presenter dossier in the next immutable version", async () => {
  const f = fixture();
  try {
    const presenter = {
      displayName: "合成主播",
      roleDescription: "测试讲解员",
      speakingStyle: "温和，短句",
      pace: "balanced",
      authorizationReference: "合成授权记录，不代表真人",
      authorizationConfirmed: true,
    };
    const p = (
      await f.call("/v1/profiles", "POST", {
        ...content,
        name: "主播样例测试",
        kind: "brand",
        presenter,
      })
    ).data.profile;
    const imported = await f.call(
      "/v1/profiles/" + p.id + "/examples/import",
      "POST",
      exampleBody(),
    );
    assert.equal(imported.status, 201);
    assert.deepEqual(imported.data.version.presenter, presenter);
    const history = (await f.call("/v1/profiles/" + p.id + "/versions")).data
      .versions;
    assert.deepEqual(history[1].presenter, presenter);
    assert.equal(history[1].examples.length, 0);
  } finally {
    await f.dispose();
  }
});
