import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordingStorageState,
  storageState,
} from "../src/platform/infrastructure/public.js";
test("recording storage reports unavailable and low space without scanning video files", async () => {
  assert.equal(storageState(9, 100), "low-space");
  assert.equal(storageState(10, 100), "available");
  assert.equal(storageState(0, 100), "low-space");
  for (const [available, total] of [
    [0, 0],
    [-1, 100],
    [101, 100],
    [NaN, 100],
    [10, Infinity],
  ])
    assert.equal(storageState(available, total), "unavailable");
  const dir = await mkdtemp(join(tmpdir(), "recording-health-"));
  try {
    const root = join(dir, "recordings"),
      queue = join(dir, "queue");
    await mkdir(root);
    await mkdir(queue);
    assert.equal(await recordingStorageState(root, queue), "available");
    assert.equal(await recordingStorageState("", queue), "unconfigured");
    assert.equal(
      await recordingStorageState(root, join(dir, "missing")),
      "unavailable",
    );
    const file = join(dir, "file");
    await writeFile(file, "test");
    assert.equal(await recordingStorageState(root, file), "unavailable");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recording processor failure is visible through authenticated health and recovers after queue repair", async (t) => {
  const { openDatabase } = await import("../src/server/db.js");
  const { createApp, seedDemo, processRecordingOutbox } = await import("../src/composition/studio.js");
  const { loadConfig } = await import("../src/platform/infrastructure/public.js");
  const folder = await mkdtemp(join(tmpdir(), "recording-worker-"));
  const root = join(folder, "recordings"), queue = join(folder, "queue");
  const db = openDatabase(":memory:");
  try {
    await mkdir(root);
    await writeFile(queue, "not a directory");
    seedDemo(db);
    const config = loadConfig({ DEMO_MODE: "true", RECORDINGS_ROOT: root, RECORDING_OUTBOX: queue });
    const app = createApp(db, config);
    const login = await app.request("/api/auth/demo", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const health = async () => {
      const res = await app.request("/api/merchant/recordings/health", { headers: { cookie } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get("cache-control"), "no-store");
      return await res.json() as { processor: string; storage: string };
    };
    assert.equal((await health()).processor, "checking");
    await assert.rejects(processRecordingOutbox(db, config));
    const failed = await health();
    assert.equal(failed.processor, "unavailable");
    assert.equal(JSON.stringify(failed).includes(folder), false);
    await rm(queue);
    await mkdir(queue);
    await processRecordingOutbox(db, config);
    assert.equal((await health()).processor, "available");
    assert.equal((await health()).storage, "available");
    const now = Date.now();
    t.mock.method(Date, "now", () => now + 61000);
    assert.equal((await health()).processor, "stalled");
    t.mock.restoreAll();
    await processRecordingOutbox(db, config);
    assert.equal((await health()).processor, "available");
    const denied = await app.request("/api/merchant/recordings/health");
    assert.equal(denied.status, 401);
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});
