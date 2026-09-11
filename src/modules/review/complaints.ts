import { complaintQuery1, complaintQuery2, complaintQuery3, complaintQuery4, complaintQuery5, complaintQuery6, complaintQuery7, complaintQuery8, complaintQuery9, complaintQuery10 } from "./persistence/complaint-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { LivePort } from "../../shared/live-ports.js";
export function attachComplaints(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  live: Pick<LivePort, "room">,
  clock = Date.now,
) {
  const room = live.room;
  function dto(row: Record<string, any>) {
    return {
      id: row.id,
      roomId: row.room_id,
      category: row.category,
      body: row.body,
      createdAt: row.created_at,
      events: complaintQuery1(db, row.id),
    };
  }
  for (const kind of ["viewer", "merchant"] as const) {
    const path =
      kind === "viewer"
        ? "/api/viewer/rooms/:id/complaints"
        : "/api/merchant/complaints/rooms/:id";
    app.get(path, (c) => {
      const r = room(c.req.param("id"));
      if (kind === "merchant" && r.merchant_id !== c.get("merchantId"))
        throw new HTTPException(404);
      const after = z
        .string()
        .max(40)
        .parse(c.req.query("after") || "");
      const rows = kind === "viewer"
        ? complaintQuery2(db, c.req.param("id"), c.get("viewerId"), after)
        : complaintQuery3(db, c.req.param("id"), c.get("merchantId"), after);
      return c.json({
        items: rows.slice(0, 50).map(dto),
        nextAfter: rows.length > 50 ? rows[49].id : null,
      });
    });
  }
  app.post("/api/viewer/rooms/:id/complaints", async (c) => {
    const r = room(c.req.param("id"));
    const input = z
      .object({
        category: z.enum(["content", "product", "conduct", "other"]),
        body: z.string().trim().min(5).max(2000),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .parse(await c.req.json());
    const viewer = c.get("viewerId"),
      roomId = c.req.param("id");
    const result = transaction(db, () => {
      const previous = complaintQuery4(db, viewer, input.idempotencyKey);
      if (previous) {
        if (
          previous.room_id !== roomId ||
          previous.category !== input.category ||
          previous.body !== input.body
        )
          throw new HTTPException(409, {
            message: "此提交编号已用于另一条投诉，请刷新后重试",
          });
        return previous;
      }
      const count = complaintQuery5(db, viewer, clock() - 86400000)!;
      if (Number(count.n) >= 5)
        throw new HTTPException(429, {
          message: "此观看会话今天提交较多，请在已有记录中查询处理结果",
        });
      const id = randomUUID(),
        now = clock();
      complaintQuery6(db, id, roomId, r.merchant_id, viewer, input.category, input.body, input.idempotencyKey, now);
      complaintQuery7(db, id, 1, "received", "已收到，等待人工受理。", viewer, now);
      return complaintQuery8(db, id)!;
    });
    return c.json({ complaint: dto(result) }, 201);
  });
  app.post("/api/merchant/complaints/:id/reply", async (c) => {
    const input = z
      .object({
        previousVersion: z.number().int().positive(),
        state: z.enum(["reviewing", "resolved"]),
        reply: z.string().trim().min(5).max(2000),
      })
      .strict()
      .parse(await c.req.json());
    const result = transaction(db, () => {
      const row = complaintQuery9(db, c.req.param("id"), c.get("merchantId"));
      if (!row) throw new HTTPException(404);
      const current = complaintQuery10(db, row.id)!;
      if (current.version !== input.previousVersion)
        throw new HTTPException(409, {
          message: "处理记录已更新，请刷新后再提交",
        });
      if (Number(current.version) >= 100)
        throw new HTTPException(409, {
          message: "此投诉处理记录已达上限，请按线下争议处理流程继续",
        });
      complaintQuery7(db, row.id, input.previousVersion + 1, input.state, input.reply, c.get("actorId"), clock());
      return row;
    });
    return c.json({ complaint: dto(result) });
  });
}
