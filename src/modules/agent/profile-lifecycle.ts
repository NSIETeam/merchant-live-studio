import { HTTPException } from "hono/http-exception";
import type { AgentDB } from "./persistence/database.js";
import { profileRevocation } from "./persistence/profile-lifecycle-queries.js";
export { profileRevocation, revokeProfile } from "./persistence/profile-lifecycle-queries.js";
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
