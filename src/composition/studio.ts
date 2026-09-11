import { attachDisclosure, attachComplaints, disclosureState } from "../modules/review/public.js";
import { createCustomers } from "../modules/customers/public.js";
import { Hono } from "hono";
import { attachAnalytics, attachAttributionSummary } from "../modules/analytics/public.js";
import { attachEngagement, createEngagement } from "../modules/engagement/public.js";
import { createRoomKnowledge } from "../modules/knowledge/public.js";
import { attachLiveAssistance, createLive, createSourceViewing, attachRecordings, processRecordingOutbox as ingestRecordings } from "../modules/live/public.js";
import { createPayments } from "../modules/payments/public.js";
import {
  HttpAgentBridge,
  type AgentBridge,
} from "../platform/adapters/public.js";
import { attachHome, createIdentity } from "../platform/identity/public.js";
import { loadConfig, createRecordingStorage, type Config } from "../platform/infrastructure/public.js";
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
  const recordingStorage = createRecordingStorage(config.recordingsRoot, config.recordingOutbox);
  const identity = createIdentity(db, config, clock);
  const content = createContentSystem(db, clock, agentBridge);
  let live: ReturnType<typeof createLive>;
  let engagement: ReturnType<typeof createEngagement>;
  let payments: ReturnType<typeof createPayments>;
  const customers = createCustomers(db, (id, tenant) => live.owned(id, tenant), clock);
  const viewing = createSourceViewing(db, customers.validSource);
  const knowledge = createRoomKnowledge(db, () => live, clock);
  live = createLive(
    db,
    config,
    {
      binding: content.live.getRoomContentBinding,
      engagement: () => engagement,
      seedFacts: knowledge.seedFacts,
      recordAttribution: viewing.record,
      disclosure: (tenant, now) => disclosureState(db, tenant, now),
      syncAuthorization: content.review.syncAuthorization,
    },
    clock,
  );
  engagement = createEngagement(db, live, () => payments, clock);
  payments = createPayments(db, engagement, live, clock);
  identity.attach(app);
  app.use("/api/merchant/*", async (c, next) => {
    if (c.req.path.startsWith("/api/merchant/content/") || /\/rooms\/[^/]+\/(agent(?:\/|$)|copilot(?:\/|$))/.test(c.req.path)) await content.review.syncAuthorization(c.get("merchantId"));
    await next();
  });
  attachHome(app, db, tenant => ({products: content.knowledge.productIds(tenant).length, drafts: content.content.draftCount(tenant), ...content.live.preparationCounts(tenant)}));
  attachOperations(app, db, config, { configured: live.mediaConfigured });
  live.attach(app);
  attachRecordings(app, db, config, recordingStorage);
  attachDisclosure(app, db, live, clock);
  attachComplaints(app, db, live, clock);
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
      requiresIndependentReview: identity.requiresIndependentReview,
      binding: content.live.getRoomContentBinding,
      factsFor: knowledge.factsFor,
      onRevocation: content.review.recordProfileRevocation,
    },
    clock,
  );
  engagement.attach(app, config);
  attachEngagement(app, db, live, clock);
  payments.attach(app);
  customers.attach(app);
  attachAttributionSummary(app, customers, viewing);
  attachAnalytics(app, live, engagement);
  app.notFound((c) => c.json({ error: "接口不存在" }, 404));
  return {
    app,
    seedDemo: live.seedDemo,
    processRecordingOutbox: () => ingestRecordings(db, config, recordingStorage),
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

export function recordAttribution(db: DB, room:string, viewer:string, code:string|undefined, now:number) { const customers=createCustomers(db,()=>{},()=>now); createSourceViewing(db,customers.validSource).record(room,viewer,code,now); }

export function processRecordingOutbox(db:DB,config:Config){return ingestRecordings(db,config,createRecordingStorage(config.recordingsRoot,config.recordingOutbox));}
