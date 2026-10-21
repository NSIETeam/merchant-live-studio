import {
  createContentAuthorizationSync,
  contentAuthorizationIssue,
} from "../src/server/content-authorization.js";
import test from "node:test";
import assert from "node:assert/strict";
import { HTTPException } from "hono/http-exception";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { createAgentService } from "../src/agent/app.js";
import { openAgentDatabase } from "../src/agent/db.js";
import { loadAgentConfig } from "../src/agent/config.js";
import type { GenerationProvider } from "../src/agent/generation-provider.js";
import type { AgentBridge } from "../src/server/services/agent-bridge.js";
async function setup(configured = true) {
  const agentDB = openAgentDatabase(":memory:"),
    agentConfig = loadAgentConfig({});
  const provider: GenerationProvider = {
    configured,
    label: "synthetic-integration-test",
    async execute(_input, outline) {
      return outline
        ? {
            paragraphs: [
              { kind: "fact", text: "测试卡片为蓝色。", factIds: ["blue"] },
              {
                kind: "transition",
                text: "仅用于软件验收。".repeat(30),
                factIds: [],
              },
            ],
          }
        : {
            chapters: [
              { title: "认识卡片", objective: "介绍" },
              { title: "互动", objective: "问答" },
            ],
          };
    },
  };
  const agent = createAgentService(agentDB, agentConfig, {
    generationProvider: provider,
  });
  const bridge: AgentBridge = {
    async request<T>(
      tenant: string,
      path: string,
      method = "GET",
      body?: unknown,
    ): Promise<T> {
      const res = await agent.app.request(path, {
        method,
        headers: {
          authorization: `Bearer ${agentConfig.serviceToken}`,
          "x-studio-tenant": tenant,
          "content-type": "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      if (!res.ok)
        throw new HTTPException(res.status as 400 | 404 | 409, {
          message: "Synthetic bridge error",
        });
      return (await res.json()) as T;
    },
    async status() {
      return agent.status();
    },
  };
  const db = openDatabase(":memory:");
  seedDemo(db);
  const credentials = {
    writer: "writer-fixture-token-not-a-real-secret",
    checker: "checker-fixture-token-not-a-real-secret",
    foreign: "foreign-fixture-token-not-a-real-secret",
  };
  const config = loadConfig({
    DEMO_MODE: "true",
    MERCHANT_CREDENTIALS: JSON.stringify(credentials),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      writer: { merchantId: "demo", role: "editor" },
      checker: { merchantId: "demo", role: "reviewer" },
    }),
  });
  const app = createApp(db, config, Date.now, bridge);
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const response = await app.request("/api" + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const login = async (id: keyof typeof credentials) =>
    (
      await call("/auth/merchant", "POST", {
        merchantId: id,
        token: credentials[id],
      })
    ).cookie;
  const writer = await login("writer"),
    checker = await login("checker"),
    foreign = await login("foreign");
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = writer,
  ) => call("/merchant/content" + path, method, body, cookie);
  const product = (
    await request("/products", "POST", {
      name: "蓝色卡片",
      sku: "generation-test",
      category: "测试资料",
      facts: [
        {
          id: "blue",
          text: "测试卡片为蓝色。",
          evidence: "合成验收设定",
          approved: true,
        },
      ],
    })
  ).data.product;
  const plan = (
    await request("/plans", "POST", {
      productId: product.id,
      name: "测试计划",
      audience: "测试人员",
      totalDays: 1,
    })
  ).data.plan;
  const course = (
    await request(`/plans/${plan.id}/courses`, "POST", {
      title: "测试课",
      dayIndex: 1,
      objective: "验收",
    })
  ).data.course;
  const base = `/courses/${course.id}`;
  const create = () =>
    request(base + "/generation", "POST", {
      profileId: "standard",
      promptVersion: 1,
      targetCharacters: 500,
      chapterCount: 2,
      idempotencyKey: "live-test-generation",
    });
  async function complete(id: string) {
    for (let i = 0; i < 200; i++) {
      const result = await request(base + "/generation/" + id);
      if (result.data.job.status === "completed") return result.data.job;
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.fail("Integrated generation did not finish");
  }
  return {
    db,
    agentDB,
    call,
    request,
    writer,
    checker,
    foreign,
    base,
    product,
    create,
    complete,
    close: async () => {
      await agent.close();
      agentDB.close();
      db.close();
    },
  };
}

test("Live imports a completed Agent manuscript once as a fresh independently reviewed draft", async () => {
  const f = await setup();
  try {
    const created = await f.create();
    assert.equal(created.status, 202);
    const id = created.data.job.id;
    await f.complete(id);
    const imported = await f.request(
      f.base + `/generation/${id}/import`,
      "POST",
      {},
    );
    assert.equal(imported.status, 201);
    assert.equal(imported.data.scriptVersion, 1);
    const detail = (await f.request(f.base)).data;
    assert.equal(detail.versions.length, 1);
    assert.equal(detail.versions[0].confirmation, undefined);
    assert.equal(detail.versions[0].paragraphs.length, 4);
    assert.equal(
      (await f.request(f.base + `/generation/${id}/import`, "POST", {})).data
        .scriptVersion,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_script_versions").get()!
        .n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT actor_id FROM content_generation_imports").get()!
        .actor_id,
      "writer",
    );
    assert.throws(() => f.db.exec("DELETE FROM content_generation_imports"));
    assert.equal(
      (
        await f.request(
          f.base + `/generation/${id}`,
          "GET",
          undefined,
          f.foreign,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          f.base + `/generation/${id}/import`,
          "POST",
          {},
          f.checker,
        )
      ).status,
      403,
    );
    const list = (await f.request(f.base + "/generation")).data;
    assert.equal(list.imports[0].receipt.scriptVersion, 1);
    assert.equal(list.jobs[0].input, undefined);
  } finally {
    await f.close();
  }
});

test("generation import refuses concurrent edits and changed evidence without creating a receipt", async () => {
  for (const change of ["script", "product"] as const) {
    const f = await setup();
    try {
      const id = (await f.create()).data.job.id;
      await f.complete(id);
      if (change === "script") {
        assert.equal(
          (
            await f.request(f.base + "/scripts", "POST", {
              baseVersion: 0,
              productVersion: 1,
              changeNote: "并行编辑",
              paragraphs: [
                {
                  id: "manual",
                  kind: "transition",
                  text: "人工新写的开场。",
                  factIds: [],
                },
              ],
            })
          ).status,
          201,
        );
      } else {
        assert.equal(
          (
            await f.request(`/products/${f.product.id}/versions`, "POST", {
              baseVersion: 1,
              name: "新版卡片",
              sku: "generation-test",
              category: "测试资料",
              facts: [],
            })
          ).status,
          201,
        );
      }
      assert.equal(
        (await f.request(f.base + `/generation/${id}/import`, "POST", {}))
          .status,
        409,
      );
      assert.equal(
        f.db
          .prepare("SELECT count(*) AS n FROM content_generation_imports")
          .get()!.n,
        0,
      );
    } finally {
      await f.close();
    }
  }
});

test("Live exposes waiting configuration without fabricated paragraphs and rejects incomplete import", async () => {
  const f = await setup(false);
  try {
    const id = (await f.create()).data.job.id;
    const page = (await f.request(f.base + "/generation")).data;
    assert.equal(page.configured, false);
    assert.equal(page.jobs[0].status, "waiting_configuration");
    assert.equal(page.jobs[0].completedChapters, 0);
    assert.equal(
      (await f.request(f.base + `/generation/${id}/import`, "POST", {})).status,
      409,
    );
    assert.equal(
      (await f.request(f.base + `/generation/${id}/cancel`, "POST", {})).data
        .job.status,
      "cancelled",
    );
  } finally {
    await f.close();
  }
});

test("completed long manuscripts cannot be newly imported after their expression authorization is revoked", async () => {
  const f = await setup();
  try {
    const owner = (await f.call("/auth/demo", "POST", {})).cookie;
    const p = (
      await f.call(
        "/merchant/agent/profiles",
        "POST",
        {
          name: "合成授权方案",
          kind: "brand",
          systemPrompt: "事实优先",
          styleGuide: "短句",
          audience: "验收人员",
          examples: [],
        },
        owner,
      )
    ).data.profile;
    const id = (
      await f.request(f.base + "/generation", "POST", {
        profileId: p.id,
        promptVersion: 1,
        targetCharacters: 500,
        chapterCount: 2,
        idempotencyKey: "revoked-long-import",
      })
    ).data.job.id;
    await f.complete(id);
    assert.equal(
      (
        await f.call(
          "/merchant/agent/profiles/" + p.id + "/revoke",
          "POST",
          { reason: "合成测试撤回" },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.request(f.base + "/generation/" + id)).data.job
        .authorizationRevoked,
      true,
    );
    assert.equal(
      (await f.request(f.base + "/generation/" + id + "/import", "POST", {}))
        .status,
      409,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM content_generation_imports")
        .get()!.n,
      0,
    );
  } finally {
    await f.close();
  }
});

test("revocation invalidates imported reviewed bindings and descendant script versions without erasing history", async () => {
  const f = await setup();
  try {
    const owner = (await f.call("/auth/demo", "POST", {})).cookie;
    const p = (
      await f.call(
        "/merchant/agent/profiles",
        "POST",
        {
          name: "已导入授权测试",
          kind: "brand",
          systemPrompt: "事实优先",
          styleGuide: "短句",
          audience: "验收",
          examples: [],
        },
        owner,
      )
    ).data.profile;
    const id = (
      await f.request(f.base + "/generation", "POST", {
        profileId: p.id,
        promptVersion: 1,
        targetCharacters: 500,
        chapterCount: 2,
        idempotencyKey: "bound-revocation",
      })
    ).data.job.id;
    await f.complete(id);
    assert.equal(
      (await f.request(f.base + "/generation/" + id + "/import", "POST", {}))
        .status,
      201,
    );
    const detail = (await f.request(f.base)).data,
      script = detail.versions[0],
      courseId = detail.course.id;
    assert.equal(script.stale, false);
    assert.equal(
      (
        await f.request(f.base + "/scripts/1/submit", "POST", {
          note: "已核对合成资料",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          {
            note: "合成依据与表达核对通过",
            decision: "approved",
            acknowledged: true,
          },
          f.checker,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          "/rooms/demo-room/binding",
          "POST",
          { courseId, scriptVersion: 1 },
          owner,
        )
      ).status,
      201,
    );
    assert.equal(
      (
        await f.request(f.base + "/scripts", "POST", {
          baseVersion: 1,
          productVersion: 1,
          changeNote: "对已生成稿作人工修订",
          paragraphs: script.paragraphs,
        })
      ).status,
      201,
    );
    assert.equal(
      (await f.request("/rooms/demo-room/binding")).data.binding.stale,
      false,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/agent/profiles/" + p.id + "/revoke",
          "POST",
          { reason: "主播授权撤回" },
          owner,
        )
      ).status,
      200,
    );
    const stale = (await f.request(f.base)).data.versions;
    assert.ok(stale.every((s: any) => s.stale));
    assert.ok(
      stale.every((s: any) => s.authorizationIssue.includes("授权已撤回")),
    );
    const bound = (await f.request("/rooms/demo-room/binding")).data.binding;
    assert.equal(bound.stale, true);
    assert.ok(bound.script.authorizationIssue.includes("授权已撤回"));
    assert.equal(
      (
        await f.request(
          "/rooms/demo-room/binding",
          "POST",
          { courseId, scriptVersion: 1 },
          owner,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(f.base + "/scripts/2/submit", "POST", {
          note: "不能通过修订清洗来源",
        })
      ).status,
      409,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_script_versions").get()!
        .n,
      2,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_review_decisions").get()!
        .n,
      1,
    );
    assert.throws(() => f.db.exec("DELETE FROM content_profile_revocations"));
  } finally {
    await f.close();
  }
});

test("authorization refresh deduplicates checks and fails closed for generated sources without disabling live controls", async () => {
  const f = await setup();
  try {
    const id = (await f.create()).data.job.id;
    await f.complete(id);
    await f.request(f.base + "/generation/" + id + "/import", "POST", {});
    const detail = (await f.request(f.base)).data;
    assert.equal(detail.versions[0].stale, false);
    let now = Date.now(),
      calls = 0,
      available = true;
    const profiles = [
      {
        id: "standard",
        name: "通用",
        kind: "standard",
        publishedVersion: 1,
        latestVersion: 1,
        createdAt: now,
      },
    ];
    const bridge: AgentBridge = {
      async request<T>() {
        calls++;
        if (!available) throw new Error("synthetic outage");
        return { profiles } as T;
      },
      async status() {
        throw new Error("unused");
      },
    };
    const sync = createContentAuthorizationSync(f.db, bridge, () => now);
    await Promise.all(Array.from({ length: 5 }, () => sync("demo")));
    assert.equal(calls, 1);
    assert.equal(
      contentAuthorizationIssue(f.db, "demo", detail.course.id, 1, now),
      undefined,
    );
    now += 6000;
    available = false;
    await sync("demo");
    assert.match(
      contentAuthorizationIssue(f.db, "demo", detail.course.id, 1, now) || "",
      /暂未确认/,
    );
    assert.equal(
      contentAuthorizationIssue(f.db, "foreign", detail.course.id, 1, now),
      undefined,
    );
    const owner = (await f.call("/auth/demo", "POST", {})).cookie;
    assert.equal(
      (
        await f.call(
          "/merchant/rooms/demo-room",
          "PATCH",
          { status: "live" },
          owner,
        )
      ).status,
      200,
    );
    now += 2000;
    available = true;
    await sync("demo");
    assert.equal(
      contentAuthorizationIssue(f.db, "demo", detail.course.id, 1, now),
      undefined,
    );
    assert.match(
      contentAuthorizationIssue(
        f.db,
        "demo",
        detail.course.id,
        1,
        now + 10001,
      ) || "",
      /暂未确认/,
    );
  } finally {
    await f.close();
  }
});

test("authorization revocation only affects the imported version and its descendants, not earlier manual drafts", async () => {
  const f = await setup();
  try {
    const owner = (await f.call("/auth/demo", "POST", {})).cookie;
    await f.request(f.base + "/scripts", "POST", {
      baseVersion: 0,
      productVersion: 1,
      changeNote: "独立手写稿",
      paragraphs: [
        {
          id: "manual",
          kind: "transition",
          text: "先查看测试资料。",
          factIds: [],
        },
      ],
    });
    const p = (
      await f.call(
        "/merchant/agent/profiles",
        "POST",
        {
          name: "来源边界测试",
          kind: "brand",
          systemPrompt: "事实优先",
          styleGuide: "短句",
          audience: "验收",
          examples: [],
        },
        owner,
      )
    ).data.profile;
    const id = (
      await f.request(f.base + "/generation", "POST", {
        profileId: p.id,
        promptVersion: 1,
        targetCharacters: 500,
        chapterCount: 2,
        idempotencyKey: "manual-before-import",
      })
    ).data.job.id;
    await f.complete(id);
    assert.equal(
      (await f.request(f.base + "/generation/" + id + "/import", "POST", {}))
        .data.scriptVersion,
      2,
    );
    await f.call(
      "/merchant/agent/profiles/" + p.id + "/revoke",
      "POST",
      { reason: "来源范围验收" },
      owner,
    );
    const versions = (await f.request(f.base)).data.versions;
    assert.equal(versions[0].stale, true);
    assert.equal(versions[1].stale, false);
    assert.equal(versions[1].authorizationIssue, undefined);
  } finally {
    await f.close();
  }
});
