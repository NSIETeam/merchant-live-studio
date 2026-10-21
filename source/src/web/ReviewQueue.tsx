import { useEffect, useState } from "react";
import type { ReviewQueueItem, ScriptVersion } from "../shared/content.js";
import { ScriptReviewPanel } from "./ScriptReviewPanel.js";
import { api } from "./api.js";
const policy = () => {};

export function ReviewQueue() {
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [page, setPage] = useState<{
    items: ReviewQueueItem[];
    nextAfter: string | null;
  } | null>(null);
  const [selected, setSelected] = useState<ReviewQueueItem | null>(null);
  const [script, setScript] = useState<ScriptVersion | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setPage(null);
    setError("");
    api<{ items: ReviewQueueItem[]; nextAfter: string | null }>(
      `/merchant/content/review-queue${cursor ? `?after=${encodeURIComponent(cursor)}` : ""}`,
    )
      .then((data) => {
        if (alive) setPage(data);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [open, cursor, revision]);
  useEffect(() => {
    setScript(null);
    if (!selected || !open) return;
    let alive = true;
    setError("");
    api<{ script: ScriptVersion }>(
      `/merchant/content/courses/${encodeURIComponent(selected.courseId)}/scripts/${selected.version}`,
    )
      .then((data) => {
        if (alive) setScript(data.script);
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [selected, open]);
  return (
    <details
      className="cw-divider"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>待审核工作台</summary>
      {open && (
        <section aria-label="待审核工作台">
          <p>
            集中处理各课程最新提交的讲稿。保存更新版后，旧版退出待审列表；历史决定可在课程版本中查看。
          </p>
          <button
            className="secondary"
            onClick={() => {
              setCursor(null);
              setSelected(null);
              setRevision((n) => n + 1);
            }}
          >
            刷新待审核列表
          </button>
          {error && <p role="alert">{error}</p>}
          {!page && !error && <p role="status">正在读取待审核稿件…</p>}
          {page && (
            <>
              {!page.items.length && <p>本页没有待审核稿件。</p>}
              <ul>
                {page.items.map((item) => (
                  <li key={item.courseId}>
                    <button
                      className="secondary"
                      onClick={() => setSelected(item)}
                    >
                      {item.productName} · {item.courseTitle} · V{item.version}
                    </button>
                    <p>
                      提交人：{item.submittedBy} ·{" "}
                      {new Date(item.submittedAt).toLocaleString("zh-CN")}
                      <br />
                      {item.note}
                    </p>
                  </li>
                ))}
              </ul>
              {page.nextAfter && (
                <button
                  className="secondary"
                  onClick={() => {
                    setSelected(null);
                    setCursor(page.nextAfter);
                  }}
                >
                  下一页
                </button>
              )}
              {cursor && (
                <button
                  className="secondary"
                  onClick={() => {
                    setSelected(null);
                    setCursor(null);
                  }}
                >
                  返回首页
                </button>
              )}
            </>
          )}
          {selected && script && (
            <article aria-label="待审讲稿全文">
              <h3>
                {selected.courseTitle} · V{script.version}
              </h3>
              <p>{script.changeNote}</p>
              {script.stale && (
                <p role="alert">依据或规则已变化，请退回重新核对，不能批准。</p>
              )}
              <p>{script.check.summary}</p>
              <ol>
                {script.paragraphs.map((paragraph) => (
                  <li key={paragraph.id}>
                    <p style={{ whiteSpace: "pre-wrap" }}>{paragraph.text}</p>
                    {paragraph.factIds.map((id) => {
                      const fact = script.productSnapshot.facts.find(
                        (f) => f.id === id,
                      );
                      return (
                        <p className="cw-meta" key={id}>
                          引用依据：
                          {fact
                            ? `${fact.text}；${fact.evidence}`
                            : `缺失 ${id}`}
                        </p>
                      );
                    })}
                    {script.check.issues
                      .filter((issue) => issue.paragraphId === paragraph.id)
                      .map((issue, i) => (
                        <p key={i} className="cw-alert">
                          {issue.level === "block" ? "阻断" : "需核对"}：
                          {issue.message}
                        </p>
                      ))}
                  </li>
                ))}
              </ol>
              <ScriptReviewPanel
                key={`${script.courseId}:${script.version}`}
                script={script}
                dirty={false}
                onPolicy={policy}
                onChanged={() => {
                  setSelected(null);
                  setRevision((n) => n + 1);
                }}
              />
            </article>
          )}
        </section>
      )}
    </details>
  );
}
