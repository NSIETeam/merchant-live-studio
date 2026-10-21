import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conflict,
  notFound,
  transaction,
} from "../../platform/infrastructure/public.js";
import type {
  ContentPort,
  KnowledgePort,
  PlanRow,
} from "../../shared/content-ports.js";
import type {
  ContentPlan,
  MarketingPlanComparison,
  MarketingPlanComparisonItem,
} from "../../shared/content.js";
import type { DB } from "../../shared/persistence.js";
import {
  findContentPlansById,
  insertContentPlans,
  listContentPlansByProductId,
  listTenantPlanIds,
  updateContentPlansById,
} from "./persistence/plans-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const planFieldsSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    audience: z.string().max(500),
    totalDays: z.number().int().min(1).max(365),
  })
  .strict();
const comparisonSchema = z
  .object({
    budgetCents: z.number().int().min(0).max(100_000_000_00),
    maxDailyPreparationMinutes: z.number().int().min(1).max(1440),
    options: z
      .array(
        z
          .object({
            planId: identifier,
            preparationMinutesPerCourse: z.number().int().min(0).max(1440),
            estimatedCostCents: z.number().int().min(0).max(100_000_000_00),
          })
          .strict(),
      )
      .min(2)
      .max(5),
  })
  .strict()
  .superRefine((value, ctx) => {
    const ids = value.options.map((option) => option.planId);
    if (new Set(ids).size !== ids.length)
      ctx.addIssue({
        code: "custom",
        path: ["options"],
        message: "不能重复比较同一个营销周期",
      });
  });
