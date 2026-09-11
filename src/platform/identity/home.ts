import { findHomePreferences, findHomeVersion, upsertHomePreferences } from "./persistence/home-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import {
  homeDestinations,
  homeLayoutSchema,
  type HomePreferences,
} from "../../shared/home.js";
import { transaction } from "../infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
export function attachHome(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  progress: (tenant: string) => { products: number; drafts: number; rooms: number; bindings: number },
) {
  const inputSchema = homeLayoutSchema
    .extend({ version: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) })
    .strict();
  app.get("/api/merchant/home", (c) => {
    const row = findHomePreferences(db, c.get("merchantId"), c.get("actorId"));
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
    c.header("Cache-Control", "no-store");
    return c.json(progress(c.get("merchantId")));
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
      const row = findHomeVersion(db, c.get("merchantId"), c.get("actorId"));
      if (Number(row?.version || 0) !== input.version)
        throw new HTTPException(409, {
          message: "主页已在其他页面修改，请重新载入布局后再调整",
        });
      upsertHomePreferences(db, c.get("merchantId"), c.get("actorId"), JSON.stringify({ modules: input.modules, shortcuts: input.shortcuts }), input.version + 1, Date.now());
    });
    c.header("Cache-Control", "no-store");
    return c.json({ ...input, version: input.version + 1 });
  });
}
