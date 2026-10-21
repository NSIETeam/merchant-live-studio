import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { test } from "node:test";
import {
  createApp,
  processSimulationJobs,
  seedDemo,
} from "../src/composition/studio.js";
import { MediaController, recordPresence } from "../src/modules/live/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";

const originalToken = "hardening-test-only-merchant-secret";
const replacementToken = "hardening-test-only-rotated-secret";

function fixture(env: NodeJS.ProcessEnv = {}) {
  const db = openDatabase(":memory:");
  let now = Date.now();
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "hardening-test-only-session-secret-32-chars",
    MERCHANT_CREDENTIALS: JSON.stringify({ seller: originalToken }),
    ...env,
  });
  seedDemo(db, now);
  const app = createApp(db, config, () => now);
  async function request(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
    headers: Record<string, string> = {},
    remoteAddress = "127.0.0.1",
  ) {
    const response = await app.request(
      `/api${path}`,
      {
        method,
        headers: {
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
      { incoming: { socket: { remoteAddress } } },
    );
    return {
      status: response.status,
      data: response.status === 204 ? null : await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const merchant = async () => (await request("/auth/demo", "POST", {})).cookie;
  const login = async (token = originalToken) =>
    request("/auth/merchant", "POST", { merchantId: "seller", token });
  const viewer = async () => (await request("/auth/viewer", "POST", {})).cookie;
  const setStatus = (cookie: string, status: "draft" | "live" | "ended") =>
    request("/merchant/rooms/demo-room", "PATCH", { status }, cookie);
  const heartbeat = (cookie: string, visible = true, playing = true) =>
    request(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible, playing },
      cookie,
    );
  const campaign = async (cookie: string, extra = {}) =>
    (
      await request(
        "/merchant/rooms/demo-room/campaigns",
        "POST",
        {
          totalCents: 1000,
          count: 10,
          minWatchSeconds: 10,
          delaySeconds: 0,
          durationSeconds: 600,
          ...extra,
        },
        cookie,
      )
    ).data.campaign;
  return {
    db,
    app,
    config,
    request,
    merchant,
    login,
    viewer,
    setStatus,
    heartbeat,
    campaign,
    advance: (ms: number) => (now += ms),
    now: () => now,
  };
}

test("logout revokes only that merchant session, including cookie replay after app recreation", async () => {
  const f = fixture();
  try {
    const first = await f.login();
    const second = await f.login();
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.notEqual(
      first.cookie,
      second.cookie,
      "independent logins need independent revocation IDs",
    );
    assert.equal(
      (await f.request("/auth/logout", "POST", {}, first.cookie)).status,
      200,
    );
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, first.cookie))
        .status,
      401,
    );
    assert.equal(
      (await f.request("/auth/me", "GET", undefined, first.cookie)).data
        .merchantId,
      null,
    );
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, second.cookie))
        .status,
      200,
    );
    const restartedApp = createApp(f.db, f.config);
    assert.equal(
      (
        await restartedApp.request("/api/merchant/rooms", {
          headers: { cookie: first.cookie },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await restartedApp.request("/api/merchant/rooms", {
          headers: { cookie: second.cookie },
        })
      ).status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("removing or rotating merchant credentials invalidates existing cookies", async () => {
  const f = fixture();
  try {
    const prior = await f.login();
    delete f.config.merchantCredentials.seller;
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, prior.cookie))
        .status,
      401,
    );
    assert.equal(
      (await f.request("/auth/me", "GET", undefined, prior.cookie)).data
        .merchantId,
      null,
    );
    f.config.merchantCredentials.seller = replacementToken;
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, prior.cookie))
        .status,
      401,
    );
    assert.equal((await f.login(originalToken)).status, 401);
    const replacement = await f.login(replacementToken);
    assert.equal(replacement.status, 200);
    assert.equal(
      (await f.request("/merchant/rooms", "GET", undefined, replacement.cookie))
        .status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("a new broadcast resets eligibility while keeping historical viewing, questions and settled claims", async () => {
  const f = fixture();
  try {
    const m = await f.merchant(),
      v = await f.viewer();
    await f.setStatus(m, "live");
    await f.heartbeat(v);
    f.advance(10000);
    assert.equal((await f.heartbeat(v)).data.watchSeconds, 10);
    const oldCampaign = await f.campaign(m);
    const oldClaim = await f.request(
      `/viewer/campaigns/${oldCampaign.id}/claim`,
      "POST",
      {},
      v,
    );
    assert.equal(oldClaim.status, 200);
    assert.equal(processSimulationJobs(f.db, f.now()), 1);
    await f.request(
      "/viewer/rooms/demo-room/questions",
      "POST",
      { text: "第一场保留的问题" },
      v,
    );
    const ledgerBefore = Number(
      f.db.prepare("SELECT count(*) AS n FROM ledger").get()?.n,
    );
    await f.setStatus(m, "ended");
    await f.setStatus(m, "draft");
    f.advance(60000);
    await f.setStatus(m, "live");
    const restarted = await f.heartbeat(v);
    assert.equal(restarted.data.watchSeconds, 0);
    assert.equal(restarted.data.totalWatchSeconds, 10);
    const current = await f.campaign(m);
    assert.equal(
      (await f.request(`/viewer/campaigns/${current.id}/claim`, "POST", {}, v))
        .status,
      403,
    );
    const history = await f.request(
      "/viewer/rooms/demo-room/claims",
      "GET",
      undefined,
      v,
    );
    assert.equal(history.data.claims[0].id, oldClaim.data.claim.id);
    assert.equal(history.data.claims[0].status, "simulated");
    assert.ok(
      Number(f.db.prepare("SELECT count(*) AS n FROM ledger").get()?.n) >=
        ledgerBefore,
    );
    const analytics = await f.request(
      "/merchant/rooms/demo-room/analytics",
      "GET",
      undefined,
      m,
    );
    assert.equal(analytics.data.totalWatchSeconds, 10);
    assert.equal(analytics.data.questions, 1);
    f.advance(10000);
    await f.heartbeat(v);
    assert.equal(
      (await f.request(`/viewer/campaigns/${current.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
    assert.equal(
      (
        await f.request(
          "/merchant/rooms/demo-room/analytics",
          "GET",
          undefined,
          m,
        )
      ).data.totalWatchSeconds,
      20,
    );
  } finally {
    f.db.close();
  }
});

test("fractional heartbeat intervals retain every millisecond and cross eligibility at the real boundary", async () => {
  const f = fixture();
  try {
    const m = await f.merchant(),
      v = await f.viewer();
    await f.setStatus(m, "live");
    await f.heartbeat(v);
    const c = await f.campaign(m, {
      minWatchSeconds: 500,
      durationSeconds: 900,
    });
    for (let i = 0; i < 100; i++) {
      f.advance(4999);
      await f.heartbeat(v);
    }
    const before = await f.heartbeat(v);
    assert.equal(before.data.watchSeconds, 499);
    assert.equal(before.data.totalWatchSeconds, 499);
    assert.equal(
      Number(
        f.db.prepare("SELECT session_watch_millis FROM visits").get()
          ?.session_watch_millis,
      ),
      499900,
    );
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      403,
    );
    f.advance(100);
    assert.equal((await f.heartbeat(v)).data.watchSeconds, 500);
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("playback qualification excludes hidden, paused, disconnected and long-gap periods", () => {
  const f = fixture();
  try {
    const room = { id: "demo-room", status: "live", live_started_at: 0 };
    let now = 100000;
    const beat = (
      delta: number,
      visible = true,
      playing = true,
      connected = true,
    ) => {
      now += delta;
      return recordPresence(
        f.db,
        room,
        "viewer-test",
        { visible, playing },
        true,
        connected,
        now,
      );
    };
    assert.equal(beat(0).watchSeconds, 0);
    assert.equal(beat(4999).watchSeconds, 4);
    assert.equal(beat(1, false).counting, false);
    assert.equal(
      beat(10000).watchSeconds,
      4,
      "returning to a visible page starts a new continuous interval",
    );
    assert.equal(beat(4999, true, false).counting, false);
    assert.equal(
      beat(4999).watchSeconds,
      4,
      "resuming does not retroactively credit paused time",
    );
    assert.equal(beat(4999, true, true, false).counting, false);
    assert.equal(
      beat(4999).watchSeconds,
      4,
      "reconnection does not backfill the lost signal period",
    );
    assert.equal(
      beat(20000).watchSeconds,
      24,
      "20-second boundary remains eligible",
    );
    assert.equal(
      beat(20001).watchSeconds,
      24,
      "a longer heartbeat gap adds no time",
    );
    assert.equal(beat(5000).watchSeconds, 29);
    assert.equal(
      Number(
        f.db.prepare("SELECT watch_millis FROM visits").get()?.watch_millis,
      ),
      29999,
    );
    room.status = "ended";
    assert.equal(beat(5000).counting, false);
    assert.equal(beat(5000).watchSeconds, 29);
  } finally {
    f.db.close();
  }
});

test("inactive or stale viewers cannot claim despite previously earning enough viewing time", async () => {
  const f = fixture();
  try {
    const m = await f.merchant(),
      v = await f.viewer();
    await f.setStatus(m, "live");
    await f.heartbeat(v);
    f.advance(10000);
    await f.heartbeat(v);
    const c = await f.campaign(m);
    await f.heartbeat(v, false);
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      403,
    );
    await f.heartbeat(v);
    f.advance(30001);
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      403,
    );
    await f.heartbeat(v);
    assert.equal(
      (await f.request(`/viewer/campaigns/${c.id}/claim`, "POST", {}, v))
        .status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("version-one databases migrate once, preserving historical rows and clearing unverifiable session eligibility", () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-hardening-migration-"));
  const filename = join(dir, "v1.sqlite");
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(filename);
    db.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL);
      INSERT INTO schema_migrations VALUES(1,1);
      CREATE TABLE rooms(id TEXT PRIMARY KEY,merchant_id TEXT NOT NULL,title TEXT NOT NULL,product_name TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'draft',stream_secret TEXT NOT NULL,created_at INTEGER NOT NULL,live_started_at INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE visits(room_id TEXT NOT NULL,viewer_id TEXT NOT NULL,first_seen INTEGER NOT NULL,last_seen INTEGER NOT NULL,watch_seconds INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(room_id,viewer_id));
      INSERT INTO rooms VALUES('historic-room','seller','Historic room','Product','live','migration-test-only-placeholder',1000,1000);
      INSERT INTO visits VALUES('historic-room','historic-viewer',1000,22000,21);
    `);
    db.close();
    db = undefined;
    for (let i = 0; i < 2; i++) {
      db = openDatabase(filename);
      const visit = db.prepare("SELECT * FROM visits").get();
      assert.equal(visit?.watch_seconds, 21);
      assert.equal(visit?.watch_millis, 21000);
      assert.equal(visit?.session_watch_millis, 0);
      assert.equal(visit?.active, 0);
      assert.equal(db.prepare("SELECT count(*) AS n FROM rooms").get()?.n, 1);
      assert.equal(
        db
          .prepare(
            "SELECT count(*) AS n FROM schema_migrations WHERE version=2",
          )
          .get()?.n,
        1,
      );
      assert.doesNotThrow(() =>
        db!.prepare("SELECT * FROM revoked_sessions").all(),
      );
      db.close();
      db = undefined;
    }
  } finally {
    db?.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a burst of new viewers neither consumes nor is blocked by the merchant login limit", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 61; i++)
      assert.equal((await f.request("/auth/viewer", "POST", {})).status, 200);
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await f.request("/auth/merchant", "POST", {
            merchantId: "seller",
            token: "invalid",
          })
        ).status,
        401,
      );
    assert.equal((await f.login()).status, 429);
    assert.equal((await f.request("/auth/viewer", "POST", {})).status, 200);
    f.advance(60000);
    assert.equal((await f.login()).status, 200);
  } finally {
    f.db.close();
  }
});

test("only an explicitly trusted proxy can supply the client IP used for anonymous login limits", async () => {
  const f = fixture({ TRUSTED_PROXY_IPS: "127.0.0.1" });
  const badLogin = { merchantId: "seller", token: "invalid" };
  try {
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await f.request("/auth/merchant", "POST", badLogin, "", {
            "x-real-ip": "192.0.2.1",
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await f.request("/auth/merchant", "POST", badLogin, "", {
          "x-real-ip": "192.0.2.1",
        })
      ).status,
      429,
    );
    assert.equal(
      (
        await f.request("/auth/merchant", "POST", badLogin, "", {
          "x-real-ip": "192.0.2.2",
        })
      ).status,
      401,
    );
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await f.request(
            "/auth/merchant",
            "POST",
            badLogin,
            "",
            { "x-real-ip": `192.0.2.${i + 1}` },
            "198.51.100.3",
          )
        ).status,
        401,
      );
    assert.equal(
      (
        await f.request(
          "/auth/merchant",
          "POST",
          badLogin,
          "",
          { "x-real-ip": "192.0.2.200" },
          "198.51.100.3",
        )
      ).status,
      429,
    );
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await f.request("/auth/merchant", "POST", badLogin, "", {
            "x-real-ip": "not-an-ip",
            "x-forwarded-for": `192.0.2.${i + 1}`,
          })
        ).status,
        401,
      );
    assert.equal(
      (
        await f.request("/auth/merchant", "POST", badLogin, "", {
          "x-real-ip": "not-an-ip",
          "x-forwarded-for": "192.0.2.201",
        })
      ).status,
      429,
    );
  } finally {
    f.db.close();
  }
});

