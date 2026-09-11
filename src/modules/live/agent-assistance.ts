import type { AgentProfile } from "../../shared/agent.js";
import type { Hono } from "hono";
import {
  attachAgentGateway,
  type AgentBridge,
} from "../../platform/adapters/public.js";
import { type Config } from "../../platform/infrastructure/public.js";
import type { ContentBinding } from "../../shared/content.js";
import type {
  CampaignRow,
  EngagementPort,
  LivePort,
} from "../../shared/live-ports.js";
import type { Fact } from "../../shared/types.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function attachLiveAssistance(
  app: App,
  config: Config,
  live: LivePort,
  engagement: EngagementPort,
  agentBridge: AgentBridge,
  ports: {
    requiresIndependentReview: (tenant: string) => boolean;
    binding: (
      id: string,
      tenant: string,
      independent: boolean,
    ) => ContentBinding | null;
    factsFor: (id: string) => Fact[];
    onRevocation: (tenant: string, profile: AgentProfile) => void;
  },
  clock: () => number,
) {
  const owned = live.owned;
  const agentBasis = (roomId: string, tenant: string) => {
    const r = owned(roomId, tenant);
    const binding = ports.binding(
      roomId,
      tenant,
      ports.requiresIndependentReview(tenant),
    );
    if (!binding)
      return {
        productName: r.product_name,
        category: undefined,
        facts: ports
          .factsFor(roomId)
          .filter((f) => f.approved && f.evidence.trim())
          .map(({ id, text, evidence, approved }) => ({
            id,
            text,
            evidence,
            approved,
          })),
        contentBound: false,
        stale: false,
      };
    return {
      productName: binding.productName,
      category: binding.category,
      // Namespace references by product revision so re-binding cannot make an
      // old Agent result appear current merely because a fact id was reused.
      facts: binding.stale
        ? []
        : binding.script.productSnapshot.facts
            .filter((f) => f.approved && f.evidence.trim())
            .map((f) => ({
              ...f,
              id: `${binding.productId}:v${binding.script.productSnapshot.version}:${f.id}`,
            })),
      contentBound: true,
      stale: binding.stale,
    };
  };
  app.get("/api/merchant/rooms/:id/agent/basis", (c) => {
    const basis = agentBasis(c.req.param("id"), c.get("merchantId"));
    return c.json(
      basis.contentBound
        ? basis
        : {
            ...basis,
            facts: ports.factsFor(c.req.param("id")),
          },
    );
  });
  attachAgentGateway(
    app,
    agentBridge,
    (roomId, tenant, input) => {
      const r = owned(roomId, tenant);
      const basis = agentBasis(roomId, tenant);
      const campaign = engagement.nextCampaign(r.id, clock()) as
        CampaignRow | undefined;
      const cue = campaign
        ? `演示红包：观看满 ${campaign.min_watch_seconds} 秒可参与。${clock() < campaign.opens_at ? Math.ceil((campaign.opens_at - clock()) / 1000) + " 秒后开启" : "现已开启"}；不发生实际转账。`
        : undefined;
      return {
        transcript: input.transcript,
        question: input.question,
        roomId: r.id,
        productName: basis.productName,
        category: basis.category,
        facts: basis.facts,
        campaignCue: cue,
      };
    },
    (tenant, run) => {
      const current = owned(run.roomId, tenant);
      const basis = agentBasis(run.roomId, tenant);
      const approved = new Set(
        basis.facts
          .filter((f) => f.approved && f.evidence.trim())
          .map((f) => f.id),
      );
      const evidenceChanged = run.result?.factIds.some(
        (id) => !approved.has(id),
      );
      const expired =
        run.mode === "live" &&
        (current.status !== "live" ||
          current.live_started_at > run.createdAt ||
          clock() - run.createdAt > 120000);
      return {
        ...run,
        stale: Boolean(run.stale || basis.stale || evidenceChanged || expired),
        staleReason: run.stale ? run.staleReason : basis.stale
          ? "本场定稿的商品依据已变化，请先复核课程讲稿。"
          : evidenceChanged
            ? "引用的事实已撤回，请重新生成。"
            : expired
              ? "直播场次或时间已变化，请重新生成当前建议。"
              : undefined,
      };
    },
    ports.onRevocation,
  );
}
