import { access, stat, statfs } from "node:fs/promises";
import { constants } from "node:fs";
export type RecordingStorageState =
  "unconfigured" | "available" | "low-space" | "unavailable";
export function storageState(
  available: number,
  total: number,
): RecordingStorageState {
  if (
    !Number.isFinite(available) ||
    !Number.isFinite(total) ||
    total <= 0 ||
    available < 0 ||
    available > total
  )
    return "unavailable";
  return available / total < 0.1 ? "low-space" : "available";
}
/** Filesystem readiness only; never implies a complete recording or active recorder. */
export async function recordingStorageState(
  root: string,
  outbox: string,
): Promise<RecordingStorageState> {
  if (!root || !outbox) return "unconfigured";
  try {
    const states = await Promise.all(
      [root, outbox].map(async (path) => {
        if (!(await stat(path)).isDirectory()) return "unavailable" as const;
        await access(path, constants.R_OK | constants.W_OK | constants.X_OK);
        const space = await statfs(path);
        return storageState(
          space.bavail * space.bsize,
          space.blocks * space.bsize,
        );
      }),
    );
    return states.includes("unavailable")
      ? "unavailable"
      : states.includes("low-space")
        ? "low-space"
        : "available";
  } catch {
    return "unavailable";
  }
}
