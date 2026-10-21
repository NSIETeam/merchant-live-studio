import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { LivePort } from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import type { Fact } from "../../shared/types.js";
import { attachMaterials } from "./materials.js";
import {
  findFactsById,
  insertFacts,
  listFactsByRoomId,
  updateFactsById,
} from "./persistence/facts-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
type FactRow = {
  id: string;
  room_id: string;
  text: string;
  evidence: string;
  approved: number;
};
export function createRoomKnowledge(
  db: DB,
  live: () => LivePort,
  clock: () => number = Date.now,
) {
  const owned: LivePort["owned"] = (...args) => live().owned(...args);
  const factsFor = (id: string): Fact[] =>
    (listFactsByRoomId(db, id) as FactRow[]).map((f) => ({
      id: f.id,
      roomId: f.room_id,
      text: f.text,
      evidence: f.evidence,
      approved: Boolean(f.approved),
    }));
  return {
    factsFor,
    seedFacts(roomId: string) {
      insertFacts(
        db,
        randomUUID(),
        roomId,
        "容量为 500 mL",
        "演示产品标签（示例数据，非真实商品凭证）",
        1,
      );
      insertFacts(
        db,
        randomUUID(),
        roomId,
        "杯盖采用旋拧结构",
        "演示产品说明书（示例数据，非真实商品凭证）",
        1,
      );
      insertFacts(
        db,
        randomUUID(),
        roomId,
        "保温时长可达 12 小时",
        "待补充检测报告：暂未审核",
        0,
      );
    },
    attach(app: App) {
      app.get("/api/merchant/rooms/:id/facts", (c) => {
        owned(c.req.param("id"), c.get("merchantId"));
        return c.json({ facts: factsFor(c.req.param("id")) });
      });
      app.post("/api/merchant/rooms/:id/facts", async (c) => {
        const r = owned(c.req.param("id"), c.get("merchantId"));
        const input = z
          .object({
            text: z.string().trim().min(1).max(400),
            evidence: z.string().trim().min(1).max(500),
            approved: z.boolean().default(false),
          })
          .parse(await c.req.json());
        insertFacts(
          db,
          randomUUID(),
          r.id,
          input.text,
          input.evidence,
          Number(input.approved),
        );
        return c.json({ facts: factsFor(r.id) }, 201);
      });
      app.patch("/api/merchant/facts/:id", async (c) => {
        const f = findFactsById(db, c.req.param("id")) as
          { room_id: string } | undefined;
        if (!f) throw new HTTPException(404);
        owned(f.room_id, c.get("merchantId"));
        const input = z
          .object({ approved: z.boolean() })
          .parse(await c.req.json());
        updateFactsById(db, Number(input.approved), c.req.param("id"));
        return c.json({ ok: true });
      });
      attachMaterials(app, db, owned, factsFor, clock);
    },
  };
}
