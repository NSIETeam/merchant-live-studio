import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { memberMayAccess } from "../src/platform/identity/public.js";
test("complaints preserve receipts, isolate viewers and tenants, reject stale replies and duplicate mutations", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "kaopu-complaints-")),
    "studio.sqlite",
  );
  const db = openDatabase(path);
  let now = 1_800_000_000_000;
  seedDemo(db, now);
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "complaints-tests-at-least-32-characters",
      MERCHANT_CREDENTIALS: JSON.stringify({
        other: "other-complaints-long-test-key",
        reviewer: "reviewer-complaints-long-test-key",
      }),
      MERCHANT_MEMBERSHIPS: JSON.stringify({
        reviewer: { merchantId: "demo", role: "reviewer" },
      }),
    }),
    () => now,
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
      ).cookie,
      reviewer = (
        await call("/auth/merchant", "POST", {
          merchantId: "reviewer",
          token: "reviewer-complaints-long-test-key",
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
    assert.equal(first.data.complaint.responseDueAt, now + 86400000);
    assert.equal(first.data.complaint.overdue, false);
    const appealPath = `${path}/${id}/appeals`;
    const appealInput = {
      reason: "原处理结果没有说明宣传依据来源。",
      idempotencyKey: crypto.randomUUID(),
    };
    assert.equal((await call(appealPath, "POST", appealInput, v)).status, 409);
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
    now += 86400000;
    assert.equal(
      (await call(path, "GET", undefined, v)).data.items[0].overdue,
      true,
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
            previousVersion: 2,
            state: "resolved",
            reply: "审核员不能处理原投诉。",
          },
          reviewer,
        )
      ).status,
      403,
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
    assert.equal((await call(appealPath, "POST", appealInput, v2)).status, 404);
    const appealed = await call(appealPath, "POST", appealInput, v);
    assert.equal(appealed.status, 201);
    assert.equal(appealed.data.replayed, false);
    const appeal = appealed.data.complaint.appeal;
    assert.equal(appeal.reviewDueAt, now + 2 * 86400000);
    assert.equal(appeal.overdue, false);
    assert.equal(
      (await call(appealPath, "POST", appealInput, v)).data.replayed,
      true,
    );
    assert.equal(
      (
        await call(
          appealPath,
          "POST",
          { ...appealInput, reason: "复用编号但修改申诉内容。" },
          v,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          appealPath,
          "POST",
          { ...appealInput, idempotencyKey: crypto.randomUUID() },
          v,
        )
      ).status,
      409,
    );
    const appealReply = `/merchant/complaints/${id}/appeals/${appeal.id}/reply`;
    assert.equal(
      (
        await call(
          appealReply,
          "POST",
          {
            previousVersion: 1,
            state: "reviewing",
            reply: "管理员不能替代独立审核员。",
          },
          owner,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          appealReply,
          "POST",
          {
            previousVersion: 1,
            state: "reviewing",
            reply: "其他商家不能查看此申诉。",
          },
          other,
        )
      ).status,
      404,
    );
    now += 2 * 86400000;
    const reviewList = await call(
      "/merchant/complaints/rooms/demo-room",
      "GET",
      undefined,
      reviewer,
    );
    assert.equal(reviewList.status, 200);
    assert.equal(reviewList.data.items[0].appeal.overdue, true);
    assert.equal(
      (
        await call(
          appealReply,
          "POST",
          {
            previousVersion: 1,
            state: "reviewing",
            reply: "已由独立审核员重新核查。",
          },
          reviewer,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          appealReply,
          "POST",
          {
            previousVersion: 1,
            state: "resolved",
            reply: "过时版本不能覆盖复核记录。",
          },
          reviewer,
        )
      ).status,
      409,
    );
    const resolvedAppeal = await call(
      appealReply,
      "POST",
      {
        previousVersion: 2,
        state: "resolved",
        reply: "复核完成并补充宣传依据说明。",
      },
      reviewer,
    );
    assert.equal(resolvedAppeal.status, 200);
    assert.equal(resolvedAppeal.data.complaint.appeal.overdue, false);
    assert.equal(resolvedAppeal.data.complaint.appeal.events.length, 3);
    assert.throws(() => db.exec("DELETE FROM complaints"));
    assert.throws(() => db.exec("UPDATE complaint_events SET reply='changed'"));
    assert.throws(() => db.exec("DELETE FROM complaint_appeals"));
    assert.throws(() =>
      db.exec("UPDATE complaint_appeal_events SET reply='changed'"),
    );
    for (let i = 0; i < 5; i++)
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
    for (const role of ["editor", "presenter", "analyst"] as const)
      assert.equal(
        memberMayAccess(
          role,
          "GET",
          "/api/merchant/complaints/rooms/demo-room",
        ),
        false,
      );
    assert.equal(
      memberMayAccess(
        "reviewer",
        "GET",
        "/api/merchant/complaints/rooms/demo-room",
      ),
      true,
    );
  } finally {
    db.close();
  }
  const restored = openDatabase(path);
  try {
    assert.equal(
      restored.prepare("SELECT count(*) AS n FROM complaint_appeals").get()!.n,
      1,
    );
    assert.equal(
      restored
        .prepare("SELECT count(*) AS n FROM complaint_appeal_events")
        .get()!.n,
      3,
    );
    assert.equal(
      restored
        .prepare(
          "SELECT state FROM complaint_appeal_events ORDER BY version DESC LIMIT 1",
        )
        .get()!.state,
      "resolved",
    );
  } finally {
    restored.close();
  }
});
