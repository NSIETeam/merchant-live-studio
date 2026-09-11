import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createApp,
  createStudio,
  seedDemo,
} from "../src/composition/studio.js";
import { createAgentService } from "../src/modules/agent/app.js";
import { loadAgentConfig } from "../src/modules/agent/config.js";
import { openAgentDatabase } from "../src/modules/agent/persistence/database.js";
import {
  HttpAgentBridge,
  type AgentBridge,
} from "../src/platform/adapters/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";
import type { AgentRun } from "../src/shared/agent.js";

const secret = "speech-provider-test-secret-32-characters";

function bridgeFixture(fail = false) {
  const state = { fail };
  const calls: { tenant: string; path: string; body: any }[] = [];
  const runs = new Map<string, AgentRun>();
  const bridge: AgentBridge = {
    async status() {
      return {
        available: !state.fail,
        modelConfigured: false,
        provider: "grounded-rules",
        queued: 0,
        running: 0,
        maxConcurrency: 2,
      };
    },
    async request<T>(
      tenant: string,
      path: string,
      _method = "GET",
      body?: any,
    ) {
      if (state.fail) throw new Error("private agent failure");
      calls.push({ tenant, path, body });
      if (path === "/v1/runs") {
        let run = runs.get(body.idempotencyKey);
        if (!run) {
          run = {
            id: `run-${runs.size + 1}`,
            roomId: body.context.roomId,
            profileId: body.profileId,
            promptVersion: 1,
            mode: "live",
            status: "queued",
            createdAt: Date.now(),
            contextDigest: "digest",
          };
          runs.set(body.idempotencyKey, run);
        }
        return { run } as T;
      }
      if (path.startsWith("/v1/runs?")) return { runs: [] } as T;
      throw new Error(`unexpected ${path}`);
    },
  };
  return { bridge, calls, setFail: (value: boolean) => (state.fail = value) };
}

function fixture(options: { failAgent?: boolean; dbPath?: string } = {}) {
  const db = openDatabase(options.dbPath || ":memory:");
  let now = Date.now();
  seedDemo(db);
  const upstream = bridgeFixture(options.failAgent);
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "speech-session-test-secret-32-characters",
    SPEECH_PROVIDER: "webhook",
    SPEECH_INGEST_SECRET: secret,
    SPEECH_AGENT_PROFILE_ID: "standard",
  });
  const studio = createStudio(db, config, () => now, upstream.bridge);
  const app = studio.app;
  const request = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) => {
    const response = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const login = async () => (await request("/auth/demo", "POST", {})).cookie;
  const live = async (cookie: string) =>
    request("/merchant/rooms/demo-room", "PATCH", { status: "live" }, cookie);
  const segment = (eventId = "event-1") => ({
    roomId: "demo-room",
    eventId,
    text: "这款随行杯是全网第一，适合每一位妈妈。",
    startedOffsetMs: 1000,
    endedOffsetMs: 2500,
    final: true,
  });
  return {
    app,
    db,
    config,
    studio,
    upstream,
    request,
    login,
    live,
    segment,
    advance: (milliseconds: number) => (now += milliseconds),
    async close() {
      await studio.close();
      db.close();
    },
  };
}

