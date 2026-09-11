import { recordingStorageState } from "./recording-health.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  readFile,
  readdir,
  unlink,
  lstat,
  mkdir,
  rename,
  link,
} from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction, type DB } from "./db.js";
import { completionSchema, hashRecording } from "./recording-files.js";
const running = new WeakMap<DB, Promise<void>>();
export function processRecordingOutbox(db: DB, config: Config) {
  if (!config.recordingsRoot || !config.recordingOutbox)
    return Promise.resolve();
  const existing = running.get(db);
  if (existing) return existing;
  const job = (async () => {
    const names = await readdir(config.recordingOutbox).catch(
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      },
    );
    for (const name of names
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .sort()
      .slice(0, 20)) {
      const file = join(config.recordingOutbox, name);
      let merchantId: string | null = null;
      try {
        const info = await lstat(file);
        if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
          throw new Error("完成回执不是有效文件");
        const item = completionSchema.parse(
          JSON.parse(await readFile(file, "utf8")),
        );
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
        const room = db
          .prepare("SELECT merchant_id FROM rooms WHERE id=?")
          .get(item.roomId);
        if (!room) throw new Error("录像直播间不存在");
        merchantId = String(room.merchant_id);
        const verified = await hashRecording(
          config.recordingsRoot,
          item.relativePath,
          item.roomId,
        );
        await verified.handle.close();
        transaction(db, () => {
          const old = db
            .prepare("SELECT * FROM recordings WHERE relative_path=?")
            .get(item.relativePath);
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
            db.prepare(
              "INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?,?,?)",
            ).run(
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
          db.prepare("DELETE FROM recording_ingest_errors WHERE receipt=?").run(
            name,
          );
        });
        const processed = join(config.recordingOutbox, "processed");
        await mkdir(processed, { recursive: true, mode: 0o700 });
        await link(file, join(processed, name)).catch(
          (error: NodeJS.ErrnoException) => {
            if (error.code !== "EEXIST") throw error;
          },
        );
        await unlink(file);
      } catch (error) {
        db.prepare(
          "INSERT INTO recording_ingest_errors(receipt,merchant_id,message,updated_at) VALUES(?,?,?,?) ON CONFLICT(receipt) DO UPDATE SET merchant_id=excluded.merchant_id,message=excluded.message,updated_at=excluded.updated_at",
        ).run(
          name,
          merchantId,
          error instanceof Error ? error.message : "录像登记失败",
          Date.now(),
        );
        await mkdir(join(config.recordingOutbox, "failed"), {
          recursive: true,
          mode: 0o700,
        });
        await rename(file, join(config.recordingOutbox, "failed", name));
      }
    }
  })().finally(() => running.delete(db));
  running.set(db, job);
  return job;
}
export function attachRecordings(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  config: Config,
) {
  app.get("/api/merchant/recordings/health", async (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      storage: await recordingStorageState(
        config.recordingsRoot,
        config.recordingOutbox,
      ),
      ingestErrorCount: Number(
        db
          .prepare(
            "SELECT count(*) AS n FROM recording_ingest_errors WHERE merchant_id=?",
          )
          .get(c.get("merchantId"))!.n,
      ),
      checkedAt: Date.now(),
    });
  });
  app.get("/api/merchant/rooms/:id/recordings", (c) => {
    const room = db
      .prepare("SELECT id FROM rooms WHERE id=? AND merchant_id=?")
      .get(c.req.param("id"), c.get("merchantId"));
    if (!room) throw new HTTPException(404);
    const after = z
      .string()
      .max(40)
      .parse(c.req.query("after") || "");
    const cursor = after
      ? db
          .prepare("SELECT started_at FROM recordings WHERE id=? AND room_id=?")
          .get(after, room.id)
      : null;
    if (after && !cursor)
      throw new HTTPException(400, { message: "录像分页位置无效，请重新刷新" });
    const beforeTime = cursor?.started_at ?? Number.MAX_SAFE_INTEGER;
    const rows = db
      .prepare(
        "SELECT id,started_at AS startedAt,completed_at AS completedAt,duration_seconds AS durationSeconds,bytes,sha256,registered_at AS registeredAt FROM recordings WHERE room_id=? AND (started_at<? OR (started_at=? AND id<?)) ORDER BY started_at DESC,id DESC LIMIT 51",
      )
      .all(room.id, beforeTime, beforeTime, after || "~");
    return c.json({
      configured: Boolean(config.recordingsRoot && config.recordingOutbox),
      ingestErrorCount: db
        .prepare(
          "SELECT count(*) AS n FROM recording_ingest_errors WHERE merchant_id=?",
        )
        .get(c.get("merchantId"))!.n,
      items: rows.slice(0, 50),
      nextAfter: rows.length > 50 ? rows[49].id : null,
    });
  });
  app.get("/api/merchant/recordings/:id/download", async (c) => {
    const record = db
      .prepare("SELECT * FROM recordings WHERE id=? AND merchant_id=?")
      .get(c.req.param("id"), c.get("merchantId"));
    if (!record) throw new HTTPException(404);
    let verified;
    try {
      verified = await hashRecording(
        config.recordingsRoot,
        String(record.relative_path),
        String(record.room_id),
      );
    } catch {
      throw new HTTPException(409, {
        message: "录像文件缺失、变化或暂时不可用",
      });
    }
    if (verified.bytes !== record.bytes || verified.sha256 !== record.sha256) {
      await verified.handle.close();
      throw new HTTPException(409, { message: "录像校验失败，已停止下载" });
    }
    const stream = verified.handle.createReadStream({
      start: 0,
      autoClose: true,
    });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      headers: {
        "Content-Type": "video/mp4",
        "Content-Length": String(record.bytes),
        "Content-Disposition": `attachment; filename="recording-${record.id}.mp4"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });
}
