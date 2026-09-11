import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { transaction } from "../../platform/infrastructure/public.js";
import type { ContentPort } from "../../shared/content-ports.js";
import type { ScriptVersion } from "../../shared/content.js";
import type { DB } from "../../shared/persistence.js";
import {
  findContentReviewDecisionsByCourseIdAndScriptVersion,
  findContentReviewRequestsByCourseIdAndScriptVersion,
  findContentScriptSuggestionsByCourseIdAndScriptVersion,
  insertContentReviewDecisions,
  insertContentReviewRequests,
  listContentReviewRequestsByCourseId,
} from "./persistence/script-review-queries.js";

export function readScriptReview(
  db: DB,
  courseId: string,
  version: number,
  content: ContentPort,
) {
  const author = { actor_id: content.author(courseId, version) };
  const submission = findContentReviewRequestsByCourseIdAndScriptVersion(
    db,
    courseId,
    version,
  ) as { submittedBy: string; submittedAt: number; note: string } | undefined;
  const decision = findContentReviewDecisionsByCourseIdAndScriptVersion(
    db,
    courseId,
    version,
  ) as
    | {
        reviewerId: string;
        reviewedAt: number;
        decision: "approved" | "changes_requested";
        note: string;
      }
    | undefined;
  return {
    authorId: author.actor_id === null ? null : String(author.actor_id),
    submission: submission ?? null,
    decision: decision ?? null,
  };
}
export function attachScriptReview(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  read: (course: string, version: number, merchant: string) => ScriptVersion,
  clock: () => number,
  content: ContentPort,
) {
  function pendingQueue(merchant: string, after: string, limit: number) {
    const candidates = new Map(
      content.reviewCandidates(merchant).map((row) => [row.courseId, row]),
    );
    const rows = listContentReviewRequestsByCourseId(db, after);
    return rows
      .flatMap((row) => {
        const course = candidates.get(String(row.course_id));
        return course && course.version === row.script_version
          ? [
              {
                ...course,
                submittedBy: String(row.submitted_by),
                submittedAt: Number(row.submitted_at),
                note: String(row.note),
              },
            ]
          : [];
      })
      .slice(0, limit);
  }
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
    const rows = pendingQueue(c.get("merchantId"), after ?? "", limit + 1);
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
    return c.json({
      review: readScriptReview(db, c.req.param("id"), version, content),
    });
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
          review = readScriptReview(db, id, version, content);
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
        const latest = { version: content.latest(id) }!;
        if (latest.version !== version)
          throw new HTTPException(409, {
            message: "已有更新的讲稿，请提交最新版本。",
          });
        insertContentReviewRequests(db, id, version, actor, clock(), note);
      });
      return c.json({
        review: readScriptReview(db, id, version, content),
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
          review = readScriptReview(db, id, version, content);
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
        if ({ version: content.latest(id) }!.version !== version)
          throw new HTTPException(409, {
            message: "稿件已更新，请审核最新提交的版本。",
          });
        if (
          input.decision === "approved" &&
          findContentScriptSuggestionsByCourseIdAndScriptVersion(
            db,
            id,
            version,
          )!.n
        )
          throw new HTTPException(409, {
            message:
              "此版本还有未处置的逐条建议，请先由编辑采纳或拒绝后再审核。",
          });
        if (
          input.decision === "approved" &&
          (script.stale || script.check.blockingCount)
        )
          throw new HTTPException(409, {
            message: "依据过期或存在阻断项，不能批准定稿。",
          });
        insertContentReviewDecisions(
          db,
          id,
          version,
          actor,
          clock(),
          input.decision,
          input.note,
        );
      });
      return c.json({
        review: readScriptReview(db, id, version, content),
        script: read(id, version, c.get("merchantId")),
      });
    },
  );
}
