import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { Membership } from "../../shared/membership.js";
export interface Config {
  production: boolean;
  recordingsRoot: string;
  recordingOutbox: string;
  requireReviewedLive: boolean;
  demoMode: boolean;
  host: string;
  port: number;
  appOrigin: string;
  databasePath: string;
  sessionSecret: string;
  merchantCredentials: Record<string, string>;
  merchantMemberships?: Record<string, Membership>;
  streamProvider: "srs" | "mediamtx";
  streamRtmpBase: string;
  streamHlsBase: string;
  streamAuthSecret: string;
  mediaControlUrl: string;
  requirePlayback: boolean;
  trustedProxyIps: string[];
  mediaControlToken: string;
  basePath: string;
  agentServiceUrl: string;
  agentServiceToken: string;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const demoMode =
    (env.DEMO_MODE ?? (production ? "false" : "true")) === "true";
  const sessionSecret =
    env.SESSION_SECRET || (production ? "" : randomBytes(32).toString("hex"));
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (production && demoMode)
    throw new Error("DEMO_MODE must be false in production");
  if ((env.PAYMENT_PROVIDER ?? "simulation") !== "simulation")
    throw new Error("Real payment provider is not implemented; use simulation");
  const accountId = z
    .string()
    .regex(/^[a-zA-Z0-9_-]{1,50}$/)
    .refine(
      (id) => !Object.hasOwn(Object.prototype, id),
      "Reserved account identifier",
    );
  const rejectReservedKeys = (value: unknown) => {
    if (
      value &&
      typeof value === "object" &&
      Object.keys(value).some((id) => Object.hasOwn(Object.prototype, id))
    )
      throw new Error("Reserved account identifier");
    return value;
  };
  const merchantCredentials = z
    .record(accountId, z.string().min(24))
    .parse(rejectReservedKeys(JSON.parse(env.MERCHANT_CREDENTIALS || "{}")));
  if (production && !Object.keys(merchantCredentials).length)
    throw new Error("MERCHANT_CREDENTIALS is required in production");
  const merchantMemberships = z
    .record(
      accountId,
      z
        .object({
          merchantId: accountId,
          role: z.enum(["editor", "reviewer", "presenter", "analyst"]),
        })
        .strict(),
    )
    .parse(rejectReservedKeys(JSON.parse(env.MERCHANT_MEMBERSHIPS || "{}")));
  for (const [actor, member] of Object.entries(merchantMemberships)) {
    if (
      actor === "demo" ||
      !Object.hasOwn(merchantCredentials, actor) ||
      actor === member.merchantId ||
      Object.hasOwn(merchantMemberships, member.merchantId) ||
      (!Object.hasOwn(merchantCredentials, member.merchantId) &&
        !(demoMode && member.merchantId === "demo"))
    )
      throw new Error(
        "MERCHANT_MEMBERSHIPS must map credentialed members to a distinct owner account",
      );
  }
  const appOrigin = z.url().parse(env.APP_ORIGIN || "http://127.0.0.1:5173");
  if (production && !appOrigin.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must use HTTPS");
  const agentServiceUrl = (
    env.AGENT_SERVICE_URL ?? (production ? "" : "http://127.0.0.1:8788")
  ).replace(/\/$/, "");
  if (agentServiceUrl) {
    const parsed = new URL(agentServiceUrl);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      parsed.pathname !== "/"
    )
      throw new Error(
        "AGENT_SERVICE_URL must be an HTTP(S) origin without credentials or path",
      );
  }
  const agentServiceToken =
    env.AGENT_SERVICE_TOKEN ||
    (production ? "" : "local-agent-development-token-change-me");
  if (production && agentServiceUrl && agentServiceToken.length < 32)
    throw new Error("AGENT_SERVICE_TOKEN must contain at least 32 characters");
  if (
    production &&
    agentServiceUrl &&
    agentServiceToken === "local-agent-development-token-change-me"
  )
    throw new Error(
      "The known development Agent token cannot be used in production",
    );
  if (Boolean(env.RECORDINGS_ROOT) !== Boolean(env.RECORDING_OUTBOX))
    throw new Error("Configure both RECORDINGS_ROOT and RECORDING_OUTBOX");
  return {
    recordingsRoot: env.RECORDINGS_ROOT || "",
    recordingOutbox: env.RECORDING_OUTBOX || "",
    production,
    requireReviewedLive: production || env.REQUIRE_REVIEWED_LIVE === "true",
    demoMode,
    sessionSecret,
    merchantCredentials,
    merchantMemberships,
    appOrigin: new URL(appOrigin).origin,
    host: env.HOST || "127.0.0.1",
    port: z.coerce
      .number()
      .int()
      .min(1)
      .max(65535)
      .parse(env.PORT || 8787),
    databasePath: env.DATABASE_PATH || "./data/studio.sqlite",
    streamProvider: z
      .enum(["srs", "mediamtx"])
      .parse(env.STREAM_PROVIDER || "mediamtx"),
    streamRtmpBase: env.STREAM_RTMP_BASE || "rtmp://localhost:1935/live",
    streamHlsBase: env.STREAM_HLS_BASE || "http://localhost:8888/live",
    streamAuthSecret: env.STREAM_AUTH_SECRET || "",
    mediaControlUrl: env.MEDIA_CONTROL_URL || "",
    mediaControlToken: env.MEDIA_CONTROL_TOKEN || "",
    basePath: env.APP_BASE_PATH || "/",
    requirePlayback:
      (env.REQUIRE_PLAYBACK ?? (production ? "true" : "false")) === "true",
    trustedProxyIps: (env.TRUSTED_PROXY_IPS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    agentServiceUrl,
    agentServiceToken,
  };
}
