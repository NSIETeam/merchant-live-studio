import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { once } from "node:events";
const port = process.env.SMOKE_PORT || "18791";
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["dist/server/server/index.js"], {
  env: {
    ...process.env,
    HOST: "127.0.0.1",
    PORT: port,
    APP_ORIGIN: base,
    DATABASE_PATH: ":memory:",
    DEMO_MODE: "true",
    NODE_ENV: "development",
    PAYMENT_PROVIDER: "simulation",
    SESSION_SECRET: "http-smoke-test-secret-not-for-production",
    MERCHANT_CREDENTIALS: "{}",
  },
  stdio: ["ignore", "ignore", "pipe"],
});
let stderr = "";
child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
try {
  let healthy = false;
  for (let i = 0; i < 50; i++) {
    if (child.exitCode !== null)
      throw new Error(`Smoke server exited: ${stderr}`);
    try {
      healthy = (await fetch(base + "/api/health")).ok;
    } catch {}
    if (healthy) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(healthy, "Smoke server did not start");
  const home = await fetch(base);
  assert.equal(home.status, 200);
  const html = await home.text();
  assert.match(html, /商家直播工作台/);
  const asset = html.match(/src="([^"]+\.js)"/)[1];
  assert.equal((await fetch(base + asset)).status, 200);
  assert.equal((await fetch(base + "/watch/demo-room")).status, 200);
  async function call(path, method = "GET", body, cookie = "") {
    const r = await fetch(base + "/api" + path, {
      method,
      headers: {
        origin: base,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {
      status: r.status,
      data: await r.json(),
      cookie: r.headers.get("set-cookie")?.split(";")[0] || "",
    };
  }
  const merchant = await call("/auth/demo", "POST", {});
  assert.equal(merchant.status, 200);
  const created = await call(
    "/merchant/rooms",
    "POST",
    { title: "HTTP 验收直播间", productName: "测试商品" },
    merchant.cookie,
  );
  assert.equal(created.status, 201);
  const id = created.data.room.id;
  assert.equal(
    (
      await call(
        "/merchant/rooms/" + id,
        "PATCH",
        { status: "live" },
        merchant.cookie,
      )
    ).status,
    200,
  );
  const c = await call(
    "/merchant/rooms/" + id + "/campaigns",
    "POST",
    {
      totalCents: 101,
      count: 1,
      minWatchSeconds: 0,
      delaySeconds: 0,
      durationSeconds: 30,
    },
    merchant.cookie,
  );
  assert.equal(c.status, 201);
  const viewer = await call("/auth/viewer", "POST", {});
  assert.equal(viewer.status, 200);
  await call(
    "/viewer/rooms/" + id + "/heartbeat",
    "POST",
    { visible: true },
    viewer.cookie,
  );
  const claimed = await call(
    "/viewer/campaigns/" + c.data.campaign.id + "/claim",
    "POST",
    {},
    viewer.cookie,
  );
  assert.equal(claimed.data.claim.amountCents, 101);
  await new Promise((r) => setTimeout(r, 2200));
  const records = await call(
    "/viewer/rooms/" + id + "/claims",
    "GET",
    undefined,
    viewer.cookie,
  );
  assert.equal(records.data.claims[0].status, "simulated");
  const stats = await call(
    "/merchant/rooms/" + id + "/analytics",
    "GET",
    undefined,
    merchant.cookie,
  );
  assert.equal(stats.data.uniqueViewers, 1);
  assert.equal(stats.data.simulatedCents, 101);
  assert.equal((await call("/does-not-exist")).status, 404);
  assert.equal((await fetch(base + "/src/server/config.ts")).status, 404);
  console.log(
    "Built HTTP smoke passed: pages, asset, auth origin, room, campaign, heartbeat, claim, worker, analytics, source privacy.",
  );
} finally {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await once(child, "exit");
  }
}