async function waitFor(
  check: () => boolean | Promise<boolean>,
  timeout = 1000,
) {
  const deadline = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

test("speech webhook authenticates, stores final segments and queues one idempotent live Agent run", async () => {
  const f = fixture();
  try {
    const merchant = await f.login();
    assert.equal((await f.live(merchant)).status, 200);
    assert.equal(
      (
        await f.app.request("/api/streams/speech/segments", {
          method: "POST",
          headers: {
            "content-type": "text/plain",
            authorization: `Bearer ${secret}`,
          },
          body: JSON.stringify(f.segment()),
        })
      ).status,
      415,
    );
    assert.equal(
      (await f.request("/streams/speech/segments", "POST", f.segment())).status,
      401,
    );
    assert.equal(
      (
        await f.request("/streams/speech/segments", "POST", f.segment(), "", {
          authorization: "Bearer wrong-secret",
        })
      ).status,
      401,
    );
    const accepted = await f.request(
      "/streams/speech/segments",
      "POST",
      f.segment(),
      "",
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(accepted.status, 202);
    assert.equal(accepted.data.duplicate, false);
    assert.equal(accepted.data.analysis.state, "pending");
    await waitFor(
      () =>
        Number(
          f.db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!
            .n,
        ) === 1,
    );
    assert.equal(f.upstream.calls.length, 1);
    assert.equal(f.upstream.calls[0].tenant, "demo");
    assert.equal(f.upstream.calls[0].body.context.transcript, f.segment().text);
    assert.equal(f.upstream.calls[0].body.mode, "live");

    const duplicate = await f.request(
      "/streams/speech/segments",
      "POST",
      f.segment(),
      "",
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.data.duplicate, true);
    assert.equal(duplicate.data.segment.id, accepted.data.segment.id);
    assert.equal(f.upstream.calls.length, 1);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segments").get()!.n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!.n,
      1,
    );
    assert.equal(
      (
        await f.request(
          "/streams/speech/segments",
          "POST",
          { ...f.segment(), text: "changed replay" },
          "",
          { authorization: `Bearer ${secret}` },
        )
      ).status,
      409,
    );

    const status = await f.request(
      "/merchant/rooms/demo-room/speech/status",
      "GET",
      undefined,
      merchant,
    );
    assert.equal(status.status, 200);
    assert.equal(status.data.latest.text, f.segment().text);
    assert.equal(status.data.latest.analysis.state, "queued");
    assert.equal(status.data.latest.currentSession, true);
    const publicRoom = await f.request("/public/rooms/demo-room");
    assert.ok(!JSON.stringify(publicRoom.data).includes(f.segment().text));
  } finally {
    await f.close();
  }
});

test("speech ingestion ignores interim text, rejects invalid state, and isolates merchant status", async () => {
  const f = fixture();
  try {
    const merchant = await f.login();
    const auth = { authorization: `Bearer ${secret}` };
    assert.equal(
      (
        await f.request(
          "/streams/speech/segments",
          "POST",
          { ...f.segment(), final: false },
          "",
          auth,
        )
      ).data.ignored,
      "interim",
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segments").get()!.n,
      0,
    );
    assert.equal(
      (
        await f.request(
          "/streams/speech/segments",
          "POST",
          f.segment(),
          "",
          auth,
        )
      ).status,
      409,
    );
    assert.equal((await f.live(merchant)).status, 200);
    assert.equal(
      (
        await f.request(
          "/streams/speech/segments",
          "POST",
          { ...f.segment(), endedOffsetMs: 999 },
          "",
          auth,
        )
      ).status,
      400,
    );
    const otherConfig = loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "speech-session-test-secret-32-characters",
      MERCHANT_CREDENTIALS: JSON.stringify({
        other: "other-merchant-access-key-32-characters",
      }),
    });
    const otherApp = createApp(f.db, otherConfig, Date.now, f.upstream.bridge);
    const login = await otherApp.request("/api/auth/merchant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        merchantId: "other",
        token: "other-merchant-access-key-32-characters",
      }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    assert.equal(
      (
        await otherApp.request("/api/merchant/rooms/demo-room/speech/status", {
          headers: { cookie },
        })
      ).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("live Agent receives a bounded current-session transcript window across ASR segment boundaries", async () => {
  const f = fixture();
  try {
    const merchant = await f.login();
    await f.live(merchant);
    const send = (eventId: string, text: string, offset: number) =>
      f.request(
        "/streams/speech/segments",
        "POST",
        {
          ...f.segment(eventId),
          text,
          startedOffsetMs: offset,
          endedOffsetMs: offset + 500,
        },
        "",
        { authorization: `Bearer ${secret}` },
      );
    await send("split-1", "这款产品在全网", 1000);
    await waitFor(() => f.upstream.calls.length === 1);
    await send("split-2", "销量排名第一。", 2000);
    await waitFor(() => f.upstream.calls.length === 2);
    assert.equal(
      f.upstream.calls[1].body.context.transcript,
      "这款产品在全网\n销量排名第一。",
    );

    await f.request(
      "/merchant/rooms/demo-room",
      "PATCH",
      { status: "ended" },
      merchant,
    );
    await f.request(
      "/merchant/rooms/demo-room",
      "PATCH",
      { status: "draft" },
      merchant,
    );
    f.advance(1);
    await f.live(merchant);
    await send("split-1", "新一场直播。", 1000);
    await waitFor(() => f.upstream.calls.length === 3);
    assert.equal(f.upstream.calls[2].body.context.transcript, "新一场直播。");
  } finally {
    await f.close();
  }
});

test("real local Agent flags a risky claim received through the speech boundary", async () => {
  const db = openDatabase(":memory:");
  const agentDb = openAgentDatabase(":memory:");
  seedDemo(db);
  const agent = createAgentService(agentDb, loadAgentConfig({}));
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "speech-real-agent-test-secret-32-characters",
    SPEECH_PROVIDER: "webhook",
    SPEECH_INGEST_SECRET: secret,
    SPEECH_AGENT_PROFILE_ID: "standard",
  });
  const bridge = new HttpAgentBridge(config, async (url, init) =>
    agent.app.request(url, init),
  );
  const studio = createStudio(db, config, Date.now, bridge);
  try {
    const login = await studio.app.request("/api/auth/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await studio.app.request("/api/merchant/rooms/demo-room", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "live" }),
    });
    const accepted = await studio.app.request("/api/streams/speech/segments", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({
        roomId: "demo-room",
        eventId: "real-agent-risk",
        text: "这款产品是全网第一，效果无人能比。",
        startedOffsetMs: 1000,
        endedOffsetMs: 2500,
        final: true,
      }),
    });
    assert.equal(accepted.status, 202);
    let latest: any = null;
    await waitFor(async () => {
      const response = await studio.app.request(
        "/api/merchant/rooms/demo-room/agent/latest",
        { headers: { cookie } },
      );
      latest = await response.json();
      return latest.run?.status === "completed";
    }, 2000);
    assert.equal(latest.available, true);
    assert.equal(latest.run.mode, "live");
    assert.equal(latest.run.result.provider, "grounded-rules");
    assert.ok(
      latest.run.result.alerts.some(
        (alert: any) => alert.level === "high" && /第一/.test(alert.phrase),
      ),
    );
  } finally {
    await studio.close();
    await agent.close();
    agentDb.close();
    db.close();
  }
});

