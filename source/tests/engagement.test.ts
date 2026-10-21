import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { seedDemo, createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
async function fixture(path = ":memory:") {
  const db = openDatabase(path);
  let now = Date.now();
  seedDemo(db);
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "engagement-test-at-least-32-characters",
    MERCHANT_CREDENTIALS: JSON.stringify({
      other: "other-test-key-at-least-24-characters",
    }),
  });
  const app = createApp(db, config, () => now);
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    if (method === "POST" && body === undefined) body = {};
    const r = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: (await r.json()) as any,
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const owner = (await call("/auth/demo", "POST", {})).cookie,
    other = (
      await call("/auth/merchant", "POST", {
        merchantId: "other",
        token: "other-test-key-at-least-24-characters",
      })
    ).cookie;
  const login = async () => (await call("/auth/viewer", "POST", {})).cookie;
  const v = await login();
  const m = (p: string, method = "GET", body?: unknown) =>
    call("/merchant/engagement" + p, method, body, owner);
  const view = (p = "", method = "GET", body?: unknown, cookie = v) =>
    call("/viewer/rooms/demo-room/engagement" + p, method, body, cookie);
  await call("/merchant/rooms/demo-room", "PATCH", { status: "live" }, owner);
  await m("/rooms/demo-room", "POST", {
    previousVersion: 0,
    enabled: true,
    points: 10,
    minWatchSeconds: 0,
    dailyLimit: 10,
  });
  const pulse = (cookie = v) =>
    call(
      "/viewer/rooms/demo-room/heartbeat",
      "POST",
      { visible: true, playing: true },
      cookie,
    );
  const gift = async (stock = 1) =>
    (
      await m("/gifts", "POST", {
        title: "合成验收礼品",
        description: "仅供自动验收，无真实发货",
        points: 7,
        stock,
        enabled: true,
      })
    ).data.id;
  return {
    db,
    call,
    m,
    view,
    v,
    other,
    login,
    pulse,
    gift,
    advance: (ms: number) => {
      now += ms;
    },
  };
}
test("daily check-in requires active eligible presence and writes points once under retries", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.view("/checkin", "POST")).status, 409);
    await f.pulse();
    const results = await Promise.all(
      Array.from({ length: 6 }, () => f.view("/checkin", "POST")),
    );
    assert.ok(results.every((r) => r.status === 200));
    assert.equal(results.filter((r) => !r.data.alreadyCheckedIn).length, 1);
    assert.equal((await f.view()).data.balance, 10);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM engagement_points").get()!.n,
      1,
    );
    assert.throws(() => f.db.exec("DELETE FROM engagement_points"));
    await f.m("/rooms/demo-room", "POST", {
      previousVersion: 1,
      enabled: true,
      points: 100,
      minWatchSeconds: 0,
      dailyLimit: 1,
    });
    assert.equal((await f.view("/checkin", "POST")).data.points, 10);
    const second = await f.login();
    await f.pulse(second);
    assert.equal(
      (await f.view("/checkin", "POST", undefined, second)).status,
      409,
    );
    assert.equal(
      (
        await f.m("/rooms/demo-room", "POST", {
          previousVersion: 1,
          enabled: false,
          points: 10,
          minWatchSeconds: 0,
          dailyLimit: 10,
        })
      ).status,
      409,
    );
  } finally {
    f.db.close();
  }
});
test("redemption reserves stock atomically, freezes price, cancels exactly once and isolates viewers", async () => {
  const f = await fixture();
  try {
    await f.pulse();
    await f.view("/checkin", "POST");
    const giftId = await f.gift();
    const request = { giftId, idempotencyKey: "reserve-one" };
    const first = await f.view("/redeem", "POST", request);
    assert.equal(first.status, 201);
    const r = first.data.redemption;
    assert.deepEqual(
      (await f.view("/redeem", "POST", request)).data,
      first.data,
    );
    assert.equal((await f.view()).data.balance, 3);
    assert.equal(
      (
        await f.view("/redeem", "POST", {
          giftId,
          idempotencyKey: "reserve-two",
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.view(
          "/redemptions/" + r.id + "/cancel",
          "POST",
          undefined,
          await f.login(),
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.m("/redemptions")).data.redemptions[0].code,
      undefined,
    );
    assert.equal(
      (
        await f.m("/redemptions/" + r.id + "/fulfill", "POST", {
          code: "wrong",
          note: "不能核销",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.view("/redemptions/" + r.id + "/cancel", "POST")).status,
      200,
    );
    assert.equal(
      (await f.view("/redemptions/" + r.id + "/cancel", "POST")).status,
      200,
    );
    assert.equal((await f.view()).data.balance, 10);
    assert.equal((await f.m("/gifts")).data.gifts[0].stock, 1);
    assert.equal(
      (
        await f.m("/redemptions/" + r.id + "/fulfill", "POST", {
          code: r.code,
          note: "已取消",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.m("/redemptions/" + r.id + "/history")).data.events.length,
      2,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/engagement/redemptions/" + r.id + "/history",
          "GET",
          undefined,
          f.other,
        )
      ).status,
      404,
    );
  } finally {
    f.db.close();
  }
});
test("simultaneous viewers cannot oversell and fulfilled gifts cannot refund points", async () => {
  const f = await fixture();
  try {
    const other = await f.login();
    for (const v of [f.v, other]) {
      await f.pulse(v);
      await f.view("/checkin", "POST", undefined, v);
    }
    const giftId = await f.gift();
    const outcomes = await Promise.all(
      [f.v, other].map((cookie) =>
        f.view("/redeem", "POST", { giftId, idempotencyKey: "one" }, cookie),
      ),
    );
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [201, 409]);
    const r = outcomes.find((x) => x.status === 201)!.data.redemption;
    assert.equal(
      (
        await f.m("/redemptions/" + r.id + "/fulfill", "POST", {
          code: r.code,
          note: "合成验收核销",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.m("/redemptions/" + r.id + "/fulfill", "POST", {
          code: r.code,
          note: "重复核销",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.m("/redemptions/" + r.id + "/cancel", "POST", {
          note: "不可退款",
        })
      ).status,
      409,
    );
    assert.equal((await f.m("/gifts")).data.gifts[0].stock, 0);
    assert.equal(
      f.db
        .prepare(
          "SELECT count(*) AS n FROM engagement_points WHERE reason='redemption'",
        )
        .get()!.n,
      1,
    );
  } finally {
    f.db.close();
  }
});

test("watch eligibility uses server time and new Shanghai day needs an active heartbeat", async () => {
  const f = await fixture();
  try {
    await f.m("/rooms/demo-room", "POST", {
      previousVersion: 1,
      enabled: true,
      points: 5,
      minWatchSeconds: 20,
      dailyLimit: 10,
    });
    await f.pulse();
    f.advance(10000);
    await f.pulse();
    assert.equal((await f.view("/checkin", "POST")).status, 409);
    f.advance(10000);
    await f.pulse();
    assert.equal((await f.view("/checkin", "POST")).status, 200);
    f.advance(86400000);
    assert.equal((await f.view("/checkin", "POST")).status, 409);
    await f.pulse();
    assert.equal((await f.view("/checkin", "POST")).status, 200);
    assert.equal((await f.view()).data.balance, 10);
  } finally {
    f.db.close();
  }
});
test("inventory editing refuses stale stock and persisted points and reservations survive reopen", async () => {
  const dir = mkdtempSync(join(tmpdir(), "engagement-")),
    path = join(dir, "db.sqlite");
  const f = await fixture(path);
  let closed = false;
  try {
    await f.pulse();
    await f.view("/checkin", "POST");
    const giftId = await f.gift();
    const before = (await f.m("/gifts")).data.gifts[0];
    await f.view("/redeem", "POST", { giftId, idempotencyKey: "persist-one" });
    const update = {
      title: "礼品新版",
      description: "新说明",
      points: 9,
      stock: 5,
      enabled: false,
      previousVersion: before.version,
      previousStock: before.stock,
    };
    assert.equal((await f.m("/gifts/" + giftId, "PATCH", update)).status, 409);
    assert.equal(
      (await f.m("/gifts/" + giftId, "PATCH", { ...update, previousStock: 0 }))
        .status,
      200,
    );
    assert.equal((await f.view()).data.redemptions[0].points, 7);
    f.db.close();
    closed = true;
    const reopened = openDatabase(path);
    try {
      assert.equal(
        reopened
          .prepare("SELECT sum(delta) AS balance FROM engagement_points")
          .get()!.balance,
        3,
      );
      assert.equal(
        reopened.prepare("SELECT state FROM engagement_redemptions").get()!
          .state,
        "reserved",
      );
      assert.equal(
        reopened
          .prepare("SELECT count(*) AS n FROM engagement_gift_history")
          .get()!.n,
        2,
      );
      assert.throws(() =>
        reopened.prepare("UPDATE engagement_checkins SET points=999").run(),
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (!closed) f.db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
