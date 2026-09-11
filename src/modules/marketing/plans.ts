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
import { type ContentPlan } from "../../shared/content.js";
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
