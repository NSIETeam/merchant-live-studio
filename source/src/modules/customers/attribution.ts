import { customerQuery1, customerQuery2, customerQuery3, customerQuery4, customerQuery5, customerQuery6, customerQuery7, customerQuery8, customerQuery9, customerQuery10, customerQuery11, customerQuery12, customerQuery13, customerQuery14, customerQuery15, customerQuery16, customerQuery17, customerQuery18, customerQuery19, customerQuery20 } from "./persistence/attribution-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { z } from "zod";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { ImportPreview, SourceMatch } from "../../shared/attribution.js";
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

export function createCustomers(
  db: DB,
  ownRoom: (id: string, merchant: string) => unknown,
  clock = Date.now,
) {
  const base = "/api/merchant/attribution";
  function storeOwned(id: string, tenant: string) {
    const store = customerQuery1(db, id, tenant);
    if (!store) throw new HTTPException(404, { message: "门店不存在" });
    return store;
  }
  function sourceMatch(code: string, store: string, when: number): SourceMatch {
    if (!code) return "missing_source";
    const source = customerQuery2(db, code);
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
      const current = customerQuery3(db, tenant, input.storeId, row.kind, row.externalId);
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
  return {
    validSource(code: string, room: string, now: number) { return !!customerQuery4(db, code, room, now); },
    stores(tenant: string) { return customerQuery5(db, tenant); },
    sourceCodes(store: string) { return customerQuery6(db, store).map(r=>String(r.code)); },
    offlineMetrics(tenant: string, store: string) { return customerQuery7(db, tenant, store)!; },
    attach(app: Hono<{ Variables: { merchantId: string; viewerId: string } }>) {
  app.get(base + "/stores", (c) =>
    c.json({
      stores: customerQuery8(db, c.get("merchantId")),
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
      customerQuery9(db, tenant, input.externalRef)
    )
      conflict("门店编号已存在");
    customerQuery10(db, id, tenant, input.name, input.externalRef, clock());
    return c.json({ store: { id, ...input } }, 201);
  });
  app.get(base + "/sources", (c) => {
    const store = z.string().uuid().parse(c.req.query("storeId"));
    storeOwned(store, c.get("merchantId"));
    return c.json({
      sources: customerQuery11(db, store),
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
    customerQuery12(db, code, input.storeId, input.roomId, input.label, now);
    return c.json(
      { source: { code, ...input, createdAt: now, disabledAt: null } },
      201,
    );
  });
  app.post(base + "/sources/:code/disable", (c) => {
    const code = z.string().parse(c.req.param("code")),
      source = customerQuery13(db, code);
    if (!source) throw new HTTPException(404);
    storeOwned(String(source.store_id), c.get("merchantId"));
    customerQuery14(db, clock(), code);
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
      const previous = customerQuery15(db, tenant, idempotencyKey);
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
      customerQuery16(db, batch, tenant, input.storeId, idempotencyKey, hash, input.sourceName, c.get("actorId"), now, JSON.stringify(result));
      input.rows.forEach((row, i) => {
        if (check.rows[i].action === "duplicate") return;
        const revision =
          check.rows[i].action === "new" ? 1 : row.previousVersion + 1;
        customerQuery17(db, randomUUID(), tenant, input.storeId, row.kind, row.externalId, revision, row.sourceCode, check.rows[i].matchState === "linked_source" ? row.sourceCode : null, check.rows[i].matchState, row.customerRef, Date.parse(row.occurredAt), cents(row.amountYuan), Number(row.voided), row.note, c.get("actorId"), now, batch);
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
    const rows = customerQuery18(db, c.get("merchantId"), store, before ?? Number.MAX_SAFE_INTEGER);
    return c.json({
      records: rows.slice(0, 100),
      nextBefore: rows.length > 100 ? rows[99].cursor : null,
    });
  });
  app.get(base + "/records/:id/history", (c) => {
    const record = customerQuery19(db, z.string().parse(c.req.param("id")), c.get("merchantId"));
    if (!record) throw new HTTPException(404);
    return c.json({
      records: customerQuery20(db, c.get("merchantId"), record.store_id, record.kind, record.external_id),
    });
  });

    },
  };
}
