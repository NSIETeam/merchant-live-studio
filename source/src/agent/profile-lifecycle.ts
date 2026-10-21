import { HTTPException } from "hono/http-exception";
import type { AgentDB } from "./db.js";
export function profileRevocation(
  db: AgentDB,
  tenant: string,
  profile: string,
) {
  return db
    .prepare(
      "SELECT reason,actor_id AS actorId,created_at AS createdAt FROM agent_profile_revocations WHERE tenant_id=? AND profile_id=?",
    )
    .get(tenant, profile) as
    { reason: string; actorId: string; createdAt: number } | undefined;
}
export function assertProfileActive(
  db: AgentDB,
  tenant: string,
  profile: string,
) {
  if (profileRevocation(db, tenant, profile))
    throw new HTTPException(409, {
      message: "此表达方案已撤回授权，所有版本停止使用。请建立新的获授权方案。",
    });
}
