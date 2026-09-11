/** Isolated real HLS transport check. Never targets an existing server. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const n = a.indexOf("=");
    return [a.slice(0, n), a.slice(n + 1)];
  }),
);
const clients = Number(args["--clients"] || 100);
assert.ok(
  Number.isInteger(clients) && clients >= 1 && clients <= 200,
  "--clients must be 1..200",
);
assert.ok(
  args["--mediamtx"] && args["--ffmpeg"],
  "Provide --mediamtx=/absolute/binary and --ffmpeg=/absolute/binary",
);
const binaries = {
  media: resolve(args["--mediamtx"]),
  ffmpeg: resolve(args["--ffmpeg"]),
};
for (const path of Object.values(binaries))
  assert.ok((await stat(path)).isFile());
const dir = await mkdtemp(join(tmpdir(), "studio-hls-"));
const children = [];
const report = {
  passed: false,
  scope: {
    clients,
    target: "new isolated loopback MediaMTX only",
    syntheticVideo: true,
    realHls: true,
    realPayment: false,
    applicationAuth: false,
    cdn: false,
  },
  limitations: [
    "Transport test only; not browser rendering or production capacity acceptance",
    "All clients run on the same machine; no WAN, CDN or WeChat device coverage",
  ],
};
const deadline = AbortSignal.timeout(45000);
const samples = [];
let bytes = 0;
async function port() {
  const s = createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
function start(name, bin, args) {
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
  const record = { name, child, log: "", done: null };
  record.done = new Promise((resolve) => {
    child.once("error", (e) => {
      record.log += e.message;
      resolve();
    });
    child.once("exit", resolve);
  });
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (d) => (record.log = (record.log + d).slice(-4000)));
  children.push(record);
  return record;
}
async function read(url, measure = true) {
  deadline.throwIfAborted();
  const t = performance.now();
  const response = await fetch(url, {
    signal: AbortSignal.any([deadline, AbortSignal.timeout(5000)]),
  });
  assert.equal(response.status, 200, `HLS status ${response.status}`);
  const data = new Uint8Array(await response.arrayBuffer());
  if (measure) {
    samples.push(performance.now() - t);
    bytes += data.length;
  }
  return data;
}
function localUrl(uri, base) {
  const url = new URL(uri, base);
  assert.equal(url.origin, new URL(base).origin);
  return url.href;
}
function uris(data) {
  return new TextDecoder()
    .decode(data)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"));
}
try {
  const rtmp = await port(),
    hls = await port();
  assert.notEqual(rtmp, hls);
  const config = `logLevel: warn\nmoq: false\napi: false\nrtsp: false\nsrt: false\nwebrtc: false\nrtmp: true\nrtmpAddress: 127.0.0.1:${rtmp}\nhls: true\nhlsAddress: 127.0.0.1:${hls}\nhlsVariant: mpegts\nhlsSegmentCount: 7\nhlsSegmentDuration: 1s\npaths:\n  all_others:\n`;
  await writeFile(join(dir, "mediamtx.yml"), config);
  start("media", binaries.media, [join(dir, "mediamtx.yml")]);
  // Readiness checks the owned listener, not an unrelated application's endpoint.
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {
      await fetch(`http://127.0.0.1:${hls}/`, {
        signal: AbortSignal.timeout(300),
      });
      ready = true;
      break;
    } catch {
      await delay(100);
    }
  }
  assert.ok(ready, "media listener failed to start");
  start("publisher", binaries.ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-re",
    "-f",
    "lavfi",
    "-i",
    "testsrc2=size=360x640:rate=15",
    "-f",
    "lavfi",
    "-i",
    "sine=frequency=440:sample_rate=44100",
    "-t",
    "35",
    "-c:v",
    "libx264",
    "-preset",
    "ultrafast",
    "-tune",
    "zerolatency",
    "-g",
    "15",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-f",
    "flv",
    `rtmp://127.0.0.1:${rtmp}/load`,
  ]);
  const master = `http://127.0.0.1:${hls}/load/index.m3u8`;
  let manifest;
  for (let i = 0; i < 60; i++) {
    try {
      manifest = await read(master, false);
      break;
    } catch {
      deadline.throwIfAborted();
      await delay(150);
    }
  }
  assert.ok(manifest, "publisher produced no HLS master");
  const playlist = localUrl(
    uris(manifest).find((s) => s.includes(".m3u8")),
    master,
  );
  const allSegments = new Set();
  let decodeSample;
  const startAt = performance.now();
  await Promise.all(
    Array.from({ length: clients }, async () => {
      const seen = new Set();
      for (let round = 0; round < 4; round++) {
        const list = await read(playlist);
        const segment = uris(list).at(-1);
        assert.ok(segment, "empty media playlist");
        const url = localUrl(segment, playlist);
        const data = await read(url);
        assert.ok(
          data.length > 188 && data.length % 188 === 0,
          "invalid MPEG-TS size",
        );
        for (let n = 0; n < data.length; n += 188)
          assert.equal(data[n], 0x47, "MPEG-TS sync lost");
        seen.add(url);
        allSegments.add(url);
        decodeSample ??= data;
        if (round < 3) await delay(1200);
      }
      assert.ok(seen.size >= 2, "client did not receive advancing media");
    }),
  );
  await writeFile(join(dir, "sample.ts"), decodeSample);
  const decoder = start("decoder", binaries.ffmpeg, [
    "-hide_banner",
    "-loglevel",
    "error",
    "-i",
    join(dir, "sample.ts"),
    "-f",
    "null",
    "-",
  ]);
  await decoder.done;
  assert.equal(decoder.child.exitCode, 0, "sample decode failed");
  samples.sort((a, b) => a - b);
  report.passed = true;
  report.measurements = {
    requests: samples.length,
    bytes,
    uniqueSegments: allSegments.size,
    roundsPerClient: 4,
    elapsedMs: Math.round(performance.now() - startAt),
    p95Ms: Number(samples[Math.ceil(samples.length * 0.95) - 1].toFixed(2)),
    sampleDecoded: true,
  };
} catch (e) {
  report.error = e.message;
  report.diagnostics = children.map((c) => ({ name: c.name, log: c.log }));
  process.exitCode = 1;
} finally {
  for (const c of children) {
    if (c.child.exitCode === null && c.child.signalCode === null)
      c.child.kill("SIGTERM");
  }
  await Promise.all(
    children.map(async (c) => {
      await Promise.race([c.done, delay(2000)]);
      if (c.child.exitCode === null && c.child.signalCode === null) {
        c.child.kill("SIGKILL");
        await c.done;
      }
    }),
  );
  await rm(dir, { recursive: true, force: true });
  report.cleanup = {
    ownedProcessesStopped: true,
    temporaryFilesRemoved: true,
    existingServicesModified: false,
  };
  console.log(JSON.stringify(report, null, 2));
}
