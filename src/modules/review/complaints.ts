import {
  complaintAppealByComplaint,
  complaintAppealByIdAndMerchant,
  complaintAppealEvents,
  complaintAppealReceipt,
  complaintQuery1,
  complaintQuery2,
  complaintQuery3,
  complaintQuery4,
  complaintQuery5,
  complaintQuery6,
  complaintQuery7,
  complaintQuery8,
  complaintQuery9,
  complaintQuery10,
  currentComplaintAppealEvent,
  currentComplaintEvent,
  insertComplaintAppeal,
  insertComplaintAppealEvent,
} from "./persistence/complaint-queries.js";
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
    const events = complaintQuery1(db, row.id) as Record<string, any>[];
    const appealRow = complaintAppealByComplaint(db, row.id) as
      Record<string, any> | undefined;
    const responseDueAt = Number(row.created_at) + 24 * 60 * 60 * 1000;
    const latest = events.at(-1);
    const appeal = appealRow
      ? (() => {
          const appealEvents = complaintAppealEvents(
            db,
            appealRow.id,
          ) as Record<string, any>[];
          const reviewDueAt =
            Number(appealRow.created_at) + 48 * 60 * 60 * 1000;
          return {
            id: appealRow.id,
            reason: appealRow.reason,
            createdAt: appealRow.created_at,
            reviewDueAt,
            overdue:
              appealEvents.at(-1)?.state !== "resolved" &&
              clock() >= reviewDueAt,
            events: appealEvents,
          };
        })()
      : null;
    return {
      id: row.id,
      roomId: row.room_id,
      category: row.category,
      body: row.body,
      createdAt: row.created_at,
      responseDueAt,
      overdue: latest?.state === "received" && clock() >= responseDueAt,
      events,
      appeal,
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
      const rows =
        kind === "viewer"
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
      complaintQuery6(
        db,
        id,
        roomId,
        r.merchant_id,
        viewer,
        input.category,
        input.body,
        input.idempotencyKey,
        now,
      );
      complaintQuery7(
        db,
        id,
        1,
        "received",
        "已收到，等待人工受理。",
        viewer,
        now,
      );
      return complaintQuery8(db, id)!;
    });
    return c.json({ complaint: dto(result) }, 201);
  });
  app.post(
    "/api/viewer/rooms/:id/complaints/:complaintId/appeals",
    async (c) => {
      room(c.req.param("id"));
      const input = z
        .object({
          reason: z.string().trim().min(5).max(2000),
          idempotencyKey: z.string().uuid(),
        })
        .strict()
        .parse(await c.req.json());
      const viewer = c.get("viewerId"),
        complaintId = c.req.param("complaintId");
      const result = transaction(db, () => {
        const previous = complaintAppealReceipt(
          db,
          viewer,
          input.idempotencyKey,
        ) as Record<string, any> | undefined;
        if (previous) {
          if (
            previous.complaint_id !== complaintId ||
            previous.reason !== input.reason
          )
            throw new HTTPException(409, {
              message: "此提交编号已用于另一项申诉，请刷新后重试",
            });
          return { row: previous, replayed: true };
        }
        const complaint = complaintQuery8(db, complaintId) as
          Record<string, any> | undefined;
        if (
          !complaint ||
          complaint.room_id !== c.req.param("id") ||
          complaint.viewer_id !== viewer
        )
          throw new HTTPException(404);
        if (currentComplaintEvent(db, complaintId)?.state !== "resolved")
          throw new HTTPException(409, {
            message: "投诉尚未答复，当前无需申诉",
          });
        if (complaintAppealByComplaint(db, complaintId))
          throw new HTTPException(409, { message: "此投诉已经提交过申诉" });
        const id = randomUUID(),
          now = clock();
        insertComplaintAppeal(
          db,
          id,
          complaintId,
          complaint.merchant_id,
          viewer,
          input.reason,
          input.idempotencyKey,
          now,
        );
        insertComplaintAppealEvent(
          db,
          id,
          1,
          "submitted",
          "申诉已提交，等待独立复核。",
          viewer,
          now,
        );
        return {
          row: complaintAppealByComplaint(db, complaintId) as Record<
            string,
            any
          >,
          replayed: false,
        };
      });
      c.header("Cache-Control", "no-store");
      return c.json(
        {
          complaint: dto(complaintQuery8(db, complaintId)!),
          replayed: result.replayed,
        },
        result.replayed ? 200 : 201,
      );
    },
  );
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
      complaintQuery7(
        db,
        row.id,
        input.previousVersion + 1,
        input.state,
        input.reply,
        c.get("actorId"),
        clock(),
      );
      return row;
    });
    return c.json({ complaint: dto(result) });
  });
  app.post(
    "/api/merchant/complaints/:id/appeals/:appealId/reply",
    async (c) => {
      if (
        c.get("requireIndependentReview") &&
        c.get("memberRole") !== "reviewer"
      )
        throw new HTTPException(403, {
          message: "申诉需要由独立审核员处理",
        });
      const input = z
        .object({
          previousVersion: z.number().int().positive(),
          state: z.enum(["reviewing", "resolved"]),
          reply: z.string().trim().min(5).max(2000),
        })
        .strict()
        .parse(await c.req.json());
      const result = transaction(db, () => {
        const complaint = complaintQuery9(
          db,
          c.req.param("id"),
          c.get("merchantId"),
        ) as Record<string, any> | undefined;
        const appeal = complaintAppealByIdAndMerchant(
          db,
          c.req.param("appealId"),
          c.get("merchantId"),
        ) as Record<string, any> | undefined;
        if (!complaint || !appeal || appeal.complaint_id !== complaint.id)
          throw new HTTPException(404);
        const current = currentComplaintAppealEvent(db, appeal.id)!;
        if (Number(current.version) !== input.previousVersion)
          throw new HTTPException(409, {
            message: "申诉处理记录已更新，请刷新后再提交",
          });
        if (Number(current.version) >= 100)
          throw new HTTPException(409, {
            message: "申诉处理记录已达上限，请转线下争议处理流程",
          });
        const original = currentComplaintEvent(db, complaint.id)!;
        if (
          Number(current.version) === 1 &&
          original.actor_id === c.get("actorId")
        )
          throw new HTTPException(403, {
            message: "原投诉处理人不能复核同一项申诉",
          });
        insertComplaintAppealEvent(
          db,
          appeal.id,
          input.previousVersion + 1,
          input.state,
          input.reply,
          c.get("actorId"),
          clock(),
        );
        return complaint;
      });
      return c.json({ complaint: dto(result) });
    },
  );
}
