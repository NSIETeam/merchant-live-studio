import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AgentBridge } from "../../platform/adapters/public.js";
import { transaction } from "../../platform/infrastructure/public.js";
import type {
  GenerationInput,
  GenerationJob,
  GenerationSummary,
} from "../../shared/generation.js";
import type { DB } from "../../shared/persistence.js";
import {
  findContentGenerationImportsByMerchantIdAndJobId,
  insertContentGenerationImports,
} from "./persistence/generation-queries.js";

type Basis = Omit<
  GenerationInput,
  | "profileId"
  | "promptVersion"
  | "idempotencyKey"
  | "targetCharacters"
  | "chapterCount"
>;
export function attachContentGeneration(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  bridge: AgentBridge,
  basis: (id: string, merchant: string) => Basis,
  save: (id: string, merchant: string, actor: string, value: unknown) => number,
  clock: () => number,
) {
  const base = "/api/merchant/content/courses/:id/generation";
  const options = z
    .object({
      profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/),
      promptVersion: z.number().int().positive(),
      idempotencyKey: z.string().min(1).max(200),
      targetCharacters: z.number().int().min(500).max(12000),
      chapterCount: z.number().int().min(2).max(8),
    })
    .strict();
  const endpoint = (id: string) =>
    `/v1/generation/jobs/${encodeURIComponent(id)}`;
  function importReceipt(merchant: string, job: string) {
    return findContentGenerationImportsByMerchantIdAndJobId(db, merchant, job);
  }
  app.get(base, async (c) => {
    basis(c.req.param("id"), c.get("merchantId"));
    const before = z.coerce
      .number()
      .int()
      .positive()
      .optional()
      .parse(c.req.query("before"));
    const tenant = c.get("merchantId");
    const [data, status] = await Promise.all([
      bridge.request<{ jobs: GenerationSummary[]; nextBefore: number | null }>(
        tenant,
        `/v1/generation/jobs?courseId=${encodeURIComponent(c.req.param("id"))}${before ? `&before=${before}` : ""}`,
      ),
      bridge.request<{ configured: boolean }>(tenant, "/v1/generation/status"),
    ]);
    return c.json({
      ...data,
      ...status,
      imports: data.jobs.map((job) => ({
        jobId: job.id,
        receipt: importReceipt(tenant, job.id) || null,
      })),
    });
  });
  app.post(base, async (c) => {
    const input = options.parse(await c.req.json());
    return c.json(
      await bridge.request(c.get("merchantId"), "/v1/generation/jobs", "POST", {
        ...basis(c.req.param("id"), c.get("merchantId")),
        ...input,
      }),
      202,
    );
  });
  app.get(base + "/:jobId", async (c) => {
    const course = z.string().parse(c.req.param("id")),
      jobId = z.string().parse(c.req.param("jobId")),
      merchant = c.get("merchantId");
    basis(course, merchant);
    const result = await bridge.request<{ job: GenerationJob }>(
      merchant,
      endpoint(jobId),
    );
    if (result.job.courseId !== course) throw new HTTPException(404);
    return c.json(result);
  });
  app.post(base + "/:jobId/:action", async (c) => {
    const merchant = c.get("merchantId"),
      course = z.string().parse(c.req.param("id")),
      jobId = z.string().parse(c.req.param("jobId")),
      action = z
        .enum(["cancel", "resume", "import"])
        .parse(c.req.param("action"));
    basis(course, merchant);
    const previous = importReceipt(merchant, jobId);
    if (action === "import" && previous) {
      if (previous.courseId !== course) throw new HTTPException(404);
      return c.json({ scriptVersion: previous.scriptVersion });
    }
    const { job } = await bridge.request<{ job: GenerationJob }>(
      merchant,
      endpoint(jobId),
    );
    if (job.courseId !== course || job.input.courseId !== course)
      throw new HTTPException(404);
    if (action !== "import")
      return c.json(
        await bridge.request(
          merchant,
          endpoint(jobId) + "/" + action,
          "POST",
          {},
        ),
      );
    if (
      job.status !== "completed" ||
      job.chapters.length !== job.input.chapterCount
    )
      throw new HTTPException(409, { message: "讲稿尚未完整生成，不能导入。" });
    const scriptVersion = transaction(db, () => {
      const prior = importReceipt(merchant, jobId);
      if (prior) return prior.scriptVersion;
      const current = basis(course, merchant);
      if (
        current.productId !== job.input.productId ||
        current.productVersion !== job.input.productVersion ||
        current.baseVersion !== job.input.baseVersion ||
        current.title !== job.input.title ||
        current.objective !== job.input.objective ||
        current.audience !== job.input.audience ||
        JSON.stringify(
          current.facts.map((f) => [f.id, f.text, f.evidence, f.approved]),
        ) !==
          JSON.stringify(
            job.input.facts.map((f) => [f.id, f.text, f.evidence, f.approved]),
          )
      )
        throw new HTTPException(409, {
          message:
            "课程、讲稿或商品依据在生成期间已变化，请核对结果并重新发起任务，不能覆盖当前稿件。",
        });
      const version = save(course, merchant, c.get("actorId"), {
        baseVersion: job.input.baseVersion,
        productVersion: job.input.productVersion,
        paragraphs: job.chapters.flatMap((chapter) => chapter.paragraphs),
        changeNote: `长稿任务 ${job.id}；提示词 ${job.input.profileId} V${job.input.promptVersion}；待人工审改`,
      });
      insertContentGenerationImports(
        db,
        merchant,
        jobId,
        course,
        version,
        c.get("actorId"),
        clock(),
        JSON.stringify(job),
      );
      return version;
    });
    return c.json({ scriptVersion }, 201);
  });
}
