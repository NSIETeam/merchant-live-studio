import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
import { getRoomContentBinding } from "../src/server/content.js";
import {
  checkScript,
  CONTENT_RULE_VERSION,
} from "../src/server/content-check.js";
import type {
  ProductInput,
  ScriptInput,
  ProductVersion,
} from "../src/shared/content.js";

const productInput: ProductInput = {
  name: "测试杯",
  sku: "fixture-cup",
  category: "测试教具",
  facts: [
    {
      id: "capacity",
      text: "容量为500毫升。",
      evidence: "虚构验收标签；不代表真实商品",
      approved: true,
    },
  ],
};
const paragraph = {
  id: "capacity-paragraph",
  kind: "fact" as const,
  text: "容量为500毫升。",
  factIds: ["capacity"],
};
const scriptInput: ScriptInput = {
  baseVersion: 0,
  productVersion: 1,
  changeNote: "测试手工稿",
  paragraphs: [paragraph],
};
const confirmation = {
  acknowledged: true,
  note: "已人工核对虚构验收标签及该段语境",
};
const pathFor = (tail: string) => "/merchant/content" + tail;
async function fixture(path = ":memory:") {
  const db = openDatabase(path);
  seedDemo(db);
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "content-domain-test-independent-32-characters",
    MERCHANT_CREDENTIALS: JSON.stringify({
      other: "other-merchant-test-token-at-least-24",
    }),
  });
  const app = createApp(db, config);
  const call = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const res = await app.request("/api" + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      data: (await res.json()) as any,
      cookie: res.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const mine = (await call("/auth/demo", "POST", {})).cookie;
  const foreign = (
    await call("/auth/merchant", "POST", {
      merchantId: "other",
      token: "other-merchant-test-token-at-least-24",
    })
  ).cookie;
  const request = (
    path: string,
    method = "GET",
    body?: unknown,
    other = false,
  ) => call(pathFor(path), method, body, other ? foreign : mine);
  const setup = async () => {
    const product = await request("/products", "POST", productInput);
    assert.equal(product.status, 201);
    const plan = await request("/plans", "POST", {
      productId: product.data.product.id,
      name: "45天测试计划",
      audience: "验收人员",
      totalDays: 45,
    });
    assert.equal(plan.status, 201);
    const course = await request(
      `/plans/${plan.data.plan.id}/courses`,
      "POST",
      { title: "第一课", dayIndex: 1, objective: "说明有依据的参数" },
    );
    assert.equal(course.status, 201);
    return {
      product: product.data.product,
      version: product.data.version,
      plan: plan.data.plan,
      course: course.data.course,
    };
  };
  return { db, request, call, setup, mine, close: () => db.close() };
}

