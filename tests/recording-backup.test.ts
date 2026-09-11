import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
  stat,
  readdir,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { backupRegisteredRecordings } from "../src/server/recording-backup.js";
import { auditRecordings } from "../src/server/recording-audit.js";

test("registered recording backup restores all pages and refuses overwrite or damaged sources", async () => {
  const dir = await mkdtemp(join(tmpdir(), "recording-backup-")),
    root = join(dir, "source"),
    dest = join(dir, "snapshot");
  const db = new DatabaseSync(":memory:");
  db.exec(
    "CREATE TABLE recordings(id TEXT PRIMARY KEY,room_id TEXT,relative_path TEXT,sha256 TEXT,bytes INTEGER)",
  );
  const data = Buffer.from("0000ftypisom-recording-test");
  const hash = createHash("sha256").update(data).digest("hex");
  await mkdir(join(root, "live/room"), { recursive: true });
  const insert = db.prepare("INSERT INTO recordings VALUES(?,?,?,?,?)");
  try {
    for (let n = 0; n < 105; n++) {
      const path = `live/room/1234567890-${String(n).padStart(6, "0")}.mp4`;
      await writeFile(join(root, path), data);
      insert.run(String(n).padStart(4, "0"), "room", path, hash, data.length);
    }
    const result = await backupRegisteredRecordings(db, root, dest);
    assert.equal(result.recordings, 105);
    assert.equal(result.bytes, 105 * data.length);
    assert.equal((await stat(dest)).mode & 0o777, 0o700);
    assert.equal(
      createHash("sha256")
        .update(await readFile(join(dest, "studio.sqlite")))
        .digest("hex"),
      result.databaseSha256,
    );
    const restored = new DatabaseSync(join(dest, "studio.sqlite"), {
      readOnly: true,
    });
    try {
      const first = await auditRecordings(
        restored,
        join(dest, "recordings"),
        join(dest, "outbox"),
      );
      assert.equal(first.verified, 100);
      assert.ok(first.nextAfter);
      const second = await auditRecordings(
        restored,
        join(dest, "recordings"),
        join(dest, "outbox"),
        first.nextAfter!,
      );
      assert.equal(second.verified, 5);
      assert.equal(second.nextAfter, null);
    } finally {
      restored.close();
    }
    await assert.rejects(
      () => backupRegisteredRecordings(db, root, dest),
      /exist/i,
    );
    assert.equal(
      JSON.parse(await readFile(join(dest, "manifest.json"), "utf8"))
        .recordings,
      105,
    );
    await writeFile(
      join(root, "live/room/1234567890-000000.mp4"),
      Buffer.from("0000ftypisom-tampered"),
    );
    const failed = join(dir, "failed");
    await assert.rejects(
      () => backupRegisteredRecordings(db, root, failed),
      /不一致/,
    );
    assert.ok(!(await readdir(dir)).includes("failed"));
    assert.equal(db.prepare("SELECT count(*) n FROM recordings").get()!.n, 105);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
