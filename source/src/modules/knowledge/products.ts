import type { Hono } from "hono";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  conflict,
  notFound,
  transaction,
} from "../../platform/infrastructure/public.js";
import type { ProductRow } from "../../shared/content-ports.js";
import {
  CONTENT_LIMITS,
  type ContentProduct,
  type ProductVersion,
} from "../../shared/content.js";
import type { DB } from "../../shared/persistence.js";
import {
  findContentProductsByIdAndMerchantId,
  findContentProductsByMerchantIdAndSku,
  findContentProductsByMerchantIdAndSku2,
  findContentProductVersionsByProductIdAndVersion,
  insertContentProducts,
  insertContentProductVersions,
  insertContentProductVersions2,
  listContentProductsByMerchantId,
  listContentProductsByMerchantId2,
  listContentProductVersionsByProductId,
  updateContentProductsById,
} from "./persistence/products-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const productSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    sku: z.string().trim().min(1).max(80),
    category: z.string().trim().min(1).max(80),
    facts: z
      .array(
        z
          .object({
            id: identifier.optional(),
            text: z.string().trim().min(1).max(400),
            evidence: z.string().trim().min(1).max(500),
            approved: z.boolean(),
          })
          .strict(),
      )
      .max(CONTENT_LIMITS.facts)
      .refine((facts) => {
        const ids = facts.flatMap((fact) => (fact.id ? [fact.id] : []));
        return new Set(ids).size === ids.length;
      }),
  })
  .strict();
const productDto = (r: ProductRow): ContentProduct => ({
  id: r.id,
  name: r.name,
  sku: r.sku,
  category: r.category,
  latestVersion: r.latest_version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});
export function createProductKnowledge(db: DB, clock: () => number = Date.now) {
  function productOwned(id: string, merchant: string): ProductRow {
    return (
      (findContentProductsByIdAndMerchantId(db, id, merchant) as
        ProductRow | undefined) ?? notFound("商品不存在")
    );
  }
  function productVersion(id: string, version: number): ProductVersion {
    const row = findContentProductVersionsByProductIdAndVersion(
      db,
      id,
      version,
    ) as { snapshot_json: string } | undefined;
    return row
      ? (JSON.parse(row.snapshot_json) as ProductVersion)
      : notFound("商品证据版本不存在");
  }
  const productIds = (merchant: string) =>
    listContentProductsByMerchantId(db, merchant).map((r) => String(r.id));
  return {
    productOwned,
    productVersion,
    productDto,
    productIds,
    attach(app: App) {
      app.get("/api/merchant/content/products", (c) =>
        c.json({
          products: (
            listContentProductsByMerchantId2(
              db,
              c.get("merchantId"),
            ) as unknown as ProductRow[]
          ).map(productDto),
        }),
      );
      app.post("/api/merchant/content/products", async (c) => {
        const input = productSchema.parse(await c.req.json()),
          merchant = c.get("merchantId"),
          id = randomUUID(),
          now = clock();
        const version: ProductVersion = {
          ...input,
          version: 1,
          createdAt: now,
          facts: input.facts.map((fact) => ({
            ...fact,
            id: fact.id || randomUUID(),
          })),
        };
        transaction(db, () => {
          if (findContentProductsByMerchantIdAndSku(db, merchant, input.sku))
            conflict("此 SKU 已存在，请打开已有商品建立新证据版本。");
          insertContentProducts(
            db,
            id,
            merchant,
            input.name,
            input.sku,
            input.category,
            now,
            now,
          );
          insertContentProductVersions(db, id, JSON.stringify(version), now);
        });
        return c.json(
          { product: productDto(productOwned(id, merchant)), version },
          201,
        );
      });
      app.get("/api/merchant/content/products/:id", (c) => {
        const product = productOwned(c.req.param("id"), c.get("merchantId"));
        return c.json({
          product: productDto(product),
          versions: (
            listContentProductVersionsByProductId(db, product.id) as {
              snapshot_json: string;
            }[]
          ).map((row) => JSON.parse(row.snapshot_json) as ProductVersion),
        });
      });
      app.post("/api/merchant/content/products/:id/versions", async (c) => {
        const { baseVersion, ...input } = productSchema
            .extend({ baseVersion: z.number().int().positive() })
            .parse(await c.req.json()),
          merchant = c.get("merchantId"),
          id = c.req.param("id");
        const version = transaction(db, () => {
          const current = productOwned(id, merchant);
          if (current.latest_version !== baseVersion)
            conflict(
              "商品资料已由其他操作更新，请刷新后再保存，避免覆盖新内容。",
            );
          if (
            findContentProductsByMerchantIdAndSku2(db, merchant, input.sku, id)
          )
            conflict("此 SKU 已被另一个商品使用。");
          const now = clock(),
            version: ProductVersion = {
              ...input,
              version: baseVersion + 1,
              createdAt: now,
              facts: input.facts.map((fact) => ({
                ...fact,
                id: fact.id || randomUUID(),
              })),
            };
          insertContentProductVersions2(
            db,
            id,
            version.version,
            JSON.stringify(version),
            now,
          );
          updateContentProductsById(
            db,
            input.name,
            input.sku,
            input.category,
            version.version,
            now,
            id,
          );
          return version;
        });
        return c.json(
          { product: productDto(productOwned(id, merchant)), version },
          201,
        );
      });
    },
  };
}
