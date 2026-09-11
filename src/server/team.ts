import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Config } from "./config.js";
import { transaction, type DB } from "./db.js";
export function attachTeam(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  config: Config,
) {
  app.get("/api/merchant/team", (c) =>
    c.json({
      members: Object.entries(config.merchantMemberships || {})
        .filter(([, m]) => m.merchantId === c.get("merchantId"))
        .map(([actorId, m]) => {
          const row = db
            .prepare(
              "SELECT disabled,version FROM team_access WHERE actor_id=?",
            )
            .get(actorId);
          return {
            actorId,
            role: m.role,
            disabled: Boolean(row?.disabled),
            version: Number(row?.version || 0),
          };
        }),
    }),
  );
  app.put("/api/merchant/team/:actorId", async (c) => {
    const actorId = c.req.param("actorId"),
      member = config.merchantMemberships?.[actorId];
    if (
      !member ||
      member.merchantId !== c.get("merchantId") ||
      actorId === c.get("actorId")
    )
      throw new HTTPException(404);
    const input = z
      .object({
        disabled: z.boolean(),
        version: z.number().int().min(0),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    transaction(db, () => {
      const row = db
        .prepare("SELECT version FROM team_access WHERE actor_id=?")
        .get(actorId);
      if (Number(row?.version || 0) !== input.version)
        throw new HTTPException(409, {
          message: "成员状态已改变，请刷新后重试",
        });
      db.prepare(
        "INSERT INTO team_access(actor_id,merchant_id,disabled,version) VALUES(?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET merchant_id=excluded.merchant_id,disabled=excluded.disabled,version=excluded.version",
      ).run(
        actorId,
        member.merchantId,
        Number(input.disabled),
        input.version + 1,
      );
      db.prepare(
        "INSERT INTO team_access_events(merchant_id,target_actor_id,actor_id,disabled,reason,version,created_at) VALUES(?,?,?,?,?,?,?)",
      ).run(
        member.merchantId,
        actorId,
        c.get("actorId"),
        Number(input.disabled),
        input.reason,
        input.version + 1,
        Date.now(),
      );
    });
    return c.json({
      actorId,
      disabled: input.disabled,
      version: input.version + 1,
    });
  });
}
