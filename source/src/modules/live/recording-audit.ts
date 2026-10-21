import { recordingAuditQuery1 } from "./persistence/recording-audit-queries.js";
import type { DB } from "../../shared/persistence.js";
import type { createRecordingStorage } from "../../platform/infrastructure/public.js";
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
  storage:ReturnType<typeof createRecordingStorage>,
): Promise<RecordingAudit> {
  if (!root || !outbox) throw new Error("录像目录与完成队列尚未配置");
  if (
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 1000 ||
    after.length > 40
  )
    throw new Error("巡检分页参数无效");
  const rows = recordingAuditQuery1(db, after, limit + 1);
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
  Object.assign(result, await storage.inspect());
  for (const row of rows.slice(0, limit)) {
    result.checked++;
    try {
      const verified = await storage.verify(
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
        await verified.close();
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
