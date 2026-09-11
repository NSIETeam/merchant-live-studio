import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { z, ZodError } from "zod";
import {
  DEFAULT_PROMPT_CONTENT,
  isModelConfigured,
  runAgent,
} from "./core/index.js";
import type { AgentConfig } from "./config.js";
import { agentTransaction, type AgentDB } from "./db.js";
import { registerTrainingRoutes, type ReservedRun } from "./training.js";
import type {
  AgentExecutionInput,
  AgentProfile,
  AgentResult,
  AgentRun,
  AgentServiceStatus,
  PromptContent,
  PromptVersion,
} from "../shared/agent.js";

const promptSchema = z
  .object({
    systemPrompt: z.string().trim().min(1).max(6000),
    styleGuide: z.string().max(4000),
    audience: z.string().max(1000),
    examples: z
      .array(
        z
          .object({
            situation: z.string().max(1000),
            response: z.string().max(2000),
          })
          .strict(),
      )
      .max(20),
  })
  .strict();
const contextSchema = z
  .object({
    roomId: z.string().min(1).max(128),
    productName: z.string().min(1).max(300),
    category: z.string().max(100).optional(),
    transcript: z.string().max(12000),
    question: z.string().max(2000).optional(),
    campaignCue: z.string().max(1000).optional(),
    facts: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            text: z.string().max(1500),
            evidence: z.string().max(2000),
            approved: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const runSchema = z
  .object({
    profileId: z.string().min(1).max(128),
    version: z.number().int().positive().optional(),
    context: contextSchema,
    mode: z.enum(["rehearsal", "live"]),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
type ProfileRow = {
  id: string;
  name: string;
  kind: AgentProfile["kind"];
  published_version: number | null;
  latest_version: number;
  created_at: number;
};
type VersionRow = { version: number; content_json: string; created_at: number };
type RunRow = {
  tenant_id: string;
  id: string;
  room_id: string;
  profile_id: string;
  prompt_version: number;
  mode: AgentRun["mode"];
  status: AgentRun["status"];
  request_digest: string;
  context_digest: string;
  input_json: string;
  result_json: string | null;
  error: string | null;
  feedback_json: string | null;
  created_at: number;
  completed_at: number | null;
};
const profileDto = (r: ProfileRow): AgentProfile => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  publishedVersion: r.published_version,
  latestVersion: r.latest_version,
  createdAt: r.created_at,
});
const versionDto = (r: VersionRow): PromptVersion => ({
  ...(JSON.parse(r.content_json) as PromptContent),
  version: r.version,
  createdAt: r.created_at,
});
const runDto = (r: RunRow): AgentRun => ({
  id: r.id,
  roomId: r.room_id,
  profileId: r.profile_id,
  promptVersion: r.prompt_version,
  mode: r.mode,
  status: r.status,
  createdAt: r.created_at,
  contextDigest: r.context_digest,
  ...(r.completed_at !== null ? { completedAt: r.completed_at } : {}),
  ...(r.result_json
    ? { result: JSON.parse(r.result_json) as AgentResult }
    : {}),
  ...(r.error ? { error: r.error } : {}),
  ...(r.feedback_json
    ? { feedback: JSON.parse(r.feedback_json) as AgentRun["feedback"] }
    : {}),
});
function canonical(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => JSON.stringify(k) + ":" + canonical(v))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const digest = (value: unknown) =>
  createHash("sha256").update(canonical(value)).digest("hex");

export interface AgentServiceOptions {
  execute?: typeof runAgent;
  clock?: () => number;
  autoStart?: boolean;
}
export function createAgentService(
  db: AgentDB,
  config: AgentConfig,
  options: AgentServiceOptions = {},
) {
  const app = new Hono<{ Variables: { tenantId: string } }>();
  const clock = options.clock || Date.now,
    execute = options.execute || runAgent;
  const expectedToken = createHash("sha256")
    .update(config.serviceToken)
    .digest();
  const active = new Map<string, { tenant: string; promise: Promise<void> }>();
  let timer: ReturnType<typeof setInterval> | undefined,
    started = false,
    closing = false,
    closed = false,
    scheduled = false;
  const modelConfigured = isModelConfigured(config.model);
  const profile = (tenant: string, id: string): ProfileRow => {
    const row = db
      .prepare("SELECT * FROM agent_profiles WHERE tenant_id=? AND id=?")
      .get(tenant, id) as ProfileRow | undefined;
    if (!row)
      throw new HTTPException(404, { message: "Agent profile not found" });
    return row;
  };
  const version = (
    tenant: string,
    id: string,
    number: number,
  ): PromptVersion => {
    const row = db
      .prepare(
        "SELECT * FROM agent_prompt_versions WHERE tenant_id=? AND profile_id=? AND version=?",
      )
      .get(tenant, id, number) as VersionRow | undefined;
    if (!row)
      throw new HTTPException(404, { message: "Prompt version not found" });
    return versionDto(row);
  };
  const run = (tenant: string, id: string): RunRow => {
    const row = db
      .prepare("SELECT * FROM agent_runs WHERE tenant_id=? AND id=?")
      .get(tenant, id) as RunRow | undefined;
    if (!row) throw new HTTPException(404, { message: "Agent run not found" });
    return row;
  };
  // Both single requests and evaluation batches use the same durable queue.
  // Callers hold one transaction for capacity, snapshots and job insertion.
  const reserve = (tenant: string, jobs: ReservedRun[]): string[] => {
    const global = (
      db
        .prepare(
          "SELECT count(*) AS count FROM agent_runs WHERE status IN ('queued','running')",
        )
        .get() as { count: number }
    ).count;
    const own = (
      db
        .prepare(
          "SELECT count(*) AS count FROM agent_runs WHERE tenant_id=? AND status IN ('queued','running')",
        )
        .get(tenant) as { count: number }
    ).count;
    if (
      global + jobs.length > config.queueLimit ||
      own + jobs.length > config.tenantQueueLimit
    )
      throw new HTTPException(429, {
        message: "Agent queue is full; try again later",
      });
    return jobs.map((job) => {
      const id = randomUUID();
      db.prepare(
        "INSERT INTO agent_runs(tenant_id,id,room_id,profile_id,prompt_version,mode,status,idempotency_key,request_digest,context_digest,input_json,created_at) VALUES(?,?,?,?,?,?,'queued',?,?,?,?,?)",
      ).run(
        tenant,
        id,
        job.snapshot.context.roomId,
        job.snapshot.profile.id,
        job.snapshot.prompt.version,
        job.mode,
        job.idempotencyKey,
        job.requestDigest,
        digest(job.snapshot.context),
        JSON.stringify(job.snapshot),
        clock(),
      );
      return id;
    });
  };
  const seed = (tenant: string) =>
    agentTransaction(db, () => {
      if (
        db
          .prepare(
            "SELECT 1 FROM agent_profiles WHERE tenant_id=? AND id='standard'",
          )
          .get(tenant)
      )
        return;
      const now = clock();
      db.prepare(
        "INSERT INTO agent_profiles VALUES(?,'standard',?,'standard',1,1,?)",
      ).run(tenant, "标准直播风格", now);
      db.prepare(
        "INSERT INTO agent_prompt_versions VALUES(?,'standard',1,?,?)",
      ).run(tenant, JSON.stringify(DEFAULT_PROMPT_CONTENT), now);
    });
  function status(): AgentServiceStatus {
    try {
      const rows = db
        .prepare(
          "SELECT status,count(*) AS count FROM agent_runs WHERE status IN ('queued','running') GROUP BY status",
        )
        .all() as { status: string; count: number }[];
      return {
        available: !closing && !closed,
        modelConfigured,
        provider: modelConfigured ? "remote-model" : "grounded-rules",
        queued: rows.find((r) => r.status === "queued")?.count || 0,
        running: rows.find((r) => r.status === "running")?.count || 0,
        maxConcurrency: config.concurrency,
        ...(!modelConfigured
          ? { message: "Local grounded rules; no remote model is configured." }
          : {}),
      };
    } catch {
      return {
        available: false,
        modelConfigured,
        provider: modelConfigured ? "remote-model" : "grounded-rules",
        queued: 0,
        running: 0,
        maxConcurrency: config.concurrency,
        message: "Agent storage is unavailable.",
      };
    }
  }
  function schedule() {
    if (!started || closing || closed || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      pump();
    });
  }
  function pump() {
    if (!started || closing || closed) return;
    while (active.size < config.concurrency) {
      let next: RunRow | undefined;
      try {
        next = agentTransaction(db, () => {
          const row = db
            .prepare(
              "SELECT * FROM agent_runs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
            )
            .get() as RunRow | undefined;
          if (row)
            db.prepare(
              "UPDATE agent_runs SET status='running',started_at=? WHERE tenant_id=? AND id=? AND status='queued'",
            ).run(clock(), row.tenant_id, row.id);
          return row;
        });
      } catch {
        return;
      }
      if (!next) return;
      const job = next;
      const promise = (async () => {
        try {
          const result = await Promise.resolve().then(() =>
            execute(
              JSON.parse(job.input_json) as AgentExecutionInput,
              config.model,
            ),
          );
          if (!closed)
            db.prepare(
              "UPDATE agent_runs SET status='completed',result_json=?,completed_at=? WHERE tenant_id=? AND id=? AND status='running'",
            ).run(JSON.stringify(result), clock(), job.tenant_id, job.id);
        } catch {
          if (!closed)
            try {
              db.prepare(
                "UPDATE agent_runs SET status='failed',error=?,completed_at=? WHERE tenant_id=? AND id=? AND status='running'",
              ).run(
                "Agent execution failed; a new run can be requested.",
                clock(),
                job.tenant_id,
                job.id,
              );
            } catch {
              /* Health reports unavailable storage; recovery handles interrupted runs. */
            }
        } finally {
          active.delete(job.id);
          schedule();
        }
      })();
      active.set(job.id, { tenant: job.tenant_id, promise });
    }
  }
  function start() {
    if (started || closing || closed) return;
    started = true;
    timer = setInterval(schedule, 250);
    timer.unref();
    schedule();
  }
  async function close({ timeoutMs = 35000 }: { timeoutMs?: number } = {}) {
    if (closed) return;
    closing = true;
    if (timer) clearInterval(timer);
    let deadline: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      Promise.allSettled([...active.values()].map((r) => r.promise)),
      new Promise<void>((resolve) => {
        deadline = setTimeout(resolve, Math.max(0, timeoutMs));
      }),
    ]);
    if (deadline) clearTimeout(deadline);
    for (const [id, task] of active)
      try {
        db.prepare(
          "UPDATE agent_runs SET status='failed',error=?,completed_at=? WHERE tenant_id=? AND id=? AND status='running'",
        ).run(
          "Agent service stopped during execution; create a new run to retry.",
          clock(),
          task.tenant,
          id,
        );
      } catch {
        /* A subsequent restart also marks interrupted runs failed. */
      }
    closed = true;
  }
  app.use("*", secureHeaders());
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });
  app.use(
    "/v1/*",
    bodyLimit({
      maxSize: 192 * 1024,
      onError: (c) => c.json({ error: "Agent request is too large" }, 413),
    }),
  );
  app.use("/v1/*", async (c, next) => {
    const header = c.req.header("authorization") || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : "";
    if (
      !token ||
      !timingSafeEqual(
        createHash("sha256").update(token).digest(),
        expectedToken,
      )
    )
      throw new HTTPException(401, {
        message: "Agent service authentication required",
      });
    const tenant = c.req.header("x-studio-tenant") || "";
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(tenant))
      throw new HTTPException(400, {
        message: "A valid trusted tenant header is required",
      });
    if (closing || closed)
      throw new HTTPException(503, { message: "Agent service is stopping" });
    if (
      !["GET", "HEAD"].includes(c.req.method) &&
      !c.req.header("content-type")?.startsWith("application/json")
    )
      throw new HTTPException(415, {
        message: "An application/json body is required",
      });
    c.set("tenantId", tenant);
    seed(tenant);
    await next();
  });
  app.onError((error, c) => {
    if (error instanceof HTTPException) {
      if (error.status === 429) c.header("Retry-After", "1");
      return c.json({ error: error.message }, error.status);
    }
    if (error instanceof ZodError || error instanceof SyntaxError)
      return c.json({ error: "Invalid Agent request" }, 400);
    return c.json(
      { error: "Agent storage or execution is temporarily unavailable" },
      503,
    );
  });
  app.get("/health", (c) => {
    const value = status();
    return c.json(value, value.available ? 200 : 503);
  });
  app.get("/v1/profiles", (c) =>
    c.json({
      profiles: (
        db
          .prepare(
            "SELECT * FROM agent_profiles WHERE tenant_id=? ORDER BY CASE WHEN id='standard' THEN 0 ELSE 1 END,created_at,id",
          )
          .all(c.get("tenantId")) as ProfileRow[]
      ).map(profileDto),
    }),
  );
  app.post("/v1/profiles", async (c) => {
    const input = promptSchema
      .extend({
        name: z.string().trim().min(1).max(100),
        kind: z.literal("brand"),
      })
      .parse(await c.req.json());
    const { name, kind, ...content } = input,
      tenant = c.get("tenantId"),
      id = randomUUID(),
      now = clock();
    agentTransaction(db, () => {
      db.prepare("INSERT INTO agent_profiles VALUES(?,?,?, ?,NULL,1,?)").run(
        tenant,
        id,
        name,
        kind,
        now,
      );
      db.prepare("INSERT INTO agent_prompt_versions VALUES(?,?,1,?,?)").run(
        tenant,
        id,
        JSON.stringify(content),
        now,
      );
    });
    return c.json(
      {
        profile: profileDto(profile(tenant, id)),
        version: version(tenant, id, 1),
      },
      201,
    );
  });
  app.get("/v1/profiles/:id/versions", (c) => {
    const tenant = c.get("tenantId"),
      id = c.req.param("id");
    profile(tenant, id);
    return c.json({
      versions: (
        db
          .prepare(
            "SELECT * FROM agent_prompt_versions WHERE tenant_id=? AND profile_id=? ORDER BY version DESC",
          )
          .all(tenant, id) as VersionRow[]
      ).map(versionDto),
    });
  });
  app.post("/v1/profiles/:id/versions", async (c) => {
    const content = promptSchema.parse(await c.req.json()),
      tenant = c.get("tenantId"),
      id = c.req.param("id");
    const number = agentTransaction(db, () => {
      const row = profile(tenant, id),
        next = row.latest_version + 1;
      db.prepare("INSERT INTO agent_prompt_versions VALUES(?,?,?,?,?)").run(
        tenant,
        id,
        next,
        JSON.stringify(content),
        clock(),
      );
      db.prepare(
        "UPDATE agent_profiles SET latest_version=? WHERE tenant_id=? AND id=?",
      ).run(next, tenant, id);
      return next;
    });
    return c.json({ version: version(tenant, id, number) }, 201);
  });
  app.post("/v1/profiles/:id/versions/:version/publish", async (c) => {
    z.object({})
      .strict()
      .parse(await c.req.json());
    const tenant = c.get("tenantId"),
      id = c.req.param("id"),
      number = z.coerce.number().int().positive().parse(c.req.param("version"));
    profile(tenant, id);
    version(tenant, id, number);
    db.prepare(
      "UPDATE agent_profiles SET published_version=? WHERE tenant_id=? AND id=?",
    ).run(number, tenant, id);
    return c.json({ profile: profileDto(profile(tenant, id)) });
  });
  app.post("/v1/runs", async (c) => {
    const input = runSchema.parse(await c.req.json()),
      tenant = c.get("tenantId"),
      requestDigest = digest(input);
    const id = agentTransaction(db, () => {
      const prior = db
        .prepare(
          "SELECT * FROM agent_runs WHERE tenant_id=? AND idempotency_key=?",
        )
        .get(tenant, input.idempotencyKey) as RunRow | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest)
          throw new HTTPException(409, {
            message: "Idempotency key was already used for a different input",
          });
        return prior.id;
      }
      const p = profile(tenant, input.profileId);
      if (
        input.mode === "live" &&
        (p.published_version === null ||
          (input.version !== undefined &&
            input.version !== p.published_version))
      )
        throw new HTTPException(409, {
          message: "Live runs require the published prompt version",
        });
      const number =
        input.mode === "live"
          ? p.published_version!
          : (input.version ?? p.latest_version);
      const snapshot: AgentExecutionInput = {
        context: input.context,
        profile: profileDto(p),
        prompt: version(tenant, p.id, number),
      };
      return reserve(tenant, [
        {
          snapshot,
          mode: input.mode,
          idempotencyKey: input.idempotencyKey,
          requestDigest,
        },
      ])[0];
    });
    const output = runDto(run(tenant, id));
    schedule();
    return c.json({ run: output }, 202);
  });
  app.get("/v1/runs", (c) => {
    const query = z
      .object({
        roomId: z.string().min(1).max(128),
        mode: z.enum(["rehearsal", "live"]).optional(),
        limit: z.coerce.number().int().min(1).max(20).default(1),
      })
      .parse(c.req.query());
    return c.json({
      runs: (
        db
          .prepare(
            "SELECT * FROM agent_runs WHERE tenant_id=? AND room_id=? AND (? IS NULL OR mode=?) ORDER BY created_at DESC,rowid DESC LIMIT ?",
          )
          .all(
            c.get("tenantId"),
            query.roomId,
            query.mode ?? null,
            query.mode ?? null,
            query.limit,
          ) as RunRow[]
      ).map(runDto),
    });
  });
  app.get("/v1/runs/:id", (c) =>
    c.json({ run: runDto(run(c.get("tenantId"), c.req.param("id"))) }),
  );
  app.post("/v1/runs/:id/feedback", async (c) => {
    const feedback = z
      .object({
        rating: z.enum(["useful", "needs_work"]),
        note: z.string().max(2000),
      })
      .strict()
      .parse(await c.req.json());
    const tenant = c.get("tenantId"),
      id = c.req.param("id");
    run(tenant, id);
    db.prepare(
      "UPDATE agent_runs SET feedback_json=? WHERE tenant_id=? AND id=?",
    ).run(JSON.stringify(feedback), tenant, id);
    return c.json({ run: runDto(run(tenant, id)) });
  });
  app.post("/v1/check", async (c) => {
    const input = z
      .object({
        context: contextSchema,
        profileId: z.string().min(1).max(128).optional(),
      })
      .strict()
      .parse(await c.req.json());
    const tenant = c.get("tenantId"),
      p = profile(tenant, input.profileId || "standard");
    return c.json(
      await runAgent({
        context: input.context,
        profile: profileDto(p),
        prompt: version(tenant, p.id, p.published_version ?? p.latest_version),
      }),
    );
  });
  registerTrainingRoutes(app, {
    db,
    clock,
    digest,
    contextSchema,
    profile: (tenant, id) => profileDto(profile(tenant, id)),
    version,
    run: (tenant, id) => runDto(run(tenant, id)),
    reserve,
    schedule,
  });
  if (options.autoStart !== false) start();
  return { app, start, close, status };
}
