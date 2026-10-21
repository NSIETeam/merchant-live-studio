import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
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

test("role changes revoke sessions, enforce new permissions and do not override reassigned memberships", async () => {
  const db = openDatabase(":memory:"),
    token = "role-change-test-token-longer-than-32";
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
  const login = async (id: string) => {
    const r = await call("/auth/merchant", "POST", { merchantId: id, token });
    assert.equal(r.status, 200);
    return {
      cookie: r.headers.get("set-cookie")!.split(";")[0],
      identity: await r.json(),
    };
  };
  try {
    const owner = await login("owner"),
      member = await login("member"),
      other = await login("other");
    const change = {
      role: "editor",
      disabled: false,
      version: 0,
      reason: "调整成员的工作职责",
    };
    assert.equal(
      (await call("/merchant/team/member", "PUT", change, member.cookie))
        .status,
      403,
    );
    assert.equal(
      (await call("/merchant/team/member", "PUT", change, other.cookie)).status,
      404,
    );
    assert.equal(
      (
        await call(
          "/merchant/team/member",
          "PUT",
          { ...change, role: "owner" },
          owner.cookie,
        )
      ).status,
      400,
    );
    assert.equal(
      (await call("/merchant/team/member", "PUT", change, owner.cookie)).status,
      200,
    );
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, member.cookie)).status,
      401,
    );
    const editor = await login("member");
    assert.equal(editor.identity.memberRole, "editor");
    assert.equal(
      (
        await call(
          "/merchant/content/products",
          "GET",
          undefined,
          editor.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (await call("/merchant/team/member", "PUT", change, owner.cookie)).status,
      409,
    );
    assert.equal(
      (
        await call(
          "/merchant/team/member",
          "PUT",
          { ...change, role: "analyst", version: 1 },
          owner.cookie,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          "/merchant/content/products",
          "GET",
          undefined,
          editor.cookie,
        )
      ).status,
      401,
    );
    const analyst = await login("member");
    assert.equal(analyst.identity.memberRole, "analyst");
    assert.equal(
      (
        await call(
          "/merchant/content/products",
          "GET",
          undefined,
          analyst.cookie,
        )
      ).status,
      403,
    );
    const history = await (
      await call("/merchant/team/events", "GET", undefined, owner.cookie)
    ).json();
    assert.equal(history.items[0].fromRole, "editor");
    assert.equal(history.items[0].toRole, "analyst");
    config.merchantMemberships!.member = {
      merchantId: "owner",
      role: "reviewer",
    };
    const reconfigured = await login("member");
    assert.equal(reconfigured.identity.memberRole, "reviewer");
    config.merchantMemberships!.member = {
      merchantId: "other",
      role: "reviewer",
    };
    assert.equal(
      (await call("/merchant/rooms", "GET", undefined, analyst.cookie)).status,
      401,
    );
    const moved = await login("member");
    assert.equal(moved.identity.memberRole, "reviewer");
    assert.equal(moved.identity.merchantId, "other");
    assert.equal(
      (
        await call(
          "/merchant/team/member",
          "PUT",
          { ...change, version: 2 },
          owner.cookie,
        )
      ).status,
      404,
    );
  } finally {
    db.close();
  }
});
