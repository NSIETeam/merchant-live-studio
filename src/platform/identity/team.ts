import { findTeamAccess, listTeamAccessEvents, findTeamAccessVersion, upsertTeamAccess, updateTeamRole, insertTeamAccessEvent } from "./persistence/team-queries.js";
import { merchantIdentity } from "./permissions.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { Config } from "../infrastructure/public.js";
import { transaction } from "../infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
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
          const row = findTeamAccess(db, actorId);
          return {
            actorId,
            role: merchantIdentity(config, actorId, db).memberRole,
            disabled: Boolean(row?.disabled),
            version: Number(row?.version || 0),
          };
        }),
    }),
  );
  app.get("/api/merchant/team/events", (c) => {
    const before = z.coerce
      .number()
      .int()
      .positive()
      .max(Number.MAX_SAFE_INTEGER)
      .parse(c.req.query("before") || Number.MAX_SAFE_INTEGER);
    const rows = listTeamAccessEvents(db, c.get("merchantId"), before);
    c.header("Cache-Control", "no-store");
    return c.json({
      items: rows.slice(0, 50),
      nextBefore: rows.length > 50 ? rows[49].id : null,
    });
  });
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
        role: z.enum(["editor", "reviewer", "presenter", "analyst"]).optional(),
        version: z.number().int().min(0),
        reason: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    const previousRole = merchantIdentity(config, actorId, db).memberRole;
    const nextRole = input.role ?? previousRole;
    transaction(db, () => {
      const row = findTeamAccessVersion(db, actorId);
      if (Number(row?.version || 0) !== input.version)
        throw new HTTPException(409, {
          message: "成员状态已改变，请刷新后重试",
        });
      upsertTeamAccess(db, actorId, member.merchantId, Number(input.disabled), input.version + 1);
      updateTeamRole(db, nextRole, member.role, actorId);
      insertTeamAccessEvent(db, member.merchantId, actorId, c.get("actorId"), Number(input.disabled), input.reason, input.version + 1, Date.now(), previousRole, nextRole);
    });
    return c.json({
      actorId,
      role: nextRole,
      disabled: input.disabled,
      version: input.version + 1,
    });
  });
}
