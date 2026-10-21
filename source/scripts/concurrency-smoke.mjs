import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access, mkdtemp, rm, realpath } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

// Correctness and measured local latency only. This is not a capacity benchmark.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const concurrency =
  args.length === 1 && /^--concurrency=\d+$/.test(args[0])
    ? Number(args[0].split("=")[1])
    : args.length === 0
      ? 20
      : NaN;
if (!Number.isInteger(concurrency) || concurrency < 20 || concurrency > 500)
  throw new Error(
    "Usage: node scripts/concurrency-smoke.mjs [--concurrency=20..500]",
  );
const rounds = Math.ceil(400 / (concurrency * 2));
const startedAt = performance.now();
const abort = new AbortController();
const deadline = setTimeout(
  () => abort.abort(new Error("Local smoke time budget exhausted")),
  25000,
);
const secrets = new Set();
const credentials = () => {
  const value = randomBytes(32).toString("hex");
  secrets.add(value);
  return value;
};
const agentToken = credentials(),
  merchantToken = credentials(),
  sessionSecret = credentials();
const children = [],
  reservations = [],
  requests = [];
let temporaryDirectory,
  liveOrigin,
  agentOrigin,
  inFlight = 0,
  peakInFlight = 0;
const report = {
  passed: false,
  scope: {
    target: "temporary loopback processes and databases only",
    concurrency,
    viewers: concurrency,
    requirePlayback: false,
    realVideo: false,
    realPayments: false,
    remoteModel: false,
  },
  limitations: [
    "Small local test only; no public-server load test",
    "No claim of ten-thousand-viewer capacity or WeChat device acceptance",
    "Playback verification is deliberately disabled; simulated rewards only",
  ],
};
const redact = (value) => {
  let text = String(value);
  for (const secret of secrets) text = text.replaceAll(secret, "[redacted]");
  return text;
};
const delay = (ms) =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
const interrupt = () => abort.abort(new Error("Local smoke interrupted"));
process.on("SIGINT", interrupt);
process.on("SIGTERM", interrupt);

async function reservePort() {
  const server = createServer();
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", accept);
  });
  reservations.push(server);
  return server.address().port;
}
async function releasePorts() {
  await Promise.all(
    reservations
      .splice(0)
      .map((server) => new Promise((accept) => server.close(accept))),
  );
}
function launch(name, entry, environment) {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const record = { name, child, exited: false, exitCode: null, output: "" };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      record.output = (record.output + redact(chunk)).slice(-12000);
    });
  record.done = new Promise((accept) => {
    child.once("error", () => {
      record.exited = true;
      record.exitCode = "spawn-error";
      accept(record.exitCode);
    });
    child.once("close", (code, signal) => {
      record.exited = true;
      record.exitCode = code ?? signal;
      accept(record.exitCode);
    });
  });
  children.push(record);
  return record;
}
async function stop(record) {
  if (!record || record.exited) return;
  record.child.kill("SIGTERM");
  let timer;
  await Promise.race([
    record.done,
    new Promise((accept) => {
      timer = setTimeout(accept, 1500);
    }),
  ]);
  clearTimeout(timer);
  if (!record.exited) {
    record.child.kill("SIGKILL");
    await record.done;
  }
}
async function request(
  path,
  {
    method = "GET",
    body,
    cookie,
    expected = 200,
    workload = false,
    startup = false,
    origin = liveOrigin,
  } = {},
) {
  abort.signal.throwIfAborted();
  const start = performance.now();
  inFlight++;
  peakInFlight = Math.max(peakInFlight, inFlight);
  let status = null;
  try {
    const response = await fetch(origin + path, {
      method,
      headers: {
        ...(cookie ? { Cookie: cookie } : {}),
        ...(body === undefined
          ? {}
          : { "Content-Type": "application/json", Origin: liveOrigin }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(2500)]),
    });
    status = response.status;
    const data = await response.json();
    assert.ok(
      (Array.isArray(expected) ? expected : [expected]).includes(status),
      `${method} ${path} returned unexpected HTTP ${status}`,
    );
    const session = response.headers.get("set-cookie")?.split(";")[0];
    if (session) secrets.add(session);
    return { status, data, cookie: session };
  } finally {
    inFlight--;
    requests.push({
      elapsedMs: performance.now() - start,
      status,
      workload,
      startup,
    });
  }
}
async function waitFor(name, fn, attempts = 70) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    abort.signal.throwIfAborted();
    const value = await fn();
    if (value) return value;
    await delay(50);
  }
  throw new Error(`${name} did not become ready`);
}
async function waitReady(record, origin, path) {
  return waitFor(record.name, async () => {
    if (record.exited)
      throw new Error(`${record.name} exited before becoming ready`);
    try {
      return await request(path, { origin, startup: true });
    } catch {
      abort.signal.throwIfAborted();
      return false;
    }
  });
}

