import { useEffect, useState } from "react";
import type { ScriptVersion, ScriptReviewRecord } from "../shared/content.js";
import type { MerchantIdentity } from "../shared/membership.js";
import { ScriptSuggestions } from "./ScriptSuggestions.js";
import { api } from "./api.js";

export function ScriptReviewPanel({
  script,
  dirty,
  onChanged,
  onPolicy,
}: {
  script: ScriptVersion;
  dirty: boolean;
  onChanged: () => void;
  onPolicy: (required: boolean) => void;
}) {
  const [review, setReview] = useState<ScriptReviewRecord | null>(null),
    [identity, setIdentity] = useState<MerchantIdentity | null>(null);
  const [note, setNote] = useState(""),
    [ack, setAck] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [refresh, setRefresh] = useState(0);
  const base = `/merchant/content/courses/${encodeURIComponent(script.courseId)}/scripts/${script.version}`;
  useEffect(() => {
    let alive = true;
    setBusy(true);
    setError("");
    Promise.all([
      api<{ review: ScriptReviewRecord }>(base + "/review"),
      api<MerchantIdentity>("/auth/me"),
    ])
      .then(([data, who]) => {
        if (alive) {
          setReview(data.review);
          setIdentity(who);
          onPolicy(who.requiresIndependentReview);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [base, refresh, onPolicy]);
  async function act(decision?: "approved" | "changes_requested") {
    setBusy(true);
    setError("");
    try {
      const data = await api<{ review: ScriptReviewRecord }>(
        base + (decision ? "/review" : "/submit"),
        "POST",
        decision ? { note, decision, acknowledged: ack } : { note },
      );
      setReview(data.review);
      setNote("");
      setAck(false);
      onChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const self =
    identity?.actorId === review?.authorId ||
    identity?.actorId === review?.submission?.submittedBy;
  const canReview =
    identity && ["owner", "reviewer"].includes(identity.memberRole) && !self;
  return (
    <section className="cw-divider" aria-label="独立审核">
      <h3>独立审核 · V{script.version}</h3>
      <p>
        {review?.decision?.decision === "approved"
          ? "已由独立账号批准"
          : review?.decision
            ? "已退回修改，请建立新版本"
            : review?.submission
              ? "等待另一审核账号处理"
              : "尚未提交独立审核"}
      </p>
      <p className="cw-meta">
        保存账号：{review?.authorId || "旧版未记录，需先保存新版本"}
        。保存者与提交者均不能审批此稿。
      </p>
      {review?.submission && (
        <p>
          提交：{review.submission.submittedBy} ·{" "}
          {new Date(review.submission.submittedAt).toLocaleString("zh-CN")}
          <br />
          {review.submission.note}
        </p>
      )}
      {review?.decision && (
        <p>
          审核：{review.decision.reviewerId} ·{" "}
          {new Date(review.decision.reviewedAt).toLocaleString("zh-CN")}
          <br />
          {review.decision.note}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      <button
        className="secondary"
        disabled={busy}
        onClick={() => setRefresh((n) => n + 1)}
      >
        刷新审核状态
      </button>
      {!review?.decision && (
        <fieldset disabled={busy || dirty || !review || !identity}>
          <label>
            提交说明或审核意见
            <textarea
              rows={3}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          {!review?.submission &&
            identity &&
            ["owner", "editor"].includes(identity.memberRole) && (
              <button
                className="primary"
                disabled={
                  !note.trim() ||
                  !review?.authorId ||
                  script.stale ||
                  script.check.blockingCount > 0
                }
                onClick={() => void act()}
              >
                提交独立审核
              </button>
            )}
          {review?.submission && canReview && (
            <>
              <label className="cw-check">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                我已核对版本、依据和风险提示，记录此次审核决定。
              </label>
              <div className="cw-actions">
                <button
                  className="primary"
                  disabled={
                    !ack ||
                    !note.trim() ||
                    script.stale ||
                    script.check.blockingCount > 0
                  }
                  onClick={() => void act("approved")}
                >
                  批准定稿
                </button>
                <button
                  className="secondary"
                  disabled={!ack || !note.trim()}
                  onClick={() => void act("changes_requested")}
                >
                  退回修改
                </button>
              </div>
            </>
          )}
          {review?.submission && self && (
            <p>请另一审核账号登录后处理；本人不能审批。</p>
          )}
        </fieldset>
      )}
      <ScriptSuggestions
        script={script}
        identity={identity}
        dirty={dirty}
        canSuggest={Boolean(
          canReview &&
          review?.submission &&
          review.decision?.decision !== "approved",
        )}
        onChanged={onChanged}
      />
      {dirty && <p>请先保存或放弃编辑，再操作此已存版本。</p>}
      <p className="cw-meta">
        每版审核决定不可覆盖。退回后修改并另存新版本再提交。审核不替代证据真实性核查。
      </p>
    </section>
  );
}
