import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { runSpeechRelay } from "../src/composition/speech-relay.js";
import {
  loadSpeechRelayConfig,
  pcmWavDurationMs,
  relaySpeechChunk,
  speechRelayEventId,
  type SpeechRelayConfig,
} from "../src/platform/adapters/public.js";

const secret = "speech-relay-ingest-secret-32-characters";
const environment = {
  MTX_PATH: "live/room-one",
  MTX_SOURCE_ID: "publisher-source-one",
  SPEECH_ASR_ENDPOINT: "https://asr.example.test/v1/audio/transcriptions",
  SPEECH_ASR_MODEL: "faster-whisper-large-v3",
  SPEECH_INGEST_SECRET: secret,
};

test("speech relay configuration fixes a room-scoped internal source and rejects unsafe endpoints", () => {
  const config = loadSpeechRelayConfig(environment);
  assert.equal(config.roomId, "room-one");
  assert.equal(
    config.sourceUrl,
    "http://127.0.0.1:18891/live/room-one/index.m3u8",
  );
  assert.equal(
    config.ingestEndpoint,
    "http://127.0.0.1:18890/api/streams/speech/segments",
  );
  assert.equal(
    config.statusEndpoint,
    "http://127.0.0.1:18890/api/streams/speech/relay-status",
  );
  assert.equal(config.segmentSeconds, 5);
  assert.equal(config.timeoutMs, 20000);

  for (const invalid of [
    { ...environment, MTX_PATH: "other/room-one" },
    {
      ...environment,
      SPEECH_RELAY_HLS_BASE: "https://external.example/live/",
    },
    {
      ...environment,
      SPEECH_INGEST_ENDPOINT:
        "https://external.example/api/streams/speech/segments",
    },
    {
      ...environment,
      SPEECH_ASR_ENDPOINT: "http://external.example/v1/audio/transcriptions",
    },
    { ...environment, SPEECH_INGEST_SECRET: "short" },
    {
      ...environment,
      SPEECH_INGEST_ENDPOINT: "http://127.0.0.1:18890/private-ingest",
    },
  ])
    assert.throws(() => loadSpeechRelayConfig(invalid));
});

test("speech relay transcribes one bounded WAV and sends one authenticated final segment", async () => {
  const config: SpeechRelayConfig = loadSpeechRelayConfig({
    ...environment,
    SPEECH_ASR_API_KEY: "private-asr-key",
  });
  const audio = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: input.toString(), init });
    if (calls.length === 1) return Response.json({ text: "  合成转写文本。 " });
    return Response.json({ accepted: true }, { status: 202 });
  };
  const result = await relaySpeechChunk(
    config,
    audio,
    { startedOffsetMs: 5000, endedOffsetMs: 10000 },
    fetchImpl,
  );
  assert.equal(result.delivered, true);
  assert.equal(result.textLength, 7);
  assert.match(result.eventId!, /^asr-[a-f0-9]{64}$/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, config.asrEndpoint);
  assert.equal(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer private-asr-key",
  );
  const form = calls[0].init?.body as FormData;
  assert.equal(form.get("model"), config.asrModel);
  assert.equal(form.get("language"), "zh");
  assert.ok(form.get("file") instanceof Blob);
  assert.equal(calls[1].url, config.ingestEndpoint);
  const delivered = JSON.parse(String(calls[1].init?.body));
  assert.deepEqual(delivered, {
    roomId: "room-one",
    eventId: result.eventId,
    text: "合成转写文本。",
    startedOffsetMs: 5000,
    endedOffsetMs: 10000,
    final: true,
  });
  assert.equal(
    (calls[1].init?.headers as Record<string, string>).Authorization,
    `Bearer ${secret}`,
  );
  assert.equal(JSON.stringify(delivered).includes("private-asr-key"), false);
  assert.equal(JSON.stringify(delivered).includes(secret), false);
  assert.equal(
    result.eventId,
    speechRelayEventId(config.sourceId, 5000, 10000, audio),
  );
});

test("empty or invalid ASR output never creates a speech segment", async () => {
  const config = loadSpeechRelayConfig(environment);
  const audio = new Uint8Array([82, 73, 70, 70, 1]);
  let calls = 0;
  const empty = await relaySpeechChunk(
    config,
    audio,
    { startedOffsetMs: 0, endedOffsetMs: 5000 },
    async () => {
      calls++;
      return Response.json({ text: "  " });
    },
  );
  assert.deepEqual(empty, { delivered: false, textLength: 0, eventId: null });
  assert.equal(calls, 1);

  const privateDetail = "private upstream diagnostic";
  await assert.rejects(
    () =>
      relaySpeechChunk(
        config,
        audio,
        { startedOffsetMs: 0, endedOffsetMs: 5000 },
        async () => new Response(privateDetail, { status: 500 }),
      ),
    (error: Error) => !error.message.includes(privateDetail),
  );
  await assert.rejects(() =>
    relaySpeechChunk(
      config,
      new Uint8Array(2 * 1024 * 1024 + 1),
      { startedOffsetMs: 0, endedOffsetMs: 5000 },
      async () => {
        throw new Error("must not run");
      },
    ),
  );
});

