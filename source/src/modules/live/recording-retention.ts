import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type {
  Config,
  createRecordingStorage,
} from "../../platform/infrastructure/public.js";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import {
  activeRetentionHoldCount,
  currentDeletionEvent,
  currentRetentionHoldEvent,
  deletedRecordingRequest,
  deletionRequest,
  deletionRequestByReceipt,
  executingDeletionRequestCount,
  insertDeletionEvent,
  insertDeletionRequest,
  insertRetentionHold,
  insertRetentionHoldEvent,
  listDeletionRequests,
  listRetentionHolds,
  openDeletionRequestCount,
  retentionHold,
  retentionHoldByReceipt,
  retentionRecording,
} from "./persistence/recording-retention-queries.js";

type Storage = ReturnType<typeof createRecordingStorage>;
type Row = Record<string, any>;

const reason = z.string().trim().min(8).max(1000);
const receipt = z.string().uuid();

export function attachRecordingRetention(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  config: Config,
  storage: Storage,
  hasOpenDispute: (merchantId: string, roomId: string) => boolean,
  clock: () => number = Date.now,
) {
  function recording(id: string, tenant: string) {
    const row = retentionRecording(db, id, tenant) as Row | undefined;
    if (!row) throw new HTTPException(404);
    return row;
  }
  function currentHold(id: string) {
    return currentRetentionHoldEvent(db, id) as Row | undefined;
  }
  function currentRequest(id: string) {
    return currentDeletionEvent(db, id) as Row | undefined;
  }
  function deletionBlockers(row: Row) {
    const blockers: string[] = [];
    if (!config.retentionPolicy) blockers.push("尚未配置并核验录像保存期限");
    if (row.room_status !== "ended") blockers.push("直播尚未结束");
    const eligibleAt = config.retentionPolicy
      ? Number(row.completed_at) +
        config.retentionPolicy.liveContentDays * 24 * 60 * 60 * 1000
      : null;
    if (eligibleAt && clock() < eligibleAt)
      blockers.push(`录像至少保留至 ${new Date(eligibleAt).toISOString()}`);
    if (Number(activeRetentionHoldCount(db, row.id)?.n || 0) > 0)
      blockers.push("录像存在有效保留");
    if (hasOpenDispute(row.merchant_id, row.room_id))
      blockers.push("直播间存在未解决投诉或申诉");
    return blockers;
  }
  function assertDeletionEligible(row: Row) {
    const blockers = deletionBlockers(row);
    if (blockers.length)
      throw new HTTPException(409, {
        message: blockers[0] + "，不能删除录像",
      });
  }
  function dto(row: Row, actorId: string, role: string) {
    const policy = config.retentionPolicy;
    const eligibleAt = policy
      ? Number(row.completed_at) + policy.liveContentDays * 24 * 60 * 60 * 1000
      : null;
    return {
      recordingId: row.id,
      roomId: row.room_id,
      policyConfigured: Boolean(policy),
      liveContentDays: policy?.liveContentDays ?? null,
      eligibleAt,
      roomStatus: row.room_status,
      openDispute: hasOpenDispute(row.merchant_id, row.room_id),
      deleted: Boolean(deletedRecordingRequest(db, row.id)),
      deletionBlockers: deletionBlockers(row),
      permissions: {
        canManageHold: role === "owner" || role === "reviewer",
        canRequestDeletion: role === "owner",
        canReviewDeletion: role === "reviewer",
        actorId,
      },
      holds: listRetentionHolds(db, row.id),
      requests: listDeletionRequests(db, row.id),
    };
  }

  app.get("/api/merchant/recordings/:id/retention", (c) =>
    c.json(
      dto(
        recording(c.req.param("id"), c.get("merchantId")),
        c.get("actorId"),
        c.get("memberRole"),
      ),
    ),
  );

  app.post("/api/merchant/recordings/:id/retention/holds", async (c) => {
    const input = z
      .object({
        kind: z.enum(["dispute", "regulatory", "business"]),
        reason,
        idempotencyKey: receipt,
      })
      .strict()
      .parse(await c.req.json());
    const row = recording(c.req.param("id"), c.get("merchantId"));
    if (deletedRecordingRequest(db, row.id))
      throw new HTTPException(410, { message: "录像已经完成删除" });
    const result = transaction(db, () => {
      if (Number(executingDeletionRequestCount(db, row.id)?.n || 0) > 0)
        throw new HTTPException(409, {
          message: "录像删除已通过复核并进入执行阶段，不能再建立保留",
        });
      const previous = retentionHoldByReceipt(
        db,
        c.get("merchantId"),
        input.idempotencyKey,
      ) as Row | undefined;
      if (previous) {
        if (
          previous.recording_id !== row.id ||
          previous.kind !== input.kind ||
          previous.reason !== input.reason
        )
          throw new HTTPException(409, {
            message: "此提交编号已用于另一项录像保留",
          });
        return { replayed: true };
      }
      const id = randomUUID(),
        now = clock();
      insertRetentionHold(
        db,
        id,
        row.id,
        row.merchant_id,
        input.kind,
        input.reason,
        input.idempotencyKey,
        c.get("actorId"),
        now,
      );
      insertRetentionHoldEvent(
        db,
        id,
        1,
        "active",
        "已建立录像保留。",
        c.get("actorId"),
        now,
      );
      return { replayed: false };
    });
    return c.json(
      {
        retention: dto(row, c.get("actorId"), c.get("memberRole")),
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  app.post(
    "/api/merchant/recordings/:id/retention/holds/:holdId/release",
    async (c) => {
      const input = z
        .object({ previousVersion: z.number().int().positive(), note: reason })
        .strict()
        .parse(await c.req.json());
      const row = recording(c.req.param("id"), c.get("merchantId"));
      transaction(db, () => {
        const hold = retentionHold(
          db,
          c.req.param("holdId"),
          row.id,
          row.merchant_id,
        ) as Row | undefined;
        if (!hold) throw new HTTPException(404);
        const current = currentHold(hold.id);
        if (!current || Number(current.version) !== input.previousVersion)
          throw new HTTPException(409, { message: "保留状态已更新，请刷新" });
        if (current.state !== "active")
          throw new HTTPException(409, { message: "此项保留已经释放" });
        if (hold.created_by === c.get("actorId"))
          throw new HTTPException(403, {
            message: "建立保留的账号不能自行释放",
          });
        insertRetentionHoldEvent(
          db,
          hold.id,
          input.previousVersion + 1,
          "released",
          input.note,
          c.get("actorId"),
          clock(),
        );
      });
      return c.json({
        retention: dto(row, c.get("actorId"), c.get("memberRole")),
      });
    },
  );

  app.post("/api/merchant/recordings/:id/deletion-requests", async (c) => {
    const input = z
      .object({ reason, idempotencyKey: receipt })
      .strict()
      .parse(await c.req.json());
    const row = recording(c.req.param("id"), c.get("merchantId"));
    assertDeletionEligible(row);
    if (deletedRecordingRequest(db, row.id))
      throw new HTTPException(410, { message: "录像已经完成删除" });
    const result = transaction(db, () => {
      const previous = deletionRequestByReceipt(
        db,
        row.merchant_id,
        input.idempotencyKey,
      ) as Row | undefined;
      if (previous) {
        if (
          previous.recording_id !== row.id ||
          previous.reason !== input.reason
        )
          throw new HTTPException(409, {
            message: "此提交编号已用于另一项删除申请",
          });
        return { replayed: true };
      }
      if (Number(openDeletionRequestCount(db, row.id)?.n || 0) > 0)
        throw new HTTPException(409, {
          message: "此录像已有待复核或待重试的删除申请",
        });
      const id = randomUUID(),
        now = clock();
      insertDeletionRequest(
        db,
        id,
        row.id,
        row.merchant_id,
        input.reason,
        input.idempotencyKey,
        c.get("actorId"),
        now,
      );
      insertDeletionEvent(
        db,
        id,
        1,
        "requested",
        "等待独立审核员复核。",
        c.get("actorId"),
        now,
      );
      return { replayed: false };
    });
    return c.json(
      {
        retention: dto(row, c.get("actorId"), c.get("memberRole")),
        replayed: result.replayed,
      },
      result.replayed ? 200 : 201,
    );
  });

  app.post(
    "/api/merchant/recordings/:id/deletion-requests/:requestId/review",
    async (c) => {
      const input = z
        .object({
          previousVersion: z.number().int().positive(),
          decision: z.enum(["approve", "reject"]),
          note: reason,
        })
        .strict()
        .parse(await c.req.json());
      const row = recording(c.req.param("id"), c.get("merchantId"));
      const request = deletionRequest(
        db,
        c.req.param("requestId"),
        row.id,
        row.merchant_id,
      ) as Row | undefined;
      if (!request) throw new HTTPException(404);
      if (request.requested_by === c.get("actorId"))
        throw new HTTPException(403, {
          message: "删除申请人不能复核自己的申请",
        });
      if (
        c.get("requireIndependentReview") &&
        c.get("memberRole") !== "reviewer"
      )
        throw new HTTPException(403, { message: "删除必须由独立审核员复核" });
      let state = currentRequest(request.id);
      if (!state || Number(state.version) !== input.previousVersion)
        throw new HTTPException(409, { message: "删除申请已更新，请刷新" });
      if (input.decision === "reject") {
        if (state.state !== "requested")
          throw new HTTPException(409, { message: "当前状态不能退回此申请" });
        insertDeletionEvent(
          db,
          request.id,
          Number(state.version) + 1,
          "rejected",
          input.note,
          c.get("actorId"),
          clock(),
        );
        return c.json({
          retention: dto(row, c.get("actorId"), c.get("memberRole")),
        });
      }
      if (
        !["requested", "failed", "approved", "deleting"].includes(state.state)
      )
        throw new HTTPException(409, { message: "当前状态不能批准此申请" });
      assertDeletionEligible(row);
      if (state.state === "requested" || state.state === "failed") {
        insertDeletionEvent(
          db,
          request.id,
          Number(state.version) + 1,
          "approved",
          input.note,
          c.get("actorId"),
          clock(),
        );
        state = currentRequest(request.id)!;
      }
      let staged: Awaited<ReturnType<Storage["stageDeletion"]>> | undefined;
      try {
        staged = await storage.stageDeletion(
          row.id,
          String(row.relative_path),
          String(row.room_id),
          { bytes: Number(row.bytes), sha256: String(row.sha256) },
          state.state === "deleting",
        );
        transaction(db, () => {
          assertDeletionEligible(row);
          const latest = currentRequest(request.id)!;
          if (latest.state === "approved")
            insertDeletionEvent(
              db,
              request.id,
              Number(latest.version) + 1,
              "deleting",
              "录像已进入删除隔离区。",
              c.get("actorId"),
              clock(),
            );
          else if (latest.state !== "deleting")
            throw new HTTPException(409, { message: "删除申请状态已变化" });
        });
        staged.remove();
        transaction(db, () => {
          const latest = currentRequest(request.id)!;
          if (latest.state === "deleting")
            insertDeletionEvent(
              db,
              request.id,
              Number(latest.version) + 1,
              "deleted",
              "录像文件已校验删除，登记与审计记录继续保留。",
              c.get("actorId"),
              clock(),
            );
        });
      } catch (error) {
        await staged?.restore().catch(() => undefined);
        const latest = currentRequest(request.id)!;
        if (["approved", "deleting"].includes(latest.state))
          insertDeletionEvent(
            db,
            request.id,
            Number(latest.version) + 1,
            "failed",
            "删除执行失败；请核对录像原位置和删除隔离区后重试。",
            c.get("actorId"),
            clock(),
          );
        if (error instanceof HTTPException) throw error;
        throw new HTTPException(409, {
          message: "录像删除未完成，文件已保留或进入人工核对状态",
        });
      }
      return c.json({
        retention: dto(row, c.get("actorId"), c.get("memberRole")),
      });
    },
  );
}
