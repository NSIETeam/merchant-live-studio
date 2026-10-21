import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
  rm,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.js";
import { loadConfig } from "../src/server/config.js";
import { createApp, seedDemo } from "../src/server/app.js";
import {
  enqueueCompletedSegment,
  hashRecording,
} from "../src/server/recording-files.js";
import { processRecordingOutbox } from "../src/server/recordings.js";

test("recording completion queue, immutable registry and verified downloads isolate tenants and changed files", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recordings-")),
    root = join(folder, "segments"),
    outbox = join(folder, "queue");
  await mkdir(join(root, "live/demo-room"), { recursive: true });
  const file = join(
      root,
      "live/demo-room",
      `${Math.floor(Date.now() / 1000) - 5}-000000.mp4`,
    ),
    bytes = Buffer.concat([
      Buffer.from([0, 0, 0, 24]),
      Buffer.from("ftypisom"),
      Buffer.alloc(128, 1),
    ]);
  await writeFile(file, bytes);
  const db = openDatabase(":memory:");
  seedDemo(db);
  const token = "recordings-local-test-token-at-least-32";
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "recordings-session-secret-at-least-32",
    RECORDINGS_ROOT: root,
    RECORDING_OUTBOX: outbox,
    MERCHANT_CREDENTIALS: JSON.stringify({
      reviewer: token,
      presenter: token,
      other: token,
    }),
    MERCHANT_MEMBERSHIPS: JSON.stringify({
      reviewer: { merchantId: "demo", role: "reviewer" },
      presenter: { merchantId: "demo", role: "presenter" },
    }),
  });
  const app = createApp(db, config);
  const call = (path: string, method = "GET", body?: unknown, cookie = "") =>
    app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  const login = async (id: string) =>
    (await call("/auth/merchant", "POST", { merchantId: id, token })).headers
      .get("set-cookie")!
      .split(";")[0];
  try {
    const owner = (await call("/auth/demo", "POST", {})).headers
        .get("set-cookie")!
        .split(";")[0],
      reviewer = await login("reviewer"),
      presenter = await login("presenter"),
      other = await login("other");
    const path = "/merchant/rooms/demo-room/recordings";
    await processRecordingOutbox(db, config);
    assert.equal(
      ((await (await call(path, "GET", undefined, owner)).json()) as any).items
        .length,
      0,
    );
    const env = {
      RECORDINGS_ROOT: root,
      RECORDING_OUTBOX: outbox,
      MTX_PATH: "live/demo-room",
      MTX_SEGMENT_PATH: file,
      MTX_SEGMENT_DURATION: "3",
    };
    await enqueueCompletedSegment(env);
    await Promise.all([
      processRecordingOutbox(db, config),
      processRecordingOutbox(db, config),
    ]);
    const page = (await (
      await call(path, "GET", undefined, reviewer)
    ).json()) as any;
    assert.equal(page.items.length, 1);
    assert.equal(page.items[0].bytes, bytes.length);
    assert.equal(JSON.stringify(page).includes(folder), false);
    const download = "/merchant/recordings/" + page.items[0].id + "/download";
    assert.equal((await call(download)).status, 401);
    assert.equal(
      (await call(download, "GET", undefined, presenter)).status,
      403,
    );
    assert.equal((await call(download, "GET", undefined, other)).status, 404);
    const response = await call(download, "GET", undefined, owner);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "video/mp4");
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
    await enqueueCompletedSegment(env);
    await processRecordingOutbox(db, config);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM recordings").get()!.n,
      1,
    );
    assert.equal(
      (await readdir(outbox)).filter((n) => n.endsWith(".json")).length,
      0,
    );
    assert.throws(() => db.exec("DELETE FROM recordings"));
    await writeFile(
      file,
      Buffer.concat([bytes.subarray(0, 12), Buffer.alloc(128, 2)]),
    );
    assert.equal((await call(download, "GET", undefined, owner)).status, 409);
    await enqueueCompletedSegment(env);
    await processRecordingOutbox(db, config);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM recording_ingest_errors").get()!.n,
      1,
    );
    assert.equal((await readdir(join(outbox, "failed"))).length, 1);
    const healthPath = "/merchant/recordings/health";
    assert.equal((await call(healthPath)).status, 401);
    assert.equal(
      (await call(healthPath, "GET", undefined, presenter)).status,
      403,
    );
    const healthResponse = await call(healthPath, "GET", undefined, reviewer);
    assert.equal(healthResponse.headers.get("cache-control"), "no-store");
    const health = await healthResponse.json();
    assert.equal(health.storage, "available");
    assert.equal(health.ingestErrorCount, 1);
    assert.equal(JSON.stringify(health).includes(folder), false);
    const otherHealth = await (
      await call(healthPath, "GET", undefined, other)
    ).json();
    assert.equal(otherHealth.ingestErrorCount, 0);

    assert.equal(
      (await call(path + "?after=not-a-record", "GET", undefined, owner))
        .status,
      400,
    );
  } finally {
    db.close();
    await rm(folder, { recursive: true });
  }
});

test("recording paths reject traversal and symlinks; malformed receipts are quarantined", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recording-paths-")),
    root = join(folder, "root"),
    outbox = join(folder, "queue");
  await mkdir(join(root, "live/demo-room"), { recursive: true });
  await mkdir(outbox);
  const db = openDatabase(":memory:");
  seedDemo(db);
  const config = loadConfig({
    RECORDINGS_ROOT: root,
    RECORDING_OUTBOX: outbox,
  });
  try {
    await writeFile(
      join(folder, "outside.mp4"),
      Buffer.from("0000ftypisom-more-bytes"),
    );
    await symlink(
      join(folder, "outside.mp4"),
      join(root, "live/demo-room/1234567890-000000.mp4"),
    );
    await assert.rejects(
      () =>
        hashRecording(
          root,
          "live/demo-room/1234567890-000000.mp4",
          "demo-room",
        ),
      /符号链接/,
    );
    await assert.rejects(
      () => hashRecording(root, "../../outside.mp4", "demo-room"),
      /路径/,
    );
    await assert.rejects(
      () =>
        hashRecording(root, "live/other/1234567890-000000.mp4", "demo-room"),
      /匹配/,
    );
    await writeFile(join(outbox, "0".repeat(64) + ".json"), "not json");
    await processRecordingOutbox(db, config);
    assert.equal((await readdir(join(outbox, "failed"))).length, 1);
    assert.equal(
      db.prepare("SELECT count(*) AS n FROM recordings").get()!.n,
      0,
    );
  } finally {
    db.close();
    await rm(folder, { recursive: true });
  }
});
