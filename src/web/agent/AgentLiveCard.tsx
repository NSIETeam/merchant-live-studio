import { useEffect, useState } from "react";
import { Sparkles, ArrowUpRight } from "lucide-react";
import type { AgentRun } from "../../shared/agent.js";
import { api } from "../shared/api.js";

type SpeechStatus = {
  provider: "disabled" | "webhook";
  configured: boolean;
  agentProfileConfigured: boolean;
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
  return (
    <section className="card">
      <div className="section-title">
        <h2>
          <Sparkles size={18} />
          直播 Agent
        </h2>
        <span className="muted">独立协作</span>
      </div>
      <p className="fine-print">
        实时语音：
        {speech === null
          ? "正在确认接入状态"
          : !speech.configured
            ? "未配置供应方"
            : speech.latest?.currentSession
              ? `${new Date(speech.latest.receivedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })} 收到片段 · ${{ queued: "已交给 Agent", pending: "等待分析", retrying: "等待 Agent 重试", waiting_profile: "待选择表达方案" }[speech.latest.analysis.state]}`
              : "已连接，等待本场语音"}
      </p>
      {run?.stale ? (
        <p className="empty-copy">{run.staleReason}</p>
      ) : run?.result ? (
        <>
          <p>{run.result.suggestion}</p>
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
