import type { AgentProfile } from "../shared/agent.js";
import type { AgentBridge } from "./services/agent-bridge.js";
import { transaction, type DB } from "./db.js";
const freshnessMs = 10000;
export function recordProfileRevocation(
  db: DB,
  tenant: string,
  profile: AgentProfile,
) {
  if (!profile.revocation) return;
  const r = profile.revocation;
  db.prepare(
    "INSERT OR IGNORE INTO content_profile_revocations VALUES(?,?,?,?,?)",
  ).run(tenant, profile.id, r.reason, r.actorId, r.createdAt);
}
export function contentAuthorizationIssue(
  db: DB,
  tenant: string,
  course: string,
  version: number,
  now = Date.now(),
): string | undefined {
  const sources = db
    .prepare(
      `SELECT i.script_version AS version,json_extract(i.snapshot_json,'$.input.profileId') AS profile,r.reason,c.verified_at AS checked FROM content_generation_imports i LEFT JOIN content_profile_revocations r ON r.merchant_id=i.merchant_id AND r.profile_id=json_extract(i.snapshot_json,'$.input.profileId') LEFT JOIN content_authorization_checks c ON c.merchant_id=i.merchant_id AND c.profile_id=json_extract(i.snapshot_json,'$.input.profileId') WHERE i.merchant_id=? AND i.course_id=? AND i.script_version<=? ORDER BY i.script_version`,
    )
    .all(tenant, course, version);
  const revoked = sources.find((s) => s.reason !== null);
  if (revoked)
    return `本课程 V${revoked.version} 导入的表达方案授权已撤回（${revoked.reason}）。后续修订仍保留该来源，停止播讲；请重新准备获授权内容并建立新课程。`;
  if (sources.some((s) => !s.checked || now - Number(s.checked) > freshnessMs))
    return "生成稿来源的授权状态暂未确认，暂停定稿与播讲。恢复 Agent 连接后刷新核验。";
  return undefined;
}
export function createContentAuthorizationSync(
  db: DB,
  bridge: AgentBridge,
  clock = Date.now,
) {
  const pending = new Map<string, Promise<void>>(),
    last = new Map<string, number>();
  return async (tenant: string) => {
    if (
      !db
        .prepare(
          "SELECT 1 FROM content_generation_imports WHERE merchant_id=? LIMIT 1",
        )
        .get(tenant)
    )
      return;
    if (clock() - (last.get(tenant) || 0) < 5000) return;
    const running = pending.get(tenant);
    if (running) return running;
    const work = (async () => {
      try {
        const result = await bridge.request<{ profiles: AgentProfile[] }>(
          tenant,
          "/v1/profiles",
        );
        const now = clock();
        transaction(db, () => {
          db.prepare(
            "DELETE FROM content_authorization_checks WHERE merchant_id=?",
          ).run(tenant);
          for (const p of result.profiles) {
            recordProfileRevocation(db, tenant, p);
            db.prepare(
              "INSERT INTO content_authorization_checks VALUES(?,?,?)",
            ).run(tenant, p.id, now);
          }
        });
        last.set(tenant, now);
      } catch {
        db.prepare(
          "DELETE FROM content_authorization_checks WHERE merchant_id=?",
        ).run(tenant);
        // Keep known revocations and readable history even when the separate Agent is unavailable.
        last.set(tenant, clock() - 4000);
      }
    })().finally(() => pending.delete(tenant));
    pending.set(tenant, work);
    return work;
  };
}
