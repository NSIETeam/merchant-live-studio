import type { Hono } from "hono";
import type { Config } from "../infrastructure/public.js";

type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;

export interface CapacitySnapshot {
  requestConcurrencyMax: number;
  audienceConcurrencyMax: number;
  inFlight: number;
  audienceInFlight: number;
  peakInFlight: number;
  peakAudienceInFlight: number;
  rejected: number;
  audienceRejected: number;
}

function isAudienceRequest(path: string) {
  return (
    path === "/api/auth/viewer" ||
    path.startsWith("/api/public/") ||
    path.startsWith("/api/viewer/")
  );
}

export function attachCapacityGuard(app: App, config: Config) {
  let inFlight = 0;
  let audienceInFlight = 0;
  let peakInFlight = 0;
  let peakAudienceInFlight = 0;
  let rejected = 0;
  let audienceRejected = 0;

  app.use("/api/*", async (c, next) => {
    const audience = isAudienceRequest(c.req.path);
    if (
      inFlight >= config.requestConcurrencyMax ||
      (audience && audienceInFlight >= config.audienceConcurrencyMax)
    ) {
      rejected++;
      if (audience) audienceRejected++;
      c.header("Retry-After", "1");
      c.header("Cache-Control", "no-store");
      return c.json({ error: "访问人数较多，请稍后重试" }, 503);
    }
    inFlight++;
    if (audience) audienceInFlight++;
    peakInFlight = Math.max(peakInFlight, inFlight);
    peakAudienceInFlight = Math.max(peakAudienceInFlight, audienceInFlight);
    try {
      await next();
    } finally {
      inFlight--;
      if (audience) audienceInFlight--;
    }
  });

  return {
    snapshot: (): CapacitySnapshot => ({
      requestConcurrencyMax: config.requestConcurrencyMax,
      audienceConcurrencyMax: config.audienceConcurrencyMax,
      inFlight,
      audienceInFlight,
      peakInFlight,
      peakAudienceInFlight,
      rejected,
      audienceRejected,
    }),
  };
}
