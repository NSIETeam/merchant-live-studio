import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { getCookie, setCookie } from "hono/cookie";
import type { Context } from "hono";
import type { Config } from "./config.js";
export interface Session {
  id: string;
  role: "merchant" | "viewer";
  expires: number;
}
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
  const session = { id, role, expires: Date.now() + 12 * 60 * 60 * 1000 };
  const payload = Buffer.from(JSON.stringify(session)).toString("base64url");
  const signature = createHmac("sha256", config.sessionSecret)
    .update(payload)
    .digest("base64url");
  setCookie(c, `studio_${role}`, `${payload}.${signature}`, {
    httpOnly: true,
    secure: config.production,
    sameSite: "Strict",
    path: "/",
    maxAge: 43200,
  });
  return session;
}
export function readSession(
  c: Context,
  config: Config,
  role: Session["role"],
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
    return session.role === role &&
      session.expires > Date.now() &&
      typeof session.id === "string"
      ? session
      : null;
  } catch {
    return null;
  }
}
