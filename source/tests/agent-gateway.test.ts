import { test } from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { HttpAgentBridge } from "../src/server/services/agent-bridge.js";
import { openAgentDatabase } from "../src/agent/db.js";
import { createAgentService } from "../src/agent/app.js";
import { loadAgentConfig } from "../src/agent/config.js";
import { DEFAULT_PROMPT_CONTENT } from "../src/agent/core/index.js";
import type { AgentRun } from "../src/shared/agent.js";

function fixture() {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const agentDb = openAgentDatabase(":memory:");
  const agent = createAgentService(agentDb, loadAgentConfig({}));
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "independent-agent-test-secret-32-characters",
  });
  const bridge = new HttpAgentBridge(config, async (url, init) =>
    agent.app.request(url, init),
  );
  const live = createApp(db, config, Date.now, bridge);
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const response = await live.request(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const finish = async (id: string, cookie: string): Promise<AgentRun> => {
    for (let i = 0; i < 100; i++) {
      const { data } = await request(
        `/merchant/agent/runs/${id}`,
        "GET",
        undefined,
        cookie,
      );
      if (data.run.status === "completed" || data.run.status === "failed")
        return data.run;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error("Agent did not finish in test deadline");
  };
  return {
    db,
    agentDb,
    agent,
    live,
    request,
    finish,
    close: async () => {
      await agent.close();
      agentDb.close();
      db.close();
    },
  };
}

test("independent Agent profile versions, async runs, feedback and evidence withdrawal cross the gateway", async () => {
  const f = fixture();
  try {
    const cookie = (await f.request("/auth/demo", "POST", {})).cookie;
    const profile = (
      await f.request(
        "/merchant/agent/profiles",
        "POST",
        { ...DEFAULT_PROMPT_CONTENT, name: "测试品牌风格", kind: "brand" },
        cookie,
      )
    ).data.profile;
    assert.equal(profile.publishedVersion, null);
    const draft = await f.request(
      `/merchant/agent/profiles/${profile.id}/versions`,
      "POST",
      { ...DEFAULT_PROMPT_CONTENT, styleGuide: "温暖、简洁，不虚构亲历。" },
      cookie,
    );
    assert.equal(draft.data.version.version, 2);
    assert.equal(
      (
        await f.request(
          `/merchant/agent/profiles/${profile.id}/versions/2/publish`,
          "POST",
          {},
          cookie,
        )
      ).status,
      200,
    );
    const body = {
      profileId: profile.id,
      version: 1,
      mode: "rehearsal",
      idempotencyKey: "gateway-snapshot-one",
      transcript: "介绍容量",
    };
    const submitted = await f.request(
      "/merchant/rooms/demo-room/agent/runs",
      "POST",
      body,
      cookie,
    );
    assert.equal(submitted.status, 202);
    const run = await f.finish(submitted.data.run.id, cookie);
    assert.equal(run.status, "completed");
    assert.equal(run.promptVersion, 1);
    assert.equal(run.result?.provider, "grounded-rules");
    assert.equal(run.result?.modelConfigured, false);
    assert.ok(run.result?.factIds.length);
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/runs",
          "POST",
          body,
          cookie,
        )
      ).data.run.id,
      run.id,
    );
    assert.equal(
      (
        await f.request(
          `/merchant/agent/runs/${run.id}/feedback`,
          "POST",
          { rating: "useful", note: "依据清楚" },
          cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          `/merchant/agent/runs/${run.id}`,
          "GET",
          undefined,
          cookie,
        )
      ).data.run.feedback.rating,
      "useful",
    );
    const fact = run.result!.factIds[0];
    await f.request(
      `/merchant/facts/${fact}`,
      "PATCH",
      { approved: false },
      cookie,
    );
    assert.equal(
      (
        await f.request(
          `/merchant/agent/runs/${run.id}`,
          "GET",
          undefined,
          cookie,
        )
      ).data.run.stale,
      true,
    );
    assert.equal(
      (
        await f.request(
          `/merchant/rooms/demo-room/agent/latest`,
          "GET",
          undefined,
          cookie,
        )
      ).data.run,
      null,
    );
    assert.equal(
      (
        await f.request(
          `/merchant/agent/runs/${run.id}/feedback`,
          "POST",
          { rating: "needs_work", note: "事实已撤回" },
          cookie,
        )
      ).data.run.stale,
      true,
    );
    assert.equal(
      (await f.request(`/merchant/agent/runs/${run.id}`)).status,
      401,
    );
  } finally {
    await f.close();
  }
});

