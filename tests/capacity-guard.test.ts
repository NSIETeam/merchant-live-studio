import test from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { loadConfig } from "../src/platform/infrastructure/public.js";
import { attachCapacityGuard } from "../src/platform/operations/public.js";

type TestApp = Hono<{
  Variables: { merchantId: string; viewerId: string };
}>;

function latch() {
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { waiting, release };
}

test("audience saturation fails fast while reserved control capacity stays usable", async () => {
  const app = new Hono() as TestApp;
  const capacity = attachCapacityGuard(
    app,
    loadConfig({
      DEMO_MODE: "true",
      REQUEST_CONCURRENCY_MAX: "3",
      AUDIENCE_CONCURRENCY_MAX: "2",
    }),
  );
  const held = latch();
  let entered = 0;
  app.get("/api/public/hold", async (c) => {
    entered++;
    await held.waiting;
    return c.json({ ok: true });
  });
  app.get("/api/merchant/control", (c) => c.json({ control: true }));

  const first = app.request("/api/public/hold");
  const second = app.request("/api/public/hold");
  while (entered < 2) await new Promise((resolve) => setImmediate(resolve));

  const rejected = await app.request("/api/public/hold");
  assert.equal(rejected.status, 503);
  assert.equal(rejected.headers.get("retry-after"), "1");
  assert.deepEqual(await rejected.json(), {
    error: "访问人数较多，请稍后重试",
  });

  const control = await app.request("/api/merchant/control");
  assert.equal(control.status, 200);
  assert.deepEqual(await control.json(), { control: true });
  assert.deepEqual(capacity.snapshot(), {
    requestConcurrencyMax: 3,
    audienceConcurrencyMax: 2,
    inFlight: 2,
    audienceInFlight: 2,
    peakInFlight: 3,
    peakAudienceInFlight: 2,
    rejected: 1,
    audienceRejected: 1,
  });

  held.release();
  assert.equal((await first).status, 200);
  assert.equal((await second).status, 200);
  assert.equal(capacity.snapshot().inFlight, 0);
  assert.equal(capacity.snapshot().audienceInFlight, 0);
});

test("capacity configuration preserves a control reserve and rejects invalid bounds", () => {
  const defaults = loadConfig({ DEMO_MODE: "true" });
  assert.equal(defaults.requestConcurrencyMax, 1024);
  assert.equal(defaults.audienceConcurrencyMax, 768);
  assert.ok(defaults.audienceConcurrencyMax < defaults.requestConcurrencyMax);

  assert.throws(
    () =>
      loadConfig({
        DEMO_MODE: "true",
        REQUEST_CONCURRENCY_MAX: "16",
        AUDIENCE_CONCURRENCY_MAX: "16",
      }),
    /AUDIENCE_CONCURRENCY_MAX must be lower/,
  );
  assert.throws(() =>
    loadConfig({
      DEMO_MODE: "true",
      REQUEST_CONCURRENCY_MAX: "4097",
      AUDIENCE_CONCURRENCY_MAX: "16",
    }),
  );
});
