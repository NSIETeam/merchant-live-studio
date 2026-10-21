import { DatabaseSync, backup } from "node:sqlite";
import { mkdir, open, writeFile, rm, chmod } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { createHash } from "node:crypto";
import { hashRecording } from "./recording-files.js";
/** Snapshot the Live database first, then copy and verify its immutable registered files. */
export async function backupRegisteredRecordings(
  source: DatabaseSync,
  root: string,
  destination: string,
) {
  if (!root || !destination) throw new Error("必须配置录像目录和新备份目录");
  const output = resolve(destination);
  await mkdir(output, { mode: 0o700 }); // Never overwrite an existing backup.
  let snapshot: DatabaseSync | undefined;
  try {
    const database = join(output, "studio.sqlite");
    await backup(source, database);
    await chmod(database, 0o600);
    snapshot = new DatabaseSync(database, { readOnly: true });
    const integrity = snapshot.prepare("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || Object.values(integrity[0])[0] !== "ok")
      throw new Error("数据库副本完整性检查失败");
    const recordings = join(output, "recordings");
    await mkdir(recordings, { mode: 0o700 });
    await mkdir(join(output, "outbox"), { mode: 0o700 });
    let after = "",
      count = 0,
      totalBytes = 0;
    for (;;) {
      const rows = snapshot
        .prepare(
          "SELECT id,room_id,relative_path,sha256,bytes FROM recordings WHERE id>? ORDER BY id LIMIT 100",
        )
        .all(after);
      if (!rows.length) break;
      for (const row of rows) {
        const relative = String(row.relative_path),
          room = String(row.room_id);
        const sourceFile = await hashRecording(root, relative, room);
        try {
          if (
            sourceFile.bytes !== row.bytes ||
            sourceFile.sha256 !== row.sha256
          )
            throw new Error("源录像与登记不一致");
          const file = join(recordings, relative);
          await mkdir(dirname(file), { recursive: true, mode: 0o700 });
          const target = await open(file, "wx", 0o600);
          try {
            const buffer = Buffer.alloc(512 * 1024);
            let position = 0;
            while (position < sourceFile.bytes) {
              const { bytesRead } = await sourceFile.handle.read(
                buffer,
                0,
                Math.min(buffer.length, sourceFile.bytes - position),
                position,
              );
              if (!bytesRead) throw new Error("录像复制中断");
              let written = 0;
              while (written < bytesRead) {
                const n = await target.write(
                  buffer,
                  written,
                  bytesRead - written,
                  position + written,
                );
                if (!n.bytesWritten) throw new Error("备份写入中断");
                written += n.bytesWritten;
              }
              position += bytesRead;
            }
            await target.sync();
          } finally {
            await target.close();
          }
          const copied = await hashRecording(recordings, relative, room);
          try {
            if (copied.sha256 !== row.sha256 || copied.bytes !== row.bytes)
              throw new Error("备份录像校验失败");
          } finally {
            await copied.handle.close();
          }
          count++;
          totalBytes += sourceFile.bytes;
        } finally {
          await sourceFile.handle.close();
        }
        after = String(row.id);
      }
    }
    snapshot.close();
    snapshot = undefined;
    const dbFile = await open(database, "r"),
      hash = createHash("sha256");
    try {
      for await (const chunk of dbFile.createReadStream({ autoClose: false }))
        hash.update(chunk);
    } finally {
      await dbFile.close();
    }
    const manifest = {
      formatVersion: 1,
      createdAt: Date.now(),
      scope: "live-database-and-registered-recordings",
      recordings: count,
      bytes: totalBytes,
      databaseSha256: hash.digest("hex"),
      excluded: [
        "Agent database",
        "pending and unregistered media",
        "recording receipts",
        "credentials and service configuration",
      ],
    };
    // Completion marker is written last; a failed run leaves no misleading completed backup.
    await writeFile(
      join(output, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      { mode: 0o600, flag: "wx" },
    );
    return manifest;
  } catch (error) {
    snapshot?.close();
    await rm(output, { recursive: true, force: true });
    throw error;
  }
}
