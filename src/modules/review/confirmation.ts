import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { conflict, transaction } from "../../platform/infrastructure/public.js";
import type { ContentPort, ReviewPort } from "../../shared/content-ports.js";
import type { DB } from "../../shared/persistence.js";
import { insertContentScriptConfirmations } from "./persistence/confirmation-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;

export function attachConfirmation(
  app: App,
  db: DB,
  content: ContentPort,
  review: ReviewPort,
  clock: () => number,
) {
  const scriptVersion = content.scriptVersion;
  const readScriptReview = review.readScriptReview;
  app.post(
    "/api/merchant/content/courses/:id/scripts/:version/confirm",
    async (c) => {
      if (c.get("requireIndependentReview"))
        throw new HTTPException(409, {
          message: "此工作空间要求独立审核，请提交审核并由另一审核账号确认。",
        });
      const input = z
        .object({
          note: z.string().trim().min(1).max(1000),
          acknowledged: z.literal(true),
        })
        .strict()
        .parse(await c.req.json());
      const merchant = c.get("merchantId"),
        id = c.req.param("id"),
        version = z.coerce
          .number()
          .int()
          .positive()
          .parse(c.req.param("version"));
      transaction(db, () => {
        const script = scriptVersion(id, version, merchant);
        if (readScriptReview(id, version).submission)
          conflict("此稿已进入独立审核流程，不能改用本人确认。");
        if (script.stale)
          conflict(
            "商品依据或检查规则已变化；请用当前证据保存新的讲稿版本并重新检查。",
          );
        if (script.check.blockingCount)
          conflict("讲稿存在阻断项，需要修改并保存新版本后再定稿。");
        if (!script.confirmation)
          insertContentScriptConfirmations(
            db,
            id,
            version,
            clock(),
            merchant,
            input.note,
          );
      });
      return c.json({ script: scriptVersion(id, version, merchant) });
    },
  );
}
