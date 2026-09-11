import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentService } from "../src/agent/app.js";
import { openAgentDatabase } from "../src/agent/db.js";
import { loadAgentConfig } from "../src/agent/config.js";
import {
  createGenerationProvider,
  type GenerationProvider,
} from "../src/agent/generation-provider.js";
const config = loadAgentConfig({});
const input = {
  courseId: "course",
  baseVersion: 0,
  productId: "product",
  productVersion: 1,
  productName: "测试卡片",
  category: "测试教具",
  title: "认识合成资料",
  objective: "验收",
  audience: "测试人员",
  facts: [
    {
      id: "color",
      text: "测试卡片为蓝色。",
      evidence: "软件验收设定",
      approved: true,
    },
  ],
  targetCharacters: 500,
  chapterCount: 2,
  profileId: "standard",
  promptVersion: 1,
  idempotencyKey: "request-1",
};
const outline = {
  chapters: [
    { title: "开场", objective: "介绍" },
    { title: "问答", objective: "总结" },
  ],
};
const chapter = {
  paragraphs: [
    { kind: "fact", text: "测试卡片为蓝色。", factIds: ["color"] },
    {
      kind: "transition",
      text: "这是软件验收用的合成材料，不是真实销售商品。".repeat(10),
      factIds: [],
    },
  ],
};
function fixture(
  provider: GenerationProvider,
  path = ":memory:",
  autoStart = true,
) {
  const db = openAgentDatabase(path),
    service = createAgentService(db, config, {
      generationProvider: provider,
      autoStart,
    });
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    tenant = "merchant-a",
  ) => {
    const res = await service.app.request("/v1/generation" + path, {
      method,
      headers: {
        authorization: `Bearer ${config.serviceToken}`,
        "x-studio-tenant": tenant,
        "content-type": "application/json",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as any };
  };
  return {
    db,
    service,
    call,
    close: async () => {
      await service.close();
      db.close();
    },
  };
}
async function settle(
  f: ReturnType<typeof fixture>,
  id: string,
  status: string,
) {
  for (let i = 0; i < 200; i++) {
    const result = await f.call("/jobs/" + id);
    if (result.data.job.status === status) return result.data;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail("Generation state did not settle: " + status);
}
const provider: GenerationProvider = {
  configured: true,
  label: "synthetic-test-only",
  async execute(_i, o) {
    return o ? structuredClone(chapter) : structuredClone(outline);
  },
};

test("unconfigured generation waits honestly, is tenant-isolated and idempotent", async () => {
  const f = fixture({
    configured: false,
    label: "unconfigured",
    async execute() {
      assert.fail("Must not generate fake output");
    },
  });
  try {
    const first = await f.call("/jobs", "POST", input);
    assert.equal(first.status, 202);
    assert.equal(first.data.job.status, "waiting_configuration");
    assert.deepEqual(first.data.job.chapters, []);
    assert.equal(
      (await f.call("/jobs", "POST", input)).data.job.id,
      first.data.job.id,
    );
    assert.equal(
      (await f.call("/jobs", "POST", { ...input, title: "changed" })).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          "/jobs/" + first.data.job.id,
          "GET",
          undefined,
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.call("/jobs/" + first.data.job.id + "/resume", "POST", {}))
        .status,
      409,
    );
    assert.equal(
      (await f.call("/jobs/" + first.data.job.id + "/cancel", "POST", {})).data
        .job.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("outline and each chapter persist separately; completion remains an unapproved draft", async () => {
  const f = fixture(provider);
  try {
    const id = (await f.call("/jobs", "POST", input)).data.job.id;
    const result = await settle(f, id, "completed");
    assert.equal(result.job.chapters.length, 2);
    assert.equal(result.attempts.length, 3);
    assert.equal(result.job.needsReview, true);
    assert.equal(result.job.input.prompt.version, 1);
    assert.equal(
      new Set(
        result.job.chapters.flatMap((c: any) =>
          c.paragraphs.map((p: any) => p.id),
        ),
      ).size,
      4,
    );
    assert.equal(
      (await f.call("/jobs/" + id + "/resume", "POST", {})).status,
      409,
    );
    assert.throws(() =>
      f.db.exec("UPDATE agent_generation_jobs SET input_json='{}'"),
    );
    assert.throws(() => f.db.exec("DELETE FROM agent_generation_attempts"));
  } finally {
    await f.close();
  }
});

test("failed chapter preserves completed chapters and resumes only the missing step", async () => {
  let failed = false;
  const stages: number[] = [];
  const f = fixture({
    ...provider,
    async execute(_i, o, chapters) {
      stages.push(o ? chapters.length : -1);
      if (o && chapters.length === 1 && !failed) {
        failed = true;
        throw new Error("private provider token must not be stored");
      }
      return o ? structuredClone(chapter) : structuredClone(outline);
    },
  });
  try {
    const id = (await f.call("/jobs", "POST", input)).data.job.id;
    const failure = await settle(f, id, "failed");
    assert.equal(failure.job.chapters.length, 1);
    assert.ok(!JSON.stringify(failure).includes("private provider token"));
    await f.call("/jobs/" + id + "/resume", "POST", {});
    const completed = await settle(f, id, "completed");
    assert.deepEqual(stages, [-1, 0, 1, 1]);
    assert.equal(completed.job.chapters.length, 2);
  } finally {
    await f.close();
  }
});

test("cancellation discards a late response; restart retains checkpoints and permits resume", async () => {
  let release!: (v: unknown) => void;
  const path = mkdtempSync(join(tmpdir(), "kaopu-generation-"));
  const f = fixture(
    {
      ...provider,
      execute() {
        return new Promise((resolve) => {
          release = resolve;
        });
      },
    },
    join(path, "agent.sqlite"),
  );
  const id = (await f.call("/jobs", "POST", input)).data.job.id;
  await settle(f, id, "running");
  await f.call("/jobs/" + id + "/cancel", "POST", {});
  release(outline);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal((await f.call("/jobs/" + id)).data.job.outline, null);
  await f.close();
  const g = fixture(provider, join(path, "agent.sqlite"));
  try {
    assert.equal((await g.call("/jobs/" + id)).data.job.status, "cancelled");
    await g.call("/jobs/" + id + "/resume", "POST", {});
    await settle(g, id, "completed");
  } finally {
    await g.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("unknown citations and malformed or oversized output fail without storing partial chapter", async () => {
  for (const bad of [
    { paragraphs: [{ kind: "fact", text: "虚构事实", factIds: ["missing"] }] },
    { paragraphs: [{ kind: "fact", text: "无依据", factIds: [] }] },
    {
      paragraphs: [
        { kind: "transition", text: "超".repeat(1501), factIds: [] },
      ],
    },
  ]) {
    const f = fixture({
      ...provider,
      async execute(_i, o) {
        return o ? bad : outline;
      },
    });
    try {
      const id = (await f.call("/jobs", "POST", input)).data.job.id;
      const result = await settle(f, id, "failed");
      assert.deepEqual(result.job.chapters, []);
      assert.equal(result.attempts[1].result, "failed");
    } finally {
      await f.close();
    }
  }
});

test("compatible model adapter rejects truncated, refused and oversized envelopes", async () => {
  let envelope: unknown = {
    choices: [
      { finish_reason: "stop", message: { content: JSON.stringify(outline) } },
    ],
  };
  let requestBody = "";
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const chunk of req) parts.push(Buffer.from(chunk));
    requestBody = Buffer.concat(parts).toString();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(envelope));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as { port: number };
  const adapter = createGenerationProvider({
    provider: "openai-compatible",
    endpoint: `http://127.0.0.1:${address.port}/chat/completions`,
    model: "synthetic-test-only",
    timeoutMs: 1000,
  });
  const f = fixture(provider, ":memory:", false);
  try {
    const snapshot = (await f.call("/jobs", "POST", input)).data.job.input;
    snapshot.prompt.presenter = {
      displayName: "PRIVATE_PRESENTER_NAME",
      roleDescription: "PRIVATE_ROLE",
      speakingStyle: "平缓短句",
      pace: "slow",
      authorizationReference: "PRIVATE_AUTHORIZATION",
      authorizationConfirmed: true,
    };
    assert.deepEqual(
      await adapter.execute(snapshot, null, [], new AbortController().signal),
      outline,
    );
    assert.deepEqual(
      JSON.parse(JSON.parse(requestBody).messages[1].content).input.prompt
        .presenter,
      { speakingStyle: "平缓短句", pace: "slow" },
    );
    assert.ok(!requestBody.includes("PRIVATE_PRESENTER_NAME"));
    assert.ok(!requestBody.includes("PRIVATE_AUTHORIZATION"));
    assert.ok(!requestBody.includes("PRIVATE_ROLE"));
    for (const bad of [
      {
        choices: [
          {
            finish_reason: "length",
            message: { content: JSON.stringify(outline) },
          },
        ],
      },
      {
        choices: [
          {
            finish_reason: "stop",
            message: { content: "{}", refusal: "refused" },
          },
        ],
      },
      { data: "x".repeat(140000) },
    ]) {
      envelope = bad;
      await assert.rejects(() =>
        adapter.execute(snapshot, null, [], new AbortController().signal),
      );
    }
  } finally {
    await f.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("stopping during the next chapter preserves the checkpoint across database reopen", async () => {
  const path = mkdtempSync(join(tmpdir(), "kaopu-generation-restart-"));
  let release!: (value: unknown) => void;
  const f = fixture(
    {
      ...provider,
      async execute(_i, o, chapters) {
        if (o && chapters.length === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return o ? structuredClone(chapter) : structuredClone(outline);
      },
    },
    join(path, "agent.sqlite"),
  );
  const id = (await f.call("/jobs", "POST", input)).data.job.id;
  for (let i = 0; i < 200 && !release; i++)
    await new Promise((r) => setTimeout(r, 10));
  assert.ok(release);
  assert.equal((await f.call("/jobs/" + id)).data.job.chapters.length, 1);
  await f.close();
  release(chapter);
  const g = fixture(provider, join(path, "agent.sqlite"));
  try {
    const restored = (await g.call("/jobs/" + id)).data.job;
    assert.equal(restored.status, "failed");
    assert.equal(restored.chapters.length, 1);
    await g.call("/jobs/" + id + "/resume", "POST", {});
    const done = await settle(g, id, "completed");
    assert.equal(done.job.chapters.length, 2);
  } finally {
    await g.close();
    rmSync(path, { recursive: true, force: true });
  }
});

test("long generation has an independent bounded deadline", () => {
  assert.equal(loadAgentConfig({}).generationTimeoutMs, 90000);
  assert.equal(
    loadAgentConfig({ AGENT_GENERATION_TIMEOUT_MS: "180000" })
      .generationTimeoutMs,
    180000,
  );
  for (const value of ["0", "180001", "invalid"])
    assert.throws(() =>
      loadAgentConfig({ AGENT_GENERATION_TIMEOUT_MS: value }),
    );
});