try {
  const liveEntry = join(root, "dist/server/server/index.js"),
    agentEntry = join(root, "dist/server/agent/index.js");
  await Promise.all([access(liveEntry), access(agentEntry)]).catch(() => {
    throw new Error("Build both services first with npm run build");
  });
  temporaryDirectory = await mkdtemp(
    join(tmpdir(), "merchant-live-concurrency-"),
  );
  const [livePort, agentPort] = await Promise.all([
    reservePort(),
    reservePort(),
  ]);
  liveOrigin = `http://127.0.0.1:${livePort}`;
  agentOrigin = `http://127.0.0.1:${agentPort}`;
  const environment = {
    ...process.env,
    NODE_ENV: "test",
    HOST: "127.0.0.1",
    PORT: String(livePort),
    APP_ORIGIN: liveOrigin,
    APP_BASE_PATH: "/",
    DATABASE_PATH: join(temporaryDirectory, "live.sqlite"),
    SESSION_SECRET: sessionSecret,
    DEMO_MODE: "false",
    MERCHANT_CREDENTIALS: JSON.stringify({ concurrency_test: merchantToken }),
    PAYMENT_PROVIDER: "simulation",
    REQUIRE_PLAYBACK: "false",
    TRUSTED_PROXY_IPS: "",
    STREAM_PROVIDER: "mediamtx",
    STREAM_AUTH_SECRET: credentials(),
    STREAM_RTMP_BASE: "rtmp://127.0.0.1:1/live",
    STREAM_HLS_BASE: "http://127.0.0.1:1/live",
    MEDIA_CONTROL_URL: "",
    MEDIA_CONTROL_TOKEN: "",
    AGENT_SERVICE_URL: agentOrigin,
    AGENT_SERVICE_TOKEN: agentToken,
    AGENT_HOST: "127.0.0.1",
    AGENT_PORT: String(agentPort),
    AGENT_DATABASE_PATH: join(temporaryDirectory, "agent.sqlite"),
    AGENT_MODEL_PROVIDER: "grounded-rules",
    AGENT_MODEL_ENDPOINT: "",
    AGENT_MODEL_MODEL: "",
    AGENT_MODEL_API_KEY: "",
    AGENT_CONCURRENCY: "2",
    AGENT_QUEUE_LIMIT: "100",
    AGENT_TENANT_QUEUE_LIMIT: "20",
  };
  await releasePorts();
  const agent = launch("agent", agentEntry, environment),
    live = launch("live", liveEntry, environment);
  await Promise.all([
    waitReady(agent, agentOrigin, "/health"),
    waitReady(live, liveOrigin, "/api/health"),
  ]);
  const merchant = (
    await request("/api/auth/merchant", {
      method: "POST",
      body: { merchantId: "concurrency_test", token: merchantToken },
    })
  ).cookie;
  assert.ok(merchant);
  const room = (
    await request("/api/merchant/rooms", {
      method: "POST",
      body: {
        title: "Isolated concurrency smoke",
        productName: "Synthetic test cup",
      },
      cookie: merchant,
      expected: 201,
    })
  ).data.room.id;
  await request(`/api/merchant/rooms/${room}`, {
    method: "PATCH",
    body: { status: "live" },
    cookie: merchant,
  });
  await request(`/api/merchant/rooms/${room}/facts`, {
    method: "POST",
    body: { text: "容量350毫升", evidence: "合成测试标签", approved: true },
    cookie: merchant,
    expected: 201,
  });
  const viewers = await Promise.all(
    Array.from({ length: concurrency }, async () => {
      const result = await request("/api/auth/viewer", {
        method: "POST",
        body: {},
      });
      assert.ok(result.cookie);
      assert.equal(result.data.canReceiveRealMoney, false);
      return result.cookie;
    }),
  );
  const heartbeat = (cookie, workload = false) =>
    request(`/api/viewer/rooms/${room}/heartbeat`, {
      method: "POST",
      body: { visible: true, playing: false },
      cookie,
      workload,
    });
  const publicRoom = (cookie, workload = false) =>
    request(`/api/public/rooms/${room}`, { cookie, workload });
  const loadStartedAt = performance.now();
  await Promise.all(
    viewers.map(async (cookie) => {
      for (let round = 0; round < rounds; round++) {
        assert.equal((await heartbeat(cookie, true)).data.counting, true);
        assert.equal((await publicRoom(cookie, true)).data.room.status, "live");
      }
    }),
  );
  const loadElapsedMs = performance.now() - loadStartedAt;
  assert.ok(requests.filter((r) => r.workload).length >= 400);
  const createCampaign = async (totalCents, count) =>
    (
      await request(`/api/merchant/rooms/${room}/campaigns`, {
        method: "POST",
        body: {
          totalCents,
          count,
          minWatchSeconds: 0,
          delaySeconds: 0,
          durationSeconds: 120,
        },
        cookie: merchant,
        expected: 201,
      })
    ).data.campaign;
  const totalCents = 10007,
    offeredCount = Math.floor(concurrency * 0.75),
    pool = await createCampaign(totalCents, offeredCount);
  const claim = (campaignId, cookie, expected = 200) =>
    request(`/api/viewer/campaigns/${campaignId}/claim`, {
      method: "POST",
      body: {},
      cookie,
      expected,
    });
  const raced = await Promise.all(
    viewers.map(async (cookie, index) => ({
      ...(await claim(pool.id, cookie, [200, 409])),
      index,
    })),
  );
  const winners = raced.filter((r) => r.status === 200),
    rejected = raced.filter((r) => r.status === 409);
  assert.equal(winners.length, offeredCount);
  assert.equal(rejected.length, concurrency - offeredCount);
  assert.equal(new Set(winners.map((r) => r.data.claim.id)).size, offeredCount);
  assert.ok(
    winners.every(
      (r) =>
        Number.isInteger(r.data.claim.amountCents) &&
        r.data.claim.amountCents > 0,
    ),
  );
  const wonCents = winners.reduce(
    (sum, r) => sum + r.data.claim.amountCents,
    0,
  );
  assert.equal(wonCents, totalCents);
  await Promise.all(
    winners.map(async (r) => {
      const replay = await claim(pool.id, viewers[r.index]);
      assert.equal(replay.data.claim.id, r.data.claim.id);
      assert.equal(replay.data.claim.amountCents, r.data.claim.amountCents);
    }),
  );
  const poolState = (
    await request(`/api/merchant/rooms/${room}/campaigns`, { cookie: merchant })
  ).data.campaigns.find((r) => r.id === pool.id);
  assert.equal(poolState.remainingCents, 0);
  assert.equal(poolState.remainingCount, 0);
  report.claims = {
    offeredCount,
    offeredCents: totalCents,
    wonCount: winners.length,
    wonCents,
    soldOutResponses: rejected.length,
    duplicateReplays: winners.length,
    remainingCount: poolState.remainingCount,
    remainingCents: poolState.remainingCents,
    conserved: true,
  };

  // Use an already partially consumed campaign to demonstrate real isolation.
  const ongoing = await createCampaign(2501, 5);
  const beforeStopClaim = (await claim(ongoing.id, viewers[0])).data.claim;
  const agentStatus = await request("/api/merchant/agent/status", {
    cookie: merchant,
  });
  assert.equal(agentStatus.data.available, true);
  assert.equal(agentStatus.data.modelConfigured, false);
  const submitted = await request(`/api/merchant/rooms/${room}/agent/runs`, {
    method: "POST",
    cookie: merchant,
    body: {
      profileId: "standard",
      mode: "live",
      transcript: "介绍容量",
      idempotencyKey: "concurrency-agent-job",
    },
    expected: 202,
  });
  const finished = await waitFor("asynchronous Agent job", async () => {
    const value = await request(
      `/api/merchant/agent/runs/${submitted.data.run.id}`,
      { cookie: merchant },
    );
    if (value.data.run.status === "failed")
      throw new Error("Agent smoke job failed");
    return value.data.run.status === "completed" ? value : false;
  });
  assert.equal(finished.data.run.result.provider, "grounded-rules");
  await stop(agent);
  assert.equal(agent.exited, true);
  assert.equal(live.exited, false);
  assert.equal(
    (await request("/api/merchant/agent/status", { cookie: merchant })).data
      .available,
    false,
  );
  const [roomAfter, heartbeatAfter, latestAfter] = await Promise.all([
    publicRoom(viewers[1]),
    heartbeat(viewers[1]),
    request(`/api/merchant/rooms/${room}/agent/latest`, { cookie: merchant }),
  ]);
  assert.equal(roomAfter.data.room.status, "live");
  assert.equal(heartbeatAfter.data.counting, true);
  assert.equal(latestAfter.data.available, false);
  const afterStopClaim = (await claim(ongoing.id, viewers[1])).data.claim;
  assert.ok(afterStopClaim.amountCents > 0);
  const ongoingState = (
    await request(`/api/merchant/rooms/${room}/campaigns`, { cookie: merchant })
  ).data.campaigns.find((r) => r.id === ongoing.id);
  assert.equal(ongoingState.remainingCount, 3);
  assert.equal(
    beforeStopClaim.amountCents +
      afterStopClaim.amountCents +
      ongoingState.remainingCents,
    ongoing.totalCents,
  );
  const expectedSimulatedCents =
    totalCents + beforeStopClaim.amountCents + afterStopClaim.amountCents;
  const settled = await waitFor(
    "simulation worker after Agent stop",
    async () => {
      const value = await request(`/api/merchant/rooms/${room}/analytics`, {
        cookie: merchant,
      });
      return value.data.simulatedCents === expectedSimulatedCents
        ? value
        : false;
    },
    // Worker drains at most 100 jobs per two-second tick; retain that bound.
    220,
  );
  assert.equal(settled.data.claims, offeredCount + 2);
  const ledger = [];
  const cursors = new Set();
  let before = null;
  do {
    const page = (
      await request(
        `/api/merchant/rooms/${room}/ledger${before ? `?before=${encodeURIComponent(before)}` : ""}`,
        { cookie: merchant },
      )
    ).data;
    ledger.push(...page.entries);
    before = page.nextBefore;
    if (before) {
      assert.ok(!cursors.has(before), "ledger cursor must advance");
      cursors.add(before);
    }
  } while (before);
  assert.equal(new Set(ledger.map((row) => row.id)).size, ledger.length);
  const reserved = ledger.filter(
    (r) =>
      r.campaignId === pool.id &&
      r.debit === "campaign_reserved" &&
      r.credit === "claim_reserved",
  );
  assert.equal(reserved.length, offeredCount);
  assert.equal(
    reserved.reduce((sum, r) => sum + r.amountCents, 0),
    totalCents,
  );
  report.isolation = {
    agentJobAccepted: true,
    agentJobCompleted: true,
    agentProcessStopped: true,
    liveProcessStillRunning: true,
    publicRoomReadable: true,
    newHeartbeatCounting: true,
    agentLatestGracefullyUnavailable: true,
    existingCampaignStillClaimable: true,
    remainingCampaignCount: ongoingState.remainingCount,
    remainingCampaignCents: ongoingState.remainingCents,
    ongoingCampaignConserved: true,
    simulationWorkerSettledAfterAgentStop: true,
  };
  report.workload = {
    requests: concurrency * rounds * 2,
    simultaneousViewerClients: concurrency,
    roundsPerViewer: rounds,
    elapsedMs: Number(loadElapsedMs.toFixed(2)),
  };
  report.passed = true;
} catch (error) {
  report.error = redact(error instanceof Error ? error.message : error);
  report.childDiagnostics = children
    .filter((child) => child.output)
    .map((child) => ({
      name: child.name,
      output: redact(child.output.split("\n").slice(-12).join("\n")),
    }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await releasePorts();
  await Promise.all(children.map(stop));
  if (temporaryDirectory) {
    const target = await realpath(temporaryDirectory);
    assert.equal(dirname(target), await realpath(tmpdir()));
    assert.ok(basename(target).startsWith("merchant-live-concurrency-"));
    await rm(target, { recursive: true, force: true });
  }
  const samples = requests
    .filter((r) => !r.startup)
    .map((r) => r.elapsedMs)
    .sort((a, b) => a - b);
  const percentile = (p) =>
    samples.length
      ? Number(samples[Math.ceil(samples.length * p) - 1].toFixed(2))
      : null;
  report.measurements = {
    requests: requests.length,
    workloadRequests: requests.filter((r) => r.workload).length,
    workloadFailedRequests: requests.filter(
      (r) => r.workload && r.status !== 200,
    ).length,
    startupConnectionRetries: requests.filter(
      (r) => r.startup && r.status === null,
    ).length,
    connectionFailuresAfterStartup: requests.filter(
      (r) => !r.startup && r.status === null,
    ).length,
    configuredConcurrency: concurrency,
    peakInFlightRequests: peakInFlight,
    latencyScope:
      "Application requests after startup; readiness probes excluded",
    p50Ms: percentile(0.5),
    p95Ms: percentile(0.95),
    totalElapsedMs: Number((performance.now() - startedAt).toFixed(2)),
    responsesByStatus: requests.reduce((counts, r) => {
      const key = r.status ?? "connection-or-abort";
      counts[key] = (counts[key] || 0) + 1;
      return counts;
    }, {}),
  };
  report.cleanup = {
    ownedChildrenStopped: children.every((child) => child.exited),
    temporaryDatabasesAndDirectoryRemoved: Boolean(temporaryDirectory),
    preexistingProcessesStopped: false,
  };
  process.off("SIGINT", interrupt);
  process.off("SIGTERM", interrupt);
  console.log(JSON.stringify(report, null, 2));
}
