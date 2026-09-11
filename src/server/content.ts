import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
import { checkScript, CONTENT_RULE_VERSION } from "./content-check.js";
import { compareScripts } from "../shared/content-diff.js";
import { readScriptReview, attachScriptReview } from "./script-review.js";
import {
  CONTENT_LIMITS,
  type ContentProduct,
  type ProductVersion,
  type ContentPlan,
  type ContentCourse,
  type ScriptVersion,
  type ScriptConfirmation,
  type ContentBinding,
} from "../shared/content.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const productSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(80),
    facts: z
      .array(
        z
          .object({
            id: identifier.optional(),
            text: z.string().trim().min(1).max(400),
            evidence: z.string().trim().min(1).max(500),
            approved: z.boolean(),
          })
          .strict(),
      )
      .max(CONTENT_LIMITS.facts)
      .refine((facts) => {
        const ids = facts.flatMap((fact) => (fact.id ? [fact.id] : []));
        return new Set(ids).size === ids.length;
      }),
  })
  .strict();
const scriptSchema = z
  .object({
    baseVersion: z.number().int().min(0),
    productVersion: z.number().int().positive(),
    changeNote: z.string().max(500),
    paragraphs: z
      .array(
        z
          .object({
            id: identifier,
            kind: z.enum(["fact", "transition"]),
            text: z
              .string()
              .trim()
              .min(1)
              .max(CONTENT_LIMITS.paragraphCharacters),
            factIds: z
              .array(identifier)
              .max(8)
              .refine((ids) => new Set(ids).size === ids.length),
          })
          .strict(),
      )
      .min(1)
      .max(CONTENT_LIMITS.paragraphs)
      .refine(
        (paragraphs) =>
          paragraphs.reduce((total, p) => total + p.text.length, 0) <=
          CONTENT_LIMITS.scriptCharacters,
      )
      .refine(
        (paragraphs) =>
          new Set(paragraphs.map((p) => p.id)).size === paragraphs.length,
      ),
  })
  .strict();
const planFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    audience: z.string().max(500),
    totalDays: z.number().int().min(1).max(365),
  })
  .strict();
const courseFieldsSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    dayIndex: z.number().int().min(1).max(365),
    objective: z.string().max(1000),
    durationMinutes: z.number().int().min(1).max(180).default(45),
    scheduleLabel: z.string().max(80).default(""),
    presenterName: z.string().max(80).default(""),
  })
  .strict();
