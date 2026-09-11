import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { loadConfig } from "../src/server/config.js";
import { createApp } from "../src/server/app.js";
test("personal home persists by actor and tenant, rejects stale devices and unauthorized modules", async () => {
  const db = openDatabase(":memory:");
  const token = "home-test-local-token-longer-than-32";
  const config = loadConfig({
    SESSION_SECRET: token,
    MERCHANT_CREDENTIALS: JSON.stringify({
      a: token,
      b: token,
      c: token,
      one: token,
      two: token,
    }),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      a: { merchantId: "one", role: "analyst" },
      b: { merchantId: "one", role: "reviewer" },
      c: { merchantId: "two", role: "reviewer" },
    }),
  });
  const app = createApp(db, config);
  const call = (path: string, method = "GET", body?: unknown, cookie = "") =>
    app.request("/api" + path, {
      method,
      headers: { cookie, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  const login = async (id: string) =>
    (await call("/auth/merchant", "POST", { merchantId: id, token })).headers
      .get("set-cookie")!
      .split(";")[0];
  try {
    const a = await login("a"),
      b = await login("b"),
      c = await login("c");
    assert.equal((await call("/merchant/home")).status, 401);
    assert.deepEqual(
      await (await call("/merchant/home", "GET", undefined, a)).json(),
      { modules: ["shortcuts", "rooms"], shortcuts: ["analytics"], version: 0 },
    );
    db.prepare(
      "INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at) VALUES(?,?,?,?,?,?)",
    ).run("room-one", "one", "test", "test", "test", 1);
    assert.equal(
      (await call("/merchant/home/progress", "GET", undefined, a)).status,
      403,
    );
    assert.deepEqual(
      await (await call("/merchant/home/progress", "GET", undefined, b)).json(),
      { products: 0, drafts: 0, rooms: 1, bindings: 0 },
    );
    assert.deepEqual(
      await (await call("/merchant/home/progress", "GET", undefined, c)).json(),
      { products: 0, drafts: 0, rooms: 0, bindings: 0 },
    );
    assert.equal(
      (
        await call(
          "/merchant/home",
          "PUT",
          { modules: ["setup"], shortcuts: [], version: 0 },
          a,
        )
      ).status,
      403,
    );
    const layout = {
      modules: ["analytics", "rooms"],
      shortcuts: [],
      version: 0,
    };
    assert.equal((await call("/merchant/home", "PUT", layout, a)).status, 200);
    assert.equal((await call("/merchant/home", "PUT", layout, a)).status, 409);
    assert.equal(
      (
        await call(
          "/merchant/home",
          "PUT",
          { ...layout, version: 1, modules: ["rewards"] },
          a,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          "/merchant/home",
          "PUT",
          { ...layout, version: 1, actorId: "b" },
          a,
        )
      ).status,
      400,
    );
    assert.equal(
      (
        await call(
          "/merchant/home",
          "PUT",
          { ...layout, version: 1, modules: ["rooms", "rooms"] },
          a,
        )
      ).status,
      400,
    );
    for (const cookie of [b, c])
      assert.equal(
        (
          (await (
            await call("/merchant/home", "GET", undefined, cookie)
          ).json()) as any
        ).version,
        0,
      );
    const newApp = createApp(db, config);
    const reloaded = await newApp.request("/api/merchant/home", {
      headers: { cookie: a },
    });
    assert.equal(reloaded.headers.get("cache-control"), "no-store");
    assert.deepEqual(await reloaded.json(), { ...layout, version: 1 });
    assert.equal(
      (
        await call(
          "/merchant/home",
          "PUT",
          { modules: [], shortcuts: [], version: 1 },
          a,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        (await (
          await call("/merchant/home", "GET", undefined, a)
        ).json()) as any
      ).modules.length,
      0,
    );
  } finally {
    db.close();
  }
});
