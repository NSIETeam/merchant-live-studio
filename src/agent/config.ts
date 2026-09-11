import { z } from "zod";
import type { AgentModelConfig } from "./core/index.js";

export const LOCAL_AGENT_SERVICE_TOKEN =
  "local-agent-development-token-change-me";
export interface AgentConfig {
  production: boolean;
  host: string;
  port: number;
  databasePath: string;
  serviceToken: string;
  queueLimit: number;
  tenantQueueLimit: number;
  concurrency: number;
  model: AgentModelConfig;
}

export function loadAgentConfig(
  env: NodeJS.ProcessEnv = process.env,
): AgentConfig {
  const production = env.NODE_ENV === "production";
  const host = env.AGENT_HOST || "127.0.0.1";
  const explicitToken = env.AGENT_SERVICE_TOKEN || "";
  if (
    (production || !["127.0.0.1", "::1", "localhost"].includes(host)) &&
    explicitToken.length < 32
  )
    throw new Error("AGENT_SERVICE_TOKEN must contain at least 32 characters");
  const serviceToken = explicitToken || LOCAL_AGENT_SERVICE_TOKEN;
  if (production && serviceToken === LOCAL_AGENT_SERVICE_TOKEN)
    throw new Error(
      "The known development Agent token cannot be used in production",
    );
  if (serviceToken.length < 32)
    throw new Error("AGENT_SERVICE_TOKEN must contain at least 32 characters");
  const integer = (
    value: string | undefined,
    fallback: number,
    maximum: number,
  ) =>
    z.coerce
      .number()
      .int()
      .min(1)
      .max(maximum)
      .parse(value || fallback);
  const provider = z
    .enum(["grounded-rules", "openai-compatible"])
    .parse(env.AGENT_MODEL_PROVIDER || "grounded-rules");
  const model: AgentModelConfig = { provider };
  if (provider === "openai-compatible") {
    let endpoint: URL;
    try {
      endpoint = new URL(env.AGENT_MODEL_ENDPOINT || "");
    } catch {
      throw new Error(
        "AGENT_MODEL_ENDPOINT must be a valid complete model URL",
      );
    }
    const local = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
      endpoint.hostname,
    );
    if (
      endpoint.username ||
      endpoint.password ||
      endpoint.hash ||
      !(
        endpoint.protocol === "https:" ||
        (endpoint.protocol === "http:" && local)
      )
    )
      throw new Error(
        "AGENT_MODEL_ENDPOINT requires HTTPS or a loopback HTTP endpoint",
      );
    if (!env.AGENT_MODEL_MODEL?.trim())
      throw new Error(
        "AGENT_MODEL_MODEL is required for the configured provider",
      );
    model.endpoint = endpoint.href;
    model.model = env.AGENT_MODEL_MODEL.trim();
    model.apiKey = env.AGENT_MODEL_API_KEY || undefined;
    model.timeoutMs = integer(env.AGENT_MODEL_TIMEOUT_MS, 10000, 30000);
  }
  return {
    production,
    host,
    serviceToken,
    model,
    port: integer(env.AGENT_PORT, 8788, 65535),
    databasePath: env.AGENT_DATABASE_PATH || "./data/agent.sqlite",
    queueLimit: integer(env.AGENT_QUEUE_LIMIT, 100, 10000),
    tenantQueueLimit: integer(env.AGENT_TENANT_QUEUE_LIMIT, 20, 10000),
    concurrency: integer(env.AGENT_CONCURRENCY, 2, 8),
  };
}
