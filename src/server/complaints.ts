import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
export function attachComplaints(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  clock = Date.now,
) {
  function room(id: string) {
    const r = db.prepare("SELECT merchant_id FROM rooms WHERE id=?").get(id);
    if (!r) throw new HTTPException(404, { message: "直播间不存在" });
    return r;
  }
  function dto(row: Record<string, any>) {
    return {
      id: row.id,
      roomId: row.room_id,
      category: row.category,
      body: row.body,
      createdAt: row.created_at,
      events: db
        .prepare(
          "SELECT version,state,reply,created_at AS createdAt FROM complaint_events WHERE complaint_id=? ORDER BY version",
        )
        .all(row.id),
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
      const column = kind === "viewer" ? "viewer_id" : "merchant_id";
      const rows = db
        .prepare(
          `SELECT * FROM complaints WHERE room_id=? AND ${column}=? AND id>? ORDER BY id LIMIT 51`,
        )
        .all(
          c.req.param("id"),
          c.get(kind === "viewer" ? "viewerId" : "merchantId"),
          after,
        );
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
      const previous = db
        .prepare(
          "SELECT * FROM complaints WHERE viewer_id=? AND idempotency_key=?",
        )
        .get(viewer, input.idempotencyKey);
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
      const count = db
        .prepare(
          "SELECT count(*) AS n FROM complaints WHERE viewer_id=? AND created_at>?",
        )
        .get(viewer, clock() - 86400000)!;
      if (Number(count.n) >= 5)
        throw new HTTPException(429, {
          message: "此观看会话今天提交较多，请在已有记录中查询处理结果",
        });
      const id = randomUUID(),
        now = clock();
      db.prepare("INSERT INTO complaints VALUES(?,?,?,?,?,?,?,?)").run(
        id,
        roomId,
        r.merchant_id,
        viewer,
        input.category,
        input.body,
        input.idempotencyKey,
        now,
      );
      db.prepare("INSERT INTO complaint_events VALUES(?,?,?,?,?,?)").run(
        id,
        1,
        "received",
        "已收到，等待人工受理。",
        viewer,
        now,
      );
      return db.prepare("SELECT * FROM complaints WHERE id=?").get(id)!;
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
      const row = db
        .prepare("SELECT * FROM complaints WHERE id=? AND merchant_id=?")
        .get(c.req.param("id"), c.get("merchantId"));
      if (!row) throw new HTTPException(404);
      const current = db
        .prepare(
          "SELECT version FROM complaint_events WHERE complaint_id=? ORDER BY version DESC LIMIT 1",
        )
        .get(row.id)!;
      if (current.version !== input.previousVersion)
        throw new HTTPException(409, {
          message: "处理记录已更新，请刷新后再提交",
        });
      if (Number(current.version) >= 100)
        throw new HTTPException(409, {
          message: "此投诉处理记录已达上限，请按线下争议处理流程继续",
        });
      db.prepare("INSERT INTO complaint_events VALUES(?,?,?,?,?,?)").run(
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
}
