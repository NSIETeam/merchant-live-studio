import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { openDatabase } from "../src/server/db.js";
import { loadConfig } from "../src/server/config.js";
import { createApp, seedDemo } from "../src/server/app.js";
test("moderation freezes reopening, preserves failure results, retries safely and requires a different reviewer", async () => {
  let connected = true,
    kickFails = true,
    kicks = 0;
  const media = createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/v3/info") {
      res.end(
        JSON.stringify({
          version: "v1.21.0",
          started: new Date().toISOString(),
        }),
      );
    } else if (req.url?.startsWith("/v3/paths/get/")) {
      if (connected)
        res.end(
          JSON.stringify({
            name: "live/demo-room",
            online: true,
            source: { type: "rtmpConn", id: "test-source" },
          }),
        );
      else {
        res.statusCode = 404;
        res.end("{}");
      }
    } else if (req.url === "/v3/rtmp/conns/kick/test-source") {
      kicks++;
      if (kickFails) {
        res.statusCode = 500;
        res.end("{}");
      } else {
        connected = false;
        res.end("{}");
      }
    } else {
      res.statusCode = 404;
      res.end("{}");
    }
  });
  media.listen(0, "127.0.0.1");
  await once(media, "listening");
  const port = (media.address() as any).port;
  const db = openDatabase(":memory:");
  seedDemo(db);
  const token = "moderation-local-test-key-at-least-32";
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "moderation-test-session-secret-at-least-32",
      MEDIA_CONTROL_URL: `http://127.0.0.1:${port}`,
      MERCHANT_CREDENTIALS: JSON.stringify({
        reviewer: token,
        presenter: token,
        other: token,
      }),
      MERCHANT_MEMBERSHIPS: JSON.stringify({
        reviewer: { merchantId: "demo", role: "reviewer" },
        presenter: { merchantId: "demo", role: "presenter" },
      }),
    }),
  );
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const r = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: r.status,
      data: (await r.json()) as any,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  try {
    const owner = (await call("/auth/demo", "POST", {})).cookie;
    const login = async (merchantId: string) =>
      (await call("/auth/merchant", "POST", { merchantId, token })).cookie;
    const reviewer = await login("reviewer"),
      presenter = await login("presenter"),
      other = await login("other");
    const room = "/merchant/rooms/demo-room",
      base = room + "/moderation";
    await call(room, "PATCH", { status: "live" }, owner);
    const campaign = (
      await call(
        room + "/campaigns",
        "POST",
        {
          totalCents: 1000,
          count: 10,
          minWatchSeconds: 0,
          delaySeconds: 0,
          durationSeconds: 600,
        },
        owner,
      )
    ).data.campaign;
    const originalSecret = db
      .prepare("SELECT stream_secret FROM rooms WHERE id='demo-room'")
      .get()!.stream_secret;
    const action = {
      kind: "stop",
      note: "合成测试：现场表述需要核查和更正",
      evidenceReference: "TEST-INCIDENT-1",
      idempotencyKey: crypto.randomUUID(),
    };
    assert.equal((await call(base, "POST", action, presenter)).status, 403);
    assert.equal((await call(base, "POST", action, other)).status, 404);
    assert.equal((await call(base, "POST", action)).status, 401);
    const stop = await call(base, "POST", action, owner);
    assert.equal(stop.status, 201);
    assert.equal(stop.data.result.disconnected, 0);
    assert.equal(kicks, 1);
    assert.equal(
      db.prepare("SELECT status FROM rooms WHERE id='demo-room'").get()!.status,
      "ended",
    );
    assert.notEqual(
      db.prepare("SELECT stream_secret FROM rooms WHERE id='demo-room'").get()!
        .stream_secret,
      originalSecret,
    );
    assert.equal(
      db.prepare("SELECT status FROM campaigns WHERE id=?").get(campaign.id)!
        .status,
      "closed",
    );
    const release = {
      kind: "release",
      holdId: stop.data.id,
      note: "合成验收：检查处置后解除限制",
      evidenceReference: "TEST-REVIEW",
      idempotencyKey: crypto.randomUUID(),
    };
    assert.equal((await call(base, "POST", release, reviewer)).status, 409);
    assert.equal(
      (await call(base, "POST", action, owner)).data.id,
      stop.data.id,
    );
    assert.equal(kicks, 1);
    await call(room, "PATCH", { status: "draft" }, owner);
    assert.equal(
      (await call(room, "PATCH", { status: "live" }, presenter)).status,
      409,
    );
    kickFails = false;
    assert.equal(
      (await call(`${base}/${stop.data.id}/retry`, "POST", {}, reviewer)).data
        .result.disconnected,
      1,
    );
    assert.equal(kicks, 2);
    assert.equal((await call(base, "POST", release, owner)).status, 403);
    assert.equal((await call(base, "POST", release, reviewer)).status, 201);
    assert.equal(
      (await call(`${base}/${stop.data.id}/retry`, "POST", {}, reviewer))
        .status,
      409,
    );
    assert.equal(
      (await call(base, "GET", undefined, presenter)).data.hold,
      null,
    );
    assert.equal(
      (await call(room, "PATCH", { status: "live" }, presenter)).status,
      200,
    );
    assert.equal(
      (
        await call(
          base,
          "POST",
          { ...release, idempotencyKey: crypto.randomUUID() },
          reviewer,
        )
      ).status,
      409,
    );
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM moderation_results").get()!.n,
      2,
    );
    assert.throws(() => db.exec("DELETE FROM moderation_actions"));
    assert.throws(() =>
      db.exec("UPDATE moderation_results SET disconnected=1"),
    );
    assert.equal((await call(base, "GET", undefined, other)).status, 404);
  } finally {
    db.close();
    media.close();
    await once(media, "close");
  }
});
