import test from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { resolve } from "node:path";

const script = resolve("scripts/capacity-probe.mjs");

async function fixture(publicStatus: (calls: number) => number) {
  let calls = 0;
  const server = createServer((request, response) => {
    const path = request.url?.replace(/^\/studio/, "");
    response.setHeader("Content-Type", "application/json");
    if (path === "/api/health") {
      response.end(
        JSON.stringify({ status: "ok", capacity: { synthetic: true } }),
      );
      return;
    }
    if (path === "/api/public/rooms/demo-room") {
      const status = publicStatus(++calls);
      response.statusCode = status;
      response.end(
        JSON.stringify(status === 200 ? { room: {} } : { error: "limit" }),
      );
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "missing" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  };
}

async function probe(origin: string, basePath = "/") {
  const child = spawn(
    process.execPath,
    [
      script,
      `--origin=${origin}`,
      `--base-path=${basePath}`,
      "--room=demo-room",
      "--stages=2,4",
      "--requests-per-stage=50",
      "--p95-ms=1000",
      "--max-error-rate=0",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const [code] = (await once(child, "close")) as [number];
  return { code, stdout, stderr, report: JSON.parse(stdout) };
}

test("capacity probe produces staged percentiles for a healthy read-only target", async () => {
  const server = await fixture(() => 200);
  try {
    const result = await probe(server.origin, "/studio/");
    assert.equal(result.code, 0, result.stderr);
    assert.equal(result.report.passed, true);
    assert.equal(result.report.scope.basePath, "/studio/");
    assert.equal(
      result.report.scope.path,
      "/studio/api/public/rooms/demo-room",
    );
    assert.deepEqual(
      result.report.stages.map(
        (stage: { concurrency: number }) => stage.concurrency,
      ),
      [2, 4],
    );
    assert.ok(
      result.report.stages.every(
        (stage: { p95Ms: number }) => stage.p95Ms >= 0,
      ),
    );
    assert.equal(result.report.server.capacity.synthetic, true);
  } finally {
    await server.close();
  }
});

test("capacity probe stops and identifies application rate limiting", async () => {
  const server = await fixture((calls) => (calls <= 10 ? 200 : 429));
  try {
    const result = await probe(server.origin);
    assert.equal(result.code, 1);
    assert.equal(result.report.passed, false);
    assert.equal(result.report.stoppedReason, "application-rate-limit");
    assert.ok(result.report.stages[0].statuses[429] > 0);
  } finally {
    await server.close();
  }
});

test("capacity probe refuses a remote host without an explicit exact opt-in", () => {
  const result = spawnSync(process.execPath, [
    script,
    "--origin=https://capacity.example.test",
    "--room=demo-room",
  ]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr.toString(),
    /requires --allow-remote=capacity\.example\.test/,
  );
});
