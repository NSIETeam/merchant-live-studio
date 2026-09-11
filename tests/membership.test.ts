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

test("review queue isolates tenants, removes superseded or decided submissions and keeps history readable", async () => {
  const f = await reviewFixture();
  try {
    await f.save();
    await f.request(f.base + "/scripts/1/submit", "POST", { note: "待审核" });
    const queue = () => f.request("/review-queue", "GET", undefined, f.checker);
    const pending = await queue();
    assert.equal(pending.status, 200);
    assert.equal(pending.data.items.length, 1);
    assert.equal(pending.data.items[0].courseId, f.course.id);
    assert.equal(pending.data.items[0].submittedBy, "writer");
    const foreign = await f.login("foreign");
    assert.deepEqual(
      (await f.request("/review-queue", "GET", undefined, foreign)).data.items,
      [],
    );
    assert.equal(
      (await f.request(f.base + "/scripts/1", "GET", undefined, foreign))
        .status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "/review-queue",
          "GET",
          undefined,
          await f.login("metrics"),
        )
      ).status,
      403,
    );
    assert.equal(
      (await f.request("/review-queue?limit=0", "GET", undefined, f.checker))
        .status,
      400,
    );
    await f.save(1);
    assert.deepEqual((await queue()).data.items, []);
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "GET",
          undefined,
          f.checker,
        )
      ).data.review.submission.note,
      "待审核",
    );
    await f.request(f.base + "/scripts/2/submit", "POST", { note: "新版待审" });
    assert.equal((await queue()).data.items[0].version, 2);
    const approved = await f.request(
      f.base + "/scripts/2/review",
      "POST",
      { decision: "approved", note: "已核对", acknowledged: true },
      f.checker,
    );
    assert.equal(approved.status, 200);
    assert.deepEqual((await queue()).data.items, []);
    const detail = await f.request(
      f.base + "/scripts/2",
      "GET",
      undefined,
      f.checker,
    );
    assert.equal(detail.data.script.confirmation.confirmedBy, "checker");
  } finally {
    f.db.close();
  }
});

test("review queue cursor does not skip remaining submissions when the previous page is reviewed", async () => {
  const f = await reviewFixture();
  try {
    const plan = f.db
      .prepare("SELECT plan_id FROM content_courses WHERE id=?")
      .get(f.course.id)!.plan_id;
    for (let index = 0; index < 3; index++) {
      const course = (
        await f.request(`/plans/${plan}/courses`, "POST", {
          title: `分页课${index}`,
          dayIndex: index + 2,
          objective: "分页测试",
        })
      ).data.course;
      const base = `/courses/${course.id}/scripts`;
      assert.equal(
        (
          await f.request(base, "POST", {
            baseVersion: 0,
            productVersion: 1,
            paragraphs: [
              {
                id: "p",
                kind: "transition",
                text: "欢迎来到测试课堂。",
                factIds: [],
              },
            ],
            changeNote: "测试",
          })
        ).status,
        201,
      );
      assert.equal(
        (await f.request(base + "/1/submit", "POST", { note: "待审" })).status,
        200,
      );
    }
    const page1 = (
      await f.request("/review-queue?limit=1", "GET", undefined, f.checker)
    ).data;
    assert.equal(page1.items.length, 1);
    assert.ok(page1.nextAfter);
    assert.equal(
      (
        await f.request(
          `/courses/${page1.items[0].courseId}/scripts/1/review`,
          "POST",
          { decision: "changes_requested", note: "修改", acknowledged: true },
          f.checker,
        )
      ).status,
      200,
    );
    const page2 = (
      await f.request(
        `/review-queue?limit=1&after=${encodeURIComponent(page1.nextAfter)}`,
        "GET",
        undefined,
        f.checker,
      )
    ).data;
    const page3 = (
      await f.request(
        `/review-queue?limit=1&after=${encodeURIComponent(page2.nextAfter)}`,
        "GET",
        undefined,
        f.checker,
      )
    ).data;
    assert.equal(
      new Set(
        [...page1.items, ...page2.items, ...page3.items].map(
          (item) => item.courseId,
        ),
      ).size,
      3,
    );
    assert.equal(page3.nextAfter, null);
  } finally {
    f.db.close();
  }
});

