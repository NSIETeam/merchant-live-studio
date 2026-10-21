import type { DB } from "../../../shared/persistence.js";
export function recordSourceVisit(db: DB, room: string, viewer: string, code: string, now: number) {
 db.prepare("INSERT OR IGNORE INTO attribution_visits(room_id,viewer_id,source_code,attributed_at,watch_seconds_baseline) SELECT room_id,viewer_id,?,?,watch_seconds FROM visits WHERE room_id=? AND viewer_id=?").run(code,now,room,viewer);
}
export function sourceViewingRows(db: DB, code: string) { return db.prepare("SELECT a.viewer_id, max(0,v.watch_seconds-a.watch_seconds_baseline) AS watchSeconds FROM attribution_visits a JOIN visits v ON v.room_id=a.room_id AND v.viewer_id=a.viewer_id WHERE a.source_code=?").all(code); }
