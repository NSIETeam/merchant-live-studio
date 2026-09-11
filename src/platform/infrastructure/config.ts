import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { z } from "zod";
import type { Membership } from "../../shared/membership.js";
import type {
  PlatformComplianceData,
  RetentionPolicyData,
} from "../../shared/platform-compliance.js";
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
  speechProvider: "disabled" | "webhook";
  speechIngestSecret: string;
  speechAgentProfileId: string;
  speechDispatchConcurrency: number;
  mediaControlUrl: string;
  requirePlayback: boolean;
  trustedProxyIps: string[];
  mediaControlToken: string;
  basePath: string;
  agentServiceUrl: string;
  agentServiceToken: string;
  platformCompliance: PlatformComplianceData | null;
  retentionPolicy: RetentionPolicyData | null;
  requestConcurrencyMax: number;
  audienceConcurrencyMax: number;
  wechatOAuth: {
    appId: string;
    appSecret: string;
    identitySecret: string;
    redirectUri: string;
  } | null;
  wechatJsSdkEnabled: boolean;
  paymentProvider: "simulation" | "wechat";
  wechatTransferConfigPath: string;
  wechatRecipientEncryptionKey: string;
  releaseRevision: string | null;
}
export function readReleaseRevision(path = "REVISION") {
  let revision = "";
  try {
    revision = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("REVISION file cannot be read");
  }
  if (!/^[a-f0-9]{40}$/i.test(revision))
    throw new Error("REVISION must contain a complete Git commit SHA");
  return revision.toLowerCase();
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === "production";
  const demoMode =
    (env.DEMO_MODE ?? (production ? "false" : "true")) === "true";
  const releaseRevision = readReleaseRevision();
  const sessionSecret =
    env.SESSION_SECRET || (production ? "" : randomBytes(32).toString("hex"));
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (production && demoMode)
    throw new Error("DEMO_MODE must be false in production");
  const paymentProvider = z
    .enum(["simulation", "wechat"])
    .parse(env.PAYMENT_PROVIDER || "simulation");
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
  const basePath = z
    .string()
    .regex(/^\/(?:[a-zA-Z0-9_-]+\/)*$/)
    .parse(env.APP_BASE_PATH || "/");
  const wechatOAuthEnabled = z
    .enum(["true", "false"])
    .parse(env.WECHAT_OAUTH_ENABLED || "false");
  const wechatJsSdkEnabled =
    z.enum(["true", "false"]).parse(env.WECHAT_JS_SDK_ENABLED || "false") ===
    "true";
  if (wechatJsSdkEnabled && wechatOAuthEnabled !== "true")
    throw new Error(
      "WECHAT_JS_SDK_ENABLED requires the complete WeChat OAuth configuration",
    );
  let wechatOAuth: Config["wechatOAuth"] = null;
  if (wechatOAuthEnabled === "true") {
    const appId = z
      .string()
      .regex(/^wx[a-zA-Z0-9]{16}$/)
      .parse(env.WECHAT_APP_ID || "");
    const appSecret = z
      .string()
      .min(32)
      .max(128)
      .parse(env.WECHAT_APP_SECRET || "");
    const identitySecret = z
      .string()
      .min(32)
      .max(128)
      .parse(env.WECHAT_IDENTITY_SECRET || "");
    const redirectUri = z
      .url()
      .max(1000)
      .parse(env.WECHAT_OAUTH_REDIRECT_URI || "");
    const parsedRedirect = new URL(redirectUri);
    if (
      parsedRedirect.origin !== new URL(appOrigin).origin ||
      parsedRedirect.pathname !== `${basePath}api/channels/wechat/callback` ||
      parsedRedirect.search ||
      parsedRedirect.hash ||
      (production && parsedRedirect.protocol !== "https:")
    )
      throw new Error(
        "WECHAT_OAUTH_REDIRECT_URI must be the current HTTPS application callback",
      );
    wechatOAuth = { appId, appSecret, identitySecret, redirectUri };
  }
  const wechatTransferConfigPath = env.WECHAT_TRANSFER_CONFIG_PATH || "";
  const wechatRecipientEncryptionKey =
    env.WECHAT_RECIPIENT_ENCRYPTION_KEY || "";
  if (paymentProvider === "wechat") {
    if (demoMode)
      throw new Error("Real WeChat payment cannot run while DEMO_MODE is true");
    if (!wechatOAuth)
      throw new Error("Real WeChat payment requires WeChat OAuth");
    if (!wechatJsSdkEnabled)
      throw new Error(
        "Real WeChat payment requires WECHAT_JS_SDK_ENABLED for H5 confirmation",
      );
    if (!wechatTransferConfigPath.startsWith("/"))
      throw new Error(
        "WECHAT_TRANSFER_CONFIG_PATH must be an absolute private file path",
      );
    if (!/^[a-fA-F0-9]{64}$/.test(wechatRecipientEncryptionKey))
      throw new Error(
        "WECHAT_RECIPIENT_ENCRYPTION_KEY must be 64 hexadecimal characters",
      );
  }
  const policyUrl = z
    .url()
    .max(1000)
    .refine((value) => {
      const parsed = new URL(value);
      return (
        parsed.protocol === "https:" ||
        (parsed.protocol === "http:" &&
          ["127.0.0.1", "localhost", "::1"].includes(parsed.hostname))
      );
    }, "Policy URLs must use HTTPS outside local development");
  const complianceSchema = z
    .object({
      operatorName: z.string().trim().min(2).max(120),
      creditCode: z
        .string()
        .trim()
        .regex(/^[0-9A-Z]{18}$/),
      address: z.string().trim().min(5).max(240),
      contact: z.string().trim().min(5).max(120),
      complaintContact: z.string().trim().min(5).max(240),
      privacyContact: z.string().trim().min(5).max(240),
      effectiveDate: z.iso.date(),
      privacyPolicyUrl: policyUrl,
      serviceTermsUrl: policyUrl,
    })
    .strict();
  const platformCompliance = env.PLATFORM_COMPLIANCE?.trim()
    ? complianceSchema.parse(JSON.parse(env.PLATFORM_COMPLIANCE))
    : null;
  const retentionSchema = z
    .object({
      effectiveDate: z.iso.date(),
      liveContentDays: z.number().int().min(60).max(3650),
      commerceRecordsMonths: z.number().int().min(36).max(120),
      securityLogsMonths: z.number().int().min(6).max(120),
      deletionReviewContact: z.string().trim().min(5).max(240),
    })
    .strict();
  const retentionPolicy = env.DATA_RETENTION_POLICY?.trim()
    ? retentionSchema.parse(JSON.parse(env.DATA_RETENTION_POLICY))
    : null;
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
  const speechProvider = z
    .enum(["disabled", "webhook"])
    .parse(env.SPEECH_PROVIDER || "disabled");
  const speechIngestSecret = env.SPEECH_INGEST_SECRET || "";
  if (speechProvider === "webhook" && speechIngestSecret.length < 32)
    throw new Error(
      "SPEECH_INGEST_SECRET must contain at least 32 characters when speech ingestion is enabled",
    );
  const speechAgentProfileId = env.SPEECH_AGENT_PROFILE_ID
    ? z
        .string()
        .regex(/^[a-zA-Z0-9_-]{1,100}$/)
        .parse(env.SPEECH_AGENT_PROFILE_ID)
    : "";
  const speechDispatchConcurrency = z.coerce
    .number()
    .int()
    .min(1)
    .max(16)
    .parse(env.SPEECH_DISPATCH_CONCURRENCY || 2);
  const requestConcurrencyMax = z.coerce
    .number()
    .int()
    .min(2)
    .max(4096)
    .parse(env.REQUEST_CONCURRENCY_MAX || (production ? 256 : 1024));
  const audienceConcurrencyMax = z.coerce
    .number()
    .int()
    .min(1)
    .max(4095)
    .parse(env.AUDIENCE_CONCURRENCY_MAX || (production ? 192 : 768));
  if (audienceConcurrencyMax >= requestConcurrencyMax)
    throw new Error(
      "AUDIENCE_CONCURRENCY_MAX must be lower than REQUEST_CONCURRENCY_MAX",
    );
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
    speechProvider,
    speechIngestSecret,
    speechAgentProfileId,
    speechDispatchConcurrency,
    mediaControlUrl: env.MEDIA_CONTROL_URL || "",
    mediaControlToken: env.MEDIA_CONTROL_TOKEN || "",
    basePath,
    requirePlayback:
      (env.REQUIRE_PLAYBACK ?? (production ? "true" : "false")) === "true",
    trustedProxyIps: (env.TRUSTED_PROXY_IPS || "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean),
    agentServiceUrl,
    agentServiceToken,
    platformCompliance,
    retentionPolicy,
    requestConcurrencyMax,
    audienceConcurrencyMax,
    wechatOAuth,
    wechatJsSdkEnabled,
    paymentProvider,
    wechatTransferConfigPath,
    wechatRecipientEncryptionKey,
    releaseRevision,
  };
}