async function suggestionFixture() {
  const f = await reviewFixture();
  await f.save();
  await f.request(f.base + "/scripts/1/submit", "POST", { note: "请逐条审改" });
  const suggestion = {
    id: crypto.randomUUID(),
    paragraphId: "p1",
    replacement: "欢迎来到合成材料的软件验收课堂。",
    reason: "明确测试用途",
  };
  const suggest = (input = suggestion, cookie = f.checker) =>
    f.request(f.base + "/scripts/1/suggestions", "POST", input, cookie);
  const resolve = (
    decision = "accepted",
    note = "按建议处理",
    cookie = f.writer,
    id = suggestion.id,
  ) =>
    f.request(`/suggestions/${id}/resolve`, "POST", { decision, note }, cookie);
  return { ...f, suggestion, suggest, resolve };
}

test("paragraph suggestions create an auditable new draft and retries never create duplicate versions", async () => {
  const f = await suggestionFixture();
  try {
    assert.equal((await f.suggest()).status, 201);
    assert.equal((await f.suggest()).status, 201);
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM content_script_suggestions")
        .get()!.n,
      1,
    );
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          { decision: "approved", note: "核对", acknowledged: true },
          f.checker,
        )
      ).status,
      409,
    );
    const accepted = await f.resolve();
    assert.equal(accepted.status, 200);
    assert.equal(accepted.data.resultVersion, 2);
    assert.equal((await f.resolve()).data.resultVersion, 2);
    assert.equal((await f.resolve("rejected")).status, 409);
    const latest = (await f.request(f.base + "/scripts/2")).data.script;
    assert.equal(latest.paragraphs[0].text, f.suggestion.replacement);
    assert.equal(latest.confirmation, undefined);
    assert.equal(
      (await f.request(f.base + "/scripts/2/review")).data.review.authorId,
      "writer",
    );
    const original = (await f.request(f.base + "/scripts/1")).data.script;
    assert.equal(original.paragraphs[0].text, "欢迎来到本次测试课堂。");
    const history = (await f.request(f.base + "/scripts/1/suggestions")).data
      .suggestions;
    assert.equal(history[0].resultVersion, 2);
    assert.equal(history[0].resolvedBy, "writer");
    assert.throws(() =>
      f.db.exec("UPDATE content_script_suggestions SET reason='rewrite'"),
    );
    assert.throws(() =>
      f.db.exec("DELETE FROM content_suggestion_resolutions"),
    );
  } finally {
    f.db.close();
  }
});

test("suggestion permissions isolate tenants and reject unauthorized writes", async () => {
  const f = await suggestionFixture();
  try {
    assert.equal((await f.suggest(f.suggestion, f.writer)).status, 403);
    assert.equal((await f.suggest()).status, 201);
    const foreign = await f.login("foreign");
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/suggestions",
          "GET",
          undefined,
          foreign,
        )
      ).status,
      404,
    );
    assert.equal((await f.resolve("accepted", "越权", foreign)).status, 404);
    assert.equal((await f.resolve("accepted", "越权", f.checker)).status, 403);
    assert.equal((await f.resolve("accepted", "越权", f.host)).status, 403);
    assert.equal(
      (await f.suggest({ ...f.suggestion, reason: "不同内容重用编号" })).status,
      409,
    );
    assert.equal(
      (
        await f.suggest({
          ...f.suggestion,
          id: crypto.randomUUID(),
          paragraphId: "missing",
        })
      ).status,
      404,
    );
    assert.equal((await f.resolve("rejected", "保留原文")).status, 200);
    assert.equal(
      f.db
        .prepare(
          "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
        )
        .get(f.course.id)!.v,
      1,
    );
    assert.equal(
      (
        await f.request(
          f.base + "/scripts/1/review",
          "POST",
          {
            decision: "approved",
            note: "建议已处置，已核对",
            acknowledged: true,
          },
          f.checker,
        )
      ).status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("suggestions never overwrite a concurrently edited paragraph or changed product basis", async () => {
  const f = await suggestionFixture();
  try {
    await f.suggest();
    const changed = await f.request(f.base + "/scripts", "POST", {
      baseVersion: 1,
      productVersion: 1,
      paragraphs: [
        {
          id: "p1",
          kind: "transition",
          text: "编辑已另写这一段。",
          factIds: [],
        },
      ],
      changeNote: "并行编辑",
    });
    assert.equal(changed.status, 201);
    assert.equal((await f.resolve()).status, 409);
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM content_suggestion_resolutions")
        .get()!.n,
      0,
    );
    assert.equal(
      (await f.suggest({ ...f.suggestion, id: crypto.randomUUID() })).status,
      409,
    );
  } finally {
    f.db.close();
  }
  const g = await suggestionFixture();
  try {
    await g.suggest();
    const updated = await g.request(
      `/products/${g.product.id}/versions`,
      "POST",
      {
        baseVersion: 1,
        name: "审核合成资料",
        sku: "review-1",
        category: "更新测试资料",
        facts: [],
      },
    );
    assert.equal(updated.status, 201);
    assert.equal((await g.resolve()).status, 409);
    assert.equal(
      g.db
        .prepare(
          "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
        )
        .get(g.course.id)!.v,
      1,
    );
  } finally {
    g.db.close();
  }
});

