import test from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/server/config.js";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { memberMayAccess } from "../src/server/permissions.js";

function fixture() {
  const credentials = Object.fromEntries(
    ["writer", "checker", "host", "metrics", "foreign"].map((id) => [
      id,
      `${id}-local-fixture-token-not-a-real-credential`,
    ]),
  );
  const memberships = {
    writer: { merchantId: "demo", role: "editor" },
    checker: { merchantId: "demo", role: "reviewer" },
    host: { merchantId: "demo", role: "presenter" },
    metrics: { merchantId: "demo", role: "analyst" },
  };
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "membership-fixture-session-secret-32-characters",
    MERCHANT_CREDENTIALS: JSON.stringify(credentials),
    MERCHANT_MEMBERSHIPS: JSON.stringify(memberships),
  });
  const db = openDatabase(":memory:");
  seedDemo(db);
  const app = createApp(db, config);
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const response = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: response.status,
      data: (await response.json()) as any,
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const login = async (id: string) =>
    (
      await call("/auth/merchant", "POST", {
        merchantId: id,
        token: credentials[id],
      })
    ).cookie;
  return { db, config, call, login };
}

test("members share the owner tenant while retaining their authenticated actor identity", async () => {
  const f = fixture();
  try {
    const writer = await f.login("writer"),
      checker = await f.login("checker"),
      foreign = await f.login("foreign");
    const identity = (await f.call("/auth/me", "GET", undefined, writer)).data;
    assert.equal(identity.merchantId, "demo");
    assert.equal(identity.actorId, "writer");
    assert.equal(identity.memberRole, "editor");
    const created = await f.call(
      "/merchant/content/products",
      "POST",
      { name: "合成测试", sku: "team-1", category: "测试资料", facts: [] },
      writer,
    );
    assert.equal(created.status, 201);
    assert.equal(
      f.db.prepare("SELECT merchant_id FROM content_products").get()!
        .merchant_id,
      "demo",
    );
    assert.equal(
      (
        await f.call(
          "/merchant/content/products/" + created.data.product.id,
          "GET",
          undefined,
          checker,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/content/products/" + created.data.product.id,
          "GET",
          undefined,
          foreign,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/content/products",
          "POST",
          { name: "越权", sku: "bad", category: "test", facts: [] },
          checker,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/content/courses/anything/scripts/1/confirm",
          "POST",
          {},
          writer,
        )
      ).status,
      403,
    );
  } finally {
    f.db.close();
  }
});

test("role boundaries protect stream credentials, payout records and mutations at HTTP routes", async () => {
  const f = fixture();
  try {
    const writer = await f.login("writer"),
      checker = await f.login("checker"),
      host = await f.login("host"),
      metrics = await f.login("metrics");
    for (const cookie of [writer, checker, metrics])
      assert.equal(
        (
          await f.call(
            "/merchant/rooms/demo-room/stream",
            "GET",
            undefined,
            cookie,
          )
        ).status,
        403,
      );
    assert.equal(
      (await f.call("/merchant/rooms/demo-room/stream", "GET", undefined, host))
        .status,
      200,
    );
    assert.equal(
      (await f.call("/merchant/rooms/demo-room/ledger", "GET", undefined, host))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/rooms/demo-room/ledger",
          "GET",
          undefined,
          metrics,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call("/merchant/content/products", "GET", undefined, metrics))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/rooms/demo-room",
          "PATCH",
          { status: "live" },
          checker,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/rooms/demo-room",
          "PATCH",
          { status: "live" },
          host,
        )
      ).status,
      200,
    );
    assert.equal(
      (await f.call("/merchant/rooms/demo-room/campaigns", "POST", {}, host))
        .status,
      403,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/agent/profiles/p/versions/1/publish",
          "POST",
          {},
          writer,
        )
      ).status,
      403,
    );
    for (const role of ["editor", "reviewer", "presenter", "analyst"] as const)
      assert.equal(
        memberMayAccess(
          role,
          "POST",
          "/api/merchant/content/future-admin-route",
        ),
        false,
      );
  } finally {
    f.db.close();
  }
});

test("changing membership revokes issued cookies rather than keeping former permissions", async () => {
  const f = fixture();
  try {
    const old = await f.login("writer");
    f.config.merchantMemberships!.writer.role = "reviewer";
    assert.equal(
      (await f.call("/auth/me", "GET", undefined, old)).data.merchantId,
      null,
    );
    assert.equal(
      (await f.call("/merchant/content/products", "GET", undefined, old))
        .status,
      401,
    );
    const fresh = await f.login("writer");
    assert.equal(
      (await f.call("/auth/me", "GET", undefined, fresh)).data.memberRole,
      "reviewer",
    );
    delete f.config.merchantCredentials.writer;
    assert.equal(
      (await f.call("/merchant/content/products", "GET", undefined, fresh))
        .status,
      401,
    );
  } finally {
    f.db.close();
  }
});

test("membership configuration rejects missing credentials, tenant cycles and owner impersonation", () => {
  const base = {
    DEMO_MODE: "true",
    MERCHANT_CREDENTIALS: JSON.stringify({
      a: "local-token-at-least-24-characters",
      b: "local-token-at-least-24-characters",
    }),
  };
  for (const members of [
    { unknown: { merchantId: "demo", role: "editor" } },
    { a: { merchantId: "a", role: "editor" } },
    {
      a: { merchantId: "b", role: "editor" },
      b: { merchantId: "a", role: "reviewer" },
    },
    { a: { merchantId: "demo", role: "owner" } },
    { demo: { merchantId: "a", role: "editor" } },
  ])
    assert.throws(() =>
      loadConfig({ ...base, MERCHANT_MEMBERSHIPS: JSON.stringify(members) }),
    );
});

