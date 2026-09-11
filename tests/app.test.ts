import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  createApp,
  expireCampaigns,
  processSimulationJobs,
  seedDemo,
  WeChatPaymentProvider,
} from "../src/composition/studio.js";
import { createStreamAdapter } from "../src/modules/live/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";

function fixture(
  agentBridge?: import("../src/platform/adapters/public.js").AgentBridge,
) {
  const db = openDatabase(":memory:");
  let now = Date.now();
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "test-only-secret-32-characters-long",
    STREAM_AUTH_SECRET: "engine-test-secret",
    MERCHANT_CREDENTIALS: JSON.stringify({
      other: "test-other-merchant-token-123456",
    }),
  });
  seedDemo(db, now);
  const app = createApp(db, config, () => now, agentBridge);
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
  ) {
    const response = await app.request(`/api${path}`, {
      method,
      headers: {
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    return {
      status: response.status,
      data,
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const merchant = async () => (await request("/auth/demo", "POST", {})).cookie;
  const viewer = async () => (await request("/auth/viewer", "POST", {})).cookie;
  const live = async (cookie: string) =>
    request("/merchant/rooms/demo-room", "PATCH", { status: "live" }, cookie);
  const campaign = async (cookie: string, extra = {}) =>
    (
      await request(
        "/merchant/rooms/demo-room/campaigns",
        "POST",
        {
          totalCents: 1000,
          count: 10,
          minWatchSeconds: 0,
          delaySeconds: 0,
          durationSeconds: 600,
          ...extra,
        },
        cookie,
      )
    ).data.campaign;
  return {
    db,
    config,
    request,
    merchant,
    viewer,
    live,
    campaign,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}
test("merchant authentication and every owned resource reject another tenant", async () => {
  const f = fixture();
  try {
    assert.equal((await f.request("/merchant/rooms")).status, 401);
    const merchant = await f.merchant(),
      viewer = await f.viewer();
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, viewer)).status,
      401,
    );
    const other = (
      await f.request("/auth/merchant", "POST", {
        merchantId: "other",
        token: "test-other-merchant-token-123456",
      })
    ).cookie;
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, other)).data.rooms
        .length,
      0,
    );
    for (const path of [
      "stream",
      "facts",
      "campaigns",
      "analytics",
      "ledger",
      "questions",
    ])
      assert.equal(
        (
          await f.request(
            `/merchant/rooms/demo-room/${path}`,
            "GET",
            undefined,
            other,
          )
        ).status,
        404,
        path,
      );
    const c = await f.campaign(merchant);
    assert.equal(
      (await f.request(`/merchant/campaigns/${c.id}/close`, "POST", {}, other))
        .status,
      404,
    );
    const fact = (
      await f.request(
        "/merchant/rooms/demo-room/facts",
        "GET",
        undefined,
        merchant,
      )
    ).data.facts[0];
    assert.equal(
      (
        await f.request(
          `/merchant/facts/${fact.id}`,
          "PATCH",
          { approved: false },
          other,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room",
          "PATCH",
          { status: "live" },
          other,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/copilot",
          "POST",
          { transcript: "test" },
          other,
        )
      ).status,
      404,
    );
  } finally {
    f.db.close();
  }
});
test("public room never exposes secrets, merchant identity, facts or presenter suggestions", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    const secret = (
      await f.request("/merchant/rooms/demo-room/stream", "GET", undefined, m)
    ).data.streamKey;
    const publicData = (await f.request("/public/rooms/demo-room")).data;
    const encoded = JSON.stringify(publicData);
    assert.ok(!encoded.includes(secret));
    assert.ok(!encoded.includes("merchantId"));
    assert.ok(!encoded.includes("facts"));
    assert.ok(!encoded.includes("suggestion"));
  } finally {
    f.db.close();
  }
});
test("CSRF origin, content-type, cookie tampering and oversized bodies are rejected", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    assert.equal(
      (
        await f.request(
          "/merchant/rooms",
          "POST",
          { title: "bad", productName: "bad" },
          m,
          { origin: "https://evil.test" },
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request("/auth/demo", "POST", undefined)).status,
      415,
    );
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, m + "tampered"))
        .status,
      401,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/rooms",
          "POST",
          { title: "x".repeat(40000) },
          m,
        )
      ).status,
      413,
    );
  } finally {
    f.db.close();
  }
});
test("room creation is durable and generated stream config uses distinct publish secret", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    const created = await f.request(
      "/merchant/rooms",
      "POST",
      { title: "新直播间", productName: "新品" },
      m,
    );
    assert.equal(created.status, 201);
    const s = (
      await f.request(
        `/merchant/rooms/${created.data.room.id}/stream`,
        "GET",
        undefined,
        m,
      )
    ).data;
    assert.ok(s.streamKey.includes("?token="));
    assert.ok(!s.playbackUrl.includes("token="));
    assert.ok(s.playbackUrl.endsWith("/index.m3u8"));
  } finally {
    f.db.close();
  }
  const dir = mkdtempSync(join(tmpdir(), "live-studio-test-"));
  try {
    let db = openDatabase(join(dir, "test.sqlite"));
    seedDemo(db);
    db.close();
    db = openDatabase(join(dir, "test.sqlite"));
    assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get()?.n, 1);
    db.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("eligibility credits only live, visible, continuous server time", async () => {
  const f = fixture();
  try {
    const m = await f.merchant(),
      v = await f.viewer();
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    f.advance(19000);
    await f.live(m);
    f.advance(1000);
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          v,
        )
      ).data.watchSeconds,
      0,
    );
    f.advance(5000);
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          v,
        )
      ).data.watchSeconds,
      5,
    );
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          v,
        )
      ).data.watchSeconds,
      5,
    );
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: false },
      v,
    );
    f.advance(5000);
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          v,
        )
      ).data.watchSeconds,
      5,
    );
    f.advance(30000);
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          v,
        )
      ).data.watchSeconds,
      5,
    );
    const c = await f.campaign(m, { minWatchSeconds: 10 });
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      403,
    );
    f.advance(5000);
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
  } finally {
    f.db.close();
  }
});
test("concurrent requests exhaust exactly the integer-cent pool; replay and outbox are idempotent", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    await f.live(m);
    const c = await f.campaign(m, { totalCents: 1234, count: 20 });
    const viewers = [];
    for (let i = 0; i < 30; i++) {
      const v = await f.viewer();
      await f.request(
        "/viewer/rooms/demo-room/heartbeat",
        "POST",
        { visible: true },
        v,
      );
      viewers.push(v);
    }
    const results = await Promise.all(
      viewers.map((v) =>
        f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v),
      ),
    );
    const won = results.filter((r) => r.status === 200);
    assert.equal(won.length, 20);
    assert.equal(results.filter((r) => r.status === 409).length, 10);
    assert.equal(
      won.reduce((n, r) => n + r.data.claim.amountCents, 0),
      1234,
    );
    assert.ok(
      won.every(
        (r) =>
          Number.isInteger(r.data.claim.amountCents) &&
          r.data.claim.amountCents > 0,
      ),
    );
    const replay = await f.request(
      `/viewer/campaigns/${c.id}/claim`,
      "POST",
      {},
      viewers[0],
    );
    assert.equal(replay.data.claim.id, results[0].data.claim.id);
    assert.equal(processSimulationJobs(f.db, f.now()), 20);
    assert.equal(processSimulationJobs(f.db, f.now()), 0);
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM ledger WHERE claim_id IS NOT NULL")
        .get()?.n,
      40,
    );
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/claims",
          "GET",
          undefined,
          viewers[0],
        )
      ).data.claims[0].status,
      "simulated",
    );
    const pool = f.db
      .prepare(
        "SELECT remaining_cents,remaining_count FROM campaigns WHERE id=?",
      )
      .get(c.id);
    assert.equal(pool?.remaining_cents, 0);
    assert.equal(pool?.remaining_count, 0);
  } finally {
    f.db.close();
  }
});
test("failure inside reservation transaction rolls back claim, pool, ledger and outbox", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    await f.live(m);
    const c = await f.campaign(m),
      v = await f.viewer();
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    f.db.exec(
      `CREATE TRIGGER fail_job BEFORE INSERT ON payout_jobs BEGIN SELECT RAISE(ABORT,'forced-outbox-failure'); END;`,
    );
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      500,
    );
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM claims").get()?.n, 0);
    assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger").get()?.n, 1);
    assert.equal(
      f.db.prepare("SELECT remaining_cents FROM campaigns WHERE id=?").get(c.id)
        ?.remaining_cents,
      1000,
    );
  } finally {
    f.db.close();
  }
});
test("expiration returns only unclaimed budget exactly once and preserves existing claims", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    await f.live(m);
    const c = await f.campaign(m, { durationSeconds: 30 }),
      v = await f.viewer();
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    const amount = (
      await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v)
    ).data.claim.amountCents;
    f.advance(31000);
    expireCampaigns(f.db, f.now());
    expireCampaigns(f.db, f.now());
    await f.request(`/merchant/campaigns/${c.id}/close`, "POST", {}, m);
    const returned = f.db
      .prepare(
        "SELECT sum(amount_cents) AS n,count(*) AS count FROM ledger WHERE credit='simulation_budget_returned'",
      )
      .get();
    assert.equal(Number(returned?.n) + amount, 1000);
    assert.equal(returned?.count, 1);
    const later = await f.viewer();
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, later))
        .status,
      409,
    );
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
  } finally {
    f.db.close();
  }
});
test("campaign validation, countdown, and non-live claims fail", async () => {
  const f = fixture();
  try {
    const m = await f.merchant(),
      v = await f.viewer();
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/campaigns",
          "POST",
          {
            totalCents: 5,
            count: 10,
            minWatchSeconds: 0,
            delaySeconds: 0,
            durationSeconds: 600,
          },
          m,
        )
      ).status,
      400,
    );
    const c = await f.campaign(m, { delaySeconds: 10 });
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      409,
    );
    f.advance(10000);
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      409,
    );
  } finally {
    f.db.close();
  }
});
test("Agent gateway sends only owned, approved facts and rejects client context injection", async () => {
  let received: any;
  const f = fixture({
    async request<T>(
      _tenant: string,
      _path: string,
      _method?: string,
      body?: unknown,
    ): Promise<T> {
      received = { tenant: _tenant, path: _path, body };
      return { suggestion: "test-agent-reply" } as T;
    },
    async status() {
      return {
        available: true,
        modelConfigured: false,
        provider: "grounded-rules",
        queued: 0,
        running: 0,
        maxConcurrency: 2,
      };
    },
  });
  try {
    const m = await f.merchant();
    const result = await f.request(
      "/merchant/rooms/demo-room/copilot",
      "POST",
      { transcript: "当前话术" },
      m,
    );
    assert.equal(result.status, 200);
    assert.equal(received.tenant, "demo");
    assert.equal(received.path, "/v1/check");
    assert.ok(
      received.body.context.facts.every(
        (fact: any) => fact.approved && fact.evidence,
      ),
    );
    assert.ok(JSON.stringify(received.body).includes("500 mL"));
    assert.ok(!JSON.stringify(received.body).includes("12 小时"));
    assert.ok(!JSON.stringify(received.body).includes("stream_secret"));
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/agent/runs",
          "POST",
          {
            profileId: "standard",
            mode: "live",
            idempotencyKey: "fake-context-attempt",
            transcript: "",
            context: { facts: [{ approved: true, text: "forged" }] },
          },
          m,
        )
      ).status,
      400,
    );
  } finally {
    f.db.close();
  }
});
test("stream hooks require trusted engine, correct room/token, live state; rotation rejects old token", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    const stream = (
      await f.request("/merchant/rooms/demo-room/stream", "GET", undefined, m)
    ).data;
    const token = stream.streamKey.split("?")[1];
    const body = { action: "publish", path: "live/demo-room", query: token };
    assert.equal(
      (await f.request("/streams/mediamtx/auth?secret=wrong", "POST", body))
        .status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/streams/mediamtx/auth?secret=engine-test-secret",
          "POST",
          body,
        )
      ).status,
      403,
    );
    await f.live(m);
    assert.equal(
      (
        await f.request(
          "/streams/mediamtx/auth?secret=engine-test-secret",
          "POST",
          body,
        )
      ).status,
      204,
    );
    const srs = {
      action: "on_publish",
      app: "live",
      stream: "demo-room",
      param: `?${token}`,
    };
    assert.equal(
      (
        await f.request(
          "/streams/srs/publish?secret=engine-test-secret",
          "POST",
          srs,
        )
      ).data.code,
      0,
    );
    await f.request("/merchant/rooms/demo-room/stream/rotate", "POST", {}, m);
    assert.equal(
      (
        await f.request(
          "/streams/mediamtx/auth?secret=engine-test-secret",
          "POST",
          body,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.request(
          "/streams/srs/publish?secret=engine-test-secret",
          "POST",
          srs,
        )
      ).status,
      403,
    );
    assert.ok(
      createStreamAdapter({
        ...f.config,
        streamProvider: "srs",
        streamHlsBase: "http://localhost:8080/live",
      })
        .playbackUrl("demo-room")
        .endsWith("/live/demo-room.m3u8"),
    );
  } finally {
    f.db.close();
  }
});
test("verified viewer sessions have independent limits behind the same reverse proxy", async () => {
  const f = fixture();
  try {
    const a = await f.viewer(),
      b = await f.viewer();
    for (let i = 0; i < 301; i++)
      await f.request(
        "/viewer/rooms/demo-room/heartbeat",
        "POST",
        { visible: true },
        a,
      );
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          a,
        )
      ).status,
      429,
    );
    assert.equal(
      (
        await f.request(
          "/viewer/rooms/demo-room/heartbeat",
          "POST",
          { visible: true },
          b,
        )
      ).status,
      200,
    );
  } finally {
    f.db.close();
  }
});
test("actual analytics and questions reflect audience interactions", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    await f.live(m);
    const v = await f.viewer();
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    f.advance(5000);
    await f.request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true },
      v,
    );
    await f.request(
      "/viewer/rooms/demo-room/questions",
      "POST",
      { text: "容量多大？" },
      v,
    );
    const a = (
      await f.request(
        "/merchant/rooms/demo-room/analytics",
        "GET",
        undefined,
        m,
      )
    ).data;
    assert.equal(a.uniqueViewers, 1);
    assert.equal(a.onlineViewers, 1);
    assert.equal(a.averageWatchSeconds, 5);
    assert.equal(a.questions, 1);
    assert.ok(a.timeline.length >= 1);
    assert.ok(a.timeline.every((p: { viewers: number }) => p.viewers === 1));
  } finally {
    f.db.close();
  }
});
test("real payments fail closed, configuration blocks demo production, notify never changes records", async () => {
  const f = fixture();
  try {
    const before = f.db.prepare("SELECT count(*) AS n FROM ledger").get()?.n;
    assert.equal(
      (await f.request("/payments/wechat/notify", "POST", { state: "SUCCESS" }))
        .status,
      501,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM ledger").get()?.n,
      before,
    );
    const p = new WeChatPaymentProvider();
    await assert.rejects(
      p.createTransfer({
        merchantId: "x",
        outBillNo: "x",
        amountCents: 1,
        verifiedRecipientId: "x",
      }),
    );
    await assert.rejects(p.queryTransfer("x", "x"));
    await assert.rejects(p.verifyAndDecodeNotification({}, new Uint8Array()));
    assert.throws(() => loadConfig({ PAYMENT_PROVIDER: "wechat" }));
    assert.throws(() =>
      loadConfig({
        NODE_ENV: "production",
        DEMO_MODE: "true",
        SESSION_SECRET: "test-secret-at-least-32-characters",
      }),
    );
  } finally {
    f.db.close();
  }
});
