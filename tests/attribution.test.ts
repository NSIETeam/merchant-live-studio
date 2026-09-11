import { recordAttribution } from "../src/server/attribution.js";
import test from "node:test";
import assert from "node:assert/strict";
import { openDatabase } from "../src/server/db.js";
import { createApp, seedDemo } from "../src/server/app.js";
import { loadConfig } from "../src/server/config.js";
async function fixture() {
  const db = openDatabase(":memory:");
  seedDemo(db);
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "attribution-test-secret-at-least-32-characters",
      MERCHANT_CREDENTIALS: JSON.stringify({
        other: "other-test-key-at-least-24-characters",
      }),
    }),
  );
  async function raw(
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) {
    const res = await app.request("/api" + path, {
      method,
      headers: {
        cookie,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: res.status,
      data: (await res.json()) as any,
      cookie: res.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const cookie = (await raw("/auth/demo", "POST", {})).cookie;
  const other = (
    await raw("/auth/merchant", "POST", {
      merchantId: "other",
      token: "other-test-key-at-least-24-characters",
    })
  ).cookie;
  const call = (p: string, m = "GET", b?: unknown, foreign = false) =>
    raw("/merchant/attribution" + p, m, b, foreign ? other : cookie);
  const store = await call("/stores", "POST", {
    name: "验收门店",
    externalRef: "store-1",
  });
  assert.equal(store.status, 201);
  const storeId = store.data.store.id;
  const source = await call("/sources", "POST", {
    storeId,
    roomId: "demo-room",
    label: "社群A",
  });
  assert.equal(source.status, 201);
  const sourceCode = source.data.source.code;
  const row = {
    kind: "order",
    externalId: "order-1",
    occurredAt: new Date().toISOString(),
    amountYuan: "19.99",
    sourceCode,
  };
  const input = (rows: unknown[]) => ({
    storeId,
    sourceName: "测试台账",
    rows,
  });
  const commit = (
    rows: unknown[],
    idempotencyKey: string = crypto.randomUUID(),
  ) =>
    call("/imports", "POST", {
      ...input(rows),
      idempotencyKey,
      acknowledged: true,
    });
  return { db, call, storeId, sourceCode, row, input, commit };
}
test("offline imports preserve exact cents, idempotency and immutable correction history", async () => {
  const f = await fixture();
  try {
    const first = await f.commit([f.row], "batch-1");
    assert.equal(first.status, 201);
    assert.equal(first.data.receipt.inserted, 1);
    assert.deepEqual((await f.commit([f.row], "batch-1")).data, first.data);
    assert.equal(
      (await f.commit([{ ...f.row, amountYuan: "20.00" }], "batch-1")).status,
      409,
    );
    assert.equal((await f.commit([f.row])).data.receipt.skipped, 1);
    assert.equal((await f.call("/summary")).data.metrics[0].salesCents, 1999);
    assert.equal(
      (
        await f.commit([
          {
            ...f.row,
            amountYuan: "10.01",
            previousVersion: 1,
            note: "部分退款，调整净额",
          },
        ])
      ).status,
      201,
    );
    let records = (await f.call("/records?storeId=" + f.storeId)).data.records;
    assert.equal(records.length, 1);
    assert.equal(records[0].revision, 2);
    assert.equal(
      (await f.call("/records/" + records[0].id + "/history")).data.records
        .length,
      2,
    );
    assert.equal((await f.call("/summary")).data.metrics[0].salesCents, 1001);
    assert.throws(() => f.db.prepare("DELETE FROM offline_records").run());
    assert.equal(
      (
        await f.commit([
          {
            ...f.row,
            amountYuan: "10.01",
            previousVersion: 2,
            voided: true,
            note: "业务取消",
          },
        ])
      ).status,
      201,
    );
    assert.equal((await f.call("/summary")).data.metrics[0].orders, 0);
  } finally {
    f.db.close();
  }
});
test("conflicting batches are atomic, unmatched records stay visible and tenant boundaries hold", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.commit([f.row, f.row])).status, 409);
    assert.equal(
      (await f.call("/records?storeId=" + f.storeId)).data.records.length,
      0,
    );
    const unknown = { ...f.row, sourceCode: "unverified-code" };
    assert.equal(
      (await f.call("/imports/preview", "POST", f.input([unknown]))).data
        .rows[0].matchState,
      "unknown_source",
    );
    assert.equal((await f.commit([unknown])).data.receipt.unlinked, 1);
    const summary = (await f.call("/summary")).data;
    assert.equal(summary.conversionProven, false);
    assert.equal(summary.metrics[0].unlinkedSalesCents, 1999);
    assert.equal(
      (await f.call("/records?storeId=" + f.storeId, "GET", undefined, true))
        .status,
      404,
    );
    assert.equal(
      (await f.call("/sources?storeId=" + f.storeId, "GET", undefined, true))
        .status,
      404,
    );
    const record = (await f.call("/records?storeId=" + f.storeId)).data
      .records[0];
    assert.equal(
      (
        await f.call(
          "/records/" + record.id + "/history",
          "GET",
          undefined,
          true,
        )
      ).status,
      404,
    );
    assert.equal(
      (await f.call("/imports/preview", "POST", f.input([f.row]), true)).status,
      404,
    );
    assert.equal(
      (await f.commit([{ ...f.row, externalId: "bad", amountYuan: "0.001" }]))
        .status,
      400,
    );
  } finally {
    f.db.close();
  }
});

test("source attribution is first-valid only and excludes viewing before association", async () => {
  const f = await fixture();
  try {
    const now = Date.now();
    f.db
      .prepare(
        "INSERT INTO visits(room_id,viewer_id,first_seen,last_seen,watch_seconds) VALUES(?,?,?,?,?)",
      )
      .run("demo-room", "browser-a", now, now, 75);
    recordAttribution(f.db, "demo-room", "browser-a", "invalid", now);
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM attribution_visits").get()!.n,
      0,
    );
    recordAttribution(f.db, "demo-room", "browser-a", f.sourceCode, now);
    const second = (
      await f.call("/sources", "POST", {
        storeId: f.storeId,
        roomId: "demo-room",
        label: "另一个社群",
      })
    ).data.source.code;
    recordAttribution(f.db, "demo-room", "browser-a", second, Date.now());
    assert.equal(
      f.db.prepare("SELECT source_code FROM attribution_visits").get()!
        .source_code,
      f.sourceCode,
    );
    f.db
      .prepare("UPDATE visits SET watch_seconds=100 WHERE viewer_id=?")
      .run("browser-a");
    assert.equal((await f.call("/summary")).data.metrics[0].watchSeconds, 25);
    assert.equal((await f.call("/summary")).data.metrics[0].sourceViewers, 1);
    await f.call("/sources/" + second + "/disable", "POST", {});
    f.db
      .prepare(
        "INSERT INTO visits(room_id,viewer_id,first_seen,last_seen) VALUES(?,?,?,?)",
      )
      .run("demo-room", "browser-b", now, now);
    recordAttribution(f.db, "demo-room", "browser-b", second, Date.now());
    assert.equal(
      f.db.prepare("SELECT count(*) AS n FROM attribution_visits").get()!.n,
      1,
    );
    assert.throws(() =>
      f.db.exec('UPDATE attribution_visits SET source_code="bad"'),
    );
  } finally {
    f.db.close();
  }
});
