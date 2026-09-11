import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  homeDestinations,
  homeLayoutSchema,
  type HomePreferences,
} from "../shared/home.js";
import { transaction, type DB } from "./db.js";
export function attachHome(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
) {
  const inputSchema = homeLayoutSchema
    .extend({ version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
    .strict();
  app.get("/api/merchant/home", (c) => {
    const row = db
      .prepare(
        "SELECT layout_json,version FROM home_preferences WHERE merchant_id=? AND actor_id=?",
      )
      .get(c.get("merchantId"), c.get("actorId"));
    const allowed = homeDestinations(c.get("memberRole"));
    const layout = row
      ? homeLayoutSchema.parse(JSON.parse(String(row.layout_json)))
      : {
          modules:
            c.get("memberRole") === "analyst"
              ? (["shortcuts", "rooms"] as const)
              : (["shortcuts", "rooms", "setup"] as const),
          shortcuts: allowed,
        };
    c.header("Cache-Control", "no-store");
    return c.json({
      modules: layout.modules.filter(
        (id) =>
          id === "shortcuts" ||
          id === "rooms" ||
          (id === "setup"
            ? c.get("memberRole") !== "analyst"
            : allowed.includes(id)),
      ),
      shortcuts: layout.shortcuts.filter((id) => allowed.includes(id)),
      version: Number(row?.version || 0),
    } satisfies HomePreferences);
  });
  app.get("/api/merchant/home/progress", (c) => {
    const merchant = c.get("merchantId");
    const count = (sql: string) => Number(db.prepare(sql).get(merchant)!.n);
    c.header("Cache-Control", "no-store");
    return c.json({
      products: count(
        "SELECT count(*) AS n FROM content_products WHERE merchant_id=?",
      ),
      drafts: count(
        "SELECT count(*) AS n FROM content_courses c JOIN content_plans p ON p.id=c.plan_id JOIN content_products x ON x.id=p.product_id WHERE x.merchant_id=? AND c.latest_script_version>0",
      ),
      rooms: count("SELECT count(*) AS n FROM rooms WHERE merchant_id=?"),
      bindings: count(
        "SELECT count(*) AS n FROM content_room_bindings b JOIN rooms r ON r.id=b.room_id WHERE r.merchant_id=?",
      ),
    });
  });
  app.put("/api/merchant/home", async (c) => {
    const input = inputSchema.parse(await c.req.json());
    const allowed = homeDestinations(c.get("memberRole"));
    if (
      input.modules.some(
        (id) =>
          id !== "shortcuts" &&
          id !== "rooms" &&
          (id === "setup"
            ? c.get("memberRole") === "analyst"
            : !allowed.includes(id)),
      ) ||
      input.shortcuts.some((id) => !allowed.includes(id))
    )
      throw new HTTPException(403, { message: "布局包含当前账号不可用的功能" });
    transaction(db, () => {
      const row = db
        .prepare(
          "SELECT version FROM home_preferences WHERE merchant_id=? AND actor_id=?",
        )
        .get(c.get("merchantId"), c.get("actorId"));
      if (Number(row?.version || 0) !== input.version)
        throw new HTTPException(409, {
          message: "主页已在其他页面修改，请重新载入布局后再调整",
        });
      db.prepare(
        "INSERT INTO home_preferences(merchant_id,actor_id,layout_json,version,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(merchant_id,actor_id) DO UPDATE SET layout_json=excluded.layout_json,version=excluded.version,updated_at=excluded.updated_at",
      ).run(
        c.get("merchantId"),
        c.get("actorId"),
        JSON.stringify({ modules: input.modules, shortcuts: input.shortcuts }),
        input.version + 1,
        Date.now(),
      );
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...input, version: input.version + 1 });
  });
}
