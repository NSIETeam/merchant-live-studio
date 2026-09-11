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
import { openAgentDatabase } from "../src/modules/agent/persistence/database.js";
import type {
  AgentContext,
  AgentExecutionInput,
  AgentResult,
} from "../src/shared/agent.js";

const serviceToken = "test-agent-service-token-with-32-characters";
const content = {
  systemPrompt: "Keep the response factual.",
  styleGuide: "Short and natural",
  audience: "New viewers",
  examples: [],
};
const context: AgentContext = {
  roomId: "room-a",
  productName: "Cup",
  transcript: "介绍容量",
  facts: [
    {
      id: "capacity",
      text: "容量350毫升",
      evidence: "商品标签",
      approved: true,
    },
  ],
};
const resultFor = (input: AgentExecutionInput): AgentResult => ({
  provider: "grounded-rules",
  modelConfigured: false,
  suggestion: input.prompt.systemPrompt,
  factIds: [],
  evidence: [],
  alerts: [],
  nextCue: "",
  needsReview: false,
  abstained: false,
  profileId: input.profile.id,
  promptVersion: input.prompt.version,
  stages: [],
  decisionSummary: [],
});
const requestInput = (key: string, extra = {}) => ({
  profileId: "standard",
  context,
  mode: "live",
  idempotencyKey: key,
  ...extra,
});
async function until(fn: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 150; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  assert.fail("Agent state did not settle");
}
function fixture(
  options: AgentServiceOptions = {},
  override: Partial<AgentConfig> = {},
  path = ":memory:",
) {
  const config = {
    ...loadAgentConfig({ AGENT_SERVICE_TOKEN: serviceToken }),
    ...override,
  };
  const db = openAgentDatabase(path);
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
    token = serviceToken,
  ) => {
    const response = await service.app.request(path, {
      method,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(tenant ? { "X-Studio-Tenant": tenant } : {}),
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: (await response.json()) as any };
  };
  const brand = async (tenant = "merchant-a") => {
    const r = await call(
      "/v1/profiles",
      "POST",
      { name: "Brand voice", kind: "brand", ...content },
      tenant,
    );
    assert.equal(r.status, 201);
    return r.data.profile;
  };
  const dispose = async () => {
    await service.close({ timeoutMs: 20 });
    db.close();
  };
  return { db, config, service, call, brand, dispose };
}

test("Agent configuration requires private service credentials and explicit bounded model setup", () => {
  const c = loadAgentConfig({});
  assert.equal(c.host, "127.0.0.1");
  assert.equal(c.port, 8788);
  assert.equal(c.concurrency, 2);
  assert.equal(c.queueLimit, 100);
  assert.equal(c.tenantQueueLimit, 20);
  assert.ok(c.serviceToken.length >= 32);
  assert.equal(c.model.provider, "grounded-rules");
  assert.throws(
    () => loadAgentConfig({ NODE_ENV: "production" }),
    /AGENT_SERVICE_TOKEN/,
  );
  assert.throws(
    () => loadAgentConfig({ AGENT_HOST: "0.0.0.0" }),
    /AGENT_SERVICE_TOKEN/,
  );
  assert.throws(
    () => loadAgentConfig({ AGENT_SERVICE_TOKEN: "short" }),
    /AGENT_SERVICE_TOKEN/,
  );
  assert.throws(() => loadAgentConfig({ AGENT_CONCURRENCY: "9" }));
  assert.throws(
    () =>
      loadAgentConfig({
        AGENT_MODEL_PROVIDER: "openai-compatible",
        AGENT_MODEL_ENDPOINT: "http://remote.example/v1/chat/completions",
        AGENT_MODEL_MODEL: "example",
      }),
    /HTTPS/,
  );
  const ignored = loadAgentConfig({
    AGENT_MODEL_ENDPOINT: "https://unused.example/v1/chat/completions",
    AGENT_MODEL_API_KEY: "should-not-enable-model",
  });
  assert.deepEqual(ignored.model, { provider: "grounded-rules" });
});