test("Agent outage never rolls back a transcript and provider retry can recover analysis", async () => {
  const f = fixture({ failAgent: true });
  try {
    const merchant = await f.login();
    await f.live(merchant);
    const first = await f.request(
      "/streams/speech/segments",
      "POST",
      f.segment("outage-event"),
      "",
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(first.status, 202);
    assert.equal(first.data.analysis.state, "pending");
    await waitFor(
      () =>
        f.db.prepare("SELECT last_error FROM speech_analysis_jobs").get()
          ?.last_error === "agent_unavailable",
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segments").get()!.n,
      1,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!.n,
      0,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/speech/status",
          "GET",
          undefined,
          merchant,
        )
      ).data.latest.analysis.state,
      "retrying",
    );
    f.upstream.setFail(false);
    f.advance(2000);
    const recovered = await f.request(
      "/streams/speech/segments",
      "POST",
      f.segment("outage-event"),
      "",
      { authorization: `Bearer ${secret}` },
    );
    assert.equal(recovered.status, 200);
    assert.equal(recovered.data.duplicate, true);
    await waitFor(
      () =>
        Number(
          f.db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!
            .n,
        ) === 1,
    );
    assert.equal(f.upstream.calls.length, 1);
    assert.equal(
      f.db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!.n,
      1,
    );
  } finally {
    await f.close();
  }
});

