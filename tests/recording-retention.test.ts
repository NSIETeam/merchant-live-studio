import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile, access, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/composition/studio.js";
import {
  createRecordingStorage,
  loadConfig,
} from "../src/platform/infrastructure/public.js";

const DAY = 24 * 60 * 60 * 1000;

test("recording deletion requires expiry, resolved disputes, released holds and independent review", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recording-retention-"));
  const root = join(folder, "segments"),
    outbox = join(folder, "outbox");
  await mkdir(join(root, "live/demo-room"), { recursive: true });
  await mkdir(outbox);
  const relativePath = "live/demo-room/1700000000-000000.mp4";
  const file = join(root, relativePath);
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(128, 7),
  ]);
  await writeFile(file, bytes);
  const now = Date.now(),
    token = "recording-retention-test-token-32";
  const db = openDatabase(":memory:");
  seedDemo(db, now - 70 * DAY);
  db.prepare("UPDATE rooms SET status='ended' WHERE id='demo-room'").run();
  db.prepare("INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?,?,?)").run(
    "recording-retention-1",
    "demo",
    "demo-room",
    relativePath,
    now - 70 * DAY,
    now - 69 * DAY,
    60,
    bytes.length,
    createHash("sha256").update(bytes).digest("hex"),
    now - 69 * DAY,
  );
  const config = loadConfig({
    DEMO_MODE: "true",
    SESSION_SECRET: "recording-retention-session-secret-32",
    RECORDINGS_ROOT: root,
    RECORDING_OUTBOX: outbox,
    DATA_RETENTION_POLICY: JSON.stringify({
      effectiveDate: "2026-09-01",
      liveContentDays: 60,
      commerceRecordsMonths: 36,
      securityLogsMonths: 6,
      deletionReviewContact: "合规负责人：retention@example.test",
    }),
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
  const app = createApp(db, config, () => now);
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
      .split(";")[0];
    const reviewer = await login("reviewer"),
      presenter = await login("presenter"),
      other = await login("other");
    const base = "/merchant/recordings/recording-retention-1";
    assert.equal(
      (await call(base + "/retention", "GET", undefined, presenter)).status,
      403,
    );
    assert.equal(
      (await call(base + "/retention", "GET", undefined, other)).status,
      404,
    );
    const initial = (await (
      await call(base + "/retention", "GET", undefined, owner)
    ).json()) as any;
    assert.equal(initial.policyConfigured, true);
    assert.equal(initial.deleted, false);
    assert.equal(initial.holds.length, 0);
    assert.deepEqual(initial.deletionBlockers, []);
    db.prepare("UPDATE rooms SET status='live' WHERE id='demo-room'").run();
    assert.equal(
      (
        await call(
          base + "/deletion-requests",
          "POST",
          {
            reason: "直播尚未结束时不能删除录像片段。",
            idempotencyKey: randomUUID(),
          },
          owner,
        )
      ).status,
      409,
    );
    db.prepare("UPDATE rooms SET status='ended' WHERE id='demo-room'").run();

    const holdKey = randomUUID();
    const holdResponse = await call(
      base + "/retention/holds",
      "POST",
      {
        kind: "dispute",
        reason: "收到线下争议通知，等待材料核实。",
        idempotencyKey: holdKey,
      },
      owner,
    );
    assert.equal(holdResponse.status, 201);
    const hold = ((await holdResponse.json()) as any).retention.holds[0];
    assert.equal(hold.state, "active");
    assert.equal(
      (
        await call(
          base + "/retention/holds",
          "POST",
          {
            kind: "dispute",
            reason: "收到线下争议通知，等待材料核实。",
            idempotencyKey: holdKey,
          },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          base + "/deletion-requests",
          "POST",
          {
            reason: "保存期限已满，申请按流程删除录像。",
            idempotencyKey: randomUUID(),
          },
          owner,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          base + `/retention/holds/${hold.id}/release`,
          "POST",
          { previousVersion: 1, note: "争议材料已经归档并确认解除保留。" },
          owner,
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await call(
          base + `/retention/holds/${hold.id}/release`,
          "POST",
          { previousVersion: 1, note: "争议材料已经归档并确认解除保留。" },
          reviewer,
        )
      ).status,
      200,
    );

    const requestKey = randomUUID();
    const requestResponse = await call(
      base + "/deletion-requests",
      "POST",
      {
        reason: "保存期限已经届满，申请删除该录像片段。",
        idempotencyKey: requestKey,
      },
      owner,
    );
    assert.equal(requestResponse.status, 201);
    const request = ((await requestResponse.json()) as any).retention
      .requests[0];
    assert.equal(request.state, "requested");
    assert.equal(
      (
        await call(
          base + "/deletion-requests",
          "POST",
          {
            reason: "保存期限已经届满，申请删除该录像片段。",
            idempotencyKey: requestKey,
          },
          owner,
        )
      ).status,
      200,
    );
    assert.equal(
      (
        await call(
          base + `/deletion-requests/${request.id}/review`,
          "POST",
          {
            previousVersion: 1,
            decision: "approve",
            note: "申请和保存期限已经复核。",
          },
          owner,
        )
      ).status,
      403,
    );

    const viewer = (await call("/auth/viewer", "POST", {})).headers
      .get("set-cookie")!
      .split(";")[0];
    const complaintResponse = await call(
      "/viewer/rooms/demo-room/complaints",
      "POST",
      {
        category: "content",
        body: "需要复核本场直播中的商品说明内容。",
        idempotencyKey: randomUUID(),
      },
      viewer,
    );
    const complaint = ((await complaintResponse.json()) as any).complaint;
    assert.equal(
      (
        await call(
          base + `/deletion-requests/${request.id}/review`,
          "POST",
          {
            previousVersion: 1,
            decision: "approve",
            note: "申请和保存期限已经复核。",
          },
          reviewer,
        )
      ).status,
      409,
    );
    assert.equal(
      (
        await call(
          `/merchant/complaints/${complaint.id}/reply`,
          "POST",
          {
            previousVersion: 1,
            state: "resolved",
            reply: "已核对并完成处理，保留相关书面记录。",
          },
          owner,
        )
      ).status,
      200,
    );

    const approved = await call(
      base + `/deletion-requests/${request.id}/review`,
      "POST",
      {
        previousVersion: 1,
        decision: "approve",
        note: "期限、争议状态和录像散列均已复核。",
      },
      reviewer,
    );
    assert.equal(approved.status, 200);
    const final = ((await approved.json()) as any).retention;
    assert.equal(final.deleted, true);
    assert.equal(final.requests[0].state, "deleted");
    await assert.rejects(access(file));
    await assert.rejects(
      access(join(root, ".retention-trash", "recording-retention-1.mp4")),
    );
    assert.equal(
      (await call(base + "/download", "GET", undefined, reviewer)).status,
      410,
    );
    const recordingPage = (await (
      await call(
        "/merchant/rooms/demo-room/recordings",
        "GET",
        undefined,
        reviewer,
      )
    ).json()) as any;
    assert.equal(recordingPage.items[0].deleted, 1);
    assert.equal(
      db
        .prepare("SELECT count(*) AS n FROM recordings WHERE id=?")
        .get("recording-retention-1")!.n,
      1,
    );
    assert.deepEqual(
      db
        .prepare(
          "SELECT state FROM recording_deletion_events WHERE request_id=? ORDER BY version",
        )
        .all(request.id)
        .map((x: any) => x.state),
      ["requested", "approved", "deleting", "deleted"],
    );
    assert.throws(
      () => db.exec("UPDATE recording_deletion_events SET note='changed'"),
      /immutable/,
    );
    assert.throws(
      () => db.exec("DELETE FROM recording_retention_holds"),
      /immutable/,
    );
  } finally {
    db.close();
    await rm(folder, { recursive: true, force: true });
  }
});