test("Agent authenticates the gateway and creates independent tenant standard profiles", async () => {
  const f = fixture();
  try {
    const health = await f.call("/health", "GET", undefined, "", "");
    assert.equal(health.status, 200);
    assert.equal(health.data.modelConfigured, false);
    assert.ok(!JSON.stringify(health.data).includes(serviceToken));
    assert.equal(
      (await f.call("/v1/profiles", "GET", undefined, "merchant-a", "")).status,
      401,
    );
    assert.equal(
      (await f.call("/v1/profiles", "GET", undefined, "merchant-a", "wrong"))
        .status,
      401,
    );
    assert.equal(
      (await f.call("/v1/profiles", "GET", undefined, "")).status,
      400,
    );
    assert.equal(
      (await f.call("/v1/profiles", "GET", undefined, "../merchant-a")).status,
      400,
    );
    for (const tenant of ["merchant-a", "merchant-b"]) {
      const r = await f.call("/v1/profiles", "GET", undefined, tenant);
      assert.equal(r.data.profiles.length, 1);
      assert.equal(r.data.profiles[0].id, "standard");
      assert.equal(r.data.profiles[0].publishedVersion, 1);
    }
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM agent_profiles").get()?.n,
      2,
    );
    assert.equal((await f.call("/v1/profiles", "POST")).status, 415);
  } finally {
    await f.dispose();
  }
});

test("Agent profiles, versions, runs, feedback, and room history are tenant isolated", async () => {
  const f = fixture();
  try {
    const p = await f.brand();
    assert.equal(
      (
        await f.call(
          `/v1/profiles/${p.id}/versions`,
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
          `/v1/profiles/${p.id}/versions`,
          "POST",
          content,
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          `/v1/profiles/${p.id}/versions/1/publish`,
          "POST",
          {},
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("foreign", { profileId: p.id, mode: "rehearsal" }),
          "merchant-b",
        )
      ).status,
      404,
    );
    const job = (await f.call("/v1/runs", "POST", requestInput("mine"))).data
      .run;
    assert.equal(
      (await f.call(`/v1/runs/${job.id}`, "GET", undefined, "merchant-b"))
        .status,
      404,
    );
    assert.equal(
      (
        await f.call(
          `/v1/runs/${job.id}/feedback`,
          "POST",
          { rating: "useful", note: "" },
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.deepEqual(
      (
        await f.call(
          "/v1/runs?roomId=room-a&limit=20",
          "GET",
          undefined,
          "merchant-b",
        )
      ).data.runs,
      [],
    );
    assert.deepEqual(
      (await f.call("/v1/runs?roomId=other-room")).data.runs,
      [],
    );
    const feedback = await f.call(`/v1/runs/${job.id}/feedback`, "POST", {
      rating: "needs_work",
      note: "More concise",
    });
    assert.equal(feedback.data.run.feedback.note, "More concise");
    const history = (await f.call("/v1/runs?roomId=room-a&limit=1")).data.runs;
    assert.equal(history[0].id, job.id);
    assert.equal(history[0].promptVersion, 1);
    assert.match(history[0].contextDigest, /^[a-f0-9]{64}$/);
    assert.equal((await f.call("/v1/runs?roomId=room-a&limit=21")).status, 400);
    assert.equal((await f.call("/v1/runs")).status, 400);
  } finally {
    await f.dispose();
  }
});

test("Prompt versions are immutable and live runs only choose the published version", async () => {
  const f = fixture();
  try {
    const p = await f.brand();
    assert.equal(p.publishedVersion, null);
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("unpublished", { profileId: p.id }),
        )
      ).status,
      409,
    );
    const draft = await f.call(
      "/v1/runs",
      "POST",
      requestInput("draft", { profileId: p.id, mode: "rehearsal" }),
    );
    assert.equal(draft.data.run.promptVersion, 1);
    await f.call(`/v1/profiles/${p.id}/versions/1/publish`, "POST", {});
    await f.call(`/v1/profiles/${p.id}/versions`, "POST", {
      ...content,
      systemPrompt: "Version two",
    });
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("draft-live", { profileId: p.id, version: 2 }),
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("published", { profileId: p.id }),
        )
      ).data.run.promptVersion,
      1,
    );
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("rehearsal-latest", {
            profileId: p.id,
            mode: "rehearsal",
          }),
        )
      ).data.run.promptVersion,
      2,
    );
    const versions = (await f.call(`/v1/profiles/${p.id}/versions`)).data
      .versions;
    assert.equal(versions[1].systemPrompt, content.systemPrompt);
    assert.throws(
      () =>
        f.db
          .prepare(
            "UPDATE agent_prompt_versions SET content_json='{}' WHERE tenant_id=? AND profile_id=? AND version=1",
          )
          .run("merchant-a", p.id),
      /immutable/,
    );
  } finally {
    await f.dispose();
  }
});

