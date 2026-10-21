import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
import type { ImportPreview, SourceMatch } from "../shared/attribution.js";
const latest = `NOT EXISTS (SELECT 1 FROM offline_records newer WHERE newer.merchant_id=r.merchant_id AND newer.store_id=r.store_id AND newer.kind=r.kind AND newer.external_id=r.external_id AND newer.revision>r.revision)`;
const columns = `r.id,r.store_id AS storeId,r.kind,r.external_id AS externalId,r.revision,r.source_code AS sourceCode,r.linked_source_code AS linkedSourceCode,r.match_state AS matchState,r.customer_ref AS customerRef,r.occurred_at AS occurredAt,r.amount_cents AS amountCents,r.voided,r.note,r.actor_id AS actorId,r.created_at AS createdAt,r.batch_id AS batchId`;
const rowSchema = z
  .object({
    kind: z.enum(["visit", "order", "cost"]),
    externalId: z.string().trim().min(1).max(100),
    occurredAt: z.iso.datetime({ offset: true }),
    amountYuan: z.string().regex(/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/),
    sourceCode: z.string().trim().max(100).default(""),
    customerRef: z.string().trim().max(100).default(""),
    previousVersion: z.number().int().min(0).default(0),
    voided: z.boolean().default(false),
    note: z.string().trim().max(500).default(""),
  })
  .strict();
const importSchema = z
  .object({
    storeId: z.string().uuid(),
    sourceName: z.string().trim().min(1).max(120),
    rows: z.array(rowSchema).min(1).max(100),
  })
  .strict();
const cents = (value: string) => {
  const [whole, fraction = ""] = value.split(".");
  return Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
};
function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

