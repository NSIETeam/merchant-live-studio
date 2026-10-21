import type { DB } from "../db.js";

export function recordPresence(
  db: DB,
  room: { id: string; status: string; live_started_at: number },
  viewer: string,
  input: { visible: boolean; playing: boolean },
  requirePlayback: boolean,
  connected: boolean,
  now: number,
) {
  const prev = db
    .prepare(
      "SELECT last_seen,watch_millis,session_watch_millis,active FROM visits WHERE room_id=? AND viewer_id=?",
    )
    .get(room.id, viewer) as
    | {
        last_seen: number;
        watch_millis: number;
        session_watch_millis: number;
        active: number;
      }
    | undefined;
  const active =
    input.visible &&
    room.status === "live" &&
    (!requirePlayback || (input.playing && connected));
  const gap = prev ? now - prev.last_seen : 0;
  const delta =
    active && prev?.active && gap > 0 && gap <= 20000
      ? Math.max(0, now - Math.max(prev.last_seen, room.live_started_at))
      : 0;
  const total = (prev?.watch_millis || 0) + delta,
    session = (prev?.session_watch_millis || 0) + delta;
  if (input.visible || prev)
    db.prepare(
      `INSERT INTO visits(room_id,viewer_id,first_seen,last_seen,watch_seconds,watch_millis,session_watch_millis,active) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(room_id,viewer_id) DO UPDATE SET last_seen=excluded.last_seen,watch_seconds=excluded.watch_seconds,watch_millis=excluded.watch_millis,session_watch_millis=excluded.session_watch_millis,active=excluded.active`,
    ).run(
      room.id,
      viewer,
      now,
      input.visible ? now : now - 31000,
      Math.floor(total / 1000),
      total,
      session,
      Number(active),
    );
  if (active)
    db.prepare("INSERT OR IGNORE INTO presence VALUES(?,?,?)").run(
      room.id,
      viewer,
      Math.floor(now / 60000),
    );
  return {
    watchSeconds: Math.floor(session / 1000),
    totalWatchSeconds: Math.floor(total / 1000),
    counting: active,
    qualifiedBy: requirePlayback
      ? "playback-heartbeats-demo-only"
      : "server-heartbeats-demo-only",
  };
}