test("minting viewer cookies cannot reset the merchant password-attempt budget", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 60; i++)
      assert.equal(
        (
          await f.request("/auth/merchant", "POST", {
            merchantId: "seller",
            token: "invalid",
          })
        ).status,
        401,
      );
    const v = await f.viewer();
    assert.equal(
      (
        await f.request(
          "/auth/merchant",
          "POST",
          { merchantId: "seller", token: originalToken },
          v,
        )
      ).status,
      429,
    );
  } finally {
    f.db.close();
  }
});

test("merchant campaign deadlines include the same authoritative clock as the public audience endpoint", async () => {
  const f = fixture();
  try {
    const m = await f.merchant();
    f.advance(120000);
    const c = await f.campaign(m, { delaySeconds: 60 });
    const privateResult = await f.request(
      "/merchant/rooms/demo-room/campaigns",
      "GET",
      undefined,
      m,
    );
    const publicResult = await f.request("/public/rooms/demo-room");
    assert.equal(privateResult.data.serverTime, f.now());
    assert.equal(publicResult.data.serverTime, f.now());
    assert.equal(c.opensAt - privateResult.data.serverTime, 60000);
  } finally {
    f.db.close();
  }
});

test("media control reports failed kicks without claiming an active stream was disconnected", async () => {
  const nativeFetch = globalThis.fetch;
  const config = loadConfig({
    MEDIA_CONTROL_URL: "http://media-control.test",
    DEMO_MODE: "false",
  });
  try {
    for (const status of [401, 500, 404]) {
      const calls: string[] = [];
      globalThis.fetch = async (input, init) => {
        const url = String(input);
        calls.push(`${init?.method || "GET"} ${url}`);
        if (url.includes("/paths/get/"))
          return Response.json({
            name: "live/demo-room",
            ready: true,
            source: { type: "rtmpConn", id: "connection-test" },
          });
        return new Response(null, { status });
      };
      const result = await new MediaController(config).disconnect("demo-room");
      assert.equal(
        result.disconnected,
        false,
        `kick HTTP ${status} must not be reported as a disconnected active publisher`,
      );
      assert.ok(result.message);
      assert.ok(
        calls.some(
          (call) =>
            call.includes("POST ") && call.includes("/rtmp/conns/kick/"),
        ),
      );
    }
    globalThis.fetch = async () => {
      throw new Error("local simulated timeout");
    };
    assert.equal(
      (await new MediaController(config).disconnect("demo-room")).disconnected,
      false,
    );
    globalThis.fetch = async () => new Response(null, { status: 404 });
    assert.equal(
      (await new MediaController(config).disconnect("demo-room")).disconnected,
      true,
      "a missing path already has no publisher",
    );
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("SRS control reports the exact room and verifies publisher removal", async () => {
  const nativeFetch = globalThis.fetch;
  const config = loadConfig({
    STREAM_PROVIDER: "srs",
    MEDIA_CONTROL_URL: "http://srs-control.test",
    MEDIA_CONTROL_USERNAME: "operator",
    MEDIA_CONTROL_PASSWORD: "private-test-password",
    DEMO_MODE: "false",
  });
  const expectedAuth = `Basic ${Buffer.from("operator:private-test-password").toString("base64")}`;
  try {
    const calls: Array<{ url: string; method: string; auth: string }> = [];
    let disconnected = false;
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      calls.push({
        url,
        method: init?.method || "GET",
        auth: new Headers(init?.headers).get("authorization") || "",
      });
      if (url.endsWith("/api/v1/versions"))
        return Response.json({ code: 0, version: "6.0.191" });
      if (url.includes("/api/v1/clients/cid-42")) {
        disconnected = true;
        return Response.json({ code: 0 });
      }
      return Response.json({
        code: 0,
        streams: disconnected
          ? []
          : [
              {
                app: "live",
                name: "other-room",
                clients: 9,
                publish: { active: true, cid: "cid-41" },
              },
              {
                app: "live",
                name: "target-room",
                clients: 3,
                publish: { active: true, cid: "cid-42" },
              },
            ],
      });
    };

    const controller = new MediaController(config);
    assert.equal(await controller.readyForAdmission(), true);
    const state = await controller.status("target-room");
    assert.equal(state.configured, true);
    assert.equal(state.connected, true);
    assert.equal(state.viewers, 2);
    assert.equal(typeof state.checkedAt, "number");
    assert.deepEqual(await controller.disconnect("target-room"), {
      disconnected: true,
    });
    assert.ok(
      calls.some(
        (call) =>
          call.method === "DELETE" &&
          call.url.endsWith("/api/v1/clients/cid-42") &&
          call.auth === expectedAuth,
      ),
    );
    assert.ok(calls.every((call) => call.auth === expectedAuth));
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test("SRS control configuration and responses fail closed", async () => {
  assert.throws(
    () =>
      loadConfig({
        MEDIA_CONTROL_URL: "http://user:password@srs-control.test",
      }),
    /without credentials/,
  );
  assert.throws(
    () =>
      loadConfig({
        MEDIA_CONTROL_USERNAME: "operator",
      }),
    /Configure both/,
  );
  assert.throws(
    () =>
      loadConfig({
        NODE_ENV: "production",
        DEMO_MODE: "false",
        APP_ORIGIN: "https://example.test",
        SESSION_SECRET: "srs-production-session-secret-at-least-32",
        MERCHANT_CREDENTIALS: JSON.stringify({
          owner: "srs-production-owner-secret-at-least-24",
        }),
        STREAM_PROVIDER: "srs",
        MEDIA_CONTROL_URL: "https://public-control.example",
        MEDIA_CONTROL_USERNAME: "operator",
        MEDIA_CONTROL_PASSWORD: "private-test-password",
      }),
    /private host/,
  );
  const nativeFetch = globalThis.fetch;
  const config = loadConfig({
    STREAM_PROVIDER: "srs",
    MEDIA_CONTROL_URL: "http://srs-control.test",
    DEMO_MODE: "false",
  });
  try {
    globalThis.fetch = async () =>
      Response.json({ code: 1061, data: { streams: [] } });
    const state = await new MediaController(config).status("target-room");
    assert.equal(state.connected, null);
    assert.match(state.message || "", /暂时无法读取/);
    const result = await new MediaController(config).disconnect("target-room");
    assert.equal(result.disconnected, false);
    assert.ok(result.message);
    globalThis.fetch = async () =>
      new Response("{}", {
        headers: { "Content-Length": String(256 * 1024 + 1) },
      });
    const oversized = await new MediaController(config).status("target-room");
    assert.equal(oversized.connected, null);
  } finally {
    globalThis.fetch = nativeFetch;
  }
});