export function recordAttribution(
  db: DB,
  room: string,
  viewer: string,
  code: string | undefined,
  now: number,
) {
  if (!code) return;
  db.prepare(
    `INSERT OR IGNORE INTO attribution_visits(room_id,viewer_id,source_code,attributed_at,watch_seconds_baseline)
    SELECT ?,?,s.code,?,v.watch_seconds FROM attribution_sources s JOIN visits v ON v.room_id=s.room_id AND v.viewer_id=? WHERE s.code=? AND s.room_id=? AND s.disabled_at IS NULL AND s.created_at<=?`,
  ).run(room, viewer, now, viewer, code, room, now);
}
export function attachAttribution(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  ownRoom: (id: string, merchant: string) => unknown,
  clock = Date.now,
) {
  const base = "/api/merchant/attribution";
  function storeOwned(id: string, tenant: string) {
    const store = db
      .prepare("SELECT * FROM attribution_stores WHERE id=? AND merchant_id=?")
      .get(id, tenant);
    if (!store) throw new HTTPException(404, { message: "门店不存在" });
    return store;
  }
  function sourceMatch(code: string, store: string, when: number): SourceMatch {
    if (!code) return "missing_source";
    const source = db
      .prepare("SELECT * FROM attribution_sources WHERE code=?")
      .get(code);
    if (!source) return "unknown_source";
    if (source.store_id !== store) return "store_mismatch";
    if (
      when < Number(source.created_at) ||
      (source.disabled_at !== null && when > Number(source.disabled_at))
    )
      return "outside_source_period";
    return "linked_source";
  }
  function preview(
    input: z.infer<typeof importSchema>,
    tenant: string,
  ): ImportPreview {
    storeOwned(input.storeId, tenant);
    const seen = new Set<string>();
    const rows = input.rows.map((row, index) => {
      const key = JSON.stringify([row.kind, row.externalId]);
      const when = Date.parse(row.occurredAt),
        amount = cents(row.amountYuan);
      const matchState = sourceMatch(row.sourceCode, input.storeId, when);
      let action: ImportPreview["rows"][number]["action"] = "new",
        message = "新增记录";
      const current = db
        .prepare(
          "SELECT * FROM offline_records WHERE merchant_id=? AND store_id=? AND kind=? AND external_id=? ORDER BY revision DESC LIMIT 1",
        )
        .get(tenant, input.storeId, row.kind, row.externalId);
      if (seen.has(key)) {
        action = "conflict";
        message = "同一批次存在重复的类型和业务编号";
      } else if (
        when > clock() + 300000 ||
        (row.kind === "visit" && amount !== 0)
      ) {
        action = "conflict";
        message = "发生时间不能晚于当前时间；到店记录金额应为零";
      } else if (
        current &&
        current.source_code === row.sourceCode &&
        current.customer_ref === row.customerRef &&
        current.occurred_at === when &&
        current.amount_cents === amount &&
        current.voided === Number(row.voided) &&
        current.note === row.note
      ) {
        action = "duplicate";
        message = "与当前版本完全相同，将跳过";
      } else if (
        current &&
        current.revision === row.previousVersion &&
        row.note
      ) {
        action = "correction";
        message = `保存修订 V${Number(current.revision) + 1}，原版本保留`;
      } else if (current || row.previousVersion !== 0 || row.voided) {
        action = "conflict";
        message = "修订需填写当前版本号及原因；新增记录不能作废";
      }
      seen.add(key);
      return {
        index: index + 1,
        kind: row.kind,
        amountCents: amount,
        occurredAt: when,
        externalId: row.externalId,
        action,
        message,
        matchState,
      };
    });
    return { canImport: rows.every((row) => row.action !== "conflict"), rows };
  }
  app.get(base + "/stores", (c) =>
    c.json({
      stores: db
        .prepare(
          "SELECT id,name,external_ref AS externalRef,created_at AS createdAt FROM attribution_stores WHERE merchant_id=? ORDER BY created_at,id",
        )
        .all(c.get("merchantId")),
    }),
  );
  app.post(base + "/stores", async (c) => {
    const input = z
      .object({
        name: z.string().trim().min(1).max(100),
        externalRef: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(await c.req.json());
    const tenant = c.get("merchantId"),
      id = randomUUID();
    if (
      db
        .prepare(
          "SELECT id FROM attribution_stores WHERE merchant_id=? AND external_ref=?",
        )
        .get(tenant, input.externalRef)
    )
      conflict("门店编号已存在");
    db.prepare("INSERT INTO attribution_stores VALUES(?,?,?,?,?)").run(
      id,
      tenant,
      input.name,
      input.externalRef,
      clock(),
    );
    return c.json({ store: { id, ...input } }, 201);
  });
  app.get(base + "/sources", (c) => {
    const store = z.string().uuid().parse(c.req.query("storeId"));
    storeOwned(store, c.get("merchantId"));
    return c.json({
      sources: db
        .prepare(
          "SELECT code,store_id AS storeId,room_id AS roomId,label,created_at AS createdAt,disabled_at AS disabledAt FROM attribution_sources WHERE store_id=? ORDER BY created_at DESC,code",
        )
        .all(store),
    });
  });
  app.post(base + "/sources", async (c) => {
    const input = z
      .object({
        storeId: z.string().uuid(),
        roomId: z.string().min(1).max(128),
        label: z.string().trim().min(1).max(100),
      })
      .strict()
      .parse(await c.req.json());
    storeOwned(input.storeId, c.get("merchantId"));
    ownRoom(input.roomId, c.get("merchantId"));
    const code = randomBytes(16).toString("hex"),
      now = clock();
    db.prepare("INSERT INTO attribution_sources VALUES(?,?,?,?,?,NULL)").run(
      code,
      input.storeId,
      input.roomId,
      input.label,
      now,
    );
    return c.json(
      { source: { code, ...input, createdAt: now, disabledAt: null } },
      201,
    );
  });
  app.post(base + "/sources/:code/disable", (c) => {
    const code = z.string().parse(c.req.param("code")),
      source = db
        .prepare("SELECT store_id FROM attribution_sources WHERE code=?")
        .get(code);
    if (!source) throw new HTTPException(404);
    storeOwned(String(source.store_id), c.get("merchantId"));
    db.prepare(
      "UPDATE attribution_sources SET disabled_at=coalesce(disabled_at,?) WHERE code=?",
    ).run(clock(), code);
    return c.json({ ok: true });
  });
  app.post(base + "/imports/preview", async (c) =>
    c.json(
      preview(importSchema.parse(await c.req.json()), c.get("merchantId")),
    ),
  );
  app.post(base + "/imports", async (c) => {
    const {
      idempotencyKey,
      acknowledged: _,
      ...input
    } = importSchema
      .extend({
        idempotencyKey: z.string().min(1).max(100),
        acknowledged: z.literal(true),
      })
      .parse(await c.req.json());
    const tenant = c.get("merchantId"),
      hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const receipt = transaction(db, () => {
      storeOwned(input.storeId, tenant);
      const previous = db
        .prepare(
          "SELECT request_hash,receipt_json FROM offline_batches WHERE merchant_id=? AND idempotency_key=?",
        )
        .get(tenant, idempotencyKey);
      if (previous) {
        if (previous.request_hash !== hash) conflict("该导入编号已有不同内容");
        return JSON.parse(String(previous.receipt_json));
      }
      const check = preview(input, tenant);
      if (!check.canImport) conflict("预览存在冲突，请修正后再导入");
      const batch = randomUUID(),
        now = clock();
      const result = {
        batchId: batch,
        inserted: check.rows.filter((r) => r.action !== "duplicate").length,
        skipped: check.rows.filter((r) => r.action === "duplicate").length,
        unlinked: check.rows.filter(
          (r) => r.matchState !== "linked_source" && r.action !== "duplicate",
        ).length,
      };
      db.prepare("INSERT INTO offline_batches VALUES(?,?,?,?,?,?,?,?,?)").run(
        batch,
        tenant,
        input.storeId,
        idempotencyKey,
        hash,
        input.sourceName,
        c.get("actorId"),
        now,
        JSON.stringify(result),
      );
      input.rows.forEach((row, i) => {
        if (check.rows[i].action === "duplicate") return;
        const revision =
          check.rows[i].action === "new" ? 1 : row.previousVersion + 1;
        db.prepare(
          "INSERT INTO offline_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        ).run(
          randomUUID(),
          tenant,
          input.storeId,
          row.kind,
          row.externalId,
          revision,
          row.sourceCode,
          check.rows[i].matchState === "linked_source" ? row.sourceCode : null,
          check.rows[i].matchState,
          row.customerRef,
          Date.parse(row.occurredAt),
          cents(row.amountYuan),
          Number(row.voided),
          row.note,
          c.get("actorId"),
          now,
          batch,
        );
      });
      return result;
    });
    return c.json({ receipt }, 201);
  });
  app.get(base + "/records", (c) => {
    const store = z.string().uuid().parse(c.req.query("storeId"));
    storeOwned(store, c.get("merchantId"));
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse(c.req.query("before"));
    const rows = db
      .prepare(
        `SELECT r.rowid AS cursor,${columns} FROM offline_records r WHERE r.merchant_id=? AND r.store_id=? AND r.rowid<? AND ${latest} ORDER BY r.rowid DESC LIMIT 101`,
      )
      .all(c.get("merchantId"), store, before ?? Number.MAX_SAFE_INTEGER);
    return c.json({
      records: rows.slice(0, 100),
      nextBefore: rows.length > 100 ? rows[99].cursor : null,
    });
  });
  app.get(base + "/records/:id/history", (c) => {
    const record = db
      .prepare("SELECT * FROM offline_records WHERE id=? AND merchant_id=?")
      .get(z.string().parse(c.req.param("id")), c.get("merchantId"));
    if (!record) throw new HTTPException(404);
    return c.json({
      records: db
        .prepare(
          `SELECT ${columns} FROM offline_records r WHERE merchant_id=? AND store_id=? AND kind=? AND external_id=? ORDER BY revision DESC`,
        )
        .all(
          c.get("merchantId"),
          record.store_id,
          record.kind,
          record.external_id,
        ),
    });
  });
  app.get(base + "/summary", (c) => {
    const stores = db
      .prepare(
        "SELECT id,name FROM attribution_stores WHERE merchant_id=? ORDER BY created_at,id",
      )
      .all(c.get("merchantId"));
    const metrics = stores.map((store) => {
      const online = db
        .prepare(
          `SELECT count(DISTINCT a.viewer_id) AS sourceViewers,coalesce(sum(max(0,v.watch_seconds-a.watch_seconds_baseline)),0) AS watchSeconds FROM attribution_visits a JOIN attribution_sources s ON s.code=a.source_code JOIN visits v ON v.room_id=a.room_id AND v.viewer_id=a.viewer_id WHERE s.store_id=?`,
        )
        .get(store.id)!;
      const offline = db
        .prepare(
          `SELECT coalesce(sum(kind='visit'),0) AS visits,coalesce(sum(kind='order'),0) AS orders,coalesce(sum(CASE WHEN kind='order' THEN amount_cents ELSE 0 END),0) AS salesCents,coalesce(sum(CASE WHEN kind='cost' THEN amount_cents ELSE 0 END),0) AS costCents,coalesce(sum(linked_source_code IS NULL),0) AS unlinkedRecords,coalesce(sum(CASE WHEN kind='order' AND linked_source_code IS NULL THEN amount_cents ELSE 0 END),0) AS unlinkedSalesCents FROM offline_records r WHERE merchant_id=? AND store_id=? AND voided=0 AND ${latest}`,
        )
        .get(c.get("merchantId"), store.id)!;
      return { storeId: store.id, name: store.name, ...online, ...offline };
    });
    return c.json({
      metrics,
      attribution: "first-valid-source-per-room-browser",
      conversionProven: false,
    });
  });
}
