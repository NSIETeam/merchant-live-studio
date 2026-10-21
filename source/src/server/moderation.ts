import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
import { MediaController } from "./services/media-control.js";
import { closeCampaign } from "./services/rewards.js";
export function activeModerationHold(db: DB, roomId: string) {
  const row = db
    .prepare(
      "SELECT * FROM moderation_actions WHERE room_id=? AND kind IN('stop','release') ORDER BY id DESC LIMIT 1",
    )
    .get(roomId);
  return row?.kind === "stop" ? row : null;
}
export function attachModeration(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  media: MediaController,
  clock = Date.now,
) {
  const base = "/api/merchant/rooms/:id/moderation",
    pending = new Map<number, Promise<void>>();
  function owned(id: string, merchant: string) {
    const room = db
      .prepare("SELECT * FROM rooms WHERE id=? AND merchant_id=?")
      .get(id, merchant);
    if (!room) throw new HTTPException(404);
    return room;
  }
  const result = (id: number) =>
    db
      .prepare(
        "SELECT id,disconnected,message,actor_id AS actorId,created_at AS createdAt FROM moderation_results WHERE action_id=? ORDER BY id DESC LIMIT 1",
      )
      .get(id) || null;
  function finish(actionId: number, roomId: string, actor: string) {
    const ongoing = pending.get(actionId);
    if (ongoing) return ongoing;
    const job = (async () => {
      let outcome: { disconnected: boolean; message?: string };
      try {
        for (const campaign of db
          .prepare(
            "SELECT id FROM campaigns WHERE room_id=? AND status='active'",
          )
          .all(roomId))
          closeCampaign(db, String(campaign.id), clock());
        outcome = (await media.readyForAdmission())
          ? await media.disconnect(roomId)
          : {
              disconnected: false,
              message: "无法确认流媒体控制服务，请检查后重试断流",
            };
      } catch {
        outcome = {
          disconnected: false,
          message: "处置执行失败，请检查服务并重试断流",
        };
      }
      db.prepare(
        "INSERT INTO moderation_results(action_id,disconnected,message,actor_id,created_at) VALUES(?,?,?,?,?)",
      ).run(
        actionId,
        outcome.disconnected ? 1 : 0,
        outcome.message || "控制服务确认无推流源",
        actor,
        clock(),
      );
    })().finally(() => pending.delete(actionId));
    pending.set(actionId, job);
    return job;
  }
  app.get(base, (c) => {
    const room = owned(
      z.string().parse(c.req.param("id")),
      c.get("merchantId"),
    );
    const before = z.coerce
      .number()
      .int()
      .positive()
      .parse(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    const rows = db
      .prepare(
        "SELECT id,kind,note,evidence_reference AS evidenceReference,actor_id AS actorId,created_at AS createdAt,hold_id AS holdId FROM moderation_actions WHERE room_id=? AND id<? ORDER BY id DESC LIMIT 51",
      )
      .all(room.id, before);
    const hold = activeModerationHold(db, String(room.id));
    return c.json({
      hold: hold
        ? {
            id: hold.id,
            actorId: hold.actor_id,
            note: hold.note,
            result: result(Number(hold.id)),
            processing: pending.has(Number(hold.id)),
          }
        : null,
      items: rows.slice(0, 50).map((row) => ({
        ...row,
        result: row.kind === "stop" ? result(Number(row.id)) : null,
      })),
      nextBefore: rows.length > 50 ? rows[49].id : null,
    });
  });
  app.post(base, async (c) => {
    const room = owned(
      z.string().parse(c.req.param("id")),
      c.get("merchantId"),
    );
    const input = z
      .object({
        kind: z.enum(["note", "stop", "release"]),
        note: z.string().trim().min(5).max(2000),
        evidenceReference: z.string().trim().max(1000),
        holdId: z.number().int().positive().optional(),
        idempotencyKey: z.string().uuid(),
      })
      .strict()
      .parse(await c.req.json());
    if (input.kind !== "release" && input.holdId !== undefined)
      throw new HTTPException(400, { message: "只有复核解除可以引用暂停记录" });
    const action = transaction(db, () => {
      const prior = db
        .prepare(
          "SELECT * FROM moderation_actions WHERE merchant_id=? AND idempotency_key=?",
        )
        .get(c.get("merchantId"), input.idempotencyKey);
      if (prior) {
        if (
          prior.room_id !== room.id ||
          prior.actor_id !== c.get("actorId") ||
          prior.kind !== input.kind ||
          prior.note !== input.note ||
          prior.evidence_reference !== input.evidenceReference ||
          prior.hold_id !== (input.holdId || null)
        )
          throw new HTTPException(409, {
            message: "提交编号已用于其他处置，请刷新后重试",
          });
        return { id: Number(prior.id), fresh: false };
      }
      const hold = activeModerationHold(db, String(room.id));
      if (input.kind === "stop" && hold)
        throw new HTTPException(409, {
          message: "直播间已暂停，请重试断流或追加记录",
        });
      if (input.kind === "release") {
        if (!hold || hold.id !== input.holdId)
          throw new HTTPException(409, {
            message: "暂停记录已变化，请刷新后复核",
          });
        if (hold.actor_id === c.get("actorId"))
          throw new HTTPException(403, {
            message: "请由另一审核或管理员账号复核解除暂停",
          });
        if (
          pending.has(Number(hold.id)) ||
          result(Number(hold.id))?.disconnected !== 1
        )
          throw new HTTPException(409, {
            message: "先确认断流处置成功，再复核恢复资格",
          });
      }
      const inserted = db
        .prepare(
          "INSERT INTO moderation_actions(room_id,merchant_id,actor_id,kind,note,evidence_reference,hold_id,idempotency_key,created_at) VALUES(?,?,?,?,?,?,?,?,?)",
        )
        .run(
          room.id,
          c.get("merchantId"),
          c.get("actorId"),
          input.kind,
          input.note,
          input.evidenceReference,
          input.holdId || null,
          input.idempotencyKey,
          clock(),
        );
      if (input.kind === "stop") {
        db.prepare(
          "UPDATE rooms SET status='ended',stream_secret=? WHERE id=?",
        ).run(randomBytes(24).toString("hex"), room.id);
        db.prepare("UPDATE visits SET active=0 WHERE room_id=?").run(room.id);
      }
      return { id: Number(inserted.lastInsertRowid), fresh: true };
    });
    if (input.kind === "stop" && action.fresh)
      await finish(action.id, String(room.id), c.get("actorId"));
    return c.json({ id: action.id, result: result(action.id) }, 201);
  });
  app.post(base + "/:actionId/retry", async (c) => {
    const room = owned(
      z.string().parse(c.req.param("id")),
      c.get("merchantId"),
    );
    const id = z.coerce
      .number()
      .int()
      .positive()
      .parse(c.req.param("actionId"));
    const hold = activeModerationHold(db, String(room.id));
    if (!hold || hold.id !== id)
      throw new HTTPException(409, { message: "只能重试当前暂停处置" });
    await finish(id, String(room.id), c.get("actorId"));
    return c.json({ id, result: result(id) });
  });
}
