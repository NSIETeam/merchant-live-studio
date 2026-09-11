import type { DB, SQLValue } from "../../../shared/persistence.js";
export function recordingAuditQuery1(db: DB, ...values: SQLValue[]) { return db.prepare("SELECT id,room_id,relative_path,sha256,bytes FROM recordings WHERE id>? ORDER BY id LIMIT ?").all(...values); }
