import { inspectRecordingStorage } from "./recording-inspection.js";
import { constants, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  readdir,
  readFile,
  lstat,
  mkdir,
  link,
  unlink,
  rename,
  open,
  realpath,
} from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { hashRecording, completionSchema } from "./recording-files.js";
import { recordingStorageState } from "./recording-health.js";
export function createRecordingStorage(root: string, outbox: string) {
  const receipt = (name: string) => {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) throw Error("完成回执名称无效");
    return join(outbox, name);
  };
  return {
    inspect: () => inspectRecordingStorage(root, outbox),
    health: () => recordingStorageState(root, outbox),
    async pending() {
      return (
        await readdir(outbox).catch((error: NodeJS.ErrnoException) => {
          if (error.code === "ENOENT") return [];
          throw error;
        })
      )
        .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
        .sort()
        .slice(0, 20);
    },
    async readReceipt(name: string) {
      const file = receipt(name),
        info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 4096)
        throw Error("完成回执不是有效文件");
      return completionSchema.parse(JSON.parse(await readFile(file, "utf8")));
    },
    async verify(path: string, room: string) {
      const verified = await hashRecording(root, path, room);
      return {
        bytes: verified.bytes,
        sha256: verified.sha256,
        close: () => verified.handle.close(),
        stream: () =>
          Readable.toWeb(
            verified.handle.createReadStream({ start: 0, autoClose: true }),
          ) as ReadableStream,
      };
    },
    async processed(name: string) {
      const file = receipt(name),
        folder = join(outbox, "processed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await link(file, join(folder, name)).catch(
        (error: NodeJS.ErrnoException) => {
          if (error.code !== "EEXIST") throw error;
        },
      );
      await unlink(file);
    },
    async failed(name: string) {
      const file = receipt(name),
        folder = join(outbox, "failed");
      await mkdir(folder, { recursive: true, mode: 0o700 });
      await rename(file, join(folder, name));
    },
    async stageDeletion(
      id: string,
      path: string,
      room: string,
      expected: { bytes: number; sha256: string },
      resumeMissing = false,
    ) {
      if (!/^[a-zA-Z0-9-]{1,80}$/.test(id)) throw Error("录像删除编号无效");
      const base = await realpath(root),
        source = resolve(base, path),
        trash = join(base, ".retention-trash"),
        target = join(trash, id + ".mp4");
      if (!source.startsWith(base + sep)) throw Error("录像路径越界");
      await mkdir(trash, { recursive: true, mode: 0o700 });
      if ((await lstat(trash)).isSymbolicLink())
        throw Error("录像删除隔离目录不能是符号链接");
      const exists = async (file: string) =>
        lstat(file).then(
          (v) => v.isFile() && !v.isSymbolicLink(),
          (e: NodeJS.ErrnoException) => {
            if (e.code === "ENOENT") return false;
            throw e;
          },
        );
      const sourceExists = await exists(source),
        targetExists = await exists(target);
      if (sourceExists && targetExists)
        throw Error("录像原件和删除隔离副本同时存在，请人工核对");
      if (!sourceExists && !targetExists) {
        if (!resumeMissing) throw Error("录像文件缺失，不能批准删除");
        return { restore: async () => {}, remove: () => {} };
      }
      if (sourceExists) {
        const verified = await hashRecording(root, path, room);
        await verified.handle.close();
        if (
          verified.bytes !== expected.bytes ||
          verified.sha256 !== expected.sha256
        )
          throw Error("录像校验失败，不能批准删除");
        await rename(source, target);
      }
      const handle = await open(
        target,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.size !== expected.bytes)
          throw Error("删除隔离录像大小不匹配");
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
        }
        if (hash.digest("hex") !== expected.sha256)
          throw Error("删除隔离录像散列不匹配");
      } catch (error) {
        await handle.close();
        if (!(await exists(source)) && (await exists(target)))
          await rename(target, source);
        throw error;
      }
      await handle.close();
      return {
        restore: async () => {
          if (await exists(target)) {
            if (await exists(source)) throw Error("录像恢复目标已存在");
            await rename(target, source);
          }
        },
        remove: () => {
          try {
            unlinkSync(target);
          } catch (error) {
            const e = error as NodeJS.ErrnoException;
            if (e.code !== "ENOENT") throw e;
          }
        },
      };
    },
  };
}
