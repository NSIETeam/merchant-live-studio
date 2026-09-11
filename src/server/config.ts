import { randomBytes } from "node:crypto";
import { z } from "zod";
export interface Config {
  production: boolean;
  demoMode: boolean;
  host: string;
  port: number;
  appOrigin: string;
  databasePath: string;
  sessionSecret: string;
  merchantCredentials: Record<string, string>;
  streamProvider: "srs" | "mediamtx";
  streamRtmpBase: string;
  streamHlsBase: string;
  streamAuthSecret: string;
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
  const merchantCredentials = z
    .record(z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/), z.string().min(24))
    .parse(JSON.parse(env.MERCHANT_CREDENTIALS || "{}"));
  if (production && !Object.keys(merchantCredentials).length)
    throw new Error("MERCHANT_CREDENTIALS is required in production");
  const appOrigin = z.url().parse(env.APP_ORIGIN || "http://127.0.0.1:5173");
  if (production && !appOrigin.startsWith("https://"))
    throw new Error("Production APP_ORIGIN must use HTTPS");
  return {
    production,
    demoMode,
    sessionSecret,
    merchantCredentials,
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
  };
}
