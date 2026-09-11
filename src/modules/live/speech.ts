import { createHash, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import type { AgentBridge } from "../../platform/adapters/public.js";
import { equalSecret } from "../../platform/identity/public.js";
import {
  transaction,
  type Config,
} from "../../platform/infrastructure/public.js";
import type { AgentContext, AgentRun } from "../../shared/agent.js";
import type { LivePort } from "../../shared/live-ports.js";
import type { DB } from "../../shared/persistence.js";
import {
  claimSpeechAnalysisJob,
  completeSpeechAnalysisJob,
  findLatestSpeechSegment,
  findSpeechAnalysis,
  findSpeechSegmentByEvent,
  insertSpeechAnalysis,
  insertSpeechAnalysisJob,
  insertSpeechSegment,
  listDueSpeechAnalysisJobs,
  listRecentSpeechSegments,
  resetRunningSpeechAnalysisJobs,
  retrySpeechAnalysisJob,
} from "./persistence/speech-queries.js";

type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
type SpeechRow = {
  id: string;
  room_id: string;
  merchant_id: string;
  provider: "webhook";
  provider_event_id: string;
  text: string;
  live_started_at: number;
  started_offset_ms: number;
  ended_offset_ms: number;
  received_at: number;
  attempts?: number;
  agent_run_id?: string | null;
  analysis_attempts?: number | null;
  analysis_last_error?: string | null;
};

const segmentSchema = z
  .object({
    roomId: z.string().min(1).max(128),
    eventId: z.string().regex(/^[a-zA-Z0-9_.:-]{1,100}$/),
    text: z.string().trim().min(1).max(4000),
    startedOffsetMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000),
    endedOffsetMs: z
      .number()
      .int()
      .min(0)
      .max(24 * 60 * 60 * 1000),
    final: z.boolean(),
  })
  .strict()
  .refine((value) => value.endedOffsetMs >= value.startedOffsetMs, {
    message: "endedOffsetMs must be greater than or equal to startedOffsetMs",
    path: ["endedOffsetMs"],
  });

const idempotencyKey = (roomId: string, startedAt: number, eventId: string) =>
  `speech:${createHash("sha256")
    .update(`${roomId}\0${startedAt}\0${eventId}`)
    .digest("hex")}`;

function transcriptWindow(db: DB, row: SpeechRow) {
  const segments = listRecentSpeechSegments(
    db,
    row.room_id,
    row.live_started_at,
    8,
  ) as { text: string }[];
  return segments
    .reverse()
    .map((item) => item.text)
    .join("\n")
    .slice(-4000);
}

