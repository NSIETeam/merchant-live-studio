import type { Hono } from "hono";
import { type Config } from "../../platform/infrastructure/public.js";
import { channelCapabilities } from "../../shared/channels.js";
import type { DB } from "../../shared/persistence.js";
import { findDatabase } from "./persistence/public-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function attachOperations(
  app: App,
  db: DB,
  config: Config,
  media: { configured: boolean },
) {
  app.get("/api/health", (c) => {
    findDatabase(db);
    return c.json({
      status: "ok",
      demoMode: config.demoMode,
      payments: "simulation",
      copilot: "agent-service",
      agentIndependent: true,
      streamProvider: config.streamProvider,
      mediaControl: media.configured,
      requirePlayback: config.requirePlayback,
    });
  });
  app.get("/api/channels", (c) => c.json({ channels: channelCapabilities }));
}
