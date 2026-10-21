import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Maximize2,
  Minus,
  Plus,
  X,
} from "lucide-react";
import type { ContentBinding } from "../../shared/content.js";
import { api } from "../shared/api.js";
import { pollResource } from "../shared/poll-resource.js";
import { BindingHistory } from "./BindingHistory.js";

export function BoundScriptPanel({
  roomId,
  onOpenContent,
}: {
  roomId: string;
  onOpenContent: () => void;
}) {
  const [binding, setBinding] = useState<ContentBinding | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [index, setIndex] = useState(0);
  const [size, setSize] = useState(23);
  const [expanded, setExpanded] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const toggleRef = useRef<HTMLButtonElement | null>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    setBinding(null);
    setLoading(true);
    setIndex(0);
    setExpanded(false);
    const polling = pollResource({
      read: (signal) =>
        api<{ binding: ContentBinding | null }>(
          `/merchant/content/rooms/${encodeURIComponent(roomId)}/binding`,
          "GET",
          undefined,
          { signal },
        ),
      onValue: (data) => {
        setBinding(data.binding);
        setError("");
        setLoading(false);
      },
      onError: (error) => {
        setError(error.message);
        setLoading(false);
      },
      intervalMs: 5000,
      timeoutMs: 8000,
    });
    const resume = () => {
      if (document.visibilityState === "visible") {
        setError("正在重新核对当前讲稿…");
        polling.refresh();
      } else {
        polling.pause();
      }
    };
    if (document.visibilityState === "hidden") polling.pause();
    document.addEventListener("visibilitychange", resume);
    return () => {
      polling.stop();
      document.removeEventListener("visibilitychange", resume);
    };
  }, [roomId]);
  useEffect(() => {
    setIndex(0);
  }, [binding?.courseId, binding?.scriptVersion]);
  useLayoutEffect(() => {
    if (!expanded) {
      if (restoreFocus.current) toggleRef.current?.focus();
      restoreFocus.current = false;
      return;
    }
    const dialog = dialogRef.current;
    if (!dialog) return;
    restoreFocus.current = true;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    dialog.showModal();
    toggleRef.current?.focus();
    return () => {
      dialog.close();
      document.body.style.overflow = overflow;
    };
  }, [expanded]);
  const script = binding?.script;
  const paragraphs = script?.paragraphs || [];
  const current = paragraphs[Math.min(index, paragraphs.length - 1)];
  const blocked = binding?.stale || !!error;
  const Panel = expanded ? "dialog" : "section";
  return (
    <Panel
      ref={(node) => {
        dialogRef.current =
          node?.tagName === "DIALOG" ? (node as HTMLDialogElement) : null;
      }}
      onCancel={(event) => {
        event.preventDefault();
        setExpanded(false);
      }}
      className={`card bound-script ${expanded ? "bound-expanded" : ""}`}
      aria-label="本场定稿播讲"
    >
      <div className="section-title">
        <h2>
          <BookOpen size={16} /> 本场定稿
        </h2>
        <div className="bound-actions">
          {binding && !blocked && (
            <span className="pill">讲稿 V{binding.scriptVersion}</span>
          )}
          {(binding || expanded) && (
            <button
              ref={toggleRef}
              className="icon-button"
              aria-label={expanded ? "退出专注播讲" : "专注播讲"}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? <X size={17} /> : <Maximize2 size={16} />}
            </button>
          )}
        </div>
      </div>
      {loading ? (
        <p className="empty-copy">正在读取本场讲稿…</p>
      ) : error ? (
        <p className="risk high" role="alert">
          {error} 暂停展示讲稿，等待重新核对当前版本。
        </p>
      ) : binding?.stale ? (
        <p className="risk high" role="alert">
          {binding.script.authorizationIssue ||
            "商品资料或讲稿状态已改变，当前版本需复核。重新定稿并绑定后再播讲。"}
        </p>
      ) : !binding ? (
        <p className="empty-copy">
          先在“商品与课程”中审改并定稿，再将课程绑定到这个直播间。
        </p>
      ) : (
        <>
          <p className="bound-product">
            {binding.productName}
            <small> · {binding.category}</small>
          </p>
          <p className="bound-heading">{binding.courseTitle}</p>
          <div
            className="bound-paragraph"
            style={{ fontSize: size }}
            aria-live="polite"
          >
            {current?.text}
          </div>
          <div className="bound-controls">
            <button
              className="secondary"
              disabled={index <= 0}
              onClick={() => setIndex((n) => Math.max(0, n - 1))}
            >
              <ChevronLeft size={15} />
              上一段
            </button>
            <span>
              {Math.min(index + 1, paragraphs.length)} / {paragraphs.length}
            </span>
            <button
              className="secondary"
              disabled={index >= paragraphs.length - 1}
              onClick={() =>
                setIndex((n) => Math.min(paragraphs.length - 1, n + 1))
              }
            >
              下一段
              <ChevronRight size={15} />
            </button>
            <div className="bound-actions">
              <button
                className="icon-button"
                aria-label="缩小讲稿字号"
                disabled={size <= 18}
                onClick={() => setSize((n) => n - 2)}
              >
                <Minus size={15} />
              </button>
              <span>{size}</span>
              <button
                className="icon-button"
                aria-label="放大讲稿字号"
                disabled={size >= 39}
                onClick={() => setSize((n) => n + 2)}
              >
                <Plus size={15} />
              </button>
            </div>
          </div>
          <details className="bound-overview">
            <summary>整稿目录与依据</summary>
            <ol>
              {paragraphs.map((p, i) => (
                <li key={p.id}>
                  <button
                    className={index === i ? "active" : ""}
                    onClick={() => setIndex(i)}
                  >
                    {p.text.slice(0, 55)}
                    {p.text.length > 55 ? "…" : ""}
                  </button>
                </li>
              ))}
            </ol>
            {current && (
              <div>
                {current.factIds.length ? (
                  script?.productSnapshot.facts
                    .filter((f) => current.factIds.includes(f.id))
                    .map((f) => (
                      <p key={f.id}>
                        <strong>{f.text}</strong>
                        <small>{f.evidence}</small>
                      </p>
                    ))
                ) : (
                  <p>此段为过渡表达，需符合主播本人真实感受。</p>
                )}
              </div>
            )}
          </details>
          <small>
            {script?.confirmation?.role === "independent_review"
              ? `独立审核 · ${script.confirmation.confirmedBy}`
              : "本地本人确认"}{" "}
            ·{" "}
            {script?.confirmation
              ? new Date(script.confirmation.confirmedAt).toLocaleString(
                  "zh-CN",
                )
              : "—"}{" "}
            · 仅主播可见
          </small>
        </>
      )}
      <button
        className="text-button"
        onClick={() => {
          setExpanded(false);
          onOpenContent();
        }}
      >
        前往商品与课程 <ChevronRight size={14} />
      </button>
      <BindingHistory key={roomId} roomId={roomId} />
    </Panel>
  );
}
