import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
import type {
  MaterialInput,
  MaterialPreview,
  MaterialBatch,
} from "../shared/training.js";
import type { Fact } from "../shared/types.js";

const materialSchema = z
  .object({
    sourceName: z.string().trim().min(1).max(120),
    format: z.enum(["csv", "json"]),
    content: z
      .string()
      .min(1)
      .refine(
        (s) => Buffer.byteLength(s, "utf8") <= 24 * 1024,
        "文件不得超过 24 KiB",
      ),
  })
  .strict();
const rowSchema = z
  .object({
    text: z.string().trim().min(1).max(400),
    evidence: z.string().trim().min(1).max(500),
  })
  .strict();
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bad = (message: string): never => {
  throw new HTTPException(400, { message });
};

// Parse quoted fields locally. Contents and source labels are never executed or fetched.
function csvRows(source: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    closed = false;
  const pushField = () => {
    row.push(field);
    field = "";
    closed = false;
  };
  const pushRow = () => {
    pushField();
    if (row.some((v) => v.trim())) rows.push(row);
    row = [];
  };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quoted) {
      if (c === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
          closed = true;
        }
      } else field += c;
    } else if (c === ",") pushField();
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && source[i + 1] === "\n") i++;
      pushRow();
    } else if (c === '"') {
      if (field || closed) bad("CSV 引号位置不正确，请使用下载的模板。");
      quoted = true;
    } else {
      if (closed) bad("CSV 引号后的内容不正确，请检查分隔符。");
      field += c;
    }
  }
  if (quoted) bad("CSV 中有未闭合的引号。");
  if (field || row.length || closed) pushRow();
  return rows;
}
export function parseMaterials(
  input: MaterialInput,
): { text: string; evidence: string }[] {
  const content = input.content.replace(/^\uFEFF/, "");
  let raw: unknown;
  if (input.format === "json") {
    try {
      raw = JSON.parse(content);
    } catch {
      bad("JSON 内容无法读取，请使用事实与依据模板。");
    }
  } else {
    const rows = csvRows(content);
    const headers = rows.shift()?.map((v) => v.trim());
    if (
      !headers ||
      headers.length !== 2 ||
      new Set(headers).size !== 2 ||
      !headers.includes("text") ||
      !headers.includes("evidence")
    )
      bad("CSV 表头应为 text,evidence；审核状态必须在导入后单独确认。");
    raw = rows.map((row, index) => {
      if (row.length !== 2) bad(`第 ${index + 2} 行列数不正确。`);
      return {
        text: row[headers!.indexOf("text")],
        evidence: row[headers!.indexOf("evidence")],
      };
    });
  }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 40)
    bad("每批需包含 1–40 条资料，请分批导入。");
  return (raw as unknown[]).map((row, index) => {
    const parsed = rowSchema.safeParse(row);
    if (!parsed.success)
      bad(
        `第 ${index + 1} 条资料需要事实与依据（最多 400 / 500 字），且不能含审核状态或其他字段。`,
      );
    return parsed.data!;
  });
}
type BatchRow = {
  id: string;
  source_name: string;
  format: MaterialInput["format"];
  content_hash: string;
  request_hash: string;
  created_at: number;
  imported_count: number;
  skipped_count: number;
  fact_ids_json: string;
};
const dto = (r: BatchRow): MaterialBatch => ({
  id: r.id,
  sourceName: r.source_name,
  format: r.format,
  contentHash: r.content_hash,
  createdAt: r.created_at,
  importedCount: r.imported_count,
  skippedCount: r.skipped_count,
  factIds: JSON.parse(r.fact_ids_json),
});
export function attachMaterials(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  owned: (id: string, tenant: string) => unknown,
  factsFor: (id: string) => Fact[],
  clock: () => number,
) {
  const preview = (roomId: string, input: MaterialInput): MaterialPreview => {
    const seen = new Set(
      factsFor(roomId).map((f) => JSON.stringify([f.text, f.evidence])),
    );
    const rows = parseMaterials(input).map((r, index) => {
      const key = JSON.stringify([r.text, r.evidence]),
        duplicate = seen.has(key);
      seen.add(key);
      return { row: index + 1, ...r, duplicate };
    });
    return {
      sourceName: input.sourceName,
      format: input.format,
      contentHash: hash(input.content),
      rows,
      duplicateCount: rows.filter((r) => r.duplicate).length,
      warnings: [
        "导入只建立待审核事实；来源描述与公开网页本身不构成事实真实性的证明。",
      ],
    };
  };
  app.get("/api/merchant/rooms/:id/materials", (c) => {
    const roomId = c.req.param("id");
    owned(roomId, c.get("merchantId"));
    const batches = db
      .prepare(
        "SELECT * FROM material_imports WHERE room_id=? ORDER BY created_at DESC,rowid DESC LIMIT 50",
      )
      .all(roomId) as BatchRow[];
    return c.json({ batches: batches.map(dto) });
  });
  app.post("/api/merchant/rooms/:id/materials/preview", async (c) => {
    const roomId = c.req.param("id");
    owned(roomId, c.get("merchantId"));
    return c.json({
      preview: preview(roomId, materialSchema.parse(await c.req.json())),
    });
  });
  app.post("/api/merchant/rooms/:id/materials/import", async (c) => {
    const roomId = c.req.param("id");
    owned(roomId, c.get("merchantId"));
    const body = materialSchema
      .extend({ idempotencyKey: z.string().min(8).max(100) })
      .parse(await c.req.json());
    const { idempotencyKey, ...input } = body,
      requestHash = hash(JSON.stringify(input));
    const batch = transaction(db, () => {
      const prior = db
        .prepare(
          "SELECT * FROM material_imports WHERE room_id=? AND idempotency_key=?",
        )
        .get(roomId, idempotencyKey) as BatchRow | undefined;
      if (prior) {
        if (prior.request_hash !== requestHash)
          throw new HTTPException(409, {
            message: "这个导入请求已用于其他内容，请重新预览后再导入。",
          });
        return dto(prior);
      }
      const parsed = preview(roomId, input);
      const factIds: string[] = [];
      for (const r of parsed.rows) {
        if (r.duplicate) continue;
        const id = randomUUID();
        db.prepare(
          "INSERT INTO facts(id,room_id,text,evidence,approved) VALUES(?,?,?,?,0)",
        ).run(id, roomId, r.text, r.evidence);
        factIds.push(id);
      }
      const id = randomUUID(),
        createdAt = clock();
      db.prepare(
        "INSERT INTO material_imports VALUES(?,?,?,?,?,?,?,?,?,?,?)",
      ).run(
        id,
        roomId,
        input.sourceName,
        input.format,
        parsed.contentHash,
        requestHash,
        idempotencyKey,
        createdAt,
        factIds.length,
        parsed.duplicateCount,
        JSON.stringify(factIds),
      );
      return {
        id,
        sourceName: input.sourceName,
        format: input.format,
        contentHash: parsed.contentHash,
        createdAt,
        importedCount: factIds.length,
        skippedCount: parsed.duplicateCount,
        factIds,
      };
    });
    return c.json({ batch, facts: factsFor(roomId) }, 201);
  });
}
