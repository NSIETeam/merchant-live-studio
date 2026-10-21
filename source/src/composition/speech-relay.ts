import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, stat, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  loadSpeechRelayConfig,
  pcmWavDurationMs,
  relaySpeechChunk,
  reportSpeechRelayStatus,
  type SpeechRelayCode,
  type SpeechRelayConfig,
} from "../platform/adapters/public.js";

const wait = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

async function deliverWithRetry(
  config: ReturnType<typeof loadSpeechRelayConfig>,
  audio: Uint8Array,
  offsets: { startedOffsetMs: number; endedOffsetMs: number },
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await relaySpeechChunk(config, audio, offsets);
    } catch {
      if (attempt === 2) throw new Error("speech chunk delivery failed");
      await wait(300 * 3 ** attempt);
    }
  }
  throw new Error("speech chunk delivery failed");
}

export async function runSpeechRelay(
  config: SpeechRelayConfig = loadSpeechRelayConfig(),
) {
  const root = await mkdtemp(join(tmpdir(), "merchant-live-speech-"));
  const runId = randomUUID();
  let child: ChildProcess | undefined;
  let stopping = false;
  let childExited = false;
  let childExitCode: number | null = null;
  let elapsedOffsetMs = 0;
  let failureCode: SpeechRelayCode = "source_failed";
  let failed = false;
  const report = async (
    state: "starting" | "ready" | "degraded" | "stopped",
    code: SpeechRelayCode,
  ) => {
    try {
      await reportSpeechRelayStatus(config, { runId, state, code });
    } catch {
      // Operational status is best effort and must not interrupt live audio.
    }
  };
  const stop = () => {
    stopping = true;
    if (child && !child.killed) child.kill("SIGINT");
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await report("starting", "waiting_audio");
    child = spawn(
      config.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-i",
        config.sourceUrl,
        "-map",
        "0:a:0",
        "-vn",
        "-acodec",
        "pcm_s16le",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-f",
        "segment",
        "-segment_time",
        String(config.segmentSeconds),
        "-reset_timestamps",
        "1",
        join(root, "chunk-%08d.wav"),
      ],
      { stdio: "ignore" },
    );
    child.once("error", () => {
      childExitCode = 127;
      childExited = true;
    });
    child.once("exit", (code) => {
      childExitCode = code;
      childExited = true;
    });

    while (true) {
      const files = (await readdir(root))
        .filter((name) => /^chunk-\d{8}\.wav$/.test(name))
        .sort();
      if (files.length > 13)
        throw new Error("speech relay backlog limit exceeded");
      const ready = childExited ? files : files.slice(0, -1);
      for (const name of ready) {
        const path = join(root, name);
        const file = await stat(path);
        if (file.size <= 44 || file.size > 2 * 1024 * 1024)
          throw new Error("speech audio segment is invalid");
        const audio = await readFile(path);
        const startedOffsetMs = elapsedOffsetMs;
        const endedOffsetMs = startedOffsetMs + pcmWavDurationMs(audio);
        try {
          await deliverWithRetry(config, audio, {
            startedOffsetMs,
            endedOffsetMs,
          });
        } catch {
          failureCode = "delivery_failed";
          throw new Error("speech chunk delivery failed");
        }
        await report("ready", "flowing");
        await unlink(path);
        elapsedOffsetMs = endedOffsetMs;
      }
      if (childExited && !(await readdir(root)).length) break;
      await wait(250);
    }
    if (!stopping && childExitCode !== 0)
      throw new Error("FFmpeg speech capture stopped unexpectedly");
  } catch (error) {
    failed = true;
    await report("degraded", failureCode);
    throw error;
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (child && !childExited && !child.killed) child.kill("SIGINT");
    await rm(root, { recursive: true, force: true });
    if (!failed) await report("stopped", "source_stopped");
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  runSpeechRelay().catch(() => {
    console.error("Speech relay stopped before the media source ended.");
    process.exitCode = 1;
  });
