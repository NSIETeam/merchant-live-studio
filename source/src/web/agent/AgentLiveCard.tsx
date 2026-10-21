import { useEffect, useState } from "react";
import { Sparkles, ArrowUpRight } from "lucide-react";
import type { AgentRun } from "../../shared/agent.js";
import { api } from "../shared/api.js";

type SpeechStatus = {
  provider: "disabled" | "webhook";
  configured: boolean;
  agentProfileConfigured: boolean;
  relay?: {
    state:
      | "unconfigured"
      | "waiting"
      | "starting"
      | "ready"
      | "degraded"
      | "stopped"
      | "stale";
    code?:
      | "waiting_audio"
      | "flowing"
      | "delivery_failed"
      | "source_stopped"
      | "source_failed";
    updatedAt?: number;
  };
  latest: null | {
    text: string;
    receivedAt: number;
    currentSession: boolean;
    analysis: {
      state: "queued" | "pending" | "retrying" | "waiting_profile";
      runId?: string;
      attempts?: number;
    };
  };
};

export function AgentLiveCard({
  roomId,
  onOpen,
}: {
  roomId: string;
  onOpen: () => void;
}) {
  const [state, setState] = useState<{
    available: boolean;
    run: AgentRun | null;
  } | null>(null);
  const [speech, setSpeech] = useState<SpeechStatus | null>(null);
  useEffect(() => {
    let active = true;
    setState(null);
    setSpeech(null);
    const refresh = async () => {
      const [agentResult, speechResult] = await Promise.allSettled([
        api<{ available: boolean; run: AgentRun | null }>(
          `/merchant/rooms/${roomId}/agent/latest`,
        ),
        api<SpeechStatus>(`/merchant/rooms/${roomId}/speech/status`),
      ]);
      if (!active) return;
      setState(
        agentResult.status === "fulfilled"
          ? agentResult.value
          : { available: false, run: null },
      );
      setSpeech(
        speechResult.status === "fulfilled" ? speechResult.value : null,
      );
    };
    void refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void refresh();
    }, 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [roomId]);
  const run = state?.run;
  const speechMessage =
    speech === null
      ? "正在确认接入状态"
      : !speech.configured
        ? "未配置供应方"
        : speech.latest?.currentSession
          ? `${new Date(speech.latest.receivedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 收到片段 · ${{ queued: "已交给 Agent", pending: "等待分析", retrying: "等待 Agent 重试", waiting_profile: "待选择表达方案" }[speech.latest.analysis.state]}`
          : {
              waiting: "转写接收接口已配置，等待媒体中继启动",
              starting: "媒体中继已启动，等待首个音频片段",
              ready: "媒体与转写链路正常，等待本场可识别语音",
              degraded:
                speech.relay?.code === "delivery_failed"
                  ? "转写或回送异常，视频直播继续运行"
                  : "媒体音频读取异常，视频直播继续运行",
              stopped: "媒体中继已停止，当前没有语音分析",
              stale: "媒体中继状态已超时，请检查转写服务",
              unconfigured: "未配置供应方",
            }[speech.relay?.state || "waiting"];
  return (
    <section className="card">
      <div className="section-title">
        <h2>
          <Sparkles size={18} />
          直播 Agent
        </h2>
        <span className="muted">独立协作</span>
      </div>
      <p className="fine-print">实时语音：{speechMessage}</p>
      {run?.stale ? (
        <p className="empty-copy">{run.staleReason}</p>
      ) : run?.result ? (
        <>
          <p>{run.result.suggestion}</p>
          {!!run.result.claimDecisions?.length && (
            <p className="fine-print" role="status">
              语义复核：
              {
                run.result.claimDecisions.filter(
                  (decision) => decision.disposition === "block",
                ).length
              }{" "}
              项建议暂停，
              {
                run.result.claimDecisions.filter(
                  (decision) => decision.disposition !== "block",
                ).length
              }{" "}
              项需结合语境。打开工作台查看依据要求和处理方向。
            </p>
          )}
          <p className="fine-print">
            最近{run.mode === "rehearsal" ? "试演" : "建议"} · 版本{" "}
            {run.promptVersion} ·{" "}
            {run.result.provider === "remote-model" ? "模型生成" : "本地规则"}
            。采用前核对当前商品与活动。
          </p>
        </>
      ) : (
        <p className="empty-copy">
          {state && !state.available
            ? "Agent 暂时未连接，直播和红包继续运行。"
            : run && ["queued", "running"].includes(run.status)
              ? "Agent 正在准备建议，直播照常进行。"
              : "在 Agent 中打磨风格和提示词，通过接口将建议带入直播。"}
        </p>
      )}
      <button className="secondary full" onClick={onOpen}>
        打开 Agent 工作台 <ArrowUpRight size={16} />
      </button>
    </section>
  );
}
