import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { transaction, type DB } from "./db.js";
import { readScriptReview } from "./script-review.js";
import { CONTENT_LIMITS, type ScriptVersion } from "../shared/content.js";

function fail(status: 403 | 404 | 409, message: string): never {
  throw new HTTPException(status, { message });
}
export function attachScriptSuggestions(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  read: (id: string, version: number, merchant: string) => ScriptVersion,
  save: (id: string, merchant: string, actor: string, value: unknown) => number,
  clock: () => number,
) {
  const base = "/api/merchant/content/courses/:id/scripts/:version/suggestions";
  const versionOf = (v: string) => z.coerce.number().int().positive().parse(v);
  const list = (id: string, version: number) =>
    db
      .prepare(
        `
    SELECT s.id,s.course_id AS courseId,s.script_version AS scriptVersion,s.paragraph_id AS paragraphId,
      s.replacement,s.reason,s.author_id AS authorId,s.created_at AS createdAt,
      r.decision,r.actor_id AS resolvedBy,r.note AS resolutionNote,r.resolved_at AS resolvedAt,r.result_version AS resultVersion
    FROM content_script_suggestions s LEFT JOIN content_suggestion_resolutions r ON r.suggestion_id=s.id
    WHERE s.course_id=? AND s.script_version=? ORDER BY s.created_at,s.id
  `,
      )
      .all(id, version);
  app.get(base, (c) => {
    const id = c.req.param("id"),
      version = versionOf(c.req.param("version"));
    read(id, version, c.get("merchantId"));
    return c.json({ suggestions: list(id, version) });
  });
  app.post(base, async (c) => {
    if (!["owner", "reviewer"].includes(c.get("memberRole")))
      fail(403, "只有审核或管理员账号可以提出审改建议。");
    const input = z
      .object({
        id: z.string().uuid(),
        paragraphId: z.string().min(1).max(128),
        replacement: z
          .string()
          .trim()
          .min(1)
          .max(CONTENT_LIMITS.paragraphCharacters),
        reason: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(await c.req.json());
    const id = c.req.param("id"),
      version = versionOf(c.req.param("version")),
      actor = c.get("actorId");
    transaction(db, () => {
      const script = read(id, version, c.get("merchantId"));
      const existing = db
        .prepare("SELECT * FROM content_script_suggestions WHERE id=?")
        .get(input.id);
      if (existing) {
        if (
          existing.course_id === id &&
          existing.script_version === version &&
          existing.author_id === actor &&
          existing.paragraph_id === input.paragraphId &&
          existing.replacement === input.replacement &&
          existing.reason === input.reason
        )
          return;
        fail(409, "建议编号已使用，请刷新后重试。");
      }
      const review = readScriptReview(db, id, version);
      if (!review.submission || review.decision?.decision === "approved")
        fail(409, "仅待审核或已退回的稿件可以提出修改建议。");
      if (review.authorId === actor || review.submission?.submittedBy === actor)
        fail(403, "请另一审核账号提出独立审改建议。");
      if (
        db
          .prepare(
            "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
          )
          .get(id)!.v !== version
      )
        fail(409, "已有更新稿件，请针对最新提交版提出建议。");
      const paragraph = script.paragraphs.find(
        (p) => p.id === input.paragraphId,
      );
      if (!paragraph) fail(404, "该版本没有此段落。");
      if (paragraph.text === input.replacement)
        fail(409, "建议文本与原文相同。");
      if (list(id, version).length >= 100)
        fail(409, "此版本已达到 100 条建议，请整理后提交新版本。");
      db.prepare(
        "INSERT INTO content_script_suggestions VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        input.id,
        id,
        version,
        input.paragraphId,
        input.replacement,
        input.reason,
        actor,
        clock(),
      );
    });
    return c.json({ suggestions: list(id, version) }, 201);
  });
  app.post("/api/merchant/content/suggestions/:id/resolve", async (c) => {
    if (!["owner", "editor"].includes(c.get("memberRole")))
      fail(403, "只有编辑或管理员账号可以处置建议。");
    const input = z
      .object({
        decision: z.enum(["accepted", "rejected"]),
        note: z.string().trim().min(1).max(2000),
      })
      .strict()
      .parse(await c.req.json());
    const id = c.req.param("id"),
      merchant = c.get("merchantId"),
      actor = c.get("actorId");
    const result = transaction(db, () => {
      const suggestion = db
        .prepare("SELECT * FROM content_script_suggestions WHERE id=?")
        .get(id);
      if (!suggestion) fail(404, "未找到建议。");
      const course = String(suggestion.course_id),
        original = read(course, Number(suggestion.script_version), merchant);
      const existing = db
        .prepare(
          "SELECT * FROM content_suggestion_resolutions WHERE suggestion_id=?",
        )
        .get(id);
      if (existing) {
        if (
          existing.decision === input.decision &&
          existing.actor_id === actor &&
          existing.note === input.note
        )
          return existing.result_version;
        fail(409, "此建议已有不可更改的处置记录。");
      }
      let resultVersion: number | null = null;
      if (input.decision === "accepted") {
        const latest = Number(
          db
            .prepare(
              "SELECT latest_script_version AS v FROM content_courses WHERE id=?",
            )
            .get(course)!.v,
        );
        const current = read(course, latest, merchant);
        const before = original.paragraphs.find(
          (p) => p.id === suggestion.paragraph_id,
        );
        const now = current.paragraphs.find(
          (p) => p.id === suggestion.paragraph_id,
        );
        if (
          original.stale ||
          current.stale ||
          original.productSnapshot.version !== current.productSnapshot.version
        )
          fail(409, "商品依据或规则已变化，请重新核对并提出建议。");
        if (
          !before ||
          !now ||
          before.text !== now.text ||
          before.kind !== now.kind ||
          JSON.stringify([...before.factIds].sort()) !==
            JSON.stringify([...now.factIds].sort())
        )
          fail(
            409,
            "目标段落已修改或删除，不能覆盖；请核对当前稿件后重新提出建议。",
          );
        resultVersion = save(course, merchant, actor, {
          baseVersion: latest,
          productVersion: current.productSnapshot.version,
          paragraphs: current.paragraphs.map((p) =>
            p.id === suggestion.paragraph_id
              ? { ...p, text: String(suggestion.replacement) }
              : p,
          ),
          changeNote: `采纳建议 ${id}（原稿 V${suggestion.script_version}）`,
        });
      }
      db.prepare(
        "INSERT INTO content_suggestion_resolutions VALUES(?,?,?,?,?,?,?)",
      ).run(
        id,
        course,
        input.decision,
        actor,
        input.note,
        clock(),
        resultVersion,
      );
      return resultVersion;
    });
    return c.json({ resultVersion: result });
  });
}