test("v21 speech segments migrate into the durable dispatch queue and survive restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "speech-restart-"));
  const path = join(dir, "studio.sqlite");
  try {
    const first = fixture({ dbPath: path, failAgent: true });
    const merchant = await first.login();
    await first.live(merchant);
    await first.request(
      "/streams/speech/segments",
      "POST",
      first.segment("restart-event"),
      "",
      { authorization: `Bearer ${secret}` },
    );
    await waitFor(
      () =>
        first.db.prepare("SELECT last_error FROM speech_analysis_jobs").get()
          ?.last_error === "agent_unavailable",
    );
    await first.studio.close();
    first.db.exec(
      "DROP TABLE recording_deletion_events; DROP TABLE recording_deletion_requests; DROP TABLE recording_retention_hold_events; DROP TABLE recording_retention_holds; DROP TABLE speech_analysis_jobs; DELETE FROM schema_migrations WHERE version>=22",
    );
    first.db.close();

    const migrated = openDatabase(path);
    assert.equal(
      migrated.prepare("SELECT max(version) v FROM schema_migrations").get()!.v,
      23,
    );
    assert.equal(
      migrated.prepare("SELECT state FROM speech_analysis_jobs").get()!.state,
      "pending",
    );
    migrated.close();

    const second = fixture({ dbPath: path });
    const secondMerchant = await second.login();
    const status = await second.request(
      "/merchant/rooms/demo-room/speech/status",
      "GET",
      undefined,
      secondMerchant,
    );
    assert.equal(status.status, 200);
    assert.equal(status.data.latest.text, second.segment("restart-event").text);
    await second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("speech webhook acknowledges durable work before slow Agent processing and bounds dispatch concurrency", async () => {
  const db = openDatabase(":memory:");
  seedDemo(db);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  let active = 0,
    maxActive = 0,
    runNumber = 0;
  const bridge: AgentBridge = {
    async status() {
      return {
        available: true,
        modelConfigured: false,
        provider: "grounded-rules",
        queued: 0,
        running: active,
        maxConcurrency: 1,
      };
    },
    async request<T>(
      _tenant: string,
      path: string,
      _method = "GET",
      body?: any,
    ) {
      if (path !== "/v1/runs") throw new Error("unexpected path");
      active++;
      maxActive = Math.max(maxActive, active);
      await gate;
      active--;
      runNumber++;
      return {
        run: {
          id: `slow-run-${runNumber}`,
          roomId: body.context.roomId,
          profileId: body.profileId,
          promptVersion: 1,
          mode: "live",
          status: "queued",
          createdAt: Date.now(),
          contextDigest: "digest",
        },
      } as T;
    },
  };
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "speech-throughput-test-secret-32-characters",
    SPEECH_PROVIDER: "webhook",
    SPEECH_INGEST_SECRET: secret,
    SPEECH_AGENT_PROFILE_ID: "standard",
    SPEECH_DISPATCH_CONCURRENCY: "1",
  });
  const studio = createStudio(db, config, Date.now, bridge);
  try {
    const login = await studio.app.request("/api/auth/demo", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    await studio.app.request("/api/merchant/rooms/demo-room", {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ status: "live" }),
    });
    for (let index = 0; index < 3; index++) {
      const submission = studio.app.request("/api/streams/speech/segments", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify({
          roomId: "demo-room",
          eventId: `slow-${index}`,
          text: `最终分段 ${index}`,
          startedOffsetMs: index * 1000,
          endedOffsetMs: index * 1000 + 500,
          final: true,
        }),
      });
      const response = await Promise.race([
        submission,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("webhook waited for Agent")), 100),
        ),
      ]);
      assert.equal(response.status, 202);
    }
    assert.equal(
      db.prepare("SELECT count(*) n FROM speech_analysis_jobs").get()!.n,
      3,
    );
    await waitFor(() => active === 1);
    assert.equal(maxActive, 1);
    release();
    await waitFor(
      () =>
        Number(
          db.prepare("SELECT count(*) n FROM speech_segment_analyses").get()!.n,
        ) === 3,
    );
    assert.equal(maxActive, 1);
  } finally {
    release();
    await studio.close();
    db.close();
  }
});

test("speech provider remains explicitly unavailable when disabled", async () => {
  const db = openDatabase(":memory:");
  try {
    seedDemo(db);
    const config = loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "speech-disabled-test-secret-32-characters",
    });
    const app = createApp(db, config);
    const response = await app.request("/api/streams/speech/segments", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error, "实时语音接入尚未配置");
  } finally {
    db.close();
  }
});

test("enabled speech provider requires an independent strong secret", () => {
  assert.throws(
    () =>
      loadConfig({
        DEMO_MODE: "true",
        SESSION_SECRET: "speech-config-test-secret-32-characters",
        SPEECH_PROVIDER: "webhook",
        SPEECH_INGEST_SECRET: "short",
      }),
    /SPEECH_INGEST_SECRET/,
  );
});