type ProductRow = {
  id: string;
  merchant_id: string;
  name: string;
  sku: string;
  category: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
};
type PlanRow = {
  id: string;
  product_id: string;
  name: string;
  audience: string;
  total_days: number;
  created_at: number;
};
type CourseRow = {
  id: string;
  plan_id: string;
  title: string;
  day_index: number;
  objective: string;
  duration_minutes: number;
  schedule_label: string;
  presenter_name: string;
  latest_script_version: number;
  created_at: number;
};
type ScriptRow = {
  course_id: string;
  version: number;
  product_id: string;
  product_version: number;
  product_snapshot_json: string;
  paragraphs_json: string;
  change_note: string;
  check_json: string;
  created_at: number;
};
type ConfirmationRow = {
  confirmed_at: number;
  confirmed_by: string;
  note: string;
};
const productDto = (r: ProductRow): ContentProduct => ({
  id: r.id,
  name: r.name,
  sku: r.sku,
  category: r.category,
  latestVersion: r.latest_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
const planDto = (r: PlanRow): ContentPlan => ({
  id: r.id,
  productId: r.product_id,
  name: r.name,
  audience: r.audience,
  totalDays: r.total_days,
  createdAt: r.created_at,
});
const courseDto = (r: CourseRow): ContentCourse => ({
  id: r.id,
  planId: r.plan_id,
  title: r.title,
  dayIndex: r.day_index,
  objective: r.objective,
  durationMinutes: r.duration_minutes,
  scheduleLabel: r.schedule_label,
  presenterName: r.presenter_name,
  latestScriptVersion: r.latest_script_version,
  createdAt: r.created_at,
});
const notFound = (message: string): never => {
  throw new HTTPException(404, { message });
};
const conflict = (message: string): never => {
  throw new HTTPException(409, { message });
};
function productOwned(db: DB, id: string, merchant: string): ProductRow {
  return (
    (db
      .prepare("SELECT * FROM content_products WHERE id=? AND merchant_id=?")
      .get(id, merchant) as ProductRow | undefined) ?? notFound("商品不存在")
  );
}
function planOwned(db: DB, id: string, merchant: string): PlanRow {
  return (
    (db
      .prepare(
        "SELECT p.* FROM content_plans p JOIN content_products product ON product.id=p.product_id WHERE p.id=? AND product.merchant_id=?",
      )
      .get(id, merchant) as PlanRow | undefined) ?? notFound("营销周期不存在")
  );
}
function courseOwned(db: DB, id: string, merchant: string): CourseRow {
  return (
    (db
      .prepare(
        "SELECT c.* FROM content_courses c JOIN content_plans p ON p.id=c.plan_id JOIN content_products product ON product.id=p.product_id WHERE c.id=? AND product.merchant_id=?",
      )
      .get(id, merchant) as CourseRow | undefined) ?? notFound("课程不存在")
  );
}
function productVersion(db: DB, id: string, version: number): ProductVersion {
  const row = db
    .prepare(
      "SELECT snapshot_json FROM content_product_versions WHERE product_id=? AND version=?",
    )
    .get(id, version) as { snapshot_json: string } | undefined;
  return row
    ? (JSON.parse(row.snapshot_json) as ProductVersion)
    : notFound("商品证据版本不存在");
}
function scriptVersion(
  db: DB,
  courseId: string,
  version: number,
  merchant: string,
): ScriptVersion {
  courseOwned(db, courseId, merchant);
  const row = db
    .prepare(
      "SELECT * FROM content_script_versions WHERE course_id=? AND version=?",
    )
    .get(courseId, version) as ScriptRow | undefined;
  if (!row) return notFound("讲稿版本不存在");
  const current = productOwned(db, row.product_id, merchant);
  const confirmationRow = db
    .prepare(
      "SELECT * FROM content_script_confirmations WHERE course_id=? AND script_version=?",
    )
    .get(courseId, version) as ConfirmationRow | undefined;
  const review = readScriptReview(db, courseId, version);
  const confirmation: ScriptConfirmation | undefined =
    review.decision?.decision === "approved"
      ? {
          confirmedAt: review.decision.reviewedAt,
          confirmedBy: review.decision.reviewerId,
          note: review.decision.note,
          role: "independent_review",
        }
      : review.submission
        ? undefined
        : confirmationRow
          ? {
              confirmedAt: confirmationRow.confirmed_at,
              confirmedBy: confirmationRow.confirmed_by,
              note: confirmationRow.note,
              role: "merchant_self_confirmation",
            }
          : undefined;
  const check = JSON.parse(row.check_json) as ScriptVersion["check"];
  const stale =
    current.latest_version !== row.product_version ||
    check.ruleVersion !== CONTENT_RULE_VERSION;
  return {
    courseId,
    version: row.version,
    productId: row.product_id,
    productSnapshot: JSON.parse(row.product_snapshot_json),
    paragraphs: JSON.parse(row.paragraphs_json),
    changeNote: row.change_note,
    createdAt: row.created_at,
    check,
    ...(confirmation ? { confirmation } : {}),
    stale,
    state: stale
      ? "needs_review"
      : confirmation
        ? "final"
        : review.decision
          ? "changes_requested"
          : review.submission
            ? "pending_review"
            : "draft",
  };
}
function roomOwned(db: DB, roomId: string, merchant: string) {
  if (
    !db
      .prepare("SELECT 1 FROM rooms WHERE id=? AND merchant_id=?")
      .get(roomId, merchant)
  )
    notFound("直播间不存在");
}
/** Returns the historical binding with stale=true after any product evidence/category revision. */
export function getRoomContentBinding(
  db: DB,
  roomId: string,
  merchant: string,
  requireIndependentReview = false,
): ContentBinding | null {
  roomOwned(db, roomId, merchant);
  const row = db
    .prepare("SELECT * FROM content_room_bindings WHERE room_id=?")
    .get(roomId) as
    { course_id: string; script_version: number; bound_at: number } | undefined;
  if (!row) return null;
  const script = scriptVersion(db, row.course_id, row.script_version, merchant);
  return {
    roomId,
    courseTitle: courseOwned(db, row.course_id, merchant).title,
    courseId: row.course_id,
    scriptVersion: row.script_version,
    boundAt: row.bound_at,
    productId: script.productId,
    productName: script.productSnapshot.name,
    category: script.productSnapshot.category,
    stale:
      script.stale ||
      !script.confirmation ||
      script.check.blockingCount > 0 ||
      (requireIndependentReview &&
        script.confirmation.role !== "independent_review"),
    script,
  };
}

export function attachContent(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  clock: () => number = Date.now,
) {
  attachScriptReview(
    app,
    db,
    (id, version, merchant) => scriptVersion(db, id, version, merchant),
    clock,
  );
  app.get("/api/merchant/content/products", (c) =>
    c.json({
      products: (
        db
          .prepare(
            "SELECT * FROM content_products WHERE merchant_id=? ORDER BY updated_at DESC,rowid DESC",
          )
          .all(c.get("merchantId")) as ProductRow[]
      ).map(productDto),
    }),
  );
  app.post("/api/merchant/content/products", async (c) => {
    const input = productSchema.parse(await c.req.json()),
      merchant = c.get("merchantId"),
      id = randomUUID(),
      now = clock();
    const version: ProductVersion = {
      ...input,
      version: 1,
      createdAt: now,
      facts: input.facts.map((fact) => ({
        ...fact,
        id: fact.id || randomUUID(),
      })),
    };
    transaction(db, () => {
      if (
        db
          .prepare(
            "SELECT 1 FROM content_products WHERE merchant_id=? AND sku=?",
          )
          .get(merchant, input.sku)
      )
        conflict("此 SKU 已存在，请打开已有商品建立新证据版本。");
      db.prepare("INSERT INTO content_products VALUES(?,?,?,?,?,1,?,?)").run(
        id,
        merchant,
        input.name,
        input.sku,
        input.category,
        now,
        now,
      );
      db.prepare("INSERT INTO content_product_versions VALUES(?,1,?,?)").run(
        id,
        JSON.stringify(version),
        now,
      );
    });
    return c.json(
      { product: productDto(productOwned(db, id, merchant)), version },
      201,
    );
  });
  app.get("/api/merchant/content/products/:id", (c) => {
    const product = productOwned(db, c.req.param("id"), c.get("merchantId"));
    return c.json({
      product: productDto(product),
      versions: (
        db
          .prepare(
            "SELECT snapshot_json FROM content_product_versions WHERE product_id=? ORDER BY version DESC",
          )
          .all(product.id) as { snapshot_json: string }[]
      ).map((row) => JSON.parse(row.snapshot_json) as ProductVersion),
    });
  });
  app.post("/api/merchant/content/products/:id/versions", async (c) => {
    const { baseVersion, ...input } = productSchema
        .extend({ baseVersion: z.number().int().positive() })
        .parse(await c.req.json()),
      merchant = c.get("merchantId"),
      id = c.req.param("id");
    const version = transaction(db, () => {
      const current = productOwned(db, id, merchant);
      if (current.latest_version !== baseVersion)
        conflict("商品资料已由其他操作更新，请刷新后再保存，避免覆盖新内容。");
      if (
        db
          .prepare(
            "SELECT 1 FROM content_products WHERE merchant_id=? AND sku=? AND id<>?",
          )
          .get(merchant, input.sku, id)
      )
        conflict("此 SKU 已被另一个商品使用。");
      const now = clock(),
        version: ProductVersion = {
          ...input,
          version: baseVersion + 1,
          createdAt: now,
          facts: input.facts.map((fact) => ({
            ...fact,
            id: fact.id || randomUUID(),
          })),
        };
      db.prepare("INSERT INTO content_product_versions VALUES(?,?,?,?)").run(
        id,
        version.version,
        JSON.stringify(version),
        now,
      );
      db.prepare(
        "UPDATE content_products SET name=?,sku=?,category=?,latest_version=?,updated_at=? WHERE id=?",
      ).run(input.name, input.sku, input.category, version.version, now, id);
      return version;
    });
    return c.json(
      { product: productDto(productOwned(db, id, merchant)), version },
      201,
    );
  });
  app.get("/api/merchant/content/plans", (c) => {
    const merchant = c.get("merchantId"),
      productId = c.req.query("productId");
    if (productId) productOwned(db, identifier.parse(productId), merchant);
    return c.json({
      plans: (
        db
          .prepare(
            "SELECT p.* FROM content_plans p JOIN content_products product ON product.id=p.product_id WHERE product.merchant_id=? AND (? IS NULL OR product.id=?) ORDER BY p.created_at DESC,p.rowid DESC",
          )
          .all(merchant, productId || null, productId || null) as PlanRow[]
      ).map(planDto),
    });
  });
  app.post("/api/merchant/content/plans", async (c) => {
    const input = z
      .object({
        productId: identifier,
        name: z.string().trim().min(1).max(120),
        audience: z.string().max(500),
        totalDays: z.number().int().min(1).max(365),
      })
      .strict()
      .parse(await c.req.json());
    productOwned(db, input.productId, c.get("merchantId"));
    const id = randomUUID();
    db.prepare("INSERT INTO content_plans VALUES(?,?,?,?,?,?)").run(
      id,
      input.productId,
      input.name,
      input.audience,
      input.totalDays,
      clock(),
    );
    return c.json(
      { plan: planDto(planOwned(db, id, c.get("merchantId"))) },
      201,
    );
  });
  app.get("/api/merchant/content/plans/:id", (c) => {
    const plan = planOwned(db, c.req.param("id"), c.get("merchantId"));
    return c.json({
      plan: planDto(plan),
      courses: (
        db
          .prepare(
            "SELECT * FROM content_courses WHERE plan_id=? ORDER BY day_index,created_at,rowid",
          )
          .all(plan.id) as CourseRow[]
      ).map(courseDto),
    });
  });
  app.patch("/api/merchant/content/plans/:id", async (c) => {
    const { base, ...input } = planFieldsSchema
      .extend({ base: planFieldsSchema })
      .parse(await c.req.json());
    const merchant = c.get("merchantId"),
      id = c.req.param("id");
    transaction(db, () => {
      const current = planOwned(db, id, merchant);
      if (
        current.name !== base.name ||
        current.audience !== base.audience ||
        current.total_days !== base.totalDays
      )
        conflict("营销周期已更新，请刷新当前安排后再修改。");
      const maxDay = Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(day_index),0) AS max_day FROM content_courses WHERE plan_id=?",
          )
          .get(id)!.max_day,
      );
      if (input.totalDays < maxDay)
        conflict("周期天数不能早于已安排课时的最后一天；请先调整相关课时。");
      db.prepare(
        "UPDATE content_plans SET name=?,audience=?,total_days=? WHERE id=?",
      ).run(input.name, input.audience, input.totalDays, id);
    });
    return c.json({ plan: planDto(planOwned(db, id, merchant)) });
  });
  app.post("/api/merchant/content/plans/:id/courses", async (c) => {
    const plan = planOwned(db, c.req.param("id"), c.get("merchantId"));
    const input = z
      .object({
        title: z.string().trim().min(1).max(120),
        dayIndex: z.number().int().min(1).max(plan.total_days),
        objective: z.string().max(1000),
        durationMinutes: z.number().int().min(1).max(180).default(45),
        scheduleLabel: z.string().max(80).default(""),
        presenterName: z.string().max(80).default(""),
      })
      .strict()
      .parse(await c.req.json());
    const id = randomUUID();
    db.prepare("INSERT INTO content_courses VALUES(?,?,?,?,?,?,?,?,0,?)").run(
      id,
      plan.id,
      input.title,
      input.dayIndex,
      input.objective,
      input.durationMinutes,
      input.scheduleLabel,
      input.presenterName,
      clock(),
    );
    return c.json(
      { course: courseDto(courseOwned(db, id, c.get("merchantId"))) },
      201,
    );
  });
  app.get("/api/merchant/content/courses/:id", (c) => {
    const merchant = c.get("merchantId"),
      course = courseOwned(db, c.req.param("id"), merchant),
      plan = planOwned(db, course.plan_id, merchant),
      product = productOwned(db, plan.product_id, merchant);
    return c.json({
      course: courseDto(course),
      plan: planDto(plan),
      product: productDto(product),
      versions: (
        db
          .prepare(
            "SELECT version FROM content_script_versions WHERE course_id=? ORDER BY version DESC",
          )
          .all(course.id) as { version: number }[]
      ).map((row) => scriptVersion(db, course.id, row.version, merchant)),
    });
  });
  app.get("/api/merchant/content/courses/:id/compare", (c) => {
    const query = z
      .object({
        from: z.coerce.number().int().positive(),
        to: z.coerce.number().int().positive(),
      })
      .parse(c.req.query());
    const before = scriptVersion(
      db,
      c.req.param("id"),
      query.from,
      c.get("merchantId"),
    );
    const after = scriptVersion(
      db,
      c.req.param("id"),
      query.to,
      c.get("merchantId"),
    );
    return c.json({ comparison: compareScripts(before, after), before, after });
  });
  app.patch("/api/merchant/content/courses/:id", async (c) => {
    const { base, ...input } = courseFieldsSchema
      .extend({ base: courseFieldsSchema })
      .parse(await c.req.json());
    const merchant = c.get("merchantId"),
      id = c.req.param("id");
    transaction(db, () => {
      const current = courseOwned(db, id, merchant),
        plan = planOwned(db, current.plan_id, merchant);
      if (
        current.title !== base.title ||
        current.day_index !== base.dayIndex ||
        current.objective !== base.objective ||
        current.duration_minutes !== base.durationMinutes ||
        current.schedule_label !== base.scheduleLabel ||
        current.presenter_name !== base.presenterName
      )
        conflict("课时安排已更新，请刷新当前安排后再修改。");
      if (input.dayIndex > plan.total_days)
        conflict("课时天数超出当前营销周期，请先调整周期或选择周期内日期。");
      db.prepare(
        "UPDATE content_courses SET title=?,day_index=?,objective=?,duration_minutes=?,schedule_label=?,presenter_name=? WHERE id=?",
      ).run(
        input.title,
        input.dayIndex,
        input.objective,
        input.durationMinutes,
        input.scheduleLabel,
        input.presenterName,
        id,
      );
    });
    return c.json({ course: courseDto(courseOwned(db, id, merchant)) });
  });
  app.post("/api/merchant/content/courses/:id/scripts", async (c) => {
    const input = scriptSchema.parse(await c.req.json()),
      merchant = c.get("merchantId"),
      id = c.req.param("id");
    const next = transaction(db, () => {
      const course = courseOwned(db, id, merchant),
        plan = planOwned(db, course.plan_id, merchant),
        product = productOwned(db, plan.product_id, merchant);
      if (course.latest_script_version !== input.baseVersion)
        conflict("讲稿已更新，请读取最新版本后再保存。");
      if (product.latest_version !== input.productVersion)
        conflict("商品依据已变化，请先刷新并核对当前证据版本。");
      const snapshot = productVersion(db, product.id, input.productVersion),
        now = clock(),
        review = checkScript(input.paragraphs, snapshot, now),
        next = input.baseVersion + 1;
      db.prepare(
        "INSERT INTO content_script_versions VALUES(?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        next,
        product.id,
        input.productVersion,
        JSON.stringify(snapshot),
        JSON.stringify(input.paragraphs),
        input.changeNote,
        JSON.stringify(review),
        now,
      );
      db.prepare(
        "UPDATE content_courses SET latest_script_version=? WHERE id=?",
      ).run(next, id);
      db.prepare("INSERT INTO content_script_authors VALUES(?,?,?)").run(
        id,
        next,
        c.get("actorId") || merchant,
      );
      return next;
    });
    return c.json({ script: scriptVersion(db, id, next, merchant) }, 201);
  });
  app.post(
    "/api/merchant/content/courses/:id/scripts/:version/confirm",
    async (c) => {
      if (c.get("requireIndependentReview"))
        throw new HTTPException(409, {
          message: "此工作空间要求独立审核，请提交审核并由另一审核账号确认。",
        });
      const input = z
        .object({
          note: z.string().trim().min(1).max(1000),
          acknowledged: z.literal(true),
        })
        .strict()
        .parse(await c.req.json());
      const merchant = c.get("merchantId"),
        id = c.req.param("id"),
        version = z.coerce
          .number()
          .int()
          .positive()
          .parse(c.req.param("version"));
      transaction(db, () => {
        const script = scriptVersion(db, id, version, merchant);
        if (readScriptReview(db, id, version).submission)
          conflict("此稿已进入独立审核流程，不能改用本人确认。");
        if (script.stale)
          conflict(
            "商品依据或检查规则已变化；请用当前证据保存新的讲稿版本并重新检查。",
          );
        if (script.check.blockingCount)
          conflict("讲稿存在阻断项，需要修改并保存新版本后再定稿。");
        if (!script.confirmation)
          db.prepare(
            "INSERT INTO content_script_confirmations VALUES(?,?,?,?,?)",
          ).run(id, version, clock(), merchant, input.note);
      });
      return c.json({ script: scriptVersion(db, id, version, merchant) });
    },
  );
  app.get("/api/merchant/content/rooms/:id/binding", (c) =>
    c.json({
      binding: getRoomContentBinding(
        db,
        c.req.param("id"),
        c.get("merchantId"),
        c.get("requireIndependentReview"),
      ),
    }),
  );
  app.get("/api/merchant/content/rooms/:id/binding-history", (c) => {
    const roomId = c.req.param("id");
    roomOwned(db, roomId, c.get("merchantId"));
    const before = z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .optional()
      .parse(c.req.query("before"));
    const rows = db
      .prepare(
        `SELECT id,room_id AS roomId,course_id AS courseId,script_version AS scriptVersion,
      bound_at AS boundAt,actor_id AS actorId,source,room_title AS roomTitle,course_title AS courseTitle,product_name AS productName
      FROM content_binding_history WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 51`,
      )
      .all(roomId, before ?? Number.MAX_SAFE_INTEGER);
    return c.json({
      history: rows.slice(0, 50),
      nextBefore: rows.length > 50 ? rows[49].id : null,
    });
  });
  app.post("/api/merchant/content/rooms/:id/binding", async (c) => {
    const input = z
        .object({
          courseId: identifier,
          scriptVersion: z.number().int().positive(),
        })
        .strict()
        .parse(await c.req.json()),
      merchant = c.get("merchantId"),
      roomId = c.req.param("id");
    transaction(db, () => {
      roomOwned(db, roomId, merchant);
      const script = scriptVersion(
        db,
        input.courseId,
        input.scriptVersion,
        merchant,
      );
      if (script.stale || !script.confirmation || script.check.blockingCount)
        conflict("仅可绑定当前商品依据下、无阻断项且已人工定稿的讲稿。");
      if (
        c.get("requireIndependentReview") &&
        script.confirmation?.role !== "independent_review"
      )
        conflict("此工作空间只允许绑定经独立审核批准的稿件。");
      const previous = db
        .prepare(
          "SELECT course_id,script_version FROM content_room_bindings WHERE room_id=?",
        )
        .get(roomId);
      if (
        previous?.course_id === input.courseId &&
        previous.script_version === input.scriptVersion
      )
        return;
      const boundAt = clock();
      db.prepare(
        "INSERT INTO content_room_bindings VALUES(?,?,?,?) ON CONFLICT(room_id) DO UPDATE SET course_id=excluded.course_id,script_version=excluded.script_version,bound_at=excluded.bound_at",
      ).run(roomId, input.courseId, input.scriptVersion, boundAt);
      db.prepare(
        `INSERT INTO content_binding_history(room_id,course_id,script_version,bound_at,actor_id,source,room_title,course_title,product_name)
        VALUES(?,?,?,?,?,'binding',?,?,?)`,
      ).run(
        roomId,
        input.courseId,
        input.scriptVersion,
        boundAt,
        c.get("actorId") || merchant,
        String(
          db.prepare("SELECT title FROM rooms WHERE id=?").get(roomId)!.title,
        ),
        courseOwned(db, input.courseId, merchant).title,
        script.productSnapshot.name,
      );
    });
    return c.json(
      { binding: getRoomContentBinding(db, roomId, merchant) },
      201,
    );
  });
}