test("relay runtime consumes completed chunks and exits cleanly with its capture process", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-relay-test-"));
  const fakeFfmpeg = join(root, "fake-ffmpeg");
  writeFileSync(
    fakeFfmpeg,
    `#!/usr/bin/env python3
import pathlib, sys
pattern=sys.argv[-1]
for index in range(2):
    import wave
    with wave.open(pattern.replace('%08d', f'{index:08d}'), 'wb') as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16000)
        output.writeframes(bytes([index + 1]) * 96000)
`,
  );
  chmodSync(fakeFfmpeg, 0o700);
  const received: any[] = [];
  const statuses: any[] = [];
  let asrCalls = 0;
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/v1/audio/transcriptions") {
        asrCalls++;
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ text: `转写片段${asrCalls}` }));
        return;
      }
      if (request.url === "/api/streams/speech/segments") {
        received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.statusCode = 202;
        response.setHeader("content-type", "application/json");
        response.end('{"accepted":true}');
        return;
      }
      if (request.url === "/api/streams/speech/relay-status") {
        statuses.push({
          ...JSON.parse(Buffer.concat(chunks).toString("utf8")),
          authorization: request.headers.authorization,
        });
        response.statusCode = 202;
        response.setHeader("content-type", "application/json");
        response.end('{"accepted":true}');
        return;
      }
      response.statusCode = 404;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const config = loadSpeechRelayConfig({
      ...environment,
      SPEECH_ASR_ENDPOINT: `${origin}/v1/audio/transcriptions`,
      SPEECH_INGEST_ENDPOINT: `${origin}/api/streams/speech/segments`,
      SPEECH_RELAY_FFMPEG: fakeFfmpeg,
      SPEECH_RELAY_SEGMENT_SECONDS: "3",
    });
    await runSpeechRelay(config);
    assert.equal(asrCalls, 2);
    assert.equal(received.length, 2);
    assert.deepEqual(
      statuses.map(({ state, code }) => ({ state, code })),
      [
        { state: "starting", code: "waiting_audio" },
        { state: "ready", code: "flowing" },
        { state: "ready", code: "flowing" },
        { state: "stopped", code: "source_stopped" },
      ],
    );
    assert.ok(statuses.every((item) => item.roomId === "room-one"));
    assert.ok(statuses.every((item) => item.runId === statuses[0].runId));
    assert.ok(
      statuses.every((item) => item.authorization === `Bearer ${secret}`),
    );
    assert.deepEqual(
      received.map((item) => ({
        roomId: item.roomId,
        text: item.text,
        startedOffsetMs: item.startedOffsetMs,
        endedOffsetMs: item.endedOffsetMs,
        final: item.final,
      })),
      [
        {
          roomId: "room-one",
          text: "转写片段1",
          startedOffsetMs: 0,
          endedOffsetMs: 3000,
          final: true,
        },
        {
          roomId: "room-one",
          text: "转写片段2",
          startedOffsetMs: 3000,
          endedOffsetMs: 6000,
          final: true,
        },
      ],
    );
    assert.notEqual(received[0].eventId, received[1].eventId);
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

test("relay runtime reports a bounded delivery failure without leaking the upstream response", async () => {
  const root = mkdtempSync(join(tmpdir(), "speech-relay-failure-test-"));
  const fakeFfmpeg = join(root, "fake-ffmpeg");
  writeFileSync(
    fakeFfmpeg,
    `#!/usr/bin/env python3
import sys, wave
with wave.open(sys.argv[-1].replace('%08d', '00000000'), 'wb') as output:
    output.setnchannels(1)
    output.setsampwidth(2)
    output.setframerate(16000)
    output.writeframes(bytes([1]) * 96000)
`,
  );
  chmodSync(fakeFfmpeg, 0o700);
  const statuses: any[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      if (request.url === "/api/streams/speech/relay-status") {
        statuses.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        response.setHeader("content-type", "application/json");
        response.end('{"accepted":true}');
        return;
      }
      if (request.url === "/v1/audio/transcriptions") {
        response.statusCode = 503;
        response.end("private model failure detail");
        return;
      }
      response.statusCode = 500;
      response.end();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const origin = `http://127.0.0.1:${address.port}`;
  try {
    const config = loadSpeechRelayConfig({
      ...environment,
      SPEECH_ASR_ENDPOINT: `${origin}/v1/audio/transcriptions`,
      SPEECH_INGEST_ENDPOINT: `${origin}/api/streams/speech/segments`,
      SPEECH_RELAY_FFMPEG: fakeFfmpeg,
      SPEECH_RELAY_SEGMENT_SECONDS: "3",
    });
    await assert.rejects(
      () => runSpeechRelay(config),
      (error: Error) =>
        error.message === "speech chunk delivery failed" &&
        !error.message.includes("private model failure detail"),
    );
    assert.deepEqual(
      statuses.map(({ state, code }) => ({ state, code })),
      [
        { state: "starting", code: "waiting_audio" },
        { state: "degraded", code: "delivery_failed" },
      ],
    );
  } finally {
    server.close();
    await once(server, "close");
    rmSync(root, { recursive: true, force: true });
  }
});

test("PCM WAV duration uses audio metadata and rejects malformed chunks", () => {
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF", 0, "ascii");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8, "ascii");
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24);
  wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36, "ascii");
  wav.writeUInt32LE(32000, 40);
  assert.equal(pcmWavDurationMs(wav), 1000);
  assert.throws(() => pcmWavDurationMs(Buffer.from("not a wav")));
  const truncated = Buffer.from(wav);
  truncated.writeUInt32LE(64000, 40);
  assert.throws(() => pcmWavDurationMs(truncated));
});