test("staged deletion can resume after interruption or restore the original file", async () => {
  const folder = await mkdtemp(join(tmpdir(), "recording-retention-stage-"));
  const root = join(folder, "segments"),
    outbox = join(folder, "outbox");
  const relativePath = "live/room-1/1700000000-000000.mp4";
  await mkdir(join(root, "live/room-1"), { recursive: true });
  await mkdir(outbox);
  const bytes = Buffer.concat([
    Buffer.from([0, 0, 0, 24]),
    Buffer.from("ftypisom"),
    Buffer.alloc(32, 2),
  ]);
  const file = join(root, relativePath);
  await writeFile(file, bytes);
  const storage = createRecordingStorage(root, outbox);
  const expected = {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
  try {
    const first = await storage.stageDeletion(
      "recording-stage-1",
      relativePath,
      "room-1",
      expected,
    );
    await assert.rejects(access(file));
    const resumed = await storage.stageDeletion(
      "recording-stage-1",
      relativePath,
      "room-1",
      expected,
      true,
    );
    await resumed.restore();
    await access(file);
    const second = await storage.stageDeletion(
      "recording-stage-1",
      relativePath,
      "room-1",
      expected,
    );
    await second.remove();
    await assert.rejects(access(file));
    const completed = await storage.stageDeletion(
      "recording-stage-1",
      relativePath,
      "room-1",
      expected,
      true,
    );
    await completed.remove();
    await assert.rejects(() =>
      storage.stageDeletion(
        "recording-stage-1",
        relativePath,
        "room-1",
        expected,
      ),
    );
    void first;
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("v22 databases add retention controls without changing registered recordings", async () => {
  const folder = await mkdtemp(
    join(tmpdir(), "recording-retention-migration-"),
  );
  const path = join(folder, "studio.sqlite");
  const first = openDatabase(path);
  try {
    seedDemo(first);
    first
      .prepare("INSERT INTO recordings VALUES(?,?,?,?,?,?,?,?,?,?)")
      .run(
        "migration-recording",
        "demo",
        "demo-room",
        "live/demo-room/1700000000-000000.mp4",
        1,
        2,
        1,
        12,
        "0".repeat(64),
        3,
      );
    first.exec(
      "DROP TABLE speech_relay_status; DROP TABLE recording_deletion_events; DROP TABLE recording_deletion_requests; DROP TABLE recording_retention_hold_events; DROP TABLE recording_retention_holds; DELETE FROM schema_migrations WHERE version>=23",
    );
  } finally {
    first.close();
  }
  const migrated = openDatabase(path);
  try {
    assert.equal(
      migrated.prepare("SELECT max(version) AS v FROM schema_migrations").get()!
        .v,
      24,
    );
    assert.equal(
      migrated
        .prepare(
          "SELECT count(*) AS n FROM recordings WHERE id='migration-recording'",
        )
        .get()!.n,
      1,
    );
    assert.equal(
      migrated
        .prepare("SELECT count(*) AS n FROM recording_retention_holds")
        .get()!.n,
      0,
    );
  } finally {
    migrated.close();
    await rm(folder, { recursive: true, force: true });
  }
});
