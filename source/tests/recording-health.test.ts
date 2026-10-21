import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  recordingStorageState,
  storageState,
} from "../src/server/recording-health.js";
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
