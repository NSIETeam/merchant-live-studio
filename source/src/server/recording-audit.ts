import { readdir, statfs } from "node:fs/promises";
import { join } from "node:path";
import type { DB } from "./db.js";
import { hashRecording } from "./recording-files.js";
export type RecordingAudit = {
  checkedAt: number;
  checked: number;
  verified: number;
  nextAfter: string | null;
  issues: { id: string; roomId: string; kind: "unavailable" | "mismatch" }[];
  storage: {
    availableBytes: number;
    totalBytes: number;
    lowSpace: boolean;
  } | null;
  queue: { pending: number; failed: number; processed: number } | null;
  warnings: string[];
};
/** Read-only, bounded verification. Never modifies a file or the registry. */
export async function auditRecordings(
  db: DB,
  root: string,
  outbox: string,
  after = "",
  limit = 100,
): Promise<RecordingAudit> {
  if (!root || !outbox) throw new Error("录像目录与完成队列尚未配置");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    after.length > 40
  )
    throw new Error("巡检分页参数无效");
  const rows = db
    .prepare(
      "SELECT id,room_id,relative_path,sha256,bytes FROM recordings WHERE id>? ORDER BY id LIMIT ?",
    )
    .all(after, limit + 1);
  const result: RecordingAudit = {
    checkedAt: Date.now(),
    checked: 0,
    verified: 0,
    nextAfter: rows.length > limit ? String(rows[limit - 1].id) : null,
    issues: [],
    storage: null,
    queue: null,
    warnings: [],
  };
  try {
    const space = await statfs(root);
    const availableBytes = space.bavail * space.bsize,
      totalBytes = space.blocks * space.bsize;
    result.storage = {
      availableBytes,
      totalBytes,
      lowSpace: totalBytes <= 0 || availableBytes / totalBytes < 0.1,
    };
    if (result.storage.lowSpace)
      result.warnings.push(
        "录像所在文件系统可用空间低于 10%，请及时扩容或按批准的留存策略处理。",
      );
  } catch {
    result.warnings.push("无法读取录像所在文件系统容量。");
  }
  try {
    const count = async (path: string, optional = false) =>
      (
        await readdir(path).catch((error: NodeJS.ErrnoException) => {
          if (optional && error.code === "ENOENT") return [];
          throw error;
        })
      ).filter((name) => /^[a-f0-9]{64}\.json$/.test(name)).length;
    result.queue = {
      pending: await count(outbox),
      failed: await count(join(outbox, "failed"), true),
      processed: await count(join(outbox, "processed"), true),
    };
    if (result.queue.failed)
      result.warnings.push("存在已隔离的完成回执，需要核对登记失败原因。");
    if (result.queue.pending)
      result.warnings.push("仍有完成回执等待登记；本次巡检不包含未登记片段。");
  } catch {
    result.warnings.push("无法读取录像完成队列。");
  }
  for (const row of rows.slice(0, limit)) {
    result.checked++;
    try {
      const verified = await hashRecording(
        root,
        String(row.relative_path),
        String(row.room_id),
      );
      try {
        if (verified.bytes !== row.bytes || verified.sha256 !== row.sha256)
          result.issues.push({
            id: String(row.id),
            roomId: String(row.room_id),
            kind: "mismatch",
          });
        else result.verified++;
      } finally {
        await verified.handle.close();
      }
    } catch {
      result.issues.push({
        id: String(row.id),
        roomId: String(row.room_id),
        kind: "unavailable",
      });
    }
  }
  return result;
}