export function attachSpeechIngestion(
  app: App,
  db: DB,
  config: Config,
  live: LivePort,
  bridge: AgentBridge,
  contextFor: (
    roomId: string,
    tenant: string,
    input: { transcript: string },
  ) => AgentContext,
  clock: () => number,
) {
  let active: Promise<void> | null = null;
  let wakeTimer: ReturnType<typeof setTimeout> | null = null;
  let closing = false;
  let wakeRequested = false;
  const analysisFor = (segmentId: string) =>
    findSpeechAnalysis(db, segmentId) as
      { agent_run_id: string; created_at: number } | undefined;

  async function dispatch(row: SpeechRow) {
    const prior = analysisFor(row.id);
    if (prior) {
      completeSpeechAnalysisJob(db, clock(), row.id);
      return;
    }
    if (!config.speechAgentProfileId) {
      const now = clock();
      retrySpeechAnalysisJob(
        db,
        now + 60000,
        "profile_unconfigured",
        now,
        row.id,
      );
      return;
    }
    if (!Number(claimSpeechAnalysisJob(db, clock(), row.id).changes)) return;
    try {
      const data = await bridge.request<{ run: AgentRun }>(
        row.merchant_id,
        "/v1/runs",
        "POST",
        {
          profileId: config.speechAgentProfileId,
          mode: "live",
          idempotencyKey: idempotencyKey(
            row.room_id,
            row.live_started_at,
            row.provider_event_id,
          ),
          context: contextFor(row.room_id, row.merchant_id, {
            transcript: transcriptWindow(db, row),
          }),
        },
      );
      if (!data.run?.id || data.run.roomId !== row.room_id)
        throw new Error("invalid_agent_run");
      transaction(db, () => {
        insertSpeechAnalysis(db, row.id, data.run.id, clock());
        completeSpeechAnalysisJob(db, clock(), row.id);
      });
    } catch {
      const now = clock();
      const delay = Math.min(
        60000,
        1000 * 2 ** Math.min(Number(row.attempts || 0), 6),
      );
      retrySpeechAnalysisJob(db, now + delay, "agent_unavailable", now, row.id);
    }
  }

  function schedule() {
    if (closing || wakeTimer) return;
    if (active) {
      wakeRequested = true;
      return;
    }
    wakeTimer = setTimeout(() => {
      wakeTimer = null;
      void process();
    }, 0);
  }

  function process(): Promise<void> {
    if (closing || config.speechProvider !== "webhook")
      return Promise.resolve();
    if (active) return active;
    let fullBatch = false;
    active = (async () => {
      const rows = listDueSpeechAnalysisJobs(
        db,
        clock(),
        config.speechDispatchConcurrency,
      ) as SpeechRow[];
      fullBatch = rows.length === config.speechDispatchConcurrency;
      await Promise.all(rows.map(dispatch));
    })()
      .catch(() => {})
      .finally(() => {
        active = null;
        if (fullBatch || wakeRequested) {
          wakeRequested = false;
          schedule();
        }
      });
    return active;
  }

  if (config.speechProvider === "webhook") {
    resetRunningSpeechAnalysisJobs(db, clock(), clock());
    schedule();
  }

  app.post("/api/streams/speech/segments", async (c) => {
    if (config.speechProvider !== "webhook")
      throw new HTTPException(503, { message: "实时语音接入尚未配置" });
    const authorization = c.req.header("authorization") || "";
    if (
      !authorization.startsWith("Bearer ") ||
      !equalSecret(
        authorization.slice("Bearer ".length),
        config.speechIngestSecret,
      )
    )
      throw new HTTPException(401, { message: "语音供应方鉴权失败" });
    if (!c.req.header("content-type")?.startsWith("application/json"))
      throw new HTTPException(415, { message: "需要 application/json 请求" });
    const input = segmentSchema.parse(await c.req.json());
    if (!input.final) return c.json({ accepted: false, ignored: "interim" });
    const room = live.room(input.roomId);
    if (room.status !== "live" || room.live_started_at <= 0)
      throw new HTTPException(409, { message: "直播间当前未开播" });
    const candidateId = randomUUID(),
      receivedAt = clock();
    const row = transaction(db, () => {
      insertSpeechSegment(
        db,
        candidateId,
        room.id,
        "webhook",
        input.eventId,
        input.text,
        room.live_started_at,
        input.startedOffsetMs,
        input.endedOffsetMs,
        receivedAt,
      );
      const saved = findSpeechSegmentByEvent(
        db,
        room.id,
        room.live_started_at,
        "webhook",
        input.eventId,
      ) as SpeechRow;
      if (
        saved.text !== input.text ||
        saved.started_offset_ms !== input.startedOffsetMs ||
        saved.ended_offset_ms !== input.endedOffsetMs
      )
        throw new HTTPException(409, {
          message: "同一语音事件不能提交不同内容",
        });
      insertSpeechAnalysisJob(db, saved.id, receivedAt, receivedAt);
      return saved;
    });
    schedule();
    const analysis = analysisFor(row.id);
    return c.json(
      {
        accepted: true,
        duplicate: row.id !== candidateId,
        segment: { id: row.id, receivedAt: row.received_at },
        analysis: {
          configured: Boolean(config.speechAgentProfileId),
          queued: Boolean(analysis),
          state: analysis
            ? "queued"
            : config.speechAgentProfileId
              ? "pending"
              : "waiting_profile",
          ...(analysis ? { runId: analysis.agent_run_id } : {}),
        },
      },
      row.id === candidateId ? 202 : 200,
    );
  });

  app.get("/api/merchant/rooms/:id/speech/status", (c) => {
    const room = live.owned(c.req.param("id"), c.get("merchantId"));
    const latest = findLatestSpeechSegment(db, room.id) as
      SpeechRow | undefined;
    return c.json({
      provider: config.speechProvider,
      configured: config.speechProvider === "webhook",
      agentProfileConfigured: Boolean(config.speechAgentProfileId),
      latest: latest
        ? {
            id: latest.id,
            text: latest.text,
            receivedAt: latest.received_at,
            startedOffsetMs: latest.started_offset_ms,
            endedOffsetMs: latest.ended_offset_ms,
            currentSession: latest.live_started_at === room.live_started_at,
            analysis: latest.agent_run_id
              ? { state: "queued", runId: latest.agent_run_id }
              : {
                  state: !config.speechAgentProfileId
                    ? "waiting_profile"
                    : latest.analysis_last_error
                      ? "retrying"
                      : "pending",
                  attempts: Number(latest.analysis_attempts || 0),
                },
          }
        : null,
    });
  });

  return {
    process,
    async close() {
      closing = true;
      wakeRequested = false;
      if (wakeTimer) clearTimeout(wakeTimer);
      wakeTimer = null;
      await (active || Promise.resolve());
      if (config.speechProvider === "webhook")
        resetRunningSpeechAnalysisJobs(db, clock(), clock());
    },
  };
}
