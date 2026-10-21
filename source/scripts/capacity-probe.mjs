import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

const values = Object.fromEntries(
  process.argv.slice(2).map((argument) => {
    const separator = argument.indexOf("=");
    assert.ok(separator > 2, `Invalid argument: ${argument}`);
    return [argument.slice(2, separator), argument.slice(separator + 1)];
  }),
);
const allowed = new Set([
  "origin",
  "base-path",
  "room",
  "stages",
  "requests-per-stage",
  "p95-ms",
  "max-error-rate",
  "allow-remote",
]);
for (const key of Object.keys(values))
  assert.ok(allowed.has(key), `Unknown argument: --${key}`);

const origin = new URL(values.origin || "http://127.0.0.1:8787");
assert.ok(
  !origin.username &&
    !origin.password &&
    !origin.search &&
    !origin.hash &&
    origin.pathname === "/",
  "--origin must be an HTTP(S) origin without credentials or a path",
);
const loopback = ["127.0.0.1", "localhost", "::1"].includes(origin.hostname);
assert.ok(
  ["http:", "https:"].includes(origin.protocol),
  "--origin must use HTTP(S)",
);
if (!loopback) {
  assert.equal(origin.protocol, "https:", "Remote probes require HTTPS");
  assert.equal(
    values["allow-remote"],
    origin.hostname,
    `Remote probe requires --allow-remote=${origin.hostname}`,
  );
}
const basePath = values["base-path"] || "/";
assert.match(
  basePath,
  /^\/(?:[a-zA-Z0-9_-]+\/)*$/,
  "--base-path must start and end with / and contain path segments only",
);
const room = values.room || "demo-room";
assert.match(room, /^[a-zA-Z0-9_-]{1,100}$/, "--room is invalid");
const stages = (values.stages || "10,25,50,100").split(",").map(Number);
assert.ok(stages.length >= 1 && stages.length <= 6, "Use 1..6 stages");
assert.ok(
  stages.every(
    (value, index) =>
      Number.isInteger(value) &&
      value >= 1 &&
      value <= 500 &&
      (index === 0 || value > stages[index - 1]),
  ),
  "--stages must be increasing integers from 1 to 500",
);
const requestsPerStage = Number(values["requests-per-stage"] || 200);
assert.ok(
  Number.isInteger(requestsPerStage) &&
    requestsPerStage >= 50 &&
    requestsPerStage <= 5000,
  "--requests-per-stage must be 50..5000",
);
const p95ThresholdMs = Number(values["p95-ms"] || 1200);
assert.ok(
  Number.isFinite(p95ThresholdMs) &&
    p95ThresholdMs >= 50 &&
    p95ThresholdMs <= 10000,
  "--p95-ms must be 50..10000",
);
const maxErrorRate = Number(values["max-error-rate"] || 0.01);
assert.ok(
  Number.isFinite(maxErrorRate) && maxErrorRate >= 0 && maxErrorRate <= 0.2,
  "--max-error-rate must be 0..0.2",
);

const target = new URL(
  `${basePath.slice(1)}api/public/rooms/${encodeURIComponent(room)}`,
  origin,
);
const healthTarget = new URL(`${basePath.slice(1)}api/health`, origin);
const controller = new AbortController();
const overallDeadline = setTimeout(
  () => controller.abort(new Error("Capacity probe time budget exhausted")),
  180_000,
);
const percentile = (sorted, ratio) =>
  sorted.length
    ? Number(sorted[Math.ceil(sorted.length * ratio) - 1].toFixed(2))
    : null;

async function request() {
  const startedAt = performance.now();
  let status = null;
  let error = null;
  try {
    const response = await fetch(target, {
      headers: {
        Accept: "application/json",
        "User-Agent": "merchant-live-capacity-probe/1",
      },
      signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
    });
    status = response.status;
    await response.arrayBuffer();
  } catch (reason) {
    error =
      reason instanceof Error && reason.name === "TimeoutError"
        ? "timeout"
        : "connection";
  }
  return { elapsedMs: performance.now() - startedAt, status, error };
}

async function runStage(concurrency) {
  const count = Math.max(requestsPerStage, concurrency);
  let cursor = 0;
  const results = [];
  const startedAt = performance.now();
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (cursor < count) {
        const index = cursor++;
        if (index >= count) break;
        results[index] = await request();
      }
    }),
  );
  const elapsed = performance.now() - startedAt;
  const latency = results
    .map((result) => result.elapsedMs)
    .sort((a, b) => a - b);
  const successful = results.filter((result) => result.status === 200).length;
  const errors = results.length - successful;
  const errorRate = errors / results.length;
  const statuses = {};
  for (const result of results) {
    const key = result.status ?? result.error ?? "unknown";
    statuses[key] = (statuses[key] || 0) + 1;
  }
  const metrics = {
    concurrency,
    requests: results.length,
    successful,
    errors,
    errorRate: Number(errorRate.toFixed(4)),
    elapsedMs: Number(elapsed.toFixed(2)),
    requestsPerSecond: Number((results.length / (elapsed / 1000)).toFixed(2)),
    p50Ms: percentile(latency, 0.5),
    p95Ms: percentile(latency, 0.95),
    p99Ms: percentile(latency, 0.99),
    statuses,
  };
  return {
    ...metrics,
    passed:
      metrics.errorRate <= maxErrorRate &&
      metrics.p95Ms !== null &&
      metrics.p95Ms <= p95ThresholdMs,
  };
}

const report = {
  passed: false,
  scope: {
    origin: origin.origin,
    basePath,
    path: target.pathname,
    method: "GET",
    readOnly: true,
    remote: !loopback,
    stages,
    requestsPerStage,
  },
  thresholds: { p95Ms: p95ThresholdMs, maxErrorRate },
  limitations: [
    "Public room JSON only; excludes HLS media bytes and browser rendering",
    "Does not create viewers, write heartbeats, claim rewards or test payments",
    "One successful run is a baseline for this host and time, not a capacity guarantee",
  ],
  stages: [],
};

try {
  const health = await fetch(healthTarget, {
    signal: AbortSignal.timeout(5000),
  });
  assert.equal(health.status, 200, "Health preflight failed");
  const healthBody = await health.json();
  report.server = {
    status: healthBody?.status || "unknown",
    capacity: healthBody?.capacity || null,
  };
  const targetCheck = await request();
  assert.equal(targetCheck.status, 200, "Public room preflight failed");
  for (const concurrency of stages) {
    const stage = await runStage(concurrency);
    report.stages.push(stage);
    if (!stage.passed) {
      report.stoppedAtConcurrency = concurrency;
      report.stoppedReason = Object.hasOwn(stage.statuses, "429")
        ? "application-rate-limit"
        : Object.hasOwn(stage.statuses, "503")
          ? "capacity-guard"
          : Object.keys(stage.statuses).some((status) =>
                ["timeout", "connection", "unknown"].includes(status),
              )
            ? "transport-error"
            : "latency-or-error-threshold";
      break;
    }
  }
  const afterHealth = await fetch(healthTarget, {
    signal: AbortSignal.timeout(5000),
  });
  if (afterHealth.status === 200) {
    const afterHealthBody = await afterHealth.json();
    report.server.afterCapacity = afterHealthBody?.capacity || null;
  }
  report.passed =
    report.stages.length === stages.length &&
    report.stages.every((stage) => stage.passed);
} catch (error) {
  report.error =
    error instanceof Error ? error.message : "Capacity probe failed";
} finally {
  clearTimeout(overallDeadline);
  console.log(JSON.stringify(report, null, 2));
  if (!report.passed) process.exitCode = 1;
}
