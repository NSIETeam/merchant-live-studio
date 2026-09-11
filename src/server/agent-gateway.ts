import { presenterSchema } from "../shared/presenter-schema.js";
import type { Hono } from "hono";
import { z } from "zod";
import type { AgentBridge } from "./services/agent-bridge.js";
import type { AgentContext, AgentRun } from "../shared/agent.js";
import { attachTrainingGateway } from "./training-gateway.js";

const id = (value: string) =>
  z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,100}$/)
    .parse(value);
const prompt = z
  .object({
    presenter: presenterSchema.optional(),
    systemPrompt: z.string().trim().min(1).max(6000),
    styleGuide: z.string().max(3000),
    audience: z.string().max(500),
    examples: z
      .array(
        z
          .object({
            situation: z.string().max(500),
            response: z.string().max(1200),
          })
          .strict(),
      )
      .max(12),
  })
  .strict();
const transcript = z.object({
  transcript: z.string().max(4000),
  question: z.string().max(200).optional(),
});

export function attachAgentGateway(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  bridge: AgentBridge,
  contextFor: (
    roomId: string,
    tenant: string,
    input: { transcript: string; question?: string },
  ) => AgentContext,
  validateRun: (tenant: string, run: AgentRun) => AgentRun = (_, run) => run,
) {
  attachTrainingGateway(app, bridge, contextFor, validateRun);
  app.get("/api/merchant/agent/status", async (c) =>
    c.json(await bridge.status()),
  );
  app.get("/api/merchant/agent/profiles", async (c) =>
    c.json(await bridge.request(c.get("merchantId"), "/v1/profiles")),
  );
  app.post("/api/merchant/agent/profiles", async (c) => {
    const body = prompt
      .extend({
        name: z.string().trim().min(1).max(80),
        kind: z.literal("brand"),
      })
      .parse(await c.req.json());
    return c.json(
      await bridge.request(c.get("merchantId"), "/v1/profiles", "POST", body),
      201,
    );
  });
  app.get("/api/merchant/agent/profiles/:id/versions", async (c) =>
    c.json(
      await bridge.request(
        c.get("merchantId"),
        `/v1/profiles/${id(c.req.param("id"))}/versions`,
      ),
    ),
  );
  app.post("/api/merchant/agent/profiles/:id/versions", async (c) =>
    c.json(
      await bridge.request(
        c.get("merchantId"),
        `/v1/profiles/${id(c.req.param("id"))}/versions`,
        "POST",
        prompt.parse(await c.req.json()),
      ),
      201,
    ),
  );
  app.post(
    "/api/merchant/agent/profiles/:id/versions/:version/publish",
    async (c) => {
      const version = z.coerce
        .number()
        .int()
        .positive()
        .parse(c.req.param("version"));
      return c.json(
        await bridge.request(
          c.get("merchantId"),
          `/v1/profiles/${id(c.req.param("id"))}/versions/${version}/publish`,
          "POST",
          {},
        ),
      );
    },
  );
  app.post("/api/merchant/rooms/:id/copilot", async (c) => {
    const body = transcript.strict().parse(await c.req.json());
    return c.json(
      await bridge.request(c.get("merchantId"), "/v1/check", "POST", {
        context: contextFor(c.req.param("id"), c.get("merchantId"), body),
      }),
    );
  });
  app.post("/api/merchant/rooms/:id/agent/runs", async (c) => {
    const body = transcript
      .extend({
        profileId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        version: z.number().int().positive().optional(),
        mode: z.enum(["rehearsal", "live"]),
        idempotencyKey: z.string().min(8).max(100),
      })
      .strict()
      .parse(await c.req.json());
    const context = contextFor(c.req.param("id"), c.get("merchantId"), body);
    const { transcript: _, question: __, ...selection } = body;
    const data = await bridge.request<{ run: AgentRun }>(
      c.get("merchantId"),
      "/v1/runs",
      "POST",
      {
        ...selection,
        context,
      },
    );
    return c.json({ run: validateRun(c.get("merchantId"), data.run) }, 202);
  });
  app.get("/api/merchant/agent/runs/:id", async (c) => {
    const data = await bridge.request<{ run: AgentRun }>(
      c.get("merchantId"),
      `/v1/runs/${id(c.req.param("id"))}`,
    );
    return c.json({ run: validateRun(c.get("merchantId"), data.run) });
  });
  app.post("/api/merchant/agent/runs/:id/feedback", async (c) => {
    const body = z
      .object({
        rating: z.enum(["useful", "needs_work"]),
        note: z.string().max(1000),
      })
      .strict()
      .parse(await c.req.json());
    const data = await bridge.request<{ run: AgentRun }>(
      c.get("merchantId"),
      `/v1/runs/${id(c.req.param("id"))}/feedback`,
      "POST",
      body,
    );
    return c.json({ run: validateRun(c.get("merchantId"), data.run) });
  });
  app.get("/api/merchant/rooms/:id/agent/latest", async (c) => {
    const context = contextFor(c.req.param("id"), c.get("merchantId"), {
      transcript: "",
    });
    try {
      const data = await bridge.request<{ runs: AgentRun[] }>(
        c.get("merchantId"),
        `/v1/runs?roomId=${encodeURIComponent(context.roomId)}&mode=live&limit=1`,
      );
      return c.json({
        available: true,
        run: data.runs[0]
          ? validateRun(c.get("merchantId"), data.runs[0])
          : null,
      });
    } catch {
      return c.json({ available: false, run: null });
    }
  });
}
