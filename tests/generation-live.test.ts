import { HTTPException } from "hono/http-exception";
import assert from "node:assert/strict";
import test from "node:test";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { createAgentService } from "../src/modules/agent/app.js";
import { loadAgentConfig } from "../src/modules/agent/config.js";
import type { GenerationProvider } from "../src/modules/agent/generation-provider.js";
import { openAgentDatabase } from "../src/modules/agent/persistence/database.js";
import type { AgentBridge } from "../src/platform/adapters/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";
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
