import { insertProfileRevocation, listProfileRevocations, listAuthorizationChecks, clearAuthorizationChecks, insertAuthorizationCheck } from "./persistence/authorization-queries.js";
import type { AgentProfile } from "../../shared/agent.js";
import type { AgentBridge } from "../../platform/adapters/public.js";
import { transaction } from "../../platform/infrastructure/public.js";
import type { DB } from "../../shared/persistence.js";
import type { ContentPort } from "../../shared/content-ports.js";
const freshnessMs = 10000;
export function recordProfileRevocation(
  db: DB,
  tenant: string,
  profile: AgentProfile,
) {
  if (!profile.revocation) return;
  const r = profile.revocation;
  insertProfileRevocation(db, tenant, profile.id, r.reason, r.actorId, r.createdAt);
}
export function contentAuthorizationIssue(
  db: DB,
  tenant: string,
  course: string,
  version: number,
  now = Date.now(),
  content: Pick<ContentPort, "generationSources">,
): string | undefined {
  const observations = listProfileRevocations(db, tenant);
  const checks = listAuthorizationChecks(db, tenant);
  const sources = content.generationSources(tenant, course, version).map(source => ({...source, reason: observations.find(r=>r.profile===source.profile)?.reason ?? null, checked: checks.find(r=>r.profile===source.profile)?.checked}));
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
  content: Pick<ContentPort, "generationSources">,
) {
  const pending = new Map<string, Promise<void>>(),
    last = new Map<string, number>();
  return async (tenant: string) => {
    if (!content.generationSources(tenant).length) return;
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
          clearAuthorizationChecks(db, tenant);
          for (const p of result.profiles) {
            recordProfileRevocation(db, tenant, p);
            insertAuthorizationCheck(db, tenant, p.id, now);
          }
        });
        last.set(tenant, now);
      } catch {
        clearAuthorizationChecks(db, tenant);
        // Keep known revocations and readable history even when the separate Agent is unavailable.
        last.set(tenant, clock() - 4000);
      }
    })().finally(() => pending.delete(tenant));
    pending.set(tenant, work);
    return work;
  };
}
