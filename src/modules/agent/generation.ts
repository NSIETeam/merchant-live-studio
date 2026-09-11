import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { PromptVersion } from "../../shared/agent.js";
import type {
  GeneratedChapter,
  GenerationJob,
  GenerationOutline,
  GenerationSnapshot,
} from "../../shared/generation.js";
import type { GenerationProvider } from "./generation-provider.js";
import type { AgentDB } from "./persistence/database.js";
import { agentTransaction } from "./persistence/database.js";
import {
  findAgentGenerationJobs,
  findAgentGenerationJobs2,
  findAgentGenerationJobsByTenantIdAndId,
  findAgentGenerationJobsByTenantIdAndIdempotencyKey,
  initializeAgentGenerationJobs,
  insertAgentGenerationAttempts,
  insertAgentGenerationJobs,
  listAgentGenerationAttemptsByTenantIdAndJobId,
  listAgentGenerationJobsByTenantIdAndCourseIdAndRowid,
  updateAgentGenerationJobs,
  updateAgentGenerationJobsByTenantIdAndId,
  updateAgentGenerationJobsByTenantIdAndId2,
  updateAgentGenerationJobsByTenantIdAndId3,
  updateAgentGenerationJobsByTenantIdAndId4,
  updateAgentGenerationJobsByTenantIdAndId5,
  updateAgentGenerationJobsByTenantIdAndId6,
} from "./persistence/generation-queries.js";
const id = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/);
const schema = z
  .object({
    courseId: id,
    baseVersion: z.number().int().min(0),
    productId: id,
    productVersion: z.number().int().positive(),
    productName: z.string().trim().min(1).max(120),
    category: z.string().max(80),
    title: z.string().trim().min(1).max(120),
    objective: z.string().max(1000),
    audience: z.string().max(1000),
    facts: z
      .array(
        z
          .object({
            id,
            text: z.string().trim().min(1).max(400),
            evidence: z.string().trim().min(1).max(500),
            approved: z.boolean(),
          })
          .strict(),
      )
      .max(40)
      .refine((f) => new Set(f.map((x) => x.id)).size === f.length),
    targetCharacters: z.number().int().min(500).max(12000),
    chapterCount: z.number().int().min(2).max(8),
    profileId: id,
    promptVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
const outlineSchema = z
  .object({
    chapters: z
      .array(
        z
          .object({
            title: z.string().trim().min(1).max(120),
            objective: z.string().max(500),
          })
          .strict(),
      )
      .min(2)
      .max(8),
  })
  .strict();
const chapterSchema = z
  .object({
    paragraphs: z
      .array(
        z
          .object({
            kind: z.enum(["fact", "transition"]),
            text: z.string().trim().min(1).max(1500),
            factIds: z
              .array(id)
              .max(8)
              .refine((ids) => new Set(ids).size === ids.length),
          })
          .strict(),
      )
      .min(1)
      .max(5),
  })
  .strict();
type Row = {
  tenant_id: string;
  id: string;
  course_id: string;
  status: GenerationJob["status"];
  input_json: string;
  outline_json: string | null;
  chapters_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  digest: string;
};
const dto = (r: Row): GenerationJob => ({
  id: r.id,
  courseId: r.course_id,
  status: r.status,
  input: JSON.parse(r.input_json),
  outline: r.outline_json ? JSON.parse(r.outline_json) : null,
  chapters: JSON.parse(r.chapters_json),
  error: r.error,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  needsReview: true,
});
function conflict(message: string): never {
  throw new HTTPException(409, { message });
}

export function registerGeneration(
  app: Hono<{ Variables: { tenantId: string } }>,
  db: AgentDB,
  provider: GenerationProvider,
  prompt: (tenant: string, profile: string, version: number) => PromptVersion,
  limits = { global: 100, tenant: 10 },
  clock = Date.now,
) {
  initializeAgentGenerationJobs(db);
  updateAgentGenerationJobs(db, clock());
  let started = false,
    closed = false,
    timer: ReturnType<typeof setInterval> | undefined;
  let active: {
    tenant: string;
    id: string;
    controller: AbortController;
    promise: Promise<void>;
  } | null = null;
  function row(tenant: string, job: string) {
    const value = findAgentGenerationJobsByTenantIdAndId(db, tenant, job) as
      Row | undefined;
    if (!value)
      throw new HTTPException(404, { message: "Generation task not found" });
    return value;
  }
  function roomForQueue(tenant: string) {
    const counts = findAgentGenerationJobs(db, tenant)!;
    if (
      Number(counts.total) >= limits.global ||
      Number(counts.owned) >= limits.tenant
    )
      throw new HTTPException(429, { message: "Generation queue is full" });
  }
  function attempt(
    job: Row,
    stage: number,
    result: string,
    error: string | null,
  ) {
    insertAgentGenerationAttempts(
      db,
      randomUUID(),
      job.tenant_id,
      job.id,
      stage,
      provider.label,
      result,
      error,
      clock(),
    );
  }
  async function step(job: Row, signal: AbortSignal) {
    const input: GenerationSnapshot = JSON.parse(job.input_json),
      outline: GenerationOutline | null = job.outline_json
        ? JSON.parse(job.outline_json)
        : null;
    const chapters: GeneratedChapter[] = JSON.parse(job.chapters_json),
      stage = outline ? chapters.length + 1 : 0;
    try {
      const raw = await provider.execute(input, outline, chapters, signal);
      if (closed || signal.aborted) return;
      let newOutline = outline;
      if (!outline) {
        newOutline = outlineSchema.parse(raw);
        if (newOutline.chapters.length !== input.chapterCount)
          throw new Error("Invalid chapter count");
      } else {
        const parsed = chapterSchema.parse(raw);
        const approved = new Set(
          input.facts.filter((f) => f.approved).map((f) => f.id),
        );
        for (const paragraph of parsed.paragraphs) {
          if (paragraph.kind === "fact" && !paragraph.factIds.length)
            throw new Error("Fact citation missing");
          if (paragraph.kind === "transition" && paragraph.factIds.length)
            throw new Error("Transition citation invalid");
          if (paragraph.factIds.some((f) => !approved.has(f)))
            throw new Error("Unknown or unapproved fact");
        }
        chapters.push({
          title: outline.chapters[chapters.length].title,
          paragraphs: parsed.paragraphs.map((p, i) => ({
            ...p,
            id: `gen-${job.id}-${stage}-${i}`,
          })),
        });
        const paragraphs = chapters.flatMap((c) => c.paragraphs);
        if (
          paragraphs.length > 40 ||
          paragraphs.reduce((n, p) => n + p.text.length, 0) > 12000
        )
          throw new Error("Manuscript too large");
      }
      agentTransaction(db, () => {
        if (row(job.tenant_id, job.id).status !== "running") return;
        updateAgentGenerationJobsByTenantIdAndId(
          db,
          JSON.stringify(newOutline),
          JSON.stringify(chapters),
          chapters.length === input.chapterCount ? "completed" : "queued",
          clock(),
          job.tenant_id,
          job.id,
        );
        attempt(job, stage, "completed", null);
      });
    } catch {
      if (closed || signal.aborted) return;
      // Never persist raw provider errors, credentials or unvalidated model output.
      const message =
        "本章生成失败或结果不完整；已完成章节保留，请检查模型配置后继续。";
      agentTransaction(db, () => {
        if (row(job.tenant_id, job.id).status !== "running") return;
        updateAgentGenerationJobsByTenantIdAndId2(
          db,
          message,
          clock(),
          job.tenant_id,
          job.id,
        );
        attempt(job, stage, "failed", message);
      });
    }
  }
  function tick() {
    if (!started || closed || active) return;
    try {
      const job = agentTransaction(db, () => {
        const value = findAgentGenerationJobs2(db) as Row | undefined;
        if (!value) return null;
        updateAgentGenerationJobsByTenantIdAndId3(
          db,
          provider.configured ? "running" : "waiting_configuration",
          clock(),
          value.tenant_id,
          value.id,
        );
        return provider.configured ? value : null;
      });
      if (!job) return;
      const controller = new AbortController();
      const promise = step(job, controller.signal)
        .catch(() => {})
        .finally(() => {
          active = null;
        });
      active = { tenant: job.tenant_id, id: job.id, controller, promise };
    } catch {
      /* Existing service health exposes storage failure; no overlapping workers. */
    }
  }
  app.get("/v1/generation/status", (c) =>
    c.json({
      configured: provider.configured,
      available: !closed,
      concurrency: 1,
    }),
  );
  app.post("/v1/generation/jobs", async (c) => {
    const input = schema.parse(await c.req.json()),
      tenant = c.get("tenantId");
    const hash = createHash("sha256")
      .update(JSON.stringify(input))
      .digest("hex");
    const job = agentTransaction(db, () => {
      const prior = findAgentGenerationJobsByTenantIdAndIdempotencyKey(
        db,
        tenant,
        input.idempotencyKey,
      ) as Row | undefined;
      if (prior) {
        if (prior.digest !== hash)
          conflict("Idempotency key has different input");
        return prior.id;
      }
      roomForQueue(tenant);
      const snapshot: GenerationSnapshot = {
        ...input,
        prompt: prompt(tenant, input.profileId, input.promptVersion),
      };
      const job = randomUUID(),
        now = clock();
      insertAgentGenerationJobs(
        db,
        tenant,
        job,
        input.courseId,
        provider.configured ? "queued" : "waiting_configuration",
        input.idempotencyKey,
        hash,
        JSON.stringify(snapshot),
        now,
        now,
      );
      return job;
    });
    return c.json({ job: dto(row(tenant, job)) }, 202);
  });
  app.get("/v1/generation/jobs", (c) => {
    const course = id.parse(c.req.query("courseId")),
      before = z.coerce
        .number()
        .int()
        .positive()
        .optional()
        .parse(c.req.query("before"));
    const rows = listAgentGenerationJobsByTenantIdAndCourseIdAndRowid(
      db,
      c.get("tenantId"),
      course,
      before ?? Number.MAX_SAFE_INTEGER,
    ) as (Row & { cursor: number })[];
    return c.json({
      jobs: rows.slice(0, 20).map((r) => ({
        id: r.id,
        courseId: r.course_id,
        status: r.status,
        error: r.error,
        completedChapters: (JSON.parse(r.chapters_json) as GeneratedChapter[])
          .length,
        chapterCount: (JSON.parse(r.input_json) as GenerationSnapshot)
          .chapterCount,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
      })),
      nextBefore: rows.length > 20 ? rows[19].cursor : null,
    });
  });
  app.get("/v1/generation/jobs/:id", (c) => {
    const job = row(c.get("tenantId"), c.req.param("id"));
    const attempts = listAgentGenerationAttemptsByTenantIdAndJobId(
      db,
      job.tenant_id,
      job.id,
    );
    return c.json({ job: dto(job), attempts });
  });
  app.post("/v1/generation/jobs/:id/:action", (c) => {
    const tenant = c.get("tenantId"),
      jobId = c.req.param("id"),
      action = z.enum(["cancel", "resume"]).parse(c.req.param("action"));
    agentTransaction(db, () => {
      const job = row(tenant, jobId);
      if (action === "cancel") {
        if (job.status === "completed")
          conflict("Completed task cannot be cancelled");
        if (job.status === "cancelled") return;
        updateAgentGenerationJobsByTenantIdAndId4(db, clock(), tenant, jobId);
        attempt(job, -1, "cancelled", null);
      } else {
        if (["queued", "running"].includes(job.status)) return;
        if (job.status === "completed")
          conflict("Completed task cannot be resumed");
        if (!provider.configured) conflict("Model is not configured");
        if (job.status !== "waiting_configuration") roomForQueue(tenant);
        updateAgentGenerationJobsByTenantIdAndId5(db, clock(), tenant, jobId);
        attempt(job, -1, "resumed", null);
      }
    });
    if (action === "cancel" && active?.id === jobId && active.tenant === tenant)
      active.controller.abort();
    return c.json({ job: dto(row(tenant, jobId)) });
  });
  return {
    start() {
      if (started || closed) return;
      started = true;
      timer = setInterval(tick, 100);
      timer.unref();
      tick();
    },
    async close() {
      if (closed) return;
      closed = true;
      if (timer) clearInterval(timer);
      if (active) {
        active.controller.abort();
        updateAgentGenerationJobsByTenantIdAndId6(
          db,
          clock(),
          active.tenant,
          active.id,
        );
      }
    },
  };
}
