import type { DB } from "../../shared/persistence.js";
import {
  findVisitsByRoomIdAndViewerId,
  insertPresence,
  insertVisits,
} from "./persistence/presence-queries.js";

export function recordPresence(
  db: DB,
  room: { id: string; status: string; live_started_at: number },
  viewer: string,
  input: { visible: boolean; playing: boolean },
  requirePlayback: boolean,
  connected: boolean,
  now: number,
) {
  const prev = findVisitsByRoomIdAndViewerId(db, room.id, viewer) as
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
    insertVisits(
      db,
      room.id,
      viewer,
      now,
      input.visible ? now : now - 31000,
      Math.floor(total / 1000),
      total,
      session,
      Number(active),
    );
  if (active) insertPresence(db, room.id, viewer, Math.floor(now / 60000));
  return {
    watchSeconds: Math.floor(session / 1000),
    totalWatchSeconds: Math.floor(total / 1000),
    counting: active,
    qualifiedBy: requirePlayback
      ? "playback-heartbeats-demo-only"
      : "server-heartbeats-demo-only",
  };
}