test("live play pages and reward claims remain usable when the Agent transport fails", async () => {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "agent-outage-test-secret-32-characters",
  });
  const bridge = new HttpAgentBridge(config, async () => {
    throw new Error("secret upstream endpoint must not appear");
  });
  const app = createApp(db, config, Date.now, bridge);
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const r = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  try {
    const m = (await request("/auth/demo", "POST", {})).cookie;
    assert.equal(
      (await request("/merchant/agent/status", "GET", undefined, m)).data
        .available,
      false,
    );
    const failed = await request(
      "/merchant/rooms/demo-room/copilot",
      "POST",
      { transcript: "介绍商品" },
      m,
    );
    assert.equal(failed.status, 503);
    assert.ok(!JSON.stringify(failed.data).includes("secret upstream"));
    assert.equal(
      (
        await request(
          "/merchant/rooms/demo-room",
          "PATCH",
          { status: "live" },
          m,
        )
      ).status,
      200,
    );
    assert.equal((await request("/public/rooms/demo-room")).status, 200);
    const campaign = (
      await request(
        "/merchant/rooms/demo-room/campaigns",
        "POST",
        {
          totalCents: 100,
          count: 1,
          minWatchSeconds: 0,
          delaySeconds: 0,
          durationSeconds: 60,
        },
        m,
      )
    ).data.campaign;
    const v = (await request("/auth/viewer", "POST", {})).cookie;
    await request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    assert.equal(
      (await request(`/viewer/campaigns/${campaign.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
    assert.equal(
      (await request("/channels")).data.channels.find(
        (c: any) => c.channel === "wechat",
      ).verifiedIdentity,
      false,
    );
  } finally {
    db.close();
  }
});

test("rehearsal drafts never replace the live card and replay/feedback preserve expired status", async () => {
  const f = fixture();
  try {
    const cookie = (await f.request("/auth/demo", "POST", {})).cookie;
    await f.request(
      "/merchant/rooms/demo-room",
      "PATCH",
      { status: "live" },
      cookie,
    );
    const body = {
      profileId: "standard",
      mode: "live",
      idempotencyKey: "published-live-proposal",
      transcript: "介绍参数",
    };
    const live = await f.finish(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/runs",
          "POST",
          body,
          cookie,
        )
      ).data.run.id,
      cookie,
    );
    const draft = await f.finish(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/runs",
          "POST",
          {
            ...body,
            mode: "rehearsal",
            idempotencyKey: "newer-rehearsal-draft",
          },
          cookie,
        )
      ).data.run.id,
      cookie,
    );
    assert.notEqual(live.id, draft.id);
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/latest",
          "GET",
          undefined,
          cookie,
        )
      ).data.run.id,
      live.id,
    );
    await f.request(
      "/merchant/rooms/demo-room",
      "PATCH",
      { status: "ended" },
      cookie,
    );
    const replay = await f.request(
      "/merchant/rooms/demo-room/agent/runs",
      "POST",
      body,
      cookie,
    );
    assert.equal(replay.data.run.id, live.id);
    assert.equal(replay.data.run.stale, true);
    const feedback = await f.request(
      `/merchant/agent/runs/${live.id}/feedback`,
      "POST",
      { rating: "useful", note: "旧场次的复盘" },
      cookie,
    );
    assert.equal(feedback.data.run.stale, true);
  } finally {
    await f.close();
  }
});
