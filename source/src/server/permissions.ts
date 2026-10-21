import type { DB } from "./db.js";
import type { Config } from "./config.js";
import type { MemberRole, MerchantIdentity } from "../shared/membership.js";
declare module "hono" {
  interface ContextVariableMap {
    actorId: string;
    memberRole: MemberRole;
    requireIndependentReview: boolean;
  }
}
export function requiresIndependentReview(config: Config, merchantId: string) {
  return (
    config.production ||
    Object.values(config.merchantMemberships || {}).some(
      (member) => member.merchantId === merchantId,
    )
  );
}

export function merchantIdentity(
  config: Config,
  actorId: string,
  db?: DB,
): MerchantIdentity {
  const member = config.merchantMemberships?.[actorId];
  const access =
    member && db
      ? db
          .prepare(
            "SELECT role_override FROM team_access WHERE actor_id=? AND merchant_id=? AND base_role=?",
          )
          .get(actorId, member.merchantId, member.role)
      : undefined;
  return {
    actorId,
    merchantId: member?.merchantId ?? actorId,
    memberRole:
      (access?.role_override as MemberRole | undefined) ??
      member?.role ??
      "owner",
    requiresIndependentReview: requiresIndependentReview(
      config,
      member?.merchantId ?? actorId,
    ),
  };
}
/** The server remains authoritative. Unknown mutation routes deny member access. */
export function memberMayAccess(
  role: MemberRole,
  method: string,
  path: string,
) {
  if (path === "/api/merchant/home")
    return ["GET", "HEAD", "PUT"].includes(method);
  if (role === "owner") return true;
  if (path === "/api/merchant/team" || path.startsWith("/api/merchant/team/"))
    return false;
  if (
    /^\/api\/merchant\/(?:recordings(?:\/|$)|rooms\/[^/]+\/recordings$)/.test(
      path,
    )
  )
    return role === "reviewer" && method === "GET";
  if (/^\/api\/merchant\/rooms\/[^/]+\/moderation(?:\/\d+\/retry)?$/.test(path))
    return (
      (role === "reviewer" && (method === "POST" || method === "GET")) ||
      (["presenter", "editor"].includes(role) && method === "GET")
    );
  if (
    path === "/api/merchant/disclosure" ||
    path.startsWith("/api/merchant/disclosure/")
  )
    return (
      ["GET", "HEAD"].includes(method) ||
      (role === "editor" &&
        method === "POST" &&
        path === "/api/merchant/disclosure") ||
      (role === "reviewer" &&
        method === "POST" &&
        /^\/api\/merchant\/disclosure\/\d+\/review$/.test(path))
    );
  if (path.startsWith("/api/merchant/complaints")) return false;
  if (
    path.startsWith("/api/merchant/attribution") ||
    path.startsWith("/api/merchant/engagement")
  )
    return role === "analyst" && ["GET", "HEAD"].includes(method);
  if (method === "GET" || method === "HEAD") {
    if (/\/stream(?:\/|$)/.test(path)) return role === "presenter";
    if (/\/ledger$/.test(path)) return role === "analyst";
    if (role === "analyst")
      return (
        path === "/api/merchant/rooms" ||
        /\/rooms\/[^/]+\/(analytics|campaigns|signal)$/.test(path)
      );
    return true;
  }
  if (role === "analyst") return false;
  if (role === "reviewer")
    return (
      method === "POST" &&
      /\/content\/courses\/[^/]+\/scripts\/\d+\/(review|suggestions)$/.test(
        path,
      )
    );
  if (role === "editor") {
    if (/\/content\//.test(path))
      return (
        (method === "POST" &&
          /^\/api\/merchant\/content\/(products|products\/[^/]+\/versions|plans|plans\/[^/]+\/courses|courses\/[^/]+\/scripts|courses\/[^/]+\/generation|courses\/[^/]+\/generation\/[^/]+\/(cancel|resume|import)|courses\/[^/]+\/scripts\/\d+\/submit|suggestions\/[^/]+\/resolve)$/.test(
            path,
          )) ||
        (method === "PATCH" &&
          /^\/api\/merchant\/content\/(plans|courses)\/[^/]+$/.test(path))
      );
    return (
      method === "POST" &&
      ((/\/agent\/profiles(?:\/|$)/.test(path) &&
        !/\/(publish|revoke)$/.test(path)) ||
        /\/materials\/(preview|import)$/.test(path) ||
        /\/rooms\/[^/]+\/agent\/(runs|suites|evaluations)$/.test(path))
    );
  }
  return (
    (method === "PATCH" && /^\/api\/merchant\/rooms\/[^/]+$/.test(path)) ||
    (method === "POST" &&
      (/\/content\/rooms\/[^/]+\/binding$/.test(path) ||
        /\/rooms\/[^/]+\/(copilot|agent\/runs|stream\/disconnect)$/.test(
          path,
        ) ||
        /\/agent\/runs\/[^/]+\/feedback$/.test(path)))
  );
}
