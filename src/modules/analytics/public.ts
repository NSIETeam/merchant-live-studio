import type { Hono } from "hono";
import type { EngagementPort, LivePort } from "../../shared/live-ports.js";
export function attachAnalytics(
  app: Hono<{ Variables: { merchantId: string; viewerId: string } }>,
  live: LivePort,
  engagement: EngagementPort,
) {
  app.get("/api/merchant/rooms/:id/analytics", (c) => {
    const id = c.req.param("id");
    live.owned(id, c.get("merchantId"));
    return c.json({ ...live.viewingStats(id), ...engagement.summary(id) });
  });
}
