import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AgentBridge } from "../../platform/adapters/public.js";
import {
  conflict,
  notFound,
  transaction,
} from "../../platform/infrastructure/public.js";
import { compareScripts } from "../../shared/content-diff.js";
import type {
  ConfirmationRow,
  CourseRow,
  KnowledgePort,
  MarketingPort,
  ReviewPort,
  ScriptRow,
} from "../../shared/content-ports.js";
import {
  CONTENT_LIMITS,
  type ContentCourse,
  type ScriptConfirmation,
  type ScriptVersion,
} from "../../shared/content.js";
import type { DB } from "../../shared/persistence.js";
import { attachContentGeneration } from "./generation.js";
import {
  findContentCoursesById,
  findContentCoursesById2,
  findContentCoursesByPlanId,
  findContentScriptAuthorsByCourseIdAndScriptVersion,
  findContentScriptVersionsByCourseIdAndVersion,
  insertContentCourses,
  insertContentScriptAuthors,
  insertContentScriptVersions,
  listContentCourses,
  listContentCoursesByPlanId,
  listContentScriptVersionsByCourseId,
  updateContentCoursesById,
  updateContentCoursesById2,
} from "./persistence/courses-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
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
export function createContent(
  db: DB,
  knowledge: KnowledgePort,
  marketing: MarketingPort,
  reviewProvider: () => ReviewPort,
  clock: () => number = Date.now,
  bridge?: AgentBridge,
) {
  const { productOwned, productVersion, productDto } = knowledge;
  const { planOwned, planDto } = marketing;
  const checkScript: ReviewPort["checkScript"] = (...args) =>
    reviewProvider().checkScript(...args);
  const readScriptReview: ReviewPort["readScriptReview"] = (...args) =>
    reviewProvider().readScriptReview(...args);
  function courseOwned(id: string, merchant: string): CourseRow {
    const row = findContentCoursesById(db, id) as unknown as
      CourseRow | undefined;
    if (!row) return notFound("课程不存在");
    planOwned(row.plan_id, merchant);
    return row;
  }
  function scriptVersion(
    courseId: string,
    version: number,
    merchant: string,
  ): ScriptVersion {
    courseOwned(courseId, merchant);
    const row = findContentScriptVersionsByCourseIdAndVersion(
      db,
      courseId,
      version,
    ) as ScriptRow | undefined;
    if (!row) return notFound("讲稿版本不存在");
    const current = productOwned(row.product_id, merchant);
    const confirmationRow = reviewProvider().readConfirmation(
      courseId,
      version,
    ) as ConfirmationRow | undefined;
    const review = readScriptReview(courseId, version);
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
      check.ruleVersion !== reviewProvider().ruleVersion;
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
  const saveScript = (
    id: string,
    merchant: string,
    actor: string,
    value: unknown,
  ) => {
    const input = scriptSchema.parse(value);
    const course = courseOwned(id, merchant),
      plan = planOwned(course.plan_id, merchant),
      product = productOwned(plan.product_id, merchant);
    if (course.latest_script_version !== input.baseVersion)
      conflict("讲稿已更新，请读取最新版本后再保存。");
    if (product.latest_version !== input.productVersion)
      conflict("商品依据已变化，请先刷新并核对当前证据版本。");
    const snapshot = productVersion(product.id, input.productVersion),
      now = clock(),
      review = checkScript(input.paragraphs, snapshot, now),
      next = input.baseVersion + 1;
    insertContentScriptVersions(
      db,
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
    updateContentCoursesById(db, next, id);
    insertContentScriptAuthors(db, id, next, actor);
    return next;
  };
  const listCourses = (plan: string) =>
    (listContentCoursesByPlanId(db, plan) as unknown as CourseRow[]).map(
      courseDto,
    );
  const maxDay = (plan: string) =>
    Number(findContentCoursesByPlanId(db, plan)!.n);
  const author = (id: string, version: number) => {
    const row = findContentScriptAuthorsByCourseIdAndScriptVersion(
      db,
      id,
      version,
    );
    return row ? String(row.actor_id) : null;
  };
  const latest = (id: string) =>
    Number(findContentCoursesById2(db, id)?.v ?? 0);
  const reviewCandidates = (merchant: string) => {
    const candidates: {
      courseId: string;
      courseTitle: string;
      productName: string;
      version: number;
    }[] = [];
    for (const row of listContentCourses(
      db,
      JSON.stringify(marketing.planIds(merchant)),
    ) as unknown as CourseRow[]) {
      try {
        const plan = planOwned(row.plan_id, merchant);
        const product = productOwned(plan.product_id, merchant);
        candidates.push({
          courseId: row.id,
          courseTitle: row.title,
          productName: product.name,
          version: row.latest_script_version,
        });
      } catch (error) {
        if (!(error instanceof HTTPException) || error.status !== 404)
          throw error;
      }
    }
    return candidates;
  };
  return {
    courseOwned,
    courseDto,
    scriptVersion,
    saveScript,
    listCourses,
    maxDay,
    author,
    latest,
    reviewCandidates,
    attach(app: App) {
      if (bridge)
        attachContentGeneration(
          app,
          db,
          bridge,
          (id, merchant) => {
            const course = courseOwned(id, merchant),
              plan = planOwned(course.plan_id, merchant),
              product = productOwned(plan.product_id, merchant);
            return {
              courseId: id,
              baseVersion: course.latest_script_version,
              productId: product.id,
              productVersion: product.latest_version,
              productName: product.name,
              category: product.category,
              title: course.title,
              objective: course.objective,
              audience: plan.audience,
              facts: productVersion(product.id, product.latest_version).facts,
            };
          },
          saveScript,
          clock,
        );
      app.post("/api/merchant/content/plans/:id/courses", async (c) => {
        const plan = planOwned(c.req.param("id"), c.get("merchantId"));
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
        insertContentCourses(
          db,
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
          { course: courseDto(courseOwned(id, c.get("merchantId"))) },
          201,
        );
      });
      app.get("/api/merchant/content/courses/:id", (c) => {
        const merchant = c.get("merchantId"),
          course = courseOwned(c.req.param("id"), merchant),
          plan = planOwned(course.plan_id, merchant),
          product = productOwned(plan.product_id, merchant);
        return c.json({
          course: courseDto(course),
          plan: planDto(plan),
          product: productDto(product),
          versions: (
            listContentScriptVersionsByCourseId(db, course.id) as {
              version: number;
            }[]
          ).map((row) => scriptVersion(course.id, row.version, merchant)),
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
          c.req.param("id"),
          query.from,
          c.get("merchantId"),
        );
        const after = scriptVersion(
          c.req.param("id"),
          query.to,
          c.get("merchantId"),
        );
        return c.json({
          comparison: compareScripts(before, after),
          before,
          after,
        });
      });
      app.patch("/api/merchant/content/courses/:id", async (c) => {
        const { base, ...input } = courseFieldsSchema
          .extend({ base: courseFieldsSchema })
          .parse(await c.req.json());
        const merchant = c.get("merchantId"),
          id = c.req.param("id");
        transaction(db, () => {
          const current = courseOwned(id, merchant),
            plan = planOwned(current.plan_id, merchant);
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
            conflict(
              "课时天数超出当前营销周期，请先调整周期或选择周期内日期。",
            );
          updateContentCoursesById2(
            db,
            input.title,
            input.dayIndex,
            input.objective,
            input.durationMinutes,
            input.scheduleLabel,
            input.presenterName,
            id,
          );
        });
        return c.json({ course: courseDto(courseOwned(id, merchant)) });
      });
      app.post("/api/merchant/content/courses/:id/scripts", async (c) => {
        const input = scriptSchema.parse(await c.req.json()),
          merchant = c.get("merchantId"),
          id = c.req.param("id");
        const next = transaction(db, () =>
          saveScript(id, merchant, c.get("actorId") || merchant, input),
        );
        return c.json({ script: scriptVersion(id, next, merchant) }, 201);
      });
    },
  };
}