test("Queued runs retain their prompt snapshot and idempotency survives profile publication", async () => {
  const seen: AgentExecutionInput[] = [];
  const f = fixture({
    execute: async (input) => {
      seen.push(input);
      return resultFor(input);
    },
  });
  try {
    const p = await f.brand();
    await f.call(`/v1/profiles/${p.id}/versions/1/publish`, "POST", {});
    const body = requestInput("stable", { profileId: p.id });
    const original = (await f.call("/v1/runs", "POST", body)).data.run;
    await f.call(`/v1/profiles/${p.id}/versions`, "POST", {
      ...content,
      systemPrompt: "Changed after enqueue",
    });
    await f.call(`/v1/profiles/${p.id}/versions/2/publish`, "POST", {});
    const retry = (
      await f.call("/v1/runs", "POST", {
        idempotencyKey: body.idempotencyKey,
        mode: body.mode,
        context: body.context,
        profileId: body.profileId,
      })
    ).data.run;
    assert.equal(retry.id, original.id);
    assert.equal(retry.promptVersion, 1);
    assert.equal(
      (
        await f.call("/v1/runs", "POST", {
          ...body,
          context: { ...context, transcript: "different" },
        })
      ).status,
      409,
    );
    f.service.start();
    await until(
      async () =>
        (await f.call(`/v1/runs/${original.id}`)).data.run.status ===
        "completed",
    );
    assert.equal(seen.length, 1);
    assert.equal(seen[0].prompt.systemPrompt, content.systemPrompt);
    assert.equal(seen[0].profile.latestVersion, 1);
    assert.equal(seen[0].profile.publishedVersion, 1);
  } finally {
    await f.dispose();
  }
});

test("Agent queue bounds both global and tenant unfinished work and allows idempotent replays when full", async () => {
  const f = fixture({}, { queueLimit: 3, tenantQueueLimit: 2 });
  try {
    const first = await f.call("/v1/runs", "POST", requestInput("a1"));
    assert.equal(first.status, 202);
    assert.equal(
      (await f.call("/v1/runs", "POST", requestInput("a2"))).status,
      202,
    );
    assert.equal(
      (await f.call("/v1/runs", "POST", requestInput("a3"))).status,
      429,
    );
    assert.equal(
      (await f.call("/v1/runs", "POST", requestInput("b1"), "merchant-b"))
        .status,
      202,
    );
    assert.equal(
      (await f.call("/v1/runs", "POST", requestInput("b2"), "merchant-b"))
        .status,
      429,
    );
    assert.equal(
      (await f.call("/v1/runs", "POST", requestInput("a1"))).data.run.id,
      first.data.run.id,
    );
    assert.equal(f.service.status().queued, 3);
  } finally {
    await f.dispose();
  }
});

test("Agent worker concurrency is bounded and queued tasks run after an active task completes", async () => {
  const releases: (() => void)[] = [];
  let executing = 0,
    maximum = 0;
  const f = fixture(
    {
      execute: async (input) => {
        executing++;
        maximum = Math.max(maximum, executing);
        await new Promise<void>((resolve) => releases.push(resolve));
        executing--;
        return resultFor(input);
      },
    },
    { concurrency: 2 },
  );
  try {
    for (const key of ["one", "two", "three"])
      await f.call("/v1/runs", "POST", requestInput(key));
    f.service.start();
    await until(() => releases.length === 2);
    assert.equal(f.service.status().running, 2);
    assert.equal(f.service.status().queued, 1);
    releases[0]();
    await until(() => releases.length === 3);
    releases[1]();
    releases[2]();
    await until(() => f.service.status().running === 0);
    assert.equal(maximum, 2);
    assert.equal(f.service.status().queued, 0);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM agent_runs WHERE status='completed'",
        )
        .get()?.n,
      3,
    );
  } finally {
    for (const release of releases) release();
    await f.dispose();
  }
});

