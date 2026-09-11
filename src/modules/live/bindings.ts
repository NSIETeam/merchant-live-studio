import { preparationCounts } from "./persistence/bindings-queries.js";
import type { Hono } from "hono";
import { z } from "zod";
import {
  conflict,
  notFound,
  transaction,
} from "../../platform/infrastructure/public.js";
import type { ContentPort } from "../../shared/content-ports.js";
import { type ContentBinding } from "../../shared/content.js";
import type { DB } from "../../shared/persistence.js";
import {
  findContentRoomBindingsByRoomId,
  findContentRoomBindingsByRoomId2,
  findRoomTitle,
  findRoomsByIdAndMerchantId,
  insertContentBindingHistory,
  insertContentRoomBindings,
  listContentBindingHistoryByRoomIdAndId,
} from "./persistence/bindings-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
export function createBindings(
  db: DB,
  content: () => ContentPort,
  clock: () => number = Date.now,
) {
  function roomOwned(roomId: string, merchant: string) {
    if (!findRoomsByIdAndMerchantId(db, roomId, merchant))
      notFound("直播间不存在");
  }
  const scriptVersion: ContentPort["scriptVersion"] = (...args) =>
    content().scriptVersion(...args);
  const courseOwned: ContentPort["courseOwned"] = (...args) =>
    content().courseOwned(...args);
  function getRoomContentBinding(
    roomId: string,
    merchant: string,
    requireIndependentReview = false,
  ): ContentBinding | null {
    roomOwned(roomId, merchant);
    const row = findContentRoomBindingsByRoomId(db, roomId) as
      | { course_id: string; script_version: number; bound_at: number }
      | undefined;
    if (!row) return null;
    const script = scriptVersion(row.course_id, row.script_version, merchant);
    return {
      roomId,
      courseTitle: courseOwned(row.course_id, merchant).title,
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
  return {
    preparationCounts: (tenant: string) => preparationCounts(db, tenant),
    getRoomContentBinding,
    roomOwned,
    attach(app: App) {
      app.get("/api/merchant/content/rooms/:id/binding", (c) =>
        c.json({
          binding: getRoomContentBinding(
            c.req.param("id"),
            c.get("merchantId"),
            c.get("requireIndependentReview"),
          ),
        }),
      );
      app.get("/api/merchant/content/rooms/:id/binding-history", (c) => {
        const roomId = c.req.param("id");
        roomOwned(roomId, c.get("merchantId"));
        const before = z.coerce
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER)
          .optional()
          .parse(c.req.query("before"));
        const rows = listContentBindingHistoryByRoomIdAndId(
          db,
          roomId,
          before ?? Number.MAX_SAFE_INTEGER,
        );
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
          roomOwned(roomId, merchant);
          const script = scriptVersion(
            input.courseId,
            input.scriptVersion,
            merchant,
          );
          if (
            script.stale ||
            !script.confirmation ||
            script.check.blockingCount
          )
            conflict("仅可绑定当前商品依据下、无阻断项且已人工定稿的讲稿。");
          if (
            c.get("requireIndependentReview") &&
            script.confirmation?.role !== "independent_review"
          )
            conflict("此工作空间只允许绑定经独立审核批准的稿件。");
          const previous = findContentRoomBindingsByRoomId2(db, roomId);
          if (
            previous?.course_id === input.courseId &&
            previous.script_version === input.scriptVersion
          )
            return;
          const boundAt = clock();
          insertContentRoomBindings(
            db,
            roomId,
            input.courseId,
            input.scriptVersion,
            boundAt,
          );
          insertContentBindingHistory(
            db,
            roomId,
            input.courseId,
            input.scriptVersion,
            boundAt,
            c.get("actorId") || merchant,
            String(findRoomTitle(db, roomId)!.title),
            courseOwned(input.courseId, merchant).title,
            script.productSnapshot.name,
          );
        });
        return c.json(
          { binding: getRoomContentBinding(roomId, merchant) },
          201,
        );
      });
    },
  };
}
