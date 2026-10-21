import type { AgentDB } from "./database.js";
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
export function revokeProfile(db: AgentDB, tenant: string, profile: string, reason: string, actor: string, now: number) {
 db.prepare("INSERT INTO agent_profile_revocations VALUES(?,?,?,?,?)").run(tenant,profile,reason,actor,now);
 db.prepare("UPDATE agent_runs SET status='failed',error='表达方案授权已撤回',completed_at=? WHERE tenant_id=? AND profile_id=? AND status IN ('queued','running')").run(now,tenant,profile);
 db.prepare("UPDATE agent_generation_jobs SET status='failed',error='表达方案授权已撤回',updated_at=? WHERE tenant_id=? AND json_extract(input_json,'$.profileId')=? AND status IN ('queued','running','waiting_configuration')").run(now,tenant,profile);
}
