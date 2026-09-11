import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
test("team access revokes old sessions even after restoration and isolates owner authority", async () => {
  const db = openDatabase(":memory:");
  const token = "local-team-test-secret-over-32-characters";
  const config = loadConfig({
    SESSION_SECRET: token,
    MERCHANT_CREDENTIALS: JSON.stringify({
      owner: token,
      member: token,
      other: token,
    }),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      member: { merchantId: "owner", role: "presenter" },
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
    call("/auth/merchant", "POST", { merchantId: id, token });
  const cookie = (r: Response) => r.headers.get("set-cookie")!.split(";")[0];
  try {
    const owner = cookie(await login("owner")),
      member = cookie(await login("member")),
      other = cookie(await login("other"));
    assert.equal(
      (await call("/merchant/team", "GET", undefined, member)).status,
      403,
    );
    const body = { disabled: true, version: 0, reason: "测试停用成员账号" };
    assert.equal(
      (await call("/merchant/team/member", "PUT", body, other)).status,
      404,
    );
    assert.equal(
      (await call("/merchant/team/owner", "PUT", body, owner)).status,
      404,
    );
    assert.equal(
      (await call("/merchant/team/member", "PUT", body, owner)).status,
      200,
    );
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, member)).status,
      401,
    );
    assert.equal((await login("member")).status, 401);
    assert.equal(
      (await call("/merchant/team/member", "PUT", body, owner)).status,
      409,
    );
    assert.equal(
      (
        await call(
          "/merchant/team/member",
          "PUT",
          { ...body, disabled: false, version: 1 },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, member)).status,
      401,
    );
    const renewed = cookie(await login("member"));
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, renewed)).status,
      200,
    );
    const state = await (
      await call("/merchant/team", "GET", undefined, owner)
    ).json();
    assert.deepEqual(state, {
      members: [
        { actorId: "member", role: "presenter", disabled: false, version: 2 },
      ],
    });
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM team_access_events").get()!.n,
      2,
    );
    const history = await call(
      "/merchant/team/events",
      "GET",
      undefined,
      owner,
    );
    assert.equal(history.headers.get("cache-control"), "no-store");
    const events = (await history.json()) as any;
    assert.equal(events.items.length, 2);
    assert.equal(events.items[0].disabled, 0);
    assert.equal(events.items[0].actorId, "owner");
    assert.equal(
      (await call("/merchant/team/events", "GET", undefined, renewed)).status,
      403,
    );
    assert.equal(
      (
        (await (
          await call("/merchant/team/events", "GET", undefined, other)
        ).json()) as any
      ).items.length,
      0,
    );
    assert.equal(
      (await call("/merchant/team/events?before=-1", "GET", undefined, owner))
        .status,
      400,
    );
    const earlier = (await (
      await call(
        `/merchant/team/events?before=${events.items[0].id}`,
        "GET",
        undefined,
        owner,
      )
    ).json()) as any;
    assert.equal(earlier.items.length, 1);
    assert.equal(earlier.items[0].disabled, 1);
    assert.throws(() => db.exec("DELETE FROM team_access_events"));
  } finally {
    db.close();
  }
});
