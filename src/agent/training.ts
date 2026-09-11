import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { agentTransaction, type AgentDB } from "./db.js";
import type {
  AgentContext,
  AgentExecutionInput,
  AgentProfile,
  AgentRun,
  PromptVersion,
} from "../shared/agent.js";
import type {
  EvaluationCase,
  EvaluationCheck,
  EvaluationReport,
  EvaluationReview,
  EvaluationSuite,
  ExampleImportReceipt,
} from "../shared/training.js";

export interface ReservedRun {
  snapshot: AgentExecutionInput;
  mode: AgentRun["mode"];
  idempotencyKey: string;
  requestDigest: string;
}
interface Dependencies {
  db: AgentDB;
  clock: () => number;
  digest: (input: unknown) => string;
  contextSchema: z.ZodType<AgentContext>;
  profile: (tenant: string, id: string) => AgentProfile;
  version: (tenant: string, id: string, version: number) => PromptVersion;
  run: (tenant: string, id: string) => AgentRun;
  /** Caller owns the transaction; reserve all jobs or throw before inserting any. */
  reserve: (tenant: string, jobs: ReservedRun[]) => string[];
  schedule: () => void;
}
const idSchema = z.string().min(1).max(128);
const unique = <T>(items: T[], key: (item: T) => string) =>
  new Set(items.map(key)).size === items.length;
const exampleSchema = z
  .object({
    situation: z.string().trim().min(1).max(500),
    response: z.string().trim().min(1).max(1200),
  })
  .strict();