test("accepting separate paragraph suggestions preserves other edits and reruns content checks", async () => {
  const f = await suggestionFixture();
  try {
    await f.suggest();
    const append = await f.request(f.base + "/scripts", "POST", {
      baseVersion: 1,
      productVersion: 1,
      paragraphs: [
        {
          id: "p1",
          kind: "transition",
          text: "欢迎来到本次测试课堂。",
          factIds: [],
        },
        {
          id: "p2",
          kind: "transition",
          text: "新增段落必须保留。",
          factIds: [],
        },
      ],
      changeNote: "新增段落",
    });
    assert.equal(append.status, 201);
    const result = await f.resolve();
    assert.equal(result.status, 200);
    assert.equal(result.data.resultVersion, 3);
    const script = (await f.request(f.base + "/scripts/3")).data.script;
    assert.equal(script.paragraphs[1].text, "新增段落必须保留。");
    assert.ok(script.check.ruleVersion);
    assert.equal(script.confirmation, undefined);
  } finally {
    f.db.close();
  }
});

test("an oversized accepted suggestion rolls back both its new version and resolution", async () => {
  const f = await suggestionFixture();
  try {
    await f.suggest();
    const first = {
      id: "p1",
      kind: "transition",
      text: "欢迎来到本次测试课堂。",
      factIds: [],
    };
    const paragraphs = [first];
    let remaining = 12000 - first.text.length;
    while (remaining) {
      const length = Math.min(1500, remaining);
      paragraphs.push({
        id: `extra-${paragraphs.length}`,
        kind: "transition",
        text: "测".repeat(length),
        factIds: [],
      });
      remaining -= length;
    }
    assert.equal(
      (
        await f.request(f.base + "/scripts", "POST", {
          baseVersion: 1,
          productVersion: 1,
          paragraphs,
          changeNote: "容量边界测试",
        })
      ).status,
      201,
    );
    assert.equal((await f.resolve()).status, 400);
    assert.equal(
      f.db
        .prepare(
          "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
        )
        .get(f.course.id)!.v,
      2,
    );
    assert.equal(
      f.db
        .prepare("SELECT count(*) AS n FROM content_suggestion_resolutions")
        .get()!.n,
      0,
    );
    assert.equal(
      (await f.resolve("rejected", "文本容量不足，另行精简")).status,
      200,
    );
  } finally {
    f.db.close();
  }
});

test("offline customer records are limited to owner and analyst, mutations to owner", async () => {
  const f = fixture();
  try {
    for (const id of ["writer", "checker", "host"]) {
      const cookie = await f.login(id);
      assert.equal(
        (await f.call("/merchant/attribution/stores", "GET", undefined, cookie))
          .status,
        403,
      );
    }
    const analyst = await f.login("metrics");
    assert.equal(
      (await f.call("/merchant/attribution/stores", "GET", undefined, analyst))
        .status,
      200,
    );
    assert.equal(
      (
        await f.call(
          "/merchant/attribution/stores",
          "POST",
          { name: "门店", externalRef: "1" },
          analyst,
        )
      ).status,
      403,
    );
  } finally {
    f.db.close();
  }
});
