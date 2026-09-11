import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createStudio } from "../src/composition/studio.js";
import {
  createAgentRuntime,
  loadAgentConfig,
} from "../src/modules/agent/public.js";
import {
  loadConfig,
  transaction,
} from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";

async function scenario(t: TestContext) {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  const studio = createStudio(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "module-boundary-test-only-secret-long",
    }),
  );
  studio.seedDemo();
  const request = async (
    path: string,
    body: unknown,
    cookie = "",
    method = "POST",
  ) => {
    const response = await studio.app.request("/api" + path, {
      method,
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      data: await response.json(),
      cookie: response.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const merchant = (await request("/auth/demo", {})).cookie;
  assert.equal(
    (
      await request(
        "/merchant/rooms/demo-room",
        { status: "live" },
        merchant,
        "PATCH",
      )
    ).status,
    200,
  );
  const result = await request(
    "/merchant/rooms/demo-room/campaigns",
    {
      totalCents: 500,
      count: 1,
      minWatchSeconds: 0,
      delaySeconds: 0,
      durationSeconds: 600,
    },
    merchant,
  );
  assert.equal(result.status, 201);
  const campaign = result.data.campaign.id as string;
  const viewer = (await request("/auth/viewer", {})).cookie;
  assert.equal(
    (
      await request(
        "/viewer/rooms/demo-room/heartbeat",
        { visible: true, playing: false },
        viewer,
      )
    ).status,
    200,
  );
  return {
    db,
    studio,
    claim: () => request(`/viewer/campaigns/${campaign}/claim`, {}, viewer),
    campaign,
  };
}

test("payment queue failure rolls back engagement reservation, budget and ledger together", async (t) => {
  const f = await scenario(t);
  f.db.exec(
    "CREATE TRIGGER reject_queue BEFORE INSERT ON payout_jobs BEGIN SELECT RAISE(ABORT,'forced queue failure'); END",
  );
  assert.equal((await f.claim()).status, 500);
  assert.deepEqual(
    {
      ...f.db
        .prepare(
          "SELECT remaining_cents,remaining_count FROM campaigns WHERE id=?",
        )
        .get(f.campaign),
    },
    { remaining_cents: 500, remaining_count: 1 },
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM claims").get()!.n, 0);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger").get()!.n, 1);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM payout_jobs").get()!.n,
    0,
  );
  f.db.exec("DROP TRIGGER reject_queue");
  assert.equal((await f.claim()).status, 200);
  assert.equal((await f.claim()).status, 200);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM claims").get()!.n, 1);
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger").get()!.n, 2);
  assert.equal(
    f.db.prepare("SELECT count(*) AS n FROM payout_jobs").get()!.n,
    1,
  );
});

test("settlement callback failure rolls back payments and claim status, then retries once", async (t) => {
  const f = await scenario(t);
  assert.equal((await f.claim()).status, 200);
  f.db.exec(
    "CREATE TRIGGER reject_settlement BEFORE UPDATE ON claims BEGIN SELECT RAISE(ABORT,'forced settlement failure'); END",
  );
  assert.throws(
    () => f.studio.processSimulationJobs(),
    /forced settlement failure/,
  );
  assert.equal(
    f.db.prepare("SELECT status FROM claims").get()!.status,
    "reserved",
  );
  assert.deepEqual(
    { ...f.db.prepare("SELECT state,attempts FROM payout_jobs").get() },
    { state: "pending", attempts: 0 },
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger").get()!.n, 2);
  f.db.exec("DROP TRIGGER reject_settlement");
  assert.equal(f.studio.processSimulationJobs(), 1);
  assert.equal(f.studio.processSimulationJobs(), 0);
  assert.equal(
    f.db.prepare("SELECT status FROM claims").get()!.status,
    "simulated",
  );
  assert.equal(f.db.prepare("SELECT count(*) AS n FROM ledger").get()!.n, 3);
});

test("nested units of work preserve inner rollback and remain subject to outer rollback", (t) => {
  const db = openDatabase(":memory:");
  t.after(() => db.close());
  db.exec("CREATE TABLE transaction_probe(value INTEGER)");
  transaction(db, () => {
    db.prepare("INSERT INTO transaction_probe VALUES(?)").run(1);
    assert.throws(
      () =>
        transaction(db, () => {
          db.prepare("INSERT INTO transaction_probe VALUES(?)").run(2);
          throw new Error("inner");
        }),
      /inner/,
    );
    transaction(db, () => {
      db.prepare("INSERT INTO transaction_probe VALUES(?)").run(3);
    });
  });
  assert.deepEqual(
    db
      .prepare("SELECT value FROM transaction_probe ORDER BY value")
      .all()
      .map((r) => r.value),
    [1, 3],
  );
  assert.throws(
    () =>
      transaction(db, () => {
        transaction(db, () => {
          db.prepare("INSERT INTO transaction_probe VALUES(?)").run(4);
        });
        throw new Error("outer");
      }),
    /outer/,
  );
  assert.deepEqual(
    db
      .prepare("SELECT value FROM transaction_probe ORDER BY value")
      .all()
      .map((r) => r.value),
    [1, 3],
  );
});

test("the Agent module owns database shutdown and concurrent close requests share completion", async () => {
  const agent = createAgentRuntime(
    loadAgentConfig({ AGENT_DATABASE_PATH: ":memory:" }),
    { autoStart: false },
  );
  assert.equal((await agent.app.request("/health")).status, 200);
  await Promise.all([agent.close(), agent.close()]);
  await agent.close();
});