async function reviewFixture() {
  const f = fixture(),
    writer = await f.login("writer"),
    checker = await f.login("checker"),
    host = await f.login("host");
  const owner = (await f.call("/auth/demo", "POST", {})).cookie;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = writer,
  ) => f.call("/merchant/content" + path, method, body, cookie);
  const product = (
    await request("/products", "POST", {
      name: "审核合成资料",
      sku: "review-1",
      category: "测试资料",
      facts: [],
    })
  ).data.product;
  const plan = (
    await request("/plans", "POST", {
      productId: product.id,
      name: "测试计划",
      audience: "测试人员",
      totalDays: 45,
    })
  ).data.plan;
  const course = (
    await request(`/plans/${plan.id}/courses`, "POST", {
      title: "审核测试课",
      dayIndex: 1,
      objective: "验证独立审核",
    })
  ).data.course;
  const base = `/courses/${course.id}`;
  const save = async (baseVersion = 0, cookie = writer) =>
    request(
      base + "/scripts",
      "POST",
      {
        baseVersion,
        productVersion: 1,
        paragraphs: [
          {
            id: "p1",
            kind: "transition",
            text: "欢迎来到本次测试课堂。",
            factIds: [],
          },
        ],
        changeNote: "合成稿件，测试用途",
      },
      cookie,
    );
  return {
    ...f,
    writer,
    checker,
    host,
    owner,
    request,
    product,
    course,
    base,
    save,
  };
}

test("independent approval records the real actor and enables a presenter binding", async () => {
  const f = await reviewFixture();
  try {
    assert.equal((await f.save()).status, 201);
    assert.equal(
      (
        await f.request(f.base + "/scripts/1/submit", "POST", {
          note: "请审核这份测试稿",
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/confirm",
          "POST",
          { note: "不能自审", acknowledged: true },
          f.owner,
        )
      ).status,
      409,
    );
    const approval = {
      decision: "approved",
      note: "已核对合成资料与全文",
      acknowledged: true,
    };
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          approval,
          f.writer,
        )
      ).status,
      403,
    );
    const approved = await f.request(
      f.base + "/scripts/1/review",
      "POST",
      approval,
      f.checker,
    );
    assert.equal(approved.status, 200);
    assert.equal(approved.data.script.confirmation.confirmedBy, "checker");
    assert.equal(approved.data.script.confirmation.role, "independent_review");
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          approval,
          f.checker,
        )
      ).status,
      200,
    );
    const bind = await f.request(
      "/rooms/demo-room/binding",
      "POST",
      { courseId: f.course.id, scriptVersion: 1 },
      f.host,
    );
    assert.equal(bind.status, 201);
    assert.equal(bind.data.binding.stale, false);
    assert.equal(
      (await f.request("/rooms/demo-room/binding-history")).data.history[0]
        .actorId,
      "host",
    );
    assert.equal(
      (
        await f.request(`/products/${f.product.id}/versions`, "POST", {
          baseVersion: 1,
          name: "新版资料",
          sku: "review-1",
          category: "测试资料",
          facts: [],
        })
      ).status,
      201,
    );
    assert.equal(
      (await f.request("/rooms/demo-room/binding")).data.binding.stale,
      true,
    );
    assert.equal(
      (
        await f.request(
          "/rooms/demo-room/binding",
          "POST",
          { courseId: f.course.id, scriptVersion: 1 },
          f.host,
        )
      ).status,
      409,
    );
  } finally {
    f.db.close();
  }
});

test("self-review is forbidden even for owners and return decisions cannot be overwritten", async () => {
  const f = await reviewFixture();
  try {
    await f.save(0, f.owner);
    await f.request(
      f.base + "/scripts/1/submit",
      "POST",
      { note: "管理员提交自己的测试稿" },
      f.owner,
    );
    const approval = {
      decision: "approved",
      note: "不能自己审批",
      acknowledged: true,
    };
    assert.equal(
      (await f.request(f.base + "/scripts/1/review", "POST", approval, f.owner))
        .status,
      403,
    );
    const returned = await f.request(
      f.base + "/scripts/1/review",
      "POST",
      {
        decision: "changes_requested",
        note: "请补充本课活动安排",
        acknowledged: true,
      },
      f.checker,
    );
    assert.equal(returned.status, 200);
    assert.equal(returned.data.script.confirmation, undefined);
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          approval,
          f.checker,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/submit",
          "POST",
          { note: "重用旧版本" },
          f.owner,
        )
      ).status,
      409,
    );
    assert.throws(
      () =>
        f.db.exec("UPDATE content_review_decisions SET decision='approved'"),
      /immutable/,
    );
    assert.throws(
      () => f.db.exec("DELETE FROM content_script_authors"),
      /immutable/,
    );
    await f.save(1);
    await f.request(f.base + "/scripts/2/submit", "POST", {
      note: "已补充后再次提交",
    });
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/2/review",
          "POST",
          approval,
          f.checker,
        )
      ).status,
      200,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_review_decisions").get()!
        .n,
      2,
    );
  } finally {
    f.db.close();
  }
});

test("a newer draft prevents approval of an obsolete pending version and foreign reviews are isolated", async () => {
  const f = await reviewFixture();
  try {
    await f.save();
    await f.request(f.base + "/scripts/1/submit", "POST", {
      note: "第一版提交",
    });
    await f.save(1);
    const approval = {
      decision: "approved",
      note: "审核结果",
      acknowledged: true,
    };
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          approval,
          f.checker,
        )
      ).status,
      409,
    );
    const foreign = await f.login("foreign");
    assert.equal(
      (await f.request(f.base + "/scripts/1/review", "GET", undefined, foreign))
        .status,
      404,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_review_decisions").get()!
        .n,
      0,
    );
  } finally {
    f.db.close();
  }
});
