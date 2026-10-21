import { useEffect, useState } from "react";
import { Sparkles, ArrowUpRight } from "lucide-react";
import type { AgentRun } from "../shared/agent.js";
import { api } from "./api.js";

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
  useEffect(() => {
    let active = true;
    setState(null);
    const refresh = () =>
      api<{ available: boolean; run: AgentRun | null }>(
        `/merchant/rooms/${roomId}/agent/latest`,
      )
        .then((value) => {
          if (active) setState(value);
        })
        .catch(() => {
          if (active) setState({ available: false, run: null });
        });
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
