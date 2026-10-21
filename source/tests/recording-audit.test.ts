import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { openDatabase } from "../src/server/db.js";
import { seedDemo } from "../src/server/app.js";
import { auditRecordings } from "../src/server/recording-audit.js";
test("recording audit checks restored read-only registry against actual files with pagination and failures", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recording-audit-"));
  const root = join(folder, "segments"),
    outbox = join(folder, "queue"),
    backup = join(folder, "backup.sqlite");
  await mkdir(join(root, "live/demo-room"), { recursive: true });
  await mkdir(outbox);
  const db = openDatabase(join(folder, "source.sqlite"));
  seedDemo(db);
  const bytes = Buffer.from("0000ftypisom-test-footage");
  try {
    for (const id of ["a", "b", "c"]) {
      const path = `live/demo-room/1234567890-${id.charCodeAt(0)}.mp4`;
      await writeFile(join(root, path), bytes);
      db.prepare("INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        id,
        "demo",
        "demo-room",
        path,
        1,
        2,
        1,
        bytes.length,
        createHash("sha256").update(bytes).digest("hex"),
        3,
      );
    }
    db.prepare("VACUUM INTO ?").run(backup);
    const restored = new DatabaseSync(backup, { readOnly: true });
    try {
      const first = await auditRecordings(restored, root, outbox, "", 2);
      assert.equal(first.verified, 2);
      assert.equal(first.nextAfter, "b");
      assert.equal(first.issues.length, 0);
      assert.ok(first.storage!.totalBytes > 0);
      const last = await auditRecordings(restored, root, outbox, "b", 2);
      assert.equal(last.verified, 1);
      assert.equal(last.nextAfter, null);
      await writeFile(
        join(root, "live/demo-room/1234567890-97.mp4"),
        Buffer.from("0000ftypisom-test-CHANGED"),
      );
      await unlink(join(root, "live/demo-room/1234567890-98.mp4"));
      await writeFile(join(outbox, "f".repeat(64) + ".json"), "{}");
      const broken = await auditRecordings(restored, root, outbox);
      assert.equal(broken.verified, 1);
      assert.deepEqual(broken.issues, [
        { id: "a", roomId: "demo-room", kind: "mismatch" },
        { id: "b", roomId: "demo-room", kind: "unavailable" },
      ]);
      assert.equal(broken.queue!.pending, 1);
      assert.ok(broken.warnings.length);
      assert.equal(
        restored.prepare("SELECT count(*) AS n FROM recordings").get()!.n,
        3,
      );
      assert.equal(
        (await auditRecordings(restored, root, join(folder, "missing"))).queue,
        null,
      );
      await assert.rejects(() =>
        auditRecordings(restored, root, outbox, "", 0),
      );
    } finally {
      restored.close();
    }
  } finally {
    db.close();
    await rm(folder, { recursive: true });
  }
});
