import { Hono } from "hono";
import { attachAnalytics } from "../modules/analytics/public.js";
import { createEngagement } from "../modules/engagement/public.js";
import { createRoomKnowledge } from "../modules/knowledge/public.js";
import { attachLiveAssistance, createLive } from "../modules/live/public.js";
import { createPayments } from "../modules/payments/public.js";
import {
  HttpAgentBridge,
  type AgentBridge,
} from "../platform/adapters/public.js";
import { createIdentity } from "../platform/identity/public.js";
import { loadConfig, type Config } from "../platform/infrastructure/public.js";
import { attachOperations } from "../platform/operations/public.js";
import type { DB } from "../shared/persistence.js";
import { createContentSystem } from "./content.js";

export function createStudio(
  db: DB,
  config: Config,
  clock: () => number = Date.now,
  agentBridge: AgentBridge = new HttpAgentBridge(config),
) {
  const app = new Hono<{
    Variables: { merchantId: string; viewerId: string };
  }>();
  const identity = createIdentity(db, config, clock);
  const content = createContentSystem(db, clock, agentBridge);
  let live: ReturnType<typeof createLive>;
  let engagement: ReturnType<typeof createEngagement>;
  let payments: ReturnType<typeof createPayments>;
  const knowledge = createRoomKnowledge(db, () => live, clock);
  live = createLive(
    db,
    config,
    {
      binding: content.live.getRoomContentBinding,
      engagement: () => engagement,
      seedFacts: knowledge.seedFacts,
    },
    clock,
  );
  engagement = createEngagement(db, live, () => payments, clock);
  payments = createPayments(db, engagement, live, clock);
  identity.attach(app);
  attachOperations(app, db, config, { configured: live.mediaConfigured });
  live.attach(app);
  knowledge.attach(app);
  content.knowledge.attach(app);
  content.marketing.attach(app);
  content.content.attach(app);
  content.review.attach(app);
  content.live.attach(app);
  attachLiveAssistance(
    app,
    config,
    live,
    engagement,
    agentBridge,
    {
      binding: content.live.getRoomContentBinding,
      factsFor: knowledge.factsFor,
    },
    clock,
  );
  engagement.attach(app, config);
  payments.attach(app);
  attachAnalytics(app, live, engagement);
  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  return {
    app,
    seedDemo: live.seedDemo,
    expireCampaigns: engagement.expireCampaigns,
    processSimulationJobs: payments.processSimulationJobs,
    tick() {
      identity.cleanup();
      engagement.expireCampaigns(clock());
      payments.processSimulationJobs(clock());
    },
  };
}
export function createApp(
  db: DB,
  config: Config,
  clock: () => number = Date.now,
  bridge?: AgentBridge,
) {
  return createStudio(db, config, clock, bridge).app;
}
export function seedDemo(db: DB, now = Date.now()) {
  createStudio(db, loadConfig(), () => now).seedDemo(now);
}
export function expireCampaigns(db: DB, now = Date.now()) {
  createStudio(db, loadConfig(), () => now).expireCampaigns(now);
}
export function processSimulationJobs(db: DB, now = Date.now()) {
  return createStudio(db, loadConfig(), () => now).processSimulationJobs(now);
}

export { WeChatPaymentProvider } from "../modules/payments/public.js";
