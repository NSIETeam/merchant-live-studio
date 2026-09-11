import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { memberMayAccess } from "../src/server/permissions.js";
test("complaints preserve receipts, isolate viewers and tenants, reject stale replies and duplicate mutations", async () => {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "complaints-tests-at-least-32-characters",
      MERCHANT_CREDENTIALS: JSON.stringify({
        other: "other-complaints-long-test-key",
      }),
    }),
  );
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const res = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return {
      status: res.status,
      data: (await res.json()) as any,
      cookie: res.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  try {
    const owner = (await call("/auth/demo", "POST", {})).cookie,
      v = (await call("/auth/viewer", "POST", {})).cookie,
      v2 = (await call("/auth/viewer", "POST", {})).cookie,
      other = (
        await call("/auth/merchant", "POST", {
          merchantId: "other",
          token: "other-complaints-long-test-key",
        })
      ).cookie;
    const path = "/viewer/rooms/demo-room/complaints",
      input = {
        category: "content",
        body: "合成测试：宣传内容缺乏依据",
        idempotencyKey: crypto.randomUUID(),
      };
    assert.equal((await call(path, "POST", input)).status, 401);
    const first = await call(path, "POST", input, v);
    assert.equal(first.status, 201);
    const id = first.data.complaint.id;
    assert.equal((await call(path, "POST", input, v)).data.complaint.id, id);
    assert.equal(
      (await call(path, "POST", { ...input, body: "另一条合成投诉内容" }, v))
        .status,
      409,
    );
    assert.equal((await call(path, "GET", undefined, v2)).data.items.length, 0);
    assert.equal(
      (
        await call(
          "/merchant/complaints/rooms/demo-room",
          "GET",
          undefined,
          other,
        )
      ).status,
      404,
    );
    const reply = "/merchant/complaints/" + id + "/reply";
    assert.equal(
      (
        await call(
          reply,
          "POST",
          {
            previousVersion: 1,
            state: "resolved",
            reply: "已核查并纠正，请查阅更正说明。",
          },
          other,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await call(
          reply,
          "POST",
          {
            previousVersion: 1,
            state: "resolved",
            reply: "已核查并纠正，请查阅更正说明。",
          },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          reply,
          "POST",
          {
            previousVersion: 1,
            state: "reviewing",
            reply: "重新受理检查内容。",
          },
          owner,
        )
      ).status,
      409,
    );
    const received = (await call(path, "GET", undefined, v)).data.items[0];
    assert.equal(received.events.length, 2);
    assert.equal(received.events[1].state, "resolved");
    assert.equal(received.viewer_id, undefined);
    assert.equal(received.events[1].actor_id, undefined);
    assert.throws(() => db.exec("DELETE FROM complaints"));
    assert.throws(() => db.exec("UPDATE complaint_events SET reply='changed'"));
    for (let i = 0; i < 4; i++)
      assert.equal(
        (
          await call(
            path,
            "POST",
            { ...input, idempotencyKey: crypto.randomUUID() },
            v,
          )
        ).status,
        201,
      );
    assert.equal(
      (
        await call(
          path,
          "POST",
          { ...input, idempotencyKey: crypto.randomUUID() },
          v,
        )
      ).status,
      429,
    );
    assert.equal((await call(path, "POST", input, v)).status, 201);
    for (const role of ["editor", "reviewer", "presenter", "analyst"] as const)
      assert.equal(
        memberMayAccess(
          role,
          "GET",
          "/api/merchant/complaints/rooms/demo-room",
        ),
        false,
      );
  } finally {
    db.close();
  }
});
