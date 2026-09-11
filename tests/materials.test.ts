import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createApp, seedDemo } from "../src/composition/studio.js";
import { parseMaterials } from "../src/modules/knowledge/public.js";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { openDatabase } from "../src/server/db.js";

async function fixture(path = ":memory:") {
  const db = openDatabase(path);
  seedDemo(db);
  const app = createApp(
    db,
    loadConfig({
      DEMO_MODE: "true",
      SESSION_SECRET: "materials-isolated-test-secret-at-least-32",
    }),
  );
  const send = async (
    path: string,
    method = "GET",
    body?: unknown,
    cookie = "",
  ) => {
    const r = await app.request("/api" + path, {
      method,
      headers: {
        ...(cookie ? { cookie } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  };
  const cookie = (await send("/auth/demo", "POST", {})).cookie;
  const request = (path: string, method = "GET", body?: unknown) =>
    send(path, method, body, cookie);
  return { db, send, request };
}
const input = {
  sourceName: "合成资料模板 · 非真实商品",
  format: "json",
  content: JSON.stringify([
    {
      text: "演示容器容量 500 毫升。",
      evidence: "虚构教学标签，不作为真实商品证据。",
    },
  ]),
};
test("material preview is read-only; committed imports stay pending with provenance and idempotency", async () => {
  const f = await fixture();
  try {
    const before = f.db.prepare("SELECT count(*) AS count FROM facts").get()!
      .count;
    const preview = await f.request(
      "/merchant/rooms/demo-room/materials/preview",
      "POST",
      input,
    );
    assert.equal(preview.status, 200);
    assert.equal(preview.data.preview.rows.length, 1);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM facts").get()!.count,
      before,
    );
    const body = { ...input, idempotencyKey: "material-import-one" };
    const imported = await f.request(
      "/merchant/rooms/demo-room/materials/import",
      "POST",
      body,
    );
    assert.equal(imported.status, 201);
    const batch = imported.data.batch;
    assert.equal(batch.importedCount, 1);
    assert.equal(batch.sourceName, input.sourceName);
    const fact = imported.data.facts.find(
      (x: { id: string }) => x.id === batch.factIds[0],
    );
    assert.equal(fact.approved, false);
    const replay = await f.request(
      "/merchant/rooms/demo-room/materials/import",
      "POST",
      body,
    );
    assert.equal(replay.data.batch.id, batch.id);
    assert.equal(
      (
        await f.request("/merchant/rooms/demo-room/materials/import", "POST", {
          ...body,
          sourceName: "different",
        })
      ).status,
      409,
    );
    assert.equal(
      (await f.request("/merchant/rooms/demo-room/materials", "GET")).data
        .batches.length,
      1,
    );
    await f.request("/merchant/facts/" + fact.id, "PATCH", { approved: true });
    const duplicate = await f.request(
      "/merchant/rooms/demo-room/materials/import",
      "POST",
      { ...body, idempotencyKey: "material-import-two" },
    );
    assert.equal(duplicate.data.batch.importedCount, 0);
    assert.equal(duplicate.data.batch.skippedCount, 1);
    assert.equal(
      duplicate.data.facts.find((x: { id: string }) => x.id === fact.id)
        .approved,
      true,
    );
  } finally {
    f.db.close();
  }
});
test("CSV supports BOM, escaped quotes, commas and multiline evidence without executing content", () => {
  const rows = parseMaterials({
    sourceName: "sample",
    format: "csv",
    content: '\uFEFFtext,evidence\r\n"容量为500,毫升","来源\n第""二""页"\r\n',
  });
  assert.deepEqual(rows, [
    { text: "容量为500,毫升", evidence: '来源\n第"二"页' },
  ]);
  for (const content of [
    "text,approved\nx,true",
    'text,evidence\n"unclosed,x',
    "text,evidence\nx,y,z",
  ])
    assert.throws(() =>
      parseMaterials({ sourceName: "x", format: "csv", content }),
    );
});
test("invalid rows and auto-approval fields reject the whole import, and transaction failures leave no partial facts", async () => {
  const f = await fixture();
  try {
    const count = () =>
      f.db.prepare("SELECT count(*) AS count FROM facts").get()!.count;
    const before = count();
    for (const rows of [
      [
        { text: "one", evidence: "source" },
        { text: "bad", evidence: "" },
      ],
      [{ text: "x", evidence: "y", approved: true }],
      Array.from({ length: 41 }, () => ({ text: "x", evidence: "y" })),
    ]) {
      const result = await f.request(
        "/merchant/rooms/demo-room/materials/import",
        "POST",
        {
          ...input,
          content: JSON.stringify(rows),
          idempotencyKey: "invalid-import",
        },
      );
      assert.equal(result.status, 400);
      assert.equal(count(), before);
    }
    f.db.exec(
      "CREATE TRIGGER force_material_rollback BEFORE INSERT ON material_imports BEGIN SELECT RAISE(ABORT,'forced-material-import-failure'); END;",
    );
    assert.equal(
      (
        await f.request("/merchant/rooms/demo-room/materials/import", "POST", {
          ...input,
          idempotencyKey: "rollback-material",
        })
      ).status,
      500,
    );
    assert.equal(count(), before);
    assert.equal(
      f.db.prepare("SELECT count(*) AS count FROM material_imports").get()!
        .count,
      0,
    );
  } finally {
    f.db.close();
  }
});
test("material imports require owned-room authentication and are absent from public room responses", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await f.send("/merchant/rooms/demo-room/materials")).status,
      401,
    );
    f.db
      .prepare(
        "INSERT INTO rooms(id,merchant_id,title,product_name,stream_secret,created_at) VALUES(?,?,?,?,?,?)",
      )
      .run("other-room", "other", "Other", "Other", "not-public", 0);
    for (const suffix of ["preview", "import"])
      assert.equal(
        (
          await f.request(
            "/merchant/rooms/other-room/materials/" + suffix,
            "POST",
            { ...input, idempotencyKey: "other-import-key" },
          )
        ).status,
        404,
      );
    await f.request("/merchant/rooms/demo-room/materials/import", "POST", {
      ...input,
      idempotencyKey: "private-source-test",
    });
    const publicRoom = await f.send("/public/rooms/demo-room");
    assert.equal(publicRoom.status, 200);
    assert.ok(!JSON.stringify(publicRoom.data).includes(input.sourceName));
    assert.ok(!JSON.stringify(publicRoom.data).includes("contentHash"));
  } finally {
    f.db.close();
  }
});
test("material migration and receipts survive database reopening without reimporting", async () => {
  const dir = mkdtempSync(join(tmpdir(), "studio-materials-")),
    path = join(dir, "db.sqlite");
  const f = await fixture(path);
  try {
    const first = await f.request(
      "/merchant/rooms/demo-room/materials/import",
      "POST",
      { ...input, idempotencyKey: "persist-materials" },
    );
    f.db.close();
    const db = openDatabase(path);
    try {
      assert.equal(
        db.prepare("SELECT max(version) AS v FROM schema_migrations").get()!.v,
        8,
      );
      assert.equal(
        db.prepare("SELECT id FROM material_imports").get()!.id,
        first.data.batch.id,
      );
      assert.equal(
        db
          .prepare("SELECT approved FROM facts WHERE id=?")
          .get(first.data.batch.factIds[0])!.approved,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    try {
      f.db.close();
    } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
});
