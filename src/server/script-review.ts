import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { type DB, transaction } from "./db.js";
import type { ScriptVersion } from "../shared/content.js";

export function readScriptReview(db: DB, courseId: string, version: number) {
  const author = db
    .prepare(
      "SELECT actor_id FROM content_script_authors WHERE course_id=? AND script_version=?",
    )
    .get(courseId, version);
  const submission = db
    .prepare(
      "SELECT submitted_by AS submittedBy,submitted_at AS submittedAt,note FROM content_review_requests WHERE course_id=? AND script_version=?",
    )
    .get(courseId, version) as
    { submittedBy: string; submittedAt: number; note: string } | undefined;
  const decision = db
    .prepare(
      "SELECT reviewer_id AS reviewerId,reviewed_at AS reviewedAt,decision,note FROM content_review_decisions WHERE course_id=? AND script_version=?",
    )
    .get(courseId, version) as
    | {
        reviewerId: string;
        reviewedAt: number;
        decision: "approved" | "changes_requested";
        note: string;
      }
    | undefined;
  return {
    authorId: author ? String(author.actor_id) : null,
    submission: submission ?? null,
    decision: decision ?? null,
  };
}
export function attachScriptReview(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  read: (course: string, version: number, merchant: string) => ScriptVersion,
  clock: () => number,
) {
  // Keyset pagination remains stable when another reviewer removes a pending row.
  app.get("/api/merchant/content/review-queue", (c) => {
    const after = z.string().max(200).optional().parse(c.req.query("after"));
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(50)
      .default(20)
      .parse(c.req.query("limit"));
    const rows = db
      .prepare(
        `
      SELECT c.id AS courseId,c.title AS courseTitle,p.name AS productName,
        r.script_version AS version,r.submitted_by AS submittedBy,
        r.submitted_at AS submittedAt,r.note
      FROM content_review_requests r
      JOIN content_courses c ON c.id=r.course_id AND c.latest_script_version=r.script_version
      JOIN content_plans plan ON plan.id=c.plan_id
      JOIN content_products p ON p.id=plan.product_id
      LEFT JOIN content_review_decisions d ON d.course_id=r.course_id AND d.script_version=r.script_version
      WHERE p.merchant_id=? AND d.course_id IS NULL AND c.id>?
      ORDER BY c.id LIMIT ?
    `,
      )
      .all(c.get("merchantId"), after ?? "", limit + 1);
    const items = rows.slice(0, limit);
    return c.json({
      items,
      nextAfter: rows.length > limit ? items.at(-1)!.courseId : null,
    });
  });
  app.get("/api/merchant/content/courses/:id/scripts/:version", (c) => {
    return c.json({
      script: read(
        c.req.param("id"),
        versionFor(c.req.param("version")),
        c.get("merchantId"),
      ),
    });
  });
  const versionFor = (value: string) =>
    z.coerce.number().int().positive().parse(value);
  const noteSchema = z
    .object({ note: z.string().trim().min(1).max(2000) })
    .strict();
  app.get("/api/merchant/content/courses/:id/scripts/:version/review", (c) => {
    const version = versionFor(c.req.param("version"));
    read(c.req.param("id"), version, c.get("merchantId"));
    return c.json({ review: readScriptReview(db, c.req.param("id"), version) });
  });
  app.post(
    "/api/merchant/content/courses/:id/scripts/:version/submit",
    async (c) => {
      const { note } = noteSchema.parse(await c.req.json()),
        id = c.req.param("id"),
        version = versionFor(c.req.param("version")),
        actor = c.get("actorId");
      transaction(db, () => {
        const script = read(id, version, c.get("merchantId")),
          review = readScriptReview(db, id, version);
        if (!review.authorId)
          throw new HTTPException(409, {
            message: "旧稿尚无保存者记录，请先保存新版本再提交独立审核。",
          });
        if (script.stale || script.check.blockingCount)
          throw new HTTPException(409, {
            message: "请先处理过期依据和阻断项，再提交审核。",
          });
        if (review.submission) {
          if (review.decision)
            throw new HTTPException(409, {
              message: "此版本已有审核决定，请修改并保存新版本后再次提交。",
            });
          return;
        }
        const latest = db
          .prepare(
            "SELECT latest_script_version AS version FROM content_courses WHERE id=?",
          )
          .get(id)!;
        if (latest.version !== version)
          throw new HTTPException(409, {
            message: "已有更新的讲稿，请提交最新版本。",
          });
        db.prepare("INSERT INTO content_review_requests VALUES(?,?,?,?,?)").run(
          id,
          version,
          actor,
          clock(),
          note,
        );
      });
      return c.json({
        review: readScriptReview(db, id, version),
        script: read(id, version, c.get("merchantId")),
      });
    },
  );
  app.post(
    "/api/merchant/content/courses/:id/scripts/:version/review",
    async (c) => {
      if (!["owner", "reviewer"].includes(c.get("memberRole")))
        throw new HTTPException(403, {
          message: "只有审核或管理员账号可以作出审核决定。",
        });
      const input = noteSchema
        .extend({
          decision: z.enum(["approved", "changes_requested"]),
          acknowledged: z.literal(true),
        })
        .parse(await c.req.json());
      const id = c.req.param("id"),
        version = versionFor(c.req.param("version")),
        actor = c.get("actorId");
      transaction(db, () => {
        const script = read(id, version, c.get("merchantId")),
          review = readScriptReview(db, id, version);
        if (!review.submission || !review.authorId)
          throw new HTTPException(409, { message: "该讲稿尚未提交独立审核。" });
        if (
          actor === review.authorId ||
          actor === review.submission.submittedBy
        )
          throw new HTTPException(403, {
            message:
              "保存或提交此稿的账号不能审核自己的稿件，请由另一审核账号操作。",
          });
        if (review.decision) {
          if (
            review.decision.decision === input.decision &&
            review.decision.note === input.note &&
            review.decision.reviewerId === actor
          )
            return;
          throw new HTTPException(409, {
            message: "此版本已有不可更改的审核决定；后续修改必须建立新版本。",
          });
        }
        if (
          db
            .prepare(
              "SELECT latest_script_version AS version FROM content_courses WHERE id=?",
            )
            .get(id)!.version !== version
        )
          throw new HTTPException(409, {
            message: "稿件已更新，请审核最新提交的版本。",
          });
        if (
          input.decision === "approved" &&
          (script.stale || script.check.blockingCount)
        )
          throw new HTTPException(409, {
            message: "依据过期或存在阻断项，不能批准定稿。",
          });
        db.prepare(
          "INSERT INTO content_review_decisions VALUES(?,?,?,?,?,?)",
        ).run(id, version, actor, clock(), input.decision, input.note);
      });
      return c.json({
        review: readScriptReview(db, id, version),
        script: read(id, version, c.get("merchantId")),
      });
    },
  );
}