const exampleImportSchema = z
  .object({
    sourceName: z.string().trim().min(1).max(120),
    authorization: z.enum(["owned", "licensed"]),
    examples: z.array(exampleSchema).min(1).max(12),
    baseVersion: z.number().int().positive(),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();
export const evaluationCaseSchema = z
  .object({
    id: idSchema,
    title: z.string().trim().min(1).max(100),
    transcript: z.string().max(1000),
    question: z.string().max(200).optional(),
    expect: z
      .object({
        mustCiteEvidence: z.boolean(),
        abstained: z.boolean().optional(),
        alertCategories: z
          .array(
            z.enum(["claim", "evidence", "emotion", "platform", "instruction"]),
          )
          .max(5)
          .refine((items) => unique(items, (item) => item)),
        forbiddenPhrases: z.array(z.string().trim().min(1).max(100)).max(8),
      })
      .strict(),
  })
  .strict();
const suiteSchema = z
  .object({
    roomId: idSchema,
    name: z.string().trim().min(1).max(100),
    cases: z
      .array(evaluationCaseSchema)
      .min(1)
      .max(8)
      .refine((items) => unique(items, (item) => item.id)),
  })
  .strict();
const reviewSchema = z
  .object({
    style: z.number().int().min(1).max(5),
    naturalness: z.number().int().min(1).max(5),
    decision: z.enum(["acceptable", "revise"]),
    note: z.string().max(1000),
  })
  .strict();
type SuiteRow = {
  id: string;
  room_id: string;
  name: string;
  revision: number;
  cases_json: string;
  created_at: number;
};
type EvaluationRow = {
  id: string;
  room_id: string;
  suite_json: string;
  variants_json: string;
  context_json: string;
  request_digest: string;
  created_at: number;
};
type ItemRow = {
  id: string;
  case_id: string;
  variant_index: number;
  run_id: string;
  review_json: string | null;
};
const suiteDto = (r: SuiteRow): EvaluationSuite => ({
  id: r.id,
  roomId: r.room_id,
  name: r.name,
  revision: r.revision,
  cases: JSON.parse(r.cases_json),
  createdAt: r.created_at,
});
const comparable = (text: string) =>
  text.normalize("NFKC").replace(/\s+/g, "").toLocaleLowerCase();

/** These are reproducible fixture checks, never a legal verdict or a style score. */
function rubric(
  run: AgentRun,
  sample: EvaluationCase,
  context: AgentContext,
): EvaluationCheck[] {
  if (run.status === "queued" || run.status === "running") return [];
  if (run.status !== "completed" || !run.result)
    return [
      {
        name: "生成完成",
        passed: false,
        detail: "本次任务失败，没有可评测的生成结果。",
      },
    ];
  const output = run.result;
  const facts = new Map(
    context.facts
      .filter((f) => f.approved && f.text.trim() && f.evidence.trim())
      .map((f) => [f.id, f]),
  );
  const referencesValid =
    unique(output.factIds, (id) => id) &&
    output.factIds.every(
      (id, index) =>
        facts.has(id) &&
        output.evidence[index] === facts.get(id)!.evidence &&
        output.suggestion.includes(facts.get(id)!.text),
    ) &&
    output.evidence.length === output.factIds.length &&
    (output.abstained
      ? output.factIds.length === 0
      : output.factIds.length > 0);
  const fallback =
    output.modelConfigured &&
    output.provider === "grounded-rules" &&
    !output.abstained;
  const checks: EvaluationCheck[] = [
    {
      name: "生成完成",
      passed: !fallback,
      detail: fallback
        ? "模型生成未完成，已回退本地规则；不能计为模型评测通过。"
        : output.provider === "grounded-rules"
          ? "本地规则结果；未调用真实模型。"
          : "已取得模型编排结果。",
    },
    {
      name: "引用与证据一致",
      passed: referencesValid,
      detail: referencesValid
        ? "引用、原文与出处对应本次已审核事实快照。"
        : "存在缺失、重复、未审核或不匹配的事实引用、原文、出处。",
    },
  ];
  if (sample.expect.mustCiteEvidence)
    checks.push({
      name: "包含证据引用",
      passed: output.factIds.length > 0 && referencesValid,
      detail: "题目要求至少引用一条已审核且出处完整的事实。",
    });
  if (sample.expect.abstained !== undefined)
    checks.push({
      name: "保留答复符合预期",
      passed: output.abstained === sample.expect.abstained,
      detail: sample.expect.abstained
        ? "题目要求资料不足时保留答复。"
        : "题目要求依据现有资料给出答复。",
    });
  for (const category of sample.expect.alertCategories)
    checks.push({
      name: `提示类别：${category}`,
      passed: output.alerts.some((alert) => alert.category === category),
      detail: "仅检查声明的提示类别是否出现，不判断完整语义是否合法。",
    });
  const generated = comparable(`${output.suggestion}\n${output.nextCue}`);
  for (const phrase of sample.expect.forbiddenPhrases)
    checks.push({
      name: `不输出：${phrase}`,
      passed: !generated.includes(comparable(phrase)),
      detail: "按规范化后的文本检查建议句和下一环节，不据此判定整体合规。",
    });
  return checks;
}

export function registerTrainingRoutes(
  app: Hono<{ Variables: { tenantId: string } }>,
  deps: Dependencies,
) {
  const { db, clock, digest, profile, version, run, reserve, schedule } = deps;
  const suite = (tenant: string, id: string) => {
    const row = db
      .prepare(
        "SELECT * FROM agent_evaluation_suites WHERE tenant_id=? AND id=?",
      )
      .get(tenant, id) as SuiteRow | undefined;
    if (!row)
      throw new HTTPException(404, { message: "Evaluation suite not found" });
    return suiteDto(row);
  };
  const report = (tenant: string, id: string): EvaluationReport => {
    const row = db
      .prepare("SELECT * FROM agent_evaluations WHERE tenant_id=? AND id=?")
      .get(tenant, id) as EvaluationRow | undefined;
    if (!row) throw new HTTPException(404, { message: "Evaluation not found" });
    const snapshot = JSON.parse(row.suite_json) as EvaluationSuite;
    const context = JSON.parse(row.context_json) as AgentContext;
    const items = (
      db
        .prepare(
          "SELECT * FROM agent_evaluation_items WHERE tenant_id=? AND evaluation_id=? ORDER BY variant_index,rowid",
        )
        .all(tenant, id) as ItemRow[]
    ).map((item) => {
      const job = run(tenant, item.run_id);
      const sample = snapshot.cases.find((c) => c.id === item.case_id)!;
      const checks = rubric(job, sample, context);
      return {
        id: item.id,
        caseId: item.case_id,
        variantIndex: item.variant_index,
        run: job,
        checks,
        outcome:
          job.status === "queued" || job.status === "running"
            ? ("pending" as const)
            : checks.length > 0 && checks.every((c) => c.passed)
              ? ("passed" as const)
              : ("failed" as const),
        ...(item.review_json
          ? { review: JSON.parse(item.review_json) as EvaluationReview }
          : {}),
      };
    });
    const terminal = items.every(
      (i) => i.run.status === "completed" || i.run.status === "failed",
    );
    return {
      id: row.id,
      roomId: row.room_id,
      suite: snapshot,
      variants: JSON.parse(row.variants_json),
      status: terminal
        ? "completed"
        : items.every((i) => i.run.status === "queued")
          ? "queued"
          : "running",
      createdAt: row.created_at,
      productName: context.productName,
      factSnapshot: context.facts,
      items,
    };
  };

  app.post("/v1/profiles/:id/examples/import", async (c) => {
    const input = exampleImportSchema.parse(await c.req.json()),
      tenant = c.get("tenantId"),
      id = c.req.param("id");
    const requestDigest = digest(input);
    const receipt = agentTransaction(db, () => {
      profile(tenant, id);
      const prior = db
        .prepare(
          "SELECT request_digest,receipt_json FROM agent_example_imports WHERE tenant_id=? AND profile_id=? AND idempotency_key=?",
        )
        .get(tenant, id, input.idempotencyKey) as
        { request_digest: string; receipt_json: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest)
          throw new HTTPException(409, {
            message:
              "Idempotency key was already used for a different example import",
          });
        return JSON.parse(prior.receipt_json) as ExampleImportReceipt;
      }
      const current = profile(tenant, id);
      if (current.latestVersion !== input.baseVersion)
        throw new HTTPException(409, {
          message:
            "The prompt changed; reload the latest version before importing examples",
        });
      const base = version(tenant, id, input.baseVersion);
      const key = (example: { situation: string; response: string }) =>
        JSON.stringify([example.situation.trim(), example.response.trim()]);
      const seen = new Set(base.examples.map(key)),
        examples = [...base.examples];
      for (const example of input.examples)
        if (!seen.has(key(example))) {
          seen.add(key(example));
          examples.push(example);
        }
      if (examples.length > 12)
        throw new HTTPException(409, {
          message:
            "A prompt can contain at most 12 imported examples; reduce the draft examples first",
        });
      const next = current.latestVersion + 1,
        now = clock();
      const content = {
        systemPrompt: base.systemPrompt,
        styleGuide: base.styleGuide,
        audience: base.audience,
        examples,
      };
      const result: ExampleImportReceipt = {
        id: randomUUID(),
        sourceName: input.sourceName,
        authorization: input.authorization,
        importedCount: examples.length - base.examples.length,
        createdAt: now,
        version: next,
      };
      db.prepare("INSERT INTO agent_prompt_versions VALUES(?,?,?,?,?)").run(
        tenant,
        id,
        next,
        JSON.stringify(content),
        now,
      );
      db.prepare(
        "UPDATE agent_profiles SET latest_version=? WHERE tenant_id=? AND id=?",
      ).run(next, tenant, id);
      db.prepare(
        "INSERT INTO agent_example_imports VALUES(?,?,?,?,?,?,?,?)",
      ).run(
        tenant,
        id,
        result.id,
        input.idempotencyKey,
        requestDigest,
        next,
        JSON.stringify(result),
        now,
      );
      return result;
    });
    return c.json(
      { receipt, version: version(tenant, id, receipt.version) },
      201,
    );
  });
  app.get("/v1/profiles/:id/example-imports", (c) => {
    const tenant = c.get("tenantId"),
      id = c.req.param("id");
    profile(tenant, id);
    return c.json({
      imports: (
        db
          .prepare(
            "SELECT receipt_json FROM agent_example_imports WHERE tenant_id=? AND profile_id=? ORDER BY created_at DESC,rowid DESC",
          )
          .all(tenant, id) as { receipt_json: string }[]
      ).map((r) => JSON.parse(r.receipt_json) as ExampleImportReceipt),
    });
  });
  app.get("/v1/suites", (c) => {
    const roomId = idSchema.parse(c.req.query("roomId"));
    return c.json({
      suites: (
        db
          .prepare(
            "SELECT * FROM agent_evaluation_suites WHERE tenant_id=? AND room_id=? ORDER BY created_at DESC,rowid DESC",
          )
          .all(c.get("tenantId"), roomId) as SuiteRow[]
      ).map(suiteDto),
    });
  });
  app.post("/v1/suites", async (c) => {
    const input = suiteSchema.parse(await c.req.json()),
      tenant = c.get("tenantId"),
      id = randomUUID();
    agentTransaction(db, () => {
      const revision = Number(
        db
          .prepare(
            "SELECT COALESCE(MAX(revision),0)+1 AS next FROM agent_evaluation_suites WHERE tenant_id=? AND room_id=? AND name=?",
          )
          .get(tenant, input.roomId, input.name)!.next,
      );
      db.prepare(
        "INSERT INTO agent_evaluation_suites VALUES(?,?,?,?,?,?,?)",
      ).run(
        tenant,
        id,
        input.roomId,
        input.name,
        revision,
        JSON.stringify(input.cases),
        clock(),
      );
    });
    return c.json({ suite: suite(tenant, id) }, 201);
  });
  app.post("/v1/evaluations", async (c) => {
    const input = z
      .object({
        suiteId: idSchema,
        variants: z
          .array(
            z
              .object({
                profileId: idSchema,
                version: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1)
          .max(2)
          .refine((items) =>
            unique(items, (v) => `${v.profileId}:${v.version}`),
          ),
        context: deps.contextSchema,
        idempotencyKey: z.string().min(1).max(200),
      })
      .strict()
      .parse(await c.req.json());
    const tenant = c.get("tenantId"),
      requestDigest = digest(input);
    const id = agentTransaction(db, () => {
      const prior = db
        .prepare(
          "SELECT id,request_digest FROM agent_evaluations WHERE tenant_id=? AND idempotency_key=?",
        )
        .get(tenant, input.idempotencyKey) as
        { id: string; request_digest: string } | undefined;
      if (prior) {
        if (prior.request_digest !== requestDigest)
          throw new HTTPException(409, {
            message:
              "Idempotency key was already used for a different evaluation",
          });
        return prior.id;
      }
      const snapshot = suite(tenant, input.suiteId);
      if (snapshot.roomId !== input.context.roomId)
        throw new HTTPException(409, {
          message: "Evaluation context must belong to the suite room",
        });
      if (!unique(input.context.facts, (fact) => fact.id))
        throw new HTTPException(400, {
          message: "Fact snapshot contains duplicate identifiers",
        });
      const evaluationId = randomUUID();
      const variants = input.variants.map((v) => ({
        ...v,
        profile: profile(tenant, v.profileId),
        prompt: version(tenant, v.profileId, v.version),
      }));
      const items = variants.flatMap((v, variantIndex) =>
        snapshot.cases.map((sample) => ({
          id: randomUUID(),
          variantIndex,
          caseId: sample.id,
          snapshot: {
            profile: v.profile,
            prompt: v.prompt,
            context: {
              ...input.context,
              transcript: sample.transcript,
              question: sample.question,
            },
          } satisfies AgentExecutionInput,
        })),
      );
      const jobs = reserve(
        tenant,
        items.map((item) => ({
          snapshot: item.snapshot,
          mode: "rehearsal",
          idempotencyKey: `evaluation:${evaluationId}:${item.id}`,
          requestDigest: digest(item.snapshot),
        })),
      );
      db.prepare(
        "INSERT INTO agent_evaluations VALUES(?,?,?,?,?,?,?,?,?,?)",
      ).run(
        tenant,
        evaluationId,
        snapshot.roomId,
        snapshot.id,
        JSON.stringify(snapshot),
        JSON.stringify(
          variants.map((v) => ({
            profileId: v.profileId,
            version: v.version,
            name: v.profile.name,
          })),
        ),
        JSON.stringify(input.context),
        input.idempotencyKey,
        requestDigest,
        clock(),
      );
      items.forEach((item, index) =>
        db
          .prepare(
            "INSERT INTO agent_evaluation_items VALUES(?,?,?,?,?,?,NULL)",
          )
          .run(
            tenant,
            item.id,
            evaluationId,
            item.caseId,
            item.variantIndex,
            jobs[index],
          ),
      );
      return evaluationId;
    });
    const output = report(tenant, id);
    schedule();
    return c.json({ evaluation: output }, 202);
  });
  app.get("/v1/evaluations", (c) => {
    const query = z
      .object({
        roomId: idSchema,
        limit: z.coerce.number().int().min(1).max(20).default(10),
      })
      .parse(c.req.query());
    const tenant = c.get("tenantId"),
      rows = db
        .prepare(
          "SELECT id FROM agent_evaluations WHERE tenant_id=? AND room_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
        )
        .all(tenant, query.roomId, query.limit) as { id: string }[];
    return c.json({ evaluations: rows.map((r) => report(tenant, r.id)) });
  });
  app.get("/v1/evaluations/:id", (c) =>
    c.json({ evaluation: report(c.get("tenantId"), c.req.param("id")) }),
  );
  app.post("/v1/evaluations/:id/items/:itemId/review", async (c) => {
    const review = reviewSchema.parse(await c.req.json()),
      tenant = c.get("tenantId"),
      id = c.req.param("id"),
      itemId = c.req.param("itemId");
    agentTransaction(db, () => {
      const item = report(tenant, id).items.find((item) => item.id === itemId);
      if (!item)
        throw new HTTPException(404, { message: "Evaluation item not found" });
      if (item.run.status !== "completed" || !item.run.result)
        throw new HTTPException(409, {
          message:
            "Only completed generation results can receive a human review",
        });
      db.prepare(
        "UPDATE agent_evaluation_items SET review_json=? WHERE tenant_id=? AND evaluation_id=? AND id=?",
      ).run(JSON.stringify(review), tenant, id, itemId);
    });
    return c.json({ evaluation: report(tenant, id) });
  });
}
