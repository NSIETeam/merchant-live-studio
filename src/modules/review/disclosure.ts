import { disclosureStateQuery1, disclosureStateQuery2 } from "./persistence/disclosure-state-queries.js";
import { disclosureQuery1, disclosureQuery2, disclosureQuery3, disclosureQuery4, disclosureQuery5, disclosureQuery6, disclosureQuery7 } from "./persistence/disclosure-queries.js";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { disclosureSchema, disclosureInDate } from "../../shared/disclosure.js";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { LivePort } from "../../shared/live-ports.js";
export function attachDisclosure(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  live: Pick<LivePort, "room">,
  clock = Date.now,
) {
  const base = "/api/merchant/disclosure";
  const latest = (merchant: string) =>
    disclosureQuery1(db, merchant);
  const event = (merchant: string) =>
    disclosureQuery2(db, merchant);
  const dto = (row: Record<string, any>) => ({
    version: row.version,
    data: JSON.parse(row.data_json),
    evidenceReference: row.evidenceReference,
    authorId: row.authorId,
    createdAt: row.createdAt,
  });
  app.get(base, (c) => {
    const merchant = c.get("merchantId"),
      row = latest(merchant);
    return c.json({
      latest: row ? dto(row) : null,
      publication: event(merchant) || null,
      events: disclosureQuery3(db, merchant),
    });
  });
  app.post(base, async (c) => {
    const input = z
      .object({
        previousVersion: z.number().int().nonnegative(),
        data: disclosureSchema,
        evidenceReference: z.string().trim().min(5).max(1000),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      transaction(db, () => {
        const merchant = c.get("merchantId"),
          previous = latest(merchant);
        if (Number(previous?.version || 0) !== input.previousVersion)
          throw new HTTPException(409, {
            message: "公示资料已更新，请刷新后保存",
          });
        disclosureQuery4(db, merchant, input.previousVersion + 1, JSON.stringify(input.data), input.evidenceReference, c.get("actorId"), clock(), "enterprise");
        return { latest: dto(latest(merchant)!) };
      }),
      201,
    );
  });
  app.post(base + "/:version/review", async (c) => {
    const version = z.coerce
      .number()
      .int()
      .positive()
      .parse(c.req.param("version"));
    const input = z
      .object({
        action: z.enum(["publish", "withdraw"]),
        note: z.string().trim().min(5).max(1000),
        acknowledged: z.literal(true),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      transaction(db, () => {
        const merchant = c.get("merchantId"),
          current = event(merchant),
          draft = latest(merchant);
        if (input.action === "publish") {
          if (!draft || draft.version !== version)
            throw new HTTPException(409, { message: "只能复核发布最新版本" });
          if (!disclosureInDate(JSON.parse(String(draft.data_json)), clock()))
            throw new HTTPException(409, {
              message: "资料已过期或缺少复核截止日期，请保存新版本后重新复核",
            });
          if (draft.authorId === c.get("actorId"))
            throw new HTTPException(403, {
              message: "请由另一账号核对依据后发布",
            });
          if (
            disclosureQuery5(db, merchant, version)
          )
            throw new HTTPException(409, {
              message: "此版本已有发布记录；更正或重新发布请保存新版本",
            });
        } else if (
          !current ||
          current.action !== "publish" ||
          current.version !== version
        )
          throw new HTTPException(409, {
            message: "公示状态已变化，请刷新后撤回",
          });
        disclosureQuery6(db, merchant, version, input.action, c.get("actorId"), input.note, clock());
        return { publication: event(merchant) };
      }),
    );
  });
  app.get("/api/public/rooms/:id/disclosure", (c) => {
    const room = live.room(c.req.param("id"));
    if (!room) throw new HTTPException(404);
    c.header("Cache-Control", "no-store");
    const current = event(String(room.merchant_id));
    if (!current || current.action !== "publish")
      return c.json({ disclosure: null });
    const version = disclosureQuery7(db, room.merchant_id, current.version)!;
    return c.json({
      disclosure: {
        version: current.version,
        publishedAt: current.createdAt,
        data: JSON.parse(String(version.data_json)),
      },
    });
  });
}

export function disclosureState(db: DB, tenant:string, now:number) {
 const publication=disclosureStateQuery1(db, tenant);
 const data=publication?.action==='publish' ? disclosureStateQuery2(db, tenant, publication.version) : undefined;
 return {published:publication?.action==='publish',version:publication ? Number(publication.version):null,valid:!!data && disclosureInDate(JSON.parse(String(data.data_json)),now)};
}
