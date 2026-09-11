import { managedAccount } from "./managed-accounts.js";
import { findSessionAccess } from "./persistence/access-queries.js";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { DB } from "../../shared/persistence.js";
import type { Config } from "../infrastructure/public.js";
import { findRevokedSessionsByIdAndExpiresAt } from "./persistence/auth-queries.js";
export interface Session {
  id: string;
  role: "merchant" | "viewer";
  expires: number;
  sid: string;
  credentialVersion?: string;
  accessVersion?: number;
}
const credentialVersion = (config: Config, id: string, db?: DB) => {
  const account = managedAccount(db, config, id);
  const credential = Object.hasOwn(config.merchantCredentials, id)
    ? config.merchantCredentials[id]
    : undefined;
  const membership = Object.hasOwn(config.merchantMemberships || {}, id)
    ? config.merchantMemberships![id]
    : undefined;
  return createHmac("sha256", config.sessionSecret)
    .update(
      account
        ? JSON.stringify([
            account.actor_id,
            account.merchant_id,
            account.role,
            account.credential_version,
            account.verifier,
          ])
        : config.demoMode && id === "demo"
          ? "local-demo"
          : (credential || "disabled") +
            (membership ? JSON.stringify(membership) : ""),
    )
    .digest("hex");
};
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
  db?: DB,
) {
  const access = role === "merchant" && db ? findSessionAccess(db, id) : null;
  if (access?.disabled) throw new Error("Account disabled");
  const session = {
    accessVersion: Number(access?.version || 0),
    id,
    role,
    sid: randomUUID(),
    expires: Date.now() + 12 * 60 * 60 * 1000,
    ...(role === "merchant"
      ? { credentialVersion: credentialVersion(config, id, db) }
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
    if (role === "merchant" && db) {
      const access = findSessionAccess(db, session.id);
      if (
        access?.disabled ||
        Number(access?.version || 0) !== (session.accessVersion ?? 0)
      )
        return null;
    }
    if (typeof session.sid !== "string") return null;
    if (
      role === "merchant" &&
      (!equalSecret(
        session.credentialVersion || "",
        credentialVersion(config, session.id, db),
      ) ||
        (!Object.hasOwn(config.merchantCredentials, session.id) &&
          !managedAccount(db, config, session.id) &&
          !(config.demoMode && session.id === "demo")))
    )
      return null;
    if (db && findRevokedSessionsByIdAndExpiresAt(db, session.sid, Date.now()))
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
