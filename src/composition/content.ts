import type { Hono } from "hono";
import { createContent } from "../modules/content/public.js";
import { createProductKnowledge } from "../modules/knowledge/public.js";
import { createBindings } from "../modules/live/public.js";
import { createMarketing } from "../modules/marketing/public.js";
import { createReview } from "../modules/review/public.js";
import type { AgentBridge } from "../platform/adapters/public.js";
import type { DB } from "../shared/persistence.js";
export function createContentSystem(
  db: DB,
  clock: () => number = Date.now,
  bridge?: AgentBridge,
) {
  let content: ReturnType<typeof createContent>;
  let review: ReturnType<typeof createReview>;
  const knowledge = createProductKnowledge(db, clock);
  const marketing = createMarketing(db, knowledge, () => content, clock);
  content = createContent(
    db,
    knowledge,
    marketing,
    () => review,
    clock,
    bridge,
  );
  review = createReview(db, content, clock);
  const live = createBindings(db, () => content, clock);
  return { knowledge, marketing, content, review, live };
}
export function attachContent(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  db: DB,
  clock: () => number = Date.now,
  bridge?: AgentBridge,
) {
  const system = createContentSystem(db, clock, bridge);
  system.knowledge.attach(app);
  system.marketing.attach(app);
  system.content.attach(app);
  system.review.attach(app);
  system.live.attach(app);
  return system;
}
export function getRoomContentBinding(
  db: DB,
  room: string,
  merchant: string,
  independent = false,
) {
  return createContentSystem(db).live.getRoomContentBinding(
    room,
    merchant,
    independent,
  );
}