test("Restart preserves queued work and idempotency but fails interrupted work without replaying it", async () => {
  const folder = mkdtempSync(join(tmpdir(), "agent-service-test-")),
    path = join(folder, "agent.sqlite");
  const before = fixture({}, {}, path);
  let after: ReturnType<typeof fixture> | undefined;
  try {
    const interrupted = (
      await before.call("/v1/runs", "POST", requestInput("interrupted"))
    ).data.run;
    const queued = (
      await before.call("/v1/runs", "POST", requestInput("queued"))
    ).data.run;
    before.db
      .prepare("UPDATE agent_runs SET status='running' WHERE id=?")
      .run(interrupted.id);
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
    const r = await after.call(`/v1/runs/${interrupted.id}`);
    assert.equal(r.data.run.status, "failed");
    assert.match(r.data.run.error, /restarted/);
    assert.equal(
      (await after.call("/v1/runs", "POST", requestInput("interrupted"))).data
        .run.id,
      interrupted.id,
    );
    after.service.start();
    await until(
      async () =>
        (await after!.call(`/v1/runs/${queued.id}`)).data.run.status ===
        "completed",
    );
    assert.equal(calls, 1);
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

test("Graceful shutdown bounds in-flight execution and prevents late writes after database close", async () => {
  let release!: () => void;
  const f = fixture({
    execute: async (input) => {
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return resultFor(input);
    },
  });
  const job = (await f.call("/v1/runs", "POST", requestInput("slow"))).data.run;
  f.service.start();
  await until(() => Boolean(release));
  await f.service.close({ timeoutMs: 5 });
  assert.equal(
    f.db.prepare("SELECT status FROM agent_runs WHERE id=?").get(job.id)
      ?.status,
    "failed",
  );
  assert.equal((await f.call("/v1/profiles")).status, 503);
  f.db.close();
  release();
  await new Promise((r) => setTimeout(r, 10));
});

test("Quick compliance check stays local even with a configured model and a full durable queue", async () => {
  let executions = 0;
  const f = fixture(
    {
      execute: async (input) => {
        executions++;
        return resultFor(input);
      },
    },
    {
      queueLimit: 1,
      model: {
        provider: "openai-compatible",
        endpoint: "https://never-called.example/v1/chat/completions",
        model: "not-connected",
        apiKey: "never-leak-this-secret",
      },
    },
  );
  try {
    await f.call("/v1/runs", "POST", requestInput("fill"));
    const check = await f.call("/v1/check", "POST", {
      context: { ...context, transcript: "保证治疗疾病" },
    });
    assert.equal(check.status, 200);
    assert.equal(check.data.provider, "grounded-rules");
    assert.equal(check.data.modelConfigured, false);
    assert.equal(check.data.profileId, "standard");
    assert.equal(executions, 0);
    assert.equal(f.service.status().queued, 1);
    assert.ok(
      !JSON.stringify((await f.call("/health")).data).includes(
        "never-leak-this-secret",
      ),
    );
  } finally {
    await f.dispose();
  }
});

test("Execution and storage failures return safe errors without disclosing configuration or raw exceptions", async () => {
  const f = fixture({
    execute: () => {
      throw new Error("upstream password=never-disclose");
    },
  });
  const job = (await f.call("/v1/runs", "POST", requestInput("failure"))).data
    .run;
  f.service.start();
  await until(
    async () =>
      (await f.call(`/v1/runs/${job.id}`)).data.run.status === "failed",
  );
  const failed = await f.call(`/v1/runs/${job.id}`);
  assert.ok(!JSON.stringify(failed.data).includes("never-disclose"));
  const second = (await f.call("/v1/runs", "POST", requestInput("failure-2")))
    .data.run;
  await until(
    async () =>
      (await f.call(`/v1/runs/${second.id}`)).data.run.status === "failed",
  );
  assert.equal(f.service.status().running, 0);
  await f.service.close();
  f.db.close();
  const health = await f.call("/health");
  assert.equal(health.status, 503);
  assert.equal(health.data.available, false);
  assert.ok(!JSON.stringify(health.data).includes(serviceToken));
});

test("presenter dossiers require explicit authorization and remain frozen in prompt and run snapshots", async () => {
  const f = fixture();
  try {
    const presenter = {
      displayName: "合成测试主播",
      roleDescription: "验收讲解员",
      speakingStyle: "短句，先解释再举例",
      pace: "slow",
      authorizationReference: "synthetic-consent-01，仅合成验收",
      authorizationConfirmed: true,
    };
    assert.equal(
      (
        await f.call("/v1/profiles", "POST", {
          ...content,
          name: "获授权表达",
          kind: "brand",
          presenter: { ...presenter, authorizationConfirmed: false },
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.call("/v1/profiles", "POST", {
          ...content,
          name: "缺依据",
          kind: "brand",
          presenter: { ...presenter, authorizationReference: "" },
        })
      ).status,
      400,
    );
    const created = await f.call("/v1/profiles", "POST", {
      ...content,
      name: "获授权表达",
      kind: "brand",
      presenter,
    });
    assert.equal(created.status, 201);
    const id = created.data.profile.id;
    const run = await f.call(
      "/v1/runs",
      "POST",
      requestInput("presenter-snapshot", {
        profileId: id,
        mode: "rehearsal",
        version: 1,
      }),
    );
    assert.equal(run.status, 202);
    const next = await f.call("/v1/profiles/" + id + "/versions", "POST", {
      ...content,
      presenter: {
        ...presenter,
        displayName: "另一位合成主播",
        speakingStyle: "先提问再解释",
      },
    });
    assert.equal(next.status, 201);
    const snapshot = JSON.parse(
      String(
        f.db
          .prepare("SELECT input_json FROM agent_runs WHERE id=?")
          .get(run.data.run.id)!.input_json,
      ),
    );
    assert.deepEqual(snapshot.prompt.presenter, presenter);
    const versions = (await f.call("/v1/profiles/" + id + "/versions")).data
      .versions;
    assert.equal(versions[0].presenter.displayName, "另一位合成主播");
    assert.deepEqual(versions[1].presenter, presenter);
    assert.equal(
      (
        await f.call(
          "/v1/profiles/" + id + "/versions",
          "GET",
          undefined,
          "merchant-b",
        )
      ).status,
      404,
    );
  } finally {
    await f.dispose();
  }
});

test("revoking a profile stops every prompt version and queued work while preserving audit history", async () => {
  const f = fixture();
  try {
    const p = await f.brand();
    await f.call("/v1/profiles/" + p.id + "/versions/1/publish", "POST", {});
    const job = (
      await f.call(
        "/v1/runs",
        "POST",
        requestInput("revoked-queued", { profileId: p.id }),
      )
    ).data.run;
    const payload = { actorId: "owner-a", reason: "合成测试：授权撤回" };
    assert.equal(
      (
        await f.call(
          "/v1/profiles/" + p.id + "/revoke",
          "POST",
          payload,
          "merchant-b",
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.call("/v1/profiles/" + p.id + "/revoke", "POST", payload))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call("/v1/profiles/" + p.id + "/revoke", "POST", {
          ...payload,
          reason: "重复",
        })
      ).data.profile.revocation.reason,
      payload.reason,
    );
    assert.equal(
      (await f.call("/v1/runs/" + job.id)).data.run.status,
      "failed",
    );
    assert.equal((await f.call("/v1/runs/" + job.id)).data.run.stale, true);
    assert.equal(
      (
        await f.call(
          "/v1/runs",
          "POST",
          requestInput("new-revoked", {
            profileId: p.id,
            mode: "rehearsal",
            version: 1,
          }),
        )
      ).status,
      409,
    );
    assert.equal(
      (await f.call("/v1/profiles/" + p.id + "/versions", "POST", content))
        .status,
      409,
    );
    assert.equal(
      (await f.call("/v1/profiles/" + p.id + "/versions/1/publish", "POST", {}))
        .status,
      409,
    );
    assert.equal(
      (await f.call("/v1/check", "POST", { profileId: p.id, context })).status,
      409,
    );
    assert.equal(
      (await f.call("/v1/profiles/" + p.id + "/versions")).data.versions.length,
      1,
    );
    assert.throws(() => f.db.exec("DELETE FROM agent_profile_revocations"));
    assert.equal(
      (await f.call("/v1/profiles/standard/revoke", "POST", payload)).status,
      409,
    );
  } finally {
    await f.dispose();
  }
});
test("late short-generation output is discarded when its profile is revoked during execution", async () => {
  let resolve!: (r: AgentResult) => void;
  let captured: AgentExecutionInput | undefined;
  const f = fixture({
    execute: (input) => {
      captured = input;
      return new Promise<AgentResult>((r) => {
        resolve = r;
      });
    },
  });
  try {
    const p = await f.brand();
    const job = (
      await f.call(
        "/v1/runs",
        "POST",
        requestInput("in-flight-revoke", {
          profileId: p.id,
          mode: "rehearsal",
        }),
      )
    ).data.run;
    f.service.start();
    await until(() => !!captured);
    await f.call("/v1/profiles/" + p.id + "/revoke", "POST", {
      actorId: "owner-a",
      reason: "撤回测试",
    });
    resolve(resultFor(captured!));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const run = (await f.call("/v1/runs/" + job.id)).data.run;
    assert.equal(run.status, "failed");
    assert.equal(run.result, undefined);
    assert.equal(run.stale, true);
    assert.equal(
      f.db.prepare("SELECT result_json FROM agent_runs WHERE id=?").get(job.id)!
        .result_json,
      null,
    );
  } finally {
    if (captured) resolve(resultFor(captured));
    await f.dispose();
  }
});