const planDto = (r: PlanRow): ContentPlan => ({
  id: r.id,
  productId: r.product_id,
  name: r.name,
  audience: r.audience,
  totalDays: r.total_days,
  createdAt: r.created_at,
});
export function createMarketing(
  db: DB,
  knowledge: KnowledgePort,
  content: () => ContentPort,
  clock: () => number = Date.now,
) {
  const { productOwned } = knowledge;
  function planOwned(id: string, merchant: string): PlanRow {
    const row = findContentPlansById(db, id) as unknown as PlanRow | undefined;
    if (!row) return notFound("营销周期不存在");
    knowledge.productOwned(row.product_id, merchant);
    return row;
  }
  const planIds = (merchant: string) =>
    listTenantPlanIds(db, JSON.stringify(knowledge.productIds(merchant))).map(
      (row) => String(row.id),
    );
  return {
    planOwned,
    planDto,
    planIds,
    attach(app: App) {
      app.get("/api/merchant/content/plans", (c) => {
        const merchant = c.get("merchantId"),
          productId = c.req.query("productId");
        if (productId) productOwned(identifier.parse(productId), merchant);
        return c.json({
          plans: (
            listContentPlansByProductId(
              db,
              JSON.stringify(knowledge.productIds(merchant)),
              productId || null,
              productId || null,
            ) as unknown as PlanRow[]
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
        productOwned(input.productId, c.get("merchantId"));
        const id = randomUUID();
        insertContentPlans(
          db,
          id,
          input.productId,
          input.name,
          input.audience,
          input.totalDays,
          clock(),
        );
        return c.json(
          { plan: planDto(planOwned(id, c.get("merchantId"))) },
          201,
        );
      });
      app.post("/api/merchant/content/plans/compare", async (c) => {
        const input = comparisonSchema.parse(await c.req.json());
        const merchant = c.get("merchantId");
        const items: MarketingPlanComparisonItem[] = input.options.map(
          (option) => {
            const row = planOwned(option.planId, merchant);
            const plan = planDto(row);
            const courses = content().listCourses(plan.id);
            const product = productOwned(row.product_id, merchant);
            const facts = knowledge.productVersion(
              product.id,
              product.latest_version,
            ).facts;
            const scriptedCourseCount = courses.filter(
              (course) => course.latestScriptVersion > 0,
            ).length;
            const finalizedCourseCount = courses.filter((course) => {
              if (!course.latestScriptVersion) return false;
              const script = content().scriptVersion(
                course.id,
                course.latestScriptVersion,
                merchant,
              );
              return script.state === "final" && !script.stale;
            }).length;
            const approvedFactCount = facts.filter(
              (fact) => fact.approved,
            ).length;
            const dailyPreparationMinutes = Math.ceil(
              (courses.length * option.preparationMinutesPerCourse) /
                plan.totalDays,
            );
            const blockers: string[] = [];
            if (!courses.length) blockers.push("尚未安排具体课时");
            if (!approvedFactCount) blockers.push("没有已审核商品事实");
            if (finalizedCourseCount < courses.length)
              blockers.push(
                `${courses.length - finalizedCourseCount} 个课时尚未形成有效定稿`,
              );
            if (dailyPreparationMinutes > input.maxDailyPreparationMinutes)
              blockers.push(
                `日均准备 ${dailyPreparationMinutes} 分钟，超过 ${input.maxDailyPreparationMinutes} 分钟上限`,
              );
            if (option.estimatedCostCents > input.budgetCents)
              blockers.push(
                `预计成本超预算 ${option.estimatedCostCents - input.budgetCents} 分`,
              );
            const ratio = (part: number, total: number) =>
              total > 0 ? Math.min(1, part / total) : 0;
            const budgetFit =
              option.estimatedCostCents <= input.budgetCents
                ? 1
                : option.estimatedCostCents > 0
                  ? input.budgetCents / option.estimatedCostCents
                  : 0;
            const capacityFit =
              dailyPreparationMinutes <= input.maxDailyPreparationMinutes
                ? 1
                : input.maxDailyPreparationMinutes / dailyPreparationMinutes;
            const score = Math.round(
              100 *
                (0.45 * ratio(finalizedCourseCount, courses.length) +
                  0.2 * ratio(approvedFactCount, facts.length) +
                  0.2 * Math.min(1, capacityFit) +
                  0.15 * Math.min(1, budgetFit)),
            );
            return {
              planId: plan.id,
              name: plan.name,
              totalDays: plan.totalDays,
              courseCount: courses.length,
              scriptedCourseCount,
              finalizedCourseCount,
              approvedFactCount,
              totalFactCount: facts.length,
              dailyPreparationMinutes,
              estimatedCostCents: option.estimatedCostCents,
              score,
              readyToExecute: blockers.length === 0,
              blockers,
            };
          },
        );
        const ranked = [...items].sort(
          (a, b) =>
            Number(b.readyToExecute) - Number(a.readyToExecute) ||
            b.score - a.score ||
            a.estimatedCostCents - b.estimatedCostCents ||
            a.name.localeCompare(b.name, "zh-CN"),
        );
        const recommended = ranked[0];
        const result: MarketingPlanComparison = {
          version: "marketing-plan-compare-2026.1",
          budgetCents: input.budgetCents,
          maxDailyPreparationMinutes: input.maxDailyPreparationMinutes,
          recommendedPlanId: recommended.planId,
          readyToExecute: recommended.readyToExecute,
          summary: recommended.readyToExecute
            ? `建议优先执行“${recommended.name}”；当前内容、预算与准备时间均满足输入约束。`
            : `当前没有方案满足全部执行条件；“${recommended.name}”得分最高，应先补齐所列缺口。`,
          items,
        };
        return c.json({ comparison: result });
      });
      app.get("/api/merchant/content/plans/:id", (c) => {
        const plan = planOwned(c.req.param("id"), c.get("merchantId"));
        return c.json({
          plan: planDto(plan),
          courses: content().listCourses(plan.id),
        });
      });
      app.patch("/api/merchant/content/plans/:id", async (c) => {
        const { base, ...input } = planFieldsSchema
          .extend({ base: planFieldsSchema })
          .parse(await c.req.json());
        const merchant = c.get("merchantId"),
          id = c.req.param("id");
        transaction(db, () => {
          const current = planOwned(id, merchant);
          if (
            current.name !== base.name ||
            current.audience !== base.audience ||
            current.total_days !== base.totalDays
          )
            conflict("营销周期已更新，请刷新当前安排后再修改。");
          const maxDay = Number({ max_day: content().maxDay(id) }!.max_day);
          if (input.totalDays < maxDay)
            conflict(
              "周期天数不能早于已安排课时的最后一天；请先调整相关课时。",
            );
          updateContentPlansById(
            db,
            input.name,
            input.audience,
            input.totalDays,
            id,
          );
        });
        return c.json({ plan: planDto(planOwned(id, merchant)) });
      });
    },
  };
}
