import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AgentBridge } from "./services/agent-bridge.js";
import type { AgentContext, AgentRun } from "../shared/agent.js";
import type { EvaluationReport } from "../shared/training.js";

const identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
const caseSchema = z
  .object({
    id: identifier,
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
          .refine((v) => new Set(v).size === v.length),
        forbiddenPhrases: z.array(z.string().trim().min(1).max(100)).max(8),
      })
      .strict(),
  })
  .strict();
export function attachTrainingGateway(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  bridge: AgentBridge,
  contextFor: (
    roomId: string,
    tenant: string,
    input: { transcript: string; question?: string },
  ) => AgentContext,
  validateRun: (tenant: string, run: AgentRun) => AgentRun,
) {
  const context = (roomId: string, tenant: string) => {
    const { campaignCue: _liveCountdown, ...snapshot } = contextFor(
      roomId,
      tenant,
      { transcript: "" },
    );
    // Evaluation inputs must stay stable across retries and compared versions.
    return snapshot;
  };
  const validate = (
    tenant: string,
    evaluation: EvaluationReport,
  ): EvaluationReport => {
    const current = context(evaluation.roomId, tenant);
    const keys = (facts: AgentContext["facts"]) =>
      facts
        .map((f) => JSON.stringify([f.id, f.text, f.evidence, f.approved]))
        .sort();
    const items = evaluation.items.map((item) => ({
      ...item,
      run: validateRun(tenant, item.run),
    }));
    const stale =
      items.some((item) => item.run.stale) ||
      current.productName !== evaluation.productName ||
      current.category !== evaluation.category ||
      JSON.stringify(keys(current.facts)) !==
        JSON.stringify(keys(evaluation.factSnapshot));
    return {
      ...evaluation,
      items,
      stale,
      staleReason: stale
        ? "商品资料或审核状态已变化，本报告保留为历史记录，请用当前资料重新评测。"
        : undefined,
    };
  };
  app.post("/api/merchant/agent/profiles/:id/examples/import", async (c) => {
    const input = z
      .object({
        sourceName: z.string().trim().min(1).max(120),
        authorization: z.enum(["owned", "licensed"]),
        examples: z
          .array(
            z
              .object({
                situation: z.string().trim().min(1).max(500),
                response: z.string().trim().min(1).max(1200),
              })
              .strict(),
          )
          .min(1)
          .max(12),
        baseVersion: z.number().int().positive(),
        idempotencyKey: z.string().min(8).max(100),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await bridge.request(
        c.get("merchantId"),
        `/v1/profiles/${identifier.parse(c.req.param("id"))}/examples/import`,
        "POST",
        input,
      ),
      201,
    );
  });
  app.get("/api/merchant/agent/profiles/:id/example-imports", async (c) =>
    c.json(
      await bridge.request(
        c.get("merchantId"),
        `/v1/profiles/${identifier.parse(c.req.param("id"))}/example-imports`,
      ),
    ),
  );
  app.get("/api/merchant/rooms/:id/agent/suites", async (c) => {
    const current = context(c.req.param("id"), c.get("merchantId"));
    return c.json(
      await bridge.request(
        c.get("merchantId"),
        `/v1/suites?roomId=${encodeURIComponent(current.roomId)}`,
      ),
    );
  });
  app.post("/api/merchant/rooms/:id/agent/suites", async (c) => {
    const current = context(c.req.param("id"), c.get("merchantId"));
    const body = z
      .object({
        name: z.string().trim().min(1).max(100),
        cases: z
          .array(caseSchema)
          .min(1)
          .max(8)
          .refine((v) => new Set(v.map((c) => c.id)).size === v.length),
      })
      .strict()
      .parse(await c.req.json());
    return c.json(
      await bridge.request(c.get("merchantId"), "/v1/suites", "POST", {
        roomId: current.roomId,
        ...body,
      }),
      201,
    );
  });
  app.post("/api/merchant/rooms/:id/agent/evaluations", async (c) => {
    const tenant = c.get("merchantId"),
      current = context(c.req.param("id"), tenant);
    const body = z
      .object({
        suiteId: identifier,
        variants: z
          .array(
            z
              .object({
                profileId: identifier,
                version: z.number().int().positive(),
              })
              .strict(),
          )
          .min(1)
          .max(2)
          .refine(
            (v) =>
              new Set(v.map((i) => `${i.profileId}:${i.version}`)).size ===
              v.length,
          ),
        idempotencyKey: z.string().min(8).max(100),
      })
      .strict()
      .parse(await c.req.json());
    const result = await bridge.request<{ evaluation: EvaluationReport }>(
      tenant,
      "/v1/evaluations",
      "POST",
      { ...body, context: current },
    );
    return c.json({ evaluation: validate(tenant, result.evaluation) }, 202);
  });
  app.get("/api/merchant/rooms/:id/agent/evaluations", async (c) => {
    const tenant = c.get("merchantId"),
      current = context(c.req.param("id"), tenant);
    const result = await bridge.request<{ evaluations: EvaluationReport[] }>(
      tenant,
      `/v1/evaluations?roomId=${encodeURIComponent(current.roomId)}&limit=10`,
    );
    return c.json({
      evaluations: result.evaluations.map((e) => validate(tenant, e)),
    });
  });
  app.get("/api/merchant/agent/evaluations/:id", async (c) => {
    const tenant = c.get("merchantId");
    const result = await bridge.request<{ evaluation: EvaluationReport }>(
      tenant,
      `/v1/evaluations/${identifier.parse(c.req.param("id"))}`,
    );
    return c.json({ evaluation: validate(tenant, result.evaluation) });
  });
  app.post(
    "/api/merchant/agent/evaluations/:id/items/:itemId/review",
    async (c) => {
      const body = z
        .object({
          style: z.number().int().min(1).max(5),
          naturalness: z.number().int().min(1).max(5),
          decision: z.enum(["acceptable", "revise"]),
          note: z.string().max(1000),
        })
        .strict()
        .parse(await c.req.json());
      const tenant = c.get("merchantId");
      const existing = await bridge.request<{ evaluation: EvaluationReport }>(
        tenant,
        `/v1/evaluations/${identifier.parse(c.req.param("id"))}`,
      );
      if (validate(tenant, existing.evaluation).stale)
        throw new HTTPException(409, {
          message:
            "评测依据已变化，请重新评测后再评分。历史评分仅针对原资料快照。",
        });
      const result = await bridge.request<{ evaluation: EvaluationReport }>(
        tenant,
        `/v1/evaluations/${identifier.parse(c.req.param("id"))}/items/${identifier.parse(c.req.param("itemId"))}/review`,
        "POST",
        body,
      );
      return c.json({ evaluation: validate(tenant, result.evaluation) });
    },
  );
}
