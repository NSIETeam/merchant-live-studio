import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { z } from "zod";

const responseLimit = 64 * 1024;
const roomPattern = /^[a-zA-Z0-9_-]{1,100}$/;

export interface SpeechRelayConfig {
  roomId: string;
  sourceUrl: string;
  sourceId: string;
  asrEndpoint: string;
  asrModel: string;
  asrApiKey?: string;
  ingestEndpoint: string;
  statusEndpoint: string;
  ingestSecret: string;
  ffmpegPath: string;
  segmentSeconds: number;
  timeoutMs: number;
}

function isLoopback(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "");
  return (
    host === "localhost" ||
    host === "::1" ||
    (isIP(host) === 4 && host.startsWith("127."))
  );
}

function endpoint(
  value: string,
  name: string,
  policy: "remote-https" | "loopback",
) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} must be a complete URL`);
  }
  if (url.username || url.password || url.hash)
    throw new Error(`${name} cannot contain credentials or a fragment`);
  if (policy === "loopback") {
    if (
      !isLoopback(url.hostname) ||
      !["http:", "https:"].includes(url.protocol)
    )
      throw new Error(`${name} must use a loopback HTTP(S) endpoint`);
  } else if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopback(url.hostname))
  )
    throw new Error(`${name} requires HTTPS or loopback HTTP`);
  return url;
}

export function loadSpeechRelayConfig(
  env: NodeJS.ProcessEnv = process.env,
): SpeechRelayConfig {
  const path = z
    .string()
    .regex(/^live\/[a-zA-Z0-9_-]{1,100}$/)
    .parse(env.MTX_PATH);
  const roomId = path.slice("live/".length);
  const sourceBase = endpoint(
    env.SPEECH_RELAY_HLS_BASE || "http://127.0.0.1:18891/live/",
    "SPEECH_RELAY_HLS_BASE",
    "loopback",
  );
  if (sourceBase.search || !sourceBase.pathname.endsWith("/"))
    throw new Error("SPEECH_RELAY_HLS_BASE must end with / and have no query");
  const sourceUrl = new URL(
    `${encodeURIComponent(roomId)}/index.m3u8`,
    sourceBase,
  );
  const asr = endpoint(
    z.string().min(1).parse(env.SPEECH_ASR_ENDPOINT),
    "SPEECH_ASR_ENDPOINT",
    "remote-https",
  );
  if (asr.search) throw new Error("SPEECH_ASR_ENDPOINT cannot contain a query");
  const ingest = endpoint(
    env.SPEECH_INGEST_ENDPOINT ||
      "http://127.0.0.1:18890/api/streams/speech/segments",
    "SPEECH_INGEST_ENDPOINT",
    "loopback",
  );
  if (ingest.search)
    throw new Error("SPEECH_INGEST_ENDPOINT cannot contain a query");
  const defaultStatus = new URL(ingest);
  const canDeriveStatus = defaultStatus.pathname.endsWith("/segments");
  if (canDeriveStatus)
    defaultStatus.pathname = defaultStatus.pathname.replace(
      /\/segments$/,
      "/relay-status",
    );
  const statusValue =
    env.SPEECH_RELAY_STATUS_ENDPOINT ||
    (canDeriveStatus ? defaultStatus.href : "");
  if (!statusValue)
    throw new Error(
      "SPEECH_RELAY_STATUS_ENDPOINT is required when the ingest path is nonstandard",
    );
  const status = endpoint(
    statusValue,
    "SPEECH_RELAY_STATUS_ENDPOINT",
    "loopback",
  );
  if (status.search)
    throw new Error("SPEECH_RELAY_STATUS_ENDPOINT cannot contain a query");
  const ingestSecret = z.string().min(32).parse(env.SPEECH_INGEST_SECRET);
  const ffmpegPath = z
    .string()
    .regex(/^\/[\w./-]+$/)
    .parse(env.SPEECH_RELAY_FFMPEG || "/usr/bin/ffmpeg");
  return {
    roomId,
    sourceUrl: sourceUrl.href,
    sourceId: z
      .string()
      .max(200)
      .parse(env.MTX_SOURCE_ID || "unknown-source"),
    asrEndpoint: asr.href,
    asrModel: z.string().trim().min(1).max(200).parse(env.SPEECH_ASR_MODEL),
    asrApiKey: env.SPEECH_ASR_API_KEY || undefined,
    ingestEndpoint: ingest.href,
    statusEndpoint: status.href,
    ingestSecret,
    ffmpegPath,
    segmentSeconds: z.coerce
      .number()
      .int()
      .min(3)
      .max(15)
      .parse(env.SPEECH_RELAY_SEGMENT_SECONDS || 5),
    timeoutMs: z.coerce
      .number()
      .int()
      .min(1000)
      .max(60000)
      .parse(env.SPEECH_ASR_TIMEOUT_MS || 20000),
  };
}

export type SpeechRelayState = "starting" | "ready" | "degraded" | "stopped";
export type SpeechRelayCode =
  | "waiting_audio"
  | "flowing"
  | "delivery_failed"
  | "source_stopped"
  | "source_failed";

export async function reportSpeechRelayStatus(
  config: SpeechRelayConfig,
  input: {
    runId: string;
    state: SpeechRelayState;
    code: SpeechRelayCode;
  },
  fetchImpl: typeof fetch = fetch,
) {
  const response = await fetchImpl(config.statusEndpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.ingestSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ roomId: config.roomId, ...input }),
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10000)),
  });
  await boundedText(response);
}

async function boundedText(response: Response) {
  if (!response.ok) throw new Error("upstream request failed");
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > responseLimit)
    throw new Error("upstream response is too large");
  const body = await response.text();
  if (Buffer.byteLength(body, "utf8") > responseLimit)
    throw new Error("upstream response is too large");
  return body;
}

export function speechRelayEventId(
  sourceId: string,
  startedOffsetMs: number,
  endedOffsetMs: number,
  audio: Uint8Array,
) {
  return `asr-${createHash("sha256")
    .update(sourceId)
    .update("\0")
    .update(String(startedOffsetMs))
    .update("\0")
    .update(String(endedOffsetMs))
    .update("\0")
    .update(audio)
    .digest("hex")}`;
}

export function pcmWavDurationMs(audio: Uint8Array) {
  const view = Buffer.from(audio.buffer, audio.byteOffset, audio.byteLength);
  if (
    view.length < 44 ||
    view.toString("ascii", 0, 4) !== "RIFF" ||
    view.toString("ascii", 8, 12) !== "WAVE"
  )
    throw new Error("audio segment is not a PCM WAV");
  let offset = 12;
  let byteRate = 0;
  let dataBytes = 0;
  while (offset + 8 <= view.length) {
    const kind = view.toString("ascii", offset, offset + 4);
    const size = view.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (size > view.length - body)
      throw new Error("audio segment WAV chunk is truncated");
    if (kind === "fmt ") {
      if (size < 16 || view.readUInt16LE(body) !== 1)
        throw new Error("audio segment must use PCM WAV");
      byteRate = view.readUInt32LE(body + 8);
    } else if (kind === "data") dataBytes += size;
    offset = body + size + (size % 2);
  }
  if (!byteRate || !dataBytes)
    throw new Error("audio segment PCM WAV metadata is incomplete");
  const duration = Math.round((dataBytes / byteRate) * 1000);
  if (duration < 100 || duration > 30000)
    throw new Error("audio segment duration is outside bounds");
  return duration;
}

export async function relaySpeechChunk(
  config: SpeechRelayConfig,
  audio: Uint8Array,
  offsets: { startedOffsetMs: number; endedOffsetMs: number },
  fetchImpl: typeof fetch = fetch,
) {
  if (!audio.byteLength || audio.byteLength > 2 * 1024 * 1024)
    throw new Error("audio segment size is invalid");
  const blobBytes = new Uint8Array(audio.byteLength);
  blobBytes.set(audio);
  const form = new FormData();
  form.set(
    "file",
    new Blob([blobBytes.buffer], { type: "audio/wav" }),
    "segment.wav",
  );
  form.set("model", config.asrModel);
  form.set("language", "zh");
  form.set("response_format", "json");
  const asrResponse = await fetchImpl(config.asrEndpoint, {
    method: "POST",
    redirect: "error",
    headers: config.asrApiKey
      ? { Authorization: `Bearer ${config.asrApiKey}` }
      : undefined,
    body: form,
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(await boundedText(asrResponse));
  } catch {
    throw new Error("ASR response is invalid");
  }
  const text = z
    .object({ text: z.string().trim().max(4000) })
    .passthrough()
    .parse(parsed).text;
  if (!text) return { delivered: false, textLength: 0, eventId: null };
  const eventId = speechRelayEventId(
    config.sourceId,
    offsets.startedOffsetMs,
    offsets.endedOffsetMs,
    audio,
  );
  const ingestResponse = await fetchImpl(config.ingestEndpoint, {
    method: "POST",
    redirect: "error",
    headers: {
      Authorization: `Bearer ${config.ingestSecret}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      roomId: config.roomId,
      eventId,
      text,
      ...offsets,
      final: true,
    }),
    signal: AbortSignal.timeout(Math.min(config.timeoutMs, 10000)),
  });
  await boundedText(ingestResponse);
  return { delivered: true, textLength: text.length, eventId };
}
