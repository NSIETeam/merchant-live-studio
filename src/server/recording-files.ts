import { constants } from "node:fs";
import {
  open,
  lstat,
  realpath,
  mkdir,
  writeFile,
  rename,
} from "node:fs/promises";
import { resolve, relative, join, sep, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
export const completionSchema = z
  .object({
    roomId: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
    relativePath: z.string().max(300),
    durationSeconds: z.number().finite().positive().max(86400),
    startedAt: z.number().int().positive(),
    completedAt: z.number().int().positive(),
  })
  .strict();
export type Completion = z.infer<typeof completionSchema>;
export async function openRecording(
  root: string,
  path: string,
  roomId: string,
) {
  if (!root) throw new Error("未配置录像目录");
  if (
    !/^live\/[a-zA-Z0-9_-]{1,80}\/[0-9_-]+\.mp4$/.test(path) ||
    path.split("/")[1] !== roomId
  )
    throw new Error("录像路径与直播间不匹配");
  const base = await realpath(root),
    target = resolve(base, path);
  if (!target.startsWith(base + sep)) throw new Error("录像路径越界");
  let part = base;
  for (const component of path.split("/")) {
    part = join(part, component);
    if ((await lstat(part)).isSymbolicLink())
      throw new Error("录像路径不能包含符号链接");
  }
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 12 || stat.size > 512 * 1024 * 1024)
      throw new Error("录像不是有效文件或超过单片段 512 MiB 限制");
    if ((await realpath(target)) !== target)
      throw new Error("录像路径发生变化");
    return { handle, stat };
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export async function hashRecording(
  root: string,
  path: string,
  roomId: string,
) {
  const opened = await openRecording(root, path, roomId),
    { handle, stat } = opened;
  try {
    const head = Buffer.alloc(12);
    await handle.read(head, 0, 12, 0);
    if (head.toString("ascii", 4, 8) !== "ftyp")
      throw new Error("录像缺少 MP4 文件头");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(512 * 1024);
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(
        buffer,
        0,
        buffer.length,
        position,
      );
      if (!bytesRead) break;
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      if (position > 512 * 1024 * 1024) throw new Error("录像超出片段限制");
    }
    const after = await handle.stat();
    if (
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      position !== stat.size
    )
      throw new Error("录像仍在变化，请在片段完成后登记");
    return { handle, bytes: stat.size, sha256: hash.digest("hex") };
  } catch (e) {
    await handle.close();
    throw e;
  }
}
export async function enqueueCompletedSegment(
  env: NodeJS.ProcessEnv = process.env,
) {
  const root = env.RECORDINGS_ROOT,
    outbox = env.RECORDING_OUTBOX,
    segment = env.MTX_SEGMENT_PATH,
    path = env.MTX_PATH;
  if (!root || !outbox || !segment || !path)
    throw new Error("缺少录制回调目录或媒体参数");
  const roomId = path.match(/^live\/([a-zA-Z0-9_-]{1,80})$/)?.[1];
  const filename = basename(segment),
    stamp = filename.match(/^(\d{10})-(\d{6})\.mp4$/);
  if (!roomId || !stamp) throw new Error("录制路径须使用 live/房间编号/%s-%f");
  const item = completionSchema.parse({
    roomId,
    relativePath: relative(resolve(root), resolve(segment)),
    durationSeconds: Number(env.MTX_SEGMENT_DURATION),
    startedAt: Number(stamp[1]) * 1000 + Number(stamp[2].slice(0, 3)),
    completedAt: Date.now(),
  });
  const { handle } = await openRecording(root, item.relativePath, item.roomId);
  await handle.close();
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  const id = createHash("sha256").update(item.relativePath).digest("hex");
  const temporary = join(outbox, `${id}.${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(item), { mode: 0o600, flag: "wx" });
  await rename(temporary, join(outbox, id + ".json"));
}