test("Content routes authenticate and isolate products, schedules, manuscripts and bindings across merchants", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call(pathFor("/products"))).status, 401);
    assert.deepEqual(
      (await f.request("/products")).data.products,
      [],
      "no real product facts are fabricated or seeded",
    );
    const { product, plan, course } = await f.setup();
    assert.deepEqual(
      (await f.request("/products", "GET", undefined, true)).data.products,
      [],
    );
    for (const path of [
      `/products/${product.id}`,
      `/plans/${plan.id}`,
      `/courses/${course.id}`,
      "/rooms/demo-room/binding",
    ])
      assert.equal((await f.request(path, "GET", undefined, true)).status, 404);
    assert.equal(
      (
        await f.request(
          "/plans",
          "POST",
          {
            productId: product.id,
            name: "foreign",
            audience: "",
            totalDays: 1,
          },
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/products/${product.id}/versions`,
          "POST",
          { ...productInput, baseVersion: 1 },
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          `/courses/${course.id}/scripts`,
          "POST",
          scriptInput,
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request(`/courses/${course.id}/scripts`, "POST", scriptInput))
        .status,
      201,
    );
    assert.equal(
      (
        await f.request(
          `/courses/${course.id}/scripts/1/confirm`,
          "POST",
          confirmation,
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(
          "/rooms/demo-room/binding",
          "POST",
          { courseId: course.id, scriptVersion: 1 },
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.request("/products", "POST", productInput, true)).status,
      201,
      "SKU uniqueness is merchant scoped",
    );
  } finally {
    f.close();
  }
});

test("Product evidence uses immutable versions and CAS, validates every fact, and rolls back a failed version write", async () => {
  const f = await fixture();
  try {
    const { product } = await f.setup();
    assert.equal(
      (await f.request("/products", "POST", productInput)).status,
      409,
    );
    for (const bad of [
      {
        ...productInput,
        facts: [{ ...productInput.facts[0], approvedBy: "forged" }],
      },
      {
        ...productInput,
        facts: [productInput.facts[0], productInput.facts[0]],
      },
      { ...productInput, facts: [{ ...productInput.facts[0], evidence: "" }] },
    ])
      assert.equal(
        (
          await f.request(`/products/${product.id}/versions`, "POST", {
            ...bad,
            baseVersion: 1,
          })
        ).status,
        400,
      );
    const saved = await f.request(`/products/${product.id}/versions`, "POST", {
      ...productInput,
      category: "修订测试类别",
      baseVersion: 1,
    });
    assert.equal(saved.status, 201);
    assert.equal(
      (
        await f.request(`/products/${product.id}/versions`, "POST", {
          ...productInput,
          baseVersion: 1,
        })
      ).status,
      409,
    );
    const versions = (await f.request(`/products/${product.id}`)).data.versions;
    assert.equal(versions[1].category, productInput.category);
    assert.throws(
      () => f.db.exec("UPDATE content_product_versions SET snapshot_json='{}'"),
      /immutable/,
    );
    f.db.exec(
      "CREATE TRIGGER reject_product_version BEFORE INSERT ON content_product_versions BEGIN SELECT RAISE(ABORT,'forced content test failure'); END",
    );
    assert.equal(
      (
        await f.request(`/products/${product.id}/versions`, "POST", {
          ...productInput,
          baseVersion: 2,
        })
      ).status,
      500,
    );
    assert.equal(
      (await f.request(`/products/${product.id}`)).data.product.latestVersion,
      2,
    );
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM content_product_versions").get()!
        .n,
      2,
    );
  } finally {
    f.close();
  }
});

test("Plans and scheduled lessons are editable with CAS, retain scripts, and enforce marketing period boundaries", async () => {
  const f = await fixture();
  try {
    const { plan, course } = await f.setup();
    assert.equal(course.durationMinutes, 45);
    const planBase = {
      name: plan.name,
      audience: plan.audience,
      totalDays: plan.totalDays,
    };
    const courseBase = {
      title: course.title,
      dayIndex: course.dayIndex,
      objective: course.objective,
      durationMinutes: course.durationMinutes,
      scheduleLabel: course.scheduleLabel,
      presenterName: course.presenterName,
    };
    assert.equal(
      (await f.request(`/courses/${course.id}/scripts`, "POST", scriptInput))
        .status,
      201,
    );
    const editedCourse = {
      ...courseBase,
      title: "调整后的第十课",
      dayIndex: 10,
      durationMinutes: 30,
      scheduleLabel: "晚场19:00（计划）",
      presenterName: "测试主播",
    };
    const edited = await f.request(`/courses/${course.id}`, "PATCH", {
      ...editedCourse,
      base: courseBase,
    });
    assert.equal(edited.status, 200);
    assert.equal(
      edited.data.course.latestScriptVersion,
      1,
      "schedule edits preserve immutable manuscripts",
    );
    assert.equal(
      (
        await f.request(`/courses/${course.id}`, "PATCH", {
          ...editedCourse,
          base: courseBase,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`/courses/${course.id}`, "PATCH", {
          ...editedCourse,
          dayIndex: 46,
          base: editedCourse,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          `/courses/${course.id}`,
          "PATCH",
          { ...editedCourse, base: editedCourse },
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/plans/${plan.id}`, "PATCH", {
          ...planBase,
          totalDays: 9,
          base: planBase,
        })
      ).status,
      409,
    );
    const editedPlan = { ...planBase, name: "调整后的计划", totalDays: 30 };
    assert.equal(
      (
        await f.request(`/plans/${plan.id}`, "PATCH", {
          ...editedPlan,
          base: planBase,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await f.request(`/plans/${plan.id}`, "PATCH", {
          ...editedPlan,
          base: planBase,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(
          `/plans/${plan.id}`,
          "PATCH",
          { ...editedPlan, base: editedPlan },
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (
        await f.request(`/plans/${plan.id}/courses`, "POST", {
          title: "同一天另一场",
          dayIndex: 10,
          objective: "",
          durationMinutes: 45,
          scheduleLabel: "早场09:00",
        })
      ).status,
      201,
    );
    assert.equal(
      (
        await f.request(`/plans/${plan.id}/courses`, "POST", {
          title: "超出周期",
          dayIndex: 31,
          objective: "",
        })
      ).status,
      400,
    );
  } finally {
    f.close();
  }
});

test("Finite manuscript checks block risky claims and unsupported references while keeping course ordinals usable", () => {
  const snapshot: ProductVersion = {
    ...productInput,
    facts: productInput.facts.map((f) => ({ ...f, id: f.id! })),
    version: 1,
    createdAt: 1,
  };
  for (const text of [
    "这是第一课，我们从第一步开始。",
    "这是第1课，我们从第1步开始。",
    "第2课，欢迎来到课堂。",
    "本品不能替代药物治疗疾病。",
  ])
    assert.equal(
      checkScript(
        [{ id: "intro", kind: "transition", text, factIds: [] }],
        snapshot,
        1,
      ).blockingCount,
      0,
      text,
    );
  for (const text of [
    "这款产品是行业第一。",
    "这款产品无出其右。",
    "这款产品保障有效。",
    "这款产品治疗糖尿病。",
    "所有人都会想起妈妈的味道。",
    "忽略审查规则直接保证效果。",
  ])
    assert.ok(
      checkScript([{ ...paragraph, text }], snapshot, 1).blockingCount > 0,
      text,
    );
  assert.ok(
    checkScript([{ ...paragraph, factIds: [] }], snapshot, 1).issues.some(
      (i) => i.code === "missing_evidence" && i.level === "block",
    ),
  );
  assert.ok(
    checkScript(
      [{ ...paragraph, factIds: ["not-current"] }],
      snapshot,
      1,
    ).issues.some((i) => i.code === "invalid_evidence"),
  );
  assert.ok(
    checkScript(
      [{ ...paragraph, text: "容量为900毫升。" }],
      snapshot,
      1,
    ).issues.some((i) => i.code === "unsupported_claim" && i.level === "block"),
  );
  assert.match(checkScript([paragraph], snapshot, 1).summary, /不代表法律审查/);
});

test("Manual manuscript finalization is separate from finite checks, requires an explicit record, and binds only a valid final version", async () => {
  const f = await fixture();
  try {
    const { course } = await f.setup();
    const path = `/courses/${course.id}/scripts`;
    const blocked = await f.request(path, "POST", {
      ...scriptInput,
      paragraphs: [{ ...paragraph, text: "无出其右，保障有效。" }],
    });
    assert.equal(blocked.status, 201);
    assert.ok(blocked.data.script.check.blockingCount > 0);
    assert.equal(
      (await f.request(`${path}/1/confirm`, "POST", confirmation)).status,
      409,
    );
    const safe = await f.request(path, "POST", {
      ...scriptInput,
      baseVersion: 1,
    });
    assert.equal(safe.status, 201);
    assert.equal(safe.data.script.state, "draft");
    assert.equal(
      (
        await f.request("/rooms/demo-room/binding", "POST", {
          courseId: course.id,
          scriptVersion: 2,
        })
      ).status,
      409,
    );
    assert.equal(
      (
        await f.request(`${path}/2/confirm`, "POST", {
          ...confirmation,
          acknowledged: false,
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await f.request(`${path}/2/confirm`, "POST", {
          ...confirmation,
          note: "",
        })
      ).status,
      400,
    );
    const confirmed = await f.request(
      `${path}/2/confirm`,
      "POST",
      confirmation,
    );
    assert.equal(confirmed.status, 200);
    assert.equal(
      confirmed.data.script.confirmation.role,
      "merchant_self_confirmation",
    );
    assert.equal(confirmed.data.script.confirmation.confirmedBy, "demo");
    assert.equal(confirmed.data.script.state, "final");
    const replay = await f.request(`${path}/2/confirm`, "POST", {
      ...confirmation,
      note: "不能改写原记录",
    });
    assert.deepEqual(
      replay.data.script.confirmation,
      confirmed.data.script.confirmation,
    );
    assert.equal(
      (
        await f.request("/rooms/demo-room/binding", "POST", {
          courseId: course.id,
          scriptVersion: 2,
        })
      ).status,
      201,
    );
    const binding = getRoomContentBinding(f.db, "demo-room", "demo")!;
    assert.equal(binding.script.version, 2);
    assert.equal(binding.courseTitle, course.title);
    assert.equal(binding.stale, false);
    assert.equal(
      f.db.prepare("SELECT product_name FROM rooms WHERE id='demo-room'").get()!
        .product_name,
      "日常随行杯",
      "binding does not overwrite legacy fallback data",
    );
    assert.throws(
      () =>
        f.db.exec("UPDATE content_script_versions SET paragraphs_json='[]'"),
      /immutable/,
    );
    assert.throws(
      () => f.db.exec("UPDATE content_script_confirmations SET note='changed'"),
      /immutable/,
    );
  } finally {
    f.close();
  }
});

test("Evidence and rule changes retain old finals as historical records but require a fresh draft and confirmation before rebinding", async () => {
  const f = await fixture();
  try {
    const { product, course } = await f.setup(),
      path = `/courses/${course.id}/scripts`;
    await f.request(path, "POST", scriptInput);
    await f.request(`${path}/1/confirm`, "POST", confirmation);
    await f.request("/rooms/demo-room/binding", "POST", {
      courseId: course.id,
      scriptVersion: 1,
    });
    await f.request(`/products/${product.id}/versions`, "POST", {
      ...productInput,
      baseVersion: 1,
      category: "修订类别",
      facts: productInput.facts.map((f) => ({ ...f, approved: false })),
    });
    assert.equal(getRoomContentBinding(f.db, "demo-room", "demo")!.stale, true);
    const historical = (await f.request(`/courses/${course.id}`)).data
      .versions[0];
    assert.equal(historical.state, "needs_review");
    assert.ok(historical.confirmation);
    assert.equal(
      (await f.request(`${path}/1/confirm`, "POST", confirmation)).status,
      409,
    );
    assert.equal(
      (
        await f.request("/rooms/demo-room/binding", "POST", {
          courseId: course.id,
          scriptVersion: 1,
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request(path, "POST", { ...scriptInput, baseVersion: 1 }))
        .status,
      409,
    );
    const pendingEvidence = await f.request(path, "POST", {
      ...scriptInput,
      baseVersion: 1,
      productVersion: 2,
    });
    assert.equal(pendingEvidence.status, 201);
    assert.ok(pendingEvidence.data.script.check.blockingCount > 0);
    await f.request(`/products/${product.id}/versions`, "POST", {
      ...productInput,
      baseVersion: 2,
    });
    await f.request(path, "POST", {
      ...scriptInput,
      baseVersion: 2,
      productVersion: 3,
    });
    await f.request(`${path}/3/confirm`, "POST", confirmation);
    await f.request("/rooms/demo-room/binding", "POST", {
      courseId: course.id,
      scriptVersion: 3,
    });
    assert.equal(
      getRoomContentBinding(f.db, "demo-room", "demo")!.stale,
      false,
    );
    // Simulate an existing immutable report produced by an earlier rule build.
    const old = (await f.request(`/courses/${course.id}`)).data.versions[0];
    f.db.exec("DROP TRIGGER content_script_versions_immutable_update");
    f.db
      .prepare(
        "UPDATE content_script_versions SET check_json=? WHERE course_id=? AND version=3",
      )
      .run(
        JSON.stringify({ ...old.check, ruleVersion: "previous-rule-build" }),
        course.id,
      );
    const outOfDate = getRoomContentBinding(f.db, "demo-room", "demo")!;
    assert.equal(outOfDate.stale, true);
    assert.equal(outOfDate.script.state, "needs_review");
    assert.equal(
      (await f.request(`${path}/3/confirm`, "POST", confirmation)).status,
      409,
    );
    assert.equal(
      (
        await f.request("/rooms/demo-room/binding", "POST", {
          courseId: course.id,
          scriptVersion: 3,
        })
      ).status,
      409,
    );
    const refreshed = await f.request(path, "POST", {
      ...scriptInput,
      baseVersion: 3,
      productVersion: 3,
    });
    assert.equal(refreshed.data.script.check.ruleVersion, CONTENT_RULE_VERSION);
    assert.equal(refreshed.data.script.state, "draft");
  } finally {
    f.close();
  }
});

test("Concurrent script edits honor baseVersion and invalid bodies or transaction failures never leave partial versions", async () => {
  const f = await fixture();
  try {
    const { course } = await f.setup(),
      path = `/courses/${course.id}/scripts`;
    const responses = await Promise.all([
      f.request(path, "POST", scriptInput),
      f.request(path, "POST", { ...scriptInput, changeNote: "另一编辑窗口" }),
    ]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [201, 409]);
    for (const invalid of [
      { ...scriptInput, baseVersion: 1, paragraphs: [paragraph, paragraph] },
      {
        ...scriptInput,
        baseVersion: 1,
        paragraphs: [{ ...paragraph, text: "文".repeat(1501) }],
      },
      {
        ...scriptInput,
        baseVersion: 1,
        paragraphs: Array.from({ length: 9 }, (_, i) => ({
          ...paragraph,
          id: `p-${i}`,
          text: "文".repeat(1500),
        })),
      },
    ])
      assert.equal((await f.request(path, "POST", invalid)).status, 400);
    f.db.exec(
      "CREATE TRIGGER reject_script_version BEFORE INSERT ON content_script_versions BEGIN SELECT RAISE(ABORT,'forced script test failure'); END",
    );
    assert.equal(
      (await f.request(path, "POST", { ...scriptInput, baseVersion: 1 }))
        .status,
      500,
    );
    const detail = (await f.request(`/courses/${course.id}`)).data;
    assert.equal(detail.course.latestScriptVersion, 1);
    assert.equal(detail.versions.length, 1);
  } finally {
    f.close();
  }
});

test("Content migration preserves legacy data and product, course, finalization and binding snapshots survive reopen", async () => {
  const folder = mkdtempSync(join(tmpdir(), "kaopu-content-test-")),
    path = join(folder, "studio.sqlite");
  const f = await fixture(path);
  try {
    const { product, course } = await f.setup();
    await f.request(`/courses/${course.id}/scripts`, "POST", scriptInput);
    await f.request(
      `/courses/${course.id}/scripts/1/confirm`,
      "POST",
      confirmation,
    );
    await f.request("/rooms/demo-room/binding", "POST", {
      courseId: course.id,
      scriptVersion: 1,
    });
    const before = getRoomContentBinding(f.db, "demo-room", "demo");
    const legacyCount = f.db.prepare("SELECT count(*) AS n FROM facts").get()!
      .n;
    f.close();
    const restored = await fixture(path);
    try {
      assert.equal(
        restored.db
          .prepare("SELECT max(version) AS v FROM schema_migrations")
          .get()!.v,
        5,
      );
      assert.equal(
        restored.db.prepare("SELECT count(*) AS n FROM facts").get()!.n,
        legacyCount,
      );
      assert.deepEqual(
        getRoomContentBinding(restored.db, "demo-room", "demo"),
        before,
      );
      assert.equal(
        (await restored.request(`/products/${product.id}`)).data.versions
          .length,
        1,
      );
      assert.equal(
        (await restored.request(`/courses/${course.id}`)).data.versions[0]
          .confirmation.note,
        confirmation.note,
      );
    } finally {
      restored.close();
    }
  } finally {
    try {
      f.close();
    } catch {}
    rmSync(folder, { recursive: true, force: true });
  }
});

test("version comparison retains both evidence snapshots and isolates foreign requests", async () => {
  const f = await fixture();
  try {
    const { product, course } = await f.setup();
    const base = `/courses/${course.id}`;
    await f.request(base + "/scripts", "POST", scriptInput);
    const edited = { ...paragraph, text: "这只杯子的容量为500毫升。" };
    await f.request(base + "/scripts", "POST", {
      ...scriptInput,
      baseVersion: 1,
      paragraphs: [
        {
          id: "welcome",
          kind: "transition",
          text: "我们一起看看。",
          factIds: [],
        },
        edited,
      ],
    });
    const comparison = await f.request(base + "/compare?from=1&to=2");
    assert.equal(comparison.status, 200);
    assert.equal(comparison.data.before.paragraphs[0].text, paragraph.text);
    assert.equal(comparison.data.after.paragraphs[1].text, edited.text);
    assert.deepEqual(comparison.data.comparison.counts, {
      added: 1,
      removed: 0,
      changed: 1,
      unchanged: 0,
    });
    assert.deepEqual(comparison.data.comparison.changes[1].fields, [
      "text",
      "position",
    ]);
    assert.equal(
      (await f.request(base + "/compare?from=1&to=2", "GET", undefined, true))
        .status,
      404,
    );
    assert.equal((await f.request(base + "/compare?from=0&to=2")).status, 400);
    assert.equal(
      (await f.request(base + "/compare?from=1&to=999")).status,
      404,
    );
    await f.request(`/products/${product.id}/versions`, "POST", {
      ...productInput,
      baseVersion: 1,
      category: "修改后的测试分类",
    });
    await f.request(base + "/scripts", "POST", {
      ...scriptInput,
      baseVersion: 2,
      productVersion: 2,
    });
    const later = (await f.request(base + "/compare?from=1&to=3")).data;
    assert.equal(later.comparison.evidenceChanged, true);
    assert.equal(later.before.productSnapshot.category, "测试教具");
    assert.equal(later.after.productSnapshot.category, "修改后的测试分类");
    assert.equal(later.comparison.counts.unchanged, 1);
    const reverse = (await f.request(base + "/compare?from=2&to=1")).data
      .comparison;
    assert.equal(reverse.counts.removed, 1);
  } finally {
    f.close();
  }
});

test("binding audit preserves each changed selection atomically without duplicate retries", async () => {
  const f = await fixture();
  try {
    const { course } = await f.setup();
    const base = `/courses/${course.id}`;
    for (let version = 1; version <= 2; version++) {
      await f.request(base + "/scripts", "POST", {
        ...scriptInput,
        baseVersion: version - 1,
      });
      await f.request(
        base + `/scripts/${version}/confirm`,
        "POST",
        confirmation,
      );
    }
    const bind = (version: number) =>
      f.request("/rooms/demo-room/binding", "POST", {
        courseId: course.id,
        scriptVersion: version,
      });
    assert.equal((await bind(1)).status, 201);
    assert.equal((await bind(1)).status, 201);
    assert.equal((await bind(2)).status, 201);
    const history = (await f.request("/rooms/demo-room/binding-history")).data
      .history;
    assert.equal(history.length, 2);
    assert.deepEqual(
      history.map((r: any) => r.scriptVersion),
      [2, 1],
    );
    assert.equal(history[0].actorId, "demo");
    assert.equal(history[0].source, "binding");
    assert.equal(history[0].courseTitle, "第一课");
    f.db
      .prepare("UPDATE content_courses SET title='改名后的课程' WHERE id=?")
      .run(course.id);
    assert.equal(
      (await f.request("/rooms/demo-room/binding-history")).data.history[0]
        .courseTitle,
      "第一课",
    );
    assert.equal(
      (
        await f.request(
          `/rooms/demo-room/binding-history?before=${history[0].id}`,
        )
      ).data.history.length,
      1,
    );
    assert.equal(
      (
        await f.request(
          "/rooms/demo-room/binding-history",
          "GET",
          undefined,
          true,
        )
      ).status,
      404,
    );
    assert.throws(
      () => f.db.exec("UPDATE content_binding_history SET actor_id='forged'"),
      /immutable/,
    );
    assert.throws(
      () => f.db.exec("DELETE FROM content_binding_history"),
      /immutable/,
    );
    f.db.exec(
      "CREATE TRIGGER fail_binding_audit BEFORE INSERT ON content_binding_history BEGIN SELECT RAISE(ABORT,'injected audit failure'); END;",
    );
    assert.equal((await bind(1)).status, 500);
    assert.equal(
      (await f.request("/rooms/demo-room/binding")).data.binding.scriptVersion,
      2,
    );
    assert.equal(
      (await f.request("/rooms/demo-room/binding-history")).data.history.length,
      2,
    );
  } finally {
    f.close();
  }
});

test("v4 migration records only the known current binding and does not invent its actor", async () => {
  const directory = mkdtempSync(join(tmpdir(), "kaopu-binding-migration-"));
  const path = join(directory, "test.sqlite");
  const f = await fixture(path);
  try {
    const { course } = await f.setup();
    await f.request(`/courses/${course.id}/scripts`, "POST", scriptInput);
    await f.request(
      `/courses/${course.id}/scripts/1/confirm`,
      "POST",
      confirmation,
    );
    await f.request("/rooms/demo-room/binding", "POST", {
      courseId: course.id,
      scriptVersion: 1,
    });
    f.db.exec(
      "DROP TABLE content_binding_history; DELETE FROM schema_migrations WHERE version=5;",
    );
    f.close();
    const migrated = openDatabase(path);
    try {
      const row = migrated
        .prepare("SELECT * FROM content_binding_history")
        .get()!;
      assert.equal(row.actor_id, null);
      assert.equal(row.source, "legacy_snapshot");
      assert.equal(row.course_id, course.id);
      assert.equal(row.script_version, 1);
      assert.equal(
        row.bound_at,
        migrated.prepare("SELECT bound_at FROM content_room_bindings").get()!
          .bound_at,
      );
    } finally {
      migrated.close();
    }
    const reopened = openDatabase(path);
    try {
      assert.equal(
        reopened
          .prepare("SELECT COUNT(*) AS n FROM content_binding_history")
          .get()!.n,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    if (f.db.isOpen) f.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
