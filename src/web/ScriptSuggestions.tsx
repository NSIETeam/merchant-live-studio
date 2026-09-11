import { useEffect, useState } from "react";
import type { ScriptSuggestion, ScriptVersion } from "../shared/content.js";
import type { MerchantIdentity } from "../shared/membership.js";
import { api } from "./api.js";

export function ScriptSuggestions({
  script,
  identity,
  dirty,
  canSuggest,
  onChanged,
}: {
  script: ScriptVersion;
  identity: MerchantIdentity | null;
  dirty: boolean;
  canSuggest: boolean;
  onChanged: () => void;
}) {
  const [items, setItems] = useState<ScriptSuggestion[]>([]);
  const [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [paragraphId, setParagraphId] = useState(
    script.paragraphs[0]?.id || "",
  );
  const [replacement, setReplacement] = useState(""),
    [reason, setReason] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [notes, setNotes] = useState<Record<string, string>>({});
  const base = `/merchant/content/courses/${encodeURIComponent(script.courseId)}/scripts/${script.version}/suggestions`;
  useEffect(() => {
    let alive = true;
    setLoaded(false);
    setError("");
    api<{ suggestions: ScriptSuggestion[] }>(base)
      .then((data) => {
        if (alive) {
          setItems(data.suggestions);
          setLoaded(true);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      });
    return () => {
      alive = false;
    };
  }, [base, revision]);
  async function submit() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(base, "POST", {
        id: requestId,
        paragraphId,
        replacement,
        reason,
      });
      setReplacement("");
      setReason("");
      setRequestId(crypto.randomUUID());
      setRevision((n) => n + 1);
      setNotice("建议已记录，编辑可以逐条采纳或拒绝。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function resolve(
    item: ScriptSuggestion,
    decision: "accepted" | "rejected",
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await api<{ resultVersion: number | null }>(
        `/merchant/content/suggestions/${encodeURIComponent(item.id)}/resolve`,
        "POST",
        { decision, note: notes[item.id] || "" },
      );
      setRevision((n) => n + 1);
      setNotice(
        result.resultVersion
          ? `已采纳并保存为 V${result.resultVersion}，请在版本列表打开新稿并重新提交审核。`
          : "已记录拒绝理由。",
      );
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const editable =
    identity && ["owner", "editor"].includes(identity.memberRole);
  return (
    <section className="cw-divider" aria-label="逐条修改建议">
      <h3>逐条修改建议 · V{script.version}</h3>
      <p>
        建议仅替换所选段落正文，引用依据保持不变。采纳会生成新稿，仍需重新审核；已修改的段落不会被旧建议覆盖。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => setRevision((n) => n + 1)}
      >
        刷新修改建议
      </button>
      {loaded && !items.length && <p>此版本尚无逐条建议。</p>}
      {loaded &&
        items.map((item) => (
          <article
            className="cw-divider"
            key={item.id}
            aria-label={`修改建议 ${item.id}`}
          >
            <p>
              第{" "}
              {script.paragraphs.findIndex((p) => p.id === item.paragraphId) +
                1}{" "}
              段 · {item.authorId} ·{" "}
              {new Date(item.createdAt).toLocaleString("zh-CN")}
            </p>
            <p>
              原文：
              {script.paragraphs.find((p) => p.id === item.paragraphId)?.text}
            </p>
            <p>建议：{item.replacement}</p>
            <p>理由：{item.reason}</p>
            {item.decision ? (
              <p>
                {item.decision === "accepted"
                  ? `已采纳 → V${item.resultVersion}`
                  : "已拒绝"}{" "}
                · {item.resolvedBy} ·{" "}
                {item.resolvedAt
                  ? new Date(item.resolvedAt).toLocaleString("zh-CN")
                  : ""}
                <br />
                {item.resolutionNote}
              </p>
            ) : editable ? (
              <fieldset disabled={busy || dirty}>
                <label>
                  处置理由
                  <textarea
                    maxLength={2000}
                    value={notes[item.id] || ""}
                    onChange={(e) =>
                      setNotes((old) => ({ ...old, [item.id]: e.target.value }))
                    }
                  />
                </label>
                <div className="cw-actions">
                  <button
                    className="primary"
                    disabled={!notes[item.id]?.trim()}
                    onClick={() => void resolve(item, "accepted")}
                  >
                    采纳并保存新版本
                  </button>
                  <button
                    className="secondary"
                    disabled={!notes[item.id]?.trim()}
                    onClick={() => void resolve(item, "rejected")}
                  >
                    拒绝建议
                  </button>
                </div>
              </fieldset>
            ) : (
              <p>等待编辑处置</p>
            )}
          </article>
        ))}
      {canSuggest && (
        <fieldset disabled={busy || dirty || !loaded}>
          <legend>提出段落修改</legend>
          <label>
            目标段落
            <select
              value={paragraphId}
              onChange={(e) => {
                setParagraphId(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            >
              {script.paragraphs.map((p, i) => (
                <option value={p.id} key={p.id}>
                  第 {i + 1} 段：{p.text.slice(0, 30)}
                </option>
              ))}
            </select>
          </label>
          <label>
            建议替换文本
            <textarea
              rows={4}
              maxLength={1500}
              value={replacement}
              onChange={(e) => {
                setReplacement(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <label>
            修改理由
            <textarea
              maxLength={2000}
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setRequestId(crypto.randomUUID());
              }}
            />
          </label>
          <button
            className="primary"
            disabled={!replacement.trim() || !reason.trim()}
            onClick={() => void submit()}
          >
            提交修改建议
          </button>
        </fieldset>
      )}
      {dirty && <p>请先保存或放弃本地编辑，再处置已存稿件的建议。</p>}
    </section>
  );
}
