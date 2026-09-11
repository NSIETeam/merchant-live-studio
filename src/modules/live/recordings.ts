import {
  recordingQuery1,
  recordingQuery2,
  recordingQuery3,
  recordingQuery4,
  recordingQuery5,
  recordingQuery6,
  recordingQuery7,
  recordingQuery8,
  recordingQuery9,
  recordingQuery10,
} from "./persistence/recording-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type {
  Config,
  createRecordingStorage,
} from "../../platform/infrastructure/public.js";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import { attachRecordingRetention } from "./recording-retention.js";
import { deletedRecordingRequest } from "./persistence/recording-retention-queries.js";
type Storage = ReturnType<typeof createRecordingStorage>;
const running = new WeakMap<DB, Promise<void>>();
const processor = new WeakMap<
  DB,
  { startedAt: number; completedAt: number; failed: boolean }
>();
function processorState(db: DB, configured: boolean) {
  if (!configured) return "unconfigured";
  const state = processor.get(db);
  if (!state) return "checking";
  if (state.failed) return "unavailable";
  const last = running.has(db) ? state.startedAt : state.completedAt;
  if (Date.now() - last > 60000) return "stalled";
  return state.completedAt ? "available" : "checking";
}
export function processRecordingOutbox(
  db: DB,
  config: Config,
  storage: Storage,
) {
  if (!config.recordingsRoot || !config.recordingOutbox)
    return Promise.resolve();
  const existing = running.get(db);
  if (existing) return existing;
  const state = {
    startedAt: Date.now(),
    completedAt: processor.get(db)?.completedAt || 0,
    failed: false,
  };
  processor.set(db, state);
  const job = (async () => {
    for (const name of await storage.pending()) {
      let merchantId: string | null = null;
      try {
        const item = await storage.readReceipt(name);
        if (
          item.startedAt > item.completedAt ||
          item.completedAt > Date.now() + 60000
        )
          throw new Error("录像回执时间无效");
        if (
          name !==
          createHash("sha256").update(item.relativePath).digest("hex") + ".json"
        )
          throw new Error("完成回执文件名不匹配");
        const room = recordingQuery1(db, item.roomId);
        if (!room) throw new Error("录像直播间不存在");
        merchantId = String(room.merchant_id);
        const verified = await storage.verify(item.relativePath, item.roomId);
        await verified.close();
        transaction(db, () => {
          const old = recordingQuery2(db, item.relativePath);
          if (old) {
            if (
              old.sha256 !== verified.sha256 ||
              old.bytes !== verified.bytes ||
              old.room_id !== item.roomId ||
              old.duration_seconds !== item.durationSeconds ||
              old.started_at !== item.startedAt
            )
              throw new Error("已登记录像与回执或文件不一致");
          } else
            recordingQuery3(
              db,
              randomUUID(),
              room.merchant_id,
              item.roomId,
              item.relativePath,
              item.startedAt,
              item.completedAt,
              item.durationSeconds,
              verified.bytes,
              verified.sha256,
              Date.now(),
            );
          recordingQuery4(db, name);
        });
        await storage.processed(name);
      } catch (error) {
        recordingQuery5(
          db,
          name,
          merchantId,
          error instanceof Error ? error.message : "录像登记失败",
          Date.now(),
        );
        await storage.failed(name);
      }
    }
  })()
    .then(
      () => {
        state.completedAt = Date.now();
      },
      (error) => {
        state.failed = true;
        throw error;
      },
    )
    .finally(() => running.delete(db));
  running.set(db, job);
  return job;
}
export function attachRecordings(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  config: Config,
  storage: Storage,
  hasOpenDispute: (merchantId: string, roomId: string) => boolean = () => false,
  clock: () => number = Date.now,
) {
  app.get("/api/merchant/recordings/health", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      storage: await storage.health(),
      processor: processorState(
        db,
        Boolean(config.recordingsRoot && config.recordingOutbox),
      ),
      ingestErrorCount: Number(recordingQuery6(db, c.get("merchantId"))!.n),
      checkedAt: Date.now(),
    });
  });
  app.get("/api/merchant/rooms/:id/recordings", (c) => {
    const room = recordingQuery7(db, c.req.param("id"), c.get("merchantId"));
    if (!room) throw new HTTPException(404);
    const after = z
      .string()
      .max(40)
      .parse(c.req.query("after") || "");
    const cursor = after ? recordingQuery8(db, after, room.id) : null;
    if (after && !cursor)
      throw new HTTPException(400, { message: "录像分页位置无效，请重新刷新" });
    const beforeTime = cursor?.started_at ?? Number.MAX_SAFE_INTEGER;
    const rows = recordingQuery9(
      db,
      room.id,
      beforeTime,
      beforeTime,
      after || "~",
    );
    return c.json({
      configured: Boolean(config.recordingsRoot && config.recordingOutbox),
      ingestErrorCount: recordingQuery6(db, c.get("merchantId"))!.n,
      items: rows.slice(0, 50),
      nextAfter: rows.length > 50 ? rows[49].id : null,
    });
  });
  app.get("/api/merchant/recordings/:id/download", async (c) => {
    const record = recordingQuery10(db, c.req.param("id"), c.get("merchantId"));
    if (!record) throw new HTTPException(404);
    if (deletedRecordingRequest(db, record.id))
      throw new HTTPException(410, {
        message: "录像文件已按复核记录删除，登记与审计记录继续保留",
      });
    let verified;
    try {
      verified = await storage.verify(
        String(record.relative_path),
        String(record.room_id),
      );
    } catch {
      throw new HTTPException(409, {
        message: "录像文件缺失、变化或暂时不可用",
      });
    }
    if (verified.bytes !== record.bytes || verified.sha256 !== record.sha256) {
      await verified.close();
      throw new HTTPException(409, { message: "录像校验失败，已停止下载" });
    }
    return new Response(verified.stream(), {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(record.bytes),
        "Content-Disposition": `attachment; filename="recording-${record.id}.mp4"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
  attachRecordingRetention(app, db, config, storage, hasOpenDispute, clock);
}
