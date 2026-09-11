import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Config } from "./config.js";
import type { DB } from "./db.js";
export interface Session {
  id: string;
  role: "merchant" | "viewer";
  expires: number;
  sid: string;
  credentialVersion?: string;
}
const credentialVersion = (config: Config, id: string) =>
  createHmac("sha256", config.sessionSecret)
    .update(
      config.demoMode && id === "demo"
        ? "local-demo"
        : config.merchantCredentials[id] || "disabled",
    )
    .digest("hex");
export function equalSecret(a: string, b: string) {
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function issueSession(
  c: Context,
  config: Config,
  role: Session["role"],
  id: string = randomUUID(),
) {
  const session = {
    id,
    role,
    sid: randomUUID(),
    expires: Date.now() + 12 * 60 * 60 * 1000,
    ...(role === "merchant"
      ? { credentialVersion: credentialVersion(config, id) }
      : {}),
  };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  setCookie(c, `studio_${role}`, `${payload}.${signature}`, {
    httpOnly: true,
    secure: config.production,
    sameSite: "Strict",
    path: config.basePath,
    maxAge: 43200,
  });
  return session;
}
export function readSession(
  c: Context,
  config: Config,
  role: Session["role"],
  db?: DB,
): Session | null {
  const raw = getCookie(c, `studio_${role}`);
  if (!raw) return null;
  const [payload, signature, ...rest] = raw.split(".");
  if (!payload || !signature || rest.length) return null;
  const expected = createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  if (!equalSecret(signature, expected)) return null;
  try {
    const session = JSON.parse(Buffer.from(payload, "base64url").toString());
    if (typeof session.sid !== "string") return null;
    if (
      role === "merchant" &&
      (!equalSecret(
        session.credentialVersion || "",
        credentialVersion(config, session.id),
      ) ||
        (!config.merchantCredentials[session.id] &&
          !(config.demoMode && session.id === "demo")))
    )
      return null;
    if (
      db &&
      db
        .prepare("SELECT id FROM revoked_sessions WHERE id=? AND expires_at>?")
        .get(session.sid, Date.now())
    )
      return null;
    return session.role === role &&
      session.expires > Date.now() &&
      typeof session.id === "string"
      ? session
      : null;
  } catch {
    return null;
  }
}
