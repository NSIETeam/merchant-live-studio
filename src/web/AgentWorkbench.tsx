import { PresenterEditor } from "./PresenterEditor.js";
import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Copy,
  FileCheck2,
  FlaskConical,
  MessageCircle,
  Mic,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
import type {
  AgentProfile,
  AgentRun,
  AgentServiceStatus,
  PromptContent,
  PromptVersion,
} from "../shared/agent";
import type { CopilotResult, Fact, Question } from "../shared/types";
import { api } from "./api";
import "./agent-workbench.css";

const emptyPrompt: PromptContent = {
  systemPrompt: "",
  styleGuide: "",
  audience: "",
  examples: [],
};
const messageOf = (error: unknown) =>
  error instanceof Error ? error.message : "请求暂时未完成，请重试。";
const contentOf = (version: PromptVersion): PromptContent => ({
  ...(version.presenter ? { presenter: { ...version.presenter } } : {}),
  systemPrompt: version.systemPrompt,
  styleGuide: version.styleGuide,
  audience: version.audience,
  examples: version.examples.map((example) => ({ ...example })),
});

export function AgentWorkbench({
  roomId,
  productName,
  canRevoke = false,
}: {
  roomId: string;
  productName: string;
  canRevoke?: boolean;
}) {
  const [service, setService] = useState<AgentServiceStatus | null>(null);
  const [serviceError, setServiceError] = useState("");
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [profileId, setProfileId] = useState("");
  const [versions, setVersions] = useState<PromptVersion[]>([]);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [draft, setDraft] = useState<PromptContent>(emptyPrompt);
  const [brandName, setBrandName] = useState("");
  const [editorBusy, setEditorBusy] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [versionLoading, setVersionLoading] = useState(false);
  const [versionError, setVersionError] = useState("");
  const [versionRetryTick, setVersionRetryTick] = useState(0);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [transcript, setTranscript] = useState("");
  const [question, setQuestion] = useState("");
  const [facts, setFacts] = useState<Fact[]>([]);
  const [basis, setBasis] = useState<{
    productName: string;
    contentBound: boolean;
    stale: boolean;
  } | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [factsError, setFactsError] = useState("");
  const [questionsError, setQuestionsError] = useState("");
  const [factText, setFactText] = useState("");
  const [evidenceText, setEvidenceText] = useState("");
  const [factBusy, setFactBusy] = useState(false);
  const [factRefresh, setFactRefresh] = useState(0);
  const [quick, setQuick] = useState<{
    key: string;
    result: CopilotResult;
  } | null>(null);
  const [quickBusy, setQuickBusy] = useState("");
  const [quickError, setQuickError] = useState("");
  const [run, setRun] = useState<{ key: string; value: AgentRun } | null>(null);
  const [runningKey, setRunningKey] = useState("");
  const [feedbackNote, setFeedbackNote] = useState("");
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [focus, setFocus] = useState(false);
  const roomRef = useRef(roomId);
  const profileRef = useRef(profileId);
  const runSequence = useRef(0);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mounted = useRef(true);
  roomRef.current = roomId;
  profileRef.current = profileId;
  const profile = profiles.find((item) => item.id === profileId);
  const savedVersion = versions.find(
    (item) => item.version === selectedVersion,
  );
  const dirty =
    !!savedVersion &&
    JSON.stringify(draft) !== JSON.stringify(contentOf(savedVersion));
  const promptTooLarge =
    new TextEncoder().encode(JSON.stringify(draft)).byteLength > 30000;
  const factSignature = JSON.stringify([
    basis,
    facts.map(({ id, text, evidence, approved }) => ({
      id,
      text,
      evidence,
      approved,
    })),
  ]);
  const quickKey = JSON.stringify([
    roomId,
    transcript,
    question,
    factSignature,
  ]);
  const runKey = JSON.stringify([quickKey, profileId, selectedVersion, draft]);
  const runKeyRef = useRef(runKey);
  const quickKeyRef = useRef(quickKey);
  runKeyRef.current = runKey;
  quickKeyRef.current = quickKey;
  const currentRun = run?.key === runKey ? run.value : null;
  const quickResult = quick?.key === quickKey ? quick.result : null;
  const completedResult =
    currentRun?.status === "completed" ? currentRun.result : undefined;
  const agentResult = currentRun?.stale ? undefined : completedResult;
  const visibleResult = profile?.revocation ? null : agentResult || quickResult;
  const running = runningKey === runKey;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      runSequence.current++;
      if (pollTimer.current) clearTimeout(pollTimer.current);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refreshProfiles = () =>
      api<{ profiles: AgentProfile[] }>("/merchant/agent/profiles")
        .then((response) => {
          if (!cancelled) {
            setProfiles(response.profiles);
            setProfileId((current) =>
              response.profiles.some((item) => item.id === current)
                ? current
                : response.profiles[0]?.id || "",
            );
          }
        })
        .catch((failure) => {
          if (!cancelled) setError(messageOf(failure));
        });
    const check = async () => {
      try {
        const response = await api<AgentServiceStatus>(
          "/merchant/agent/status",
        );
        if (!cancelled) {
          setService(response);
          setServiceError("");
          if (response.available) void refreshProfiles();
        }
      } catch (failure) {
        if (!cancelled) {
          setService(null);
          setServiceError(messageOf(failure));
        }
      }
    };
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void check();
    }, 10000);
    void refreshProfiles();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setVersions([]);
    setSelectedVersion(null);
    setDraft(emptyPrompt);
    setVersionError("");
    if (!profileId) return;
    setVersionLoading(true);
    void api<{ versions: PromptVersion[] }>(
      `/merchant/agent/profiles/${encodeURIComponent(profileId)}/versions`,
    )
      .then((response) => {
        if (cancelled) return;
        const sorted = [...response.versions].sort(
          (a, b) => b.version - a.version,
        );
        setVersions(sorted);
        setSelectedVersion(sorted[0]?.version ?? null);
        setDraft(sorted[0] ? contentOf(sorted[0]) : emptyPrompt);
      })
      .catch((failure) => {
        if (!cancelled) setVersionError(messageOf(failure));
      })
      .finally(() => {
        if (!cancelled) setVersionLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, versionRetryTick]);

  useEffect(() => {
    // Recovery only retries an unsuccessful initial read. Loaded versions and
    // an editor's unsaved draft are never refreshed by service status changes.
    if (
      !profileId ||
      !versionError ||
      versionLoading ||
      versions.length ||
      !service?.available
    )
      return;
    const timer = setTimeout(
      () => setVersionRetryTick((value) => value + 1),
      5000,
    );
    return () => clearTimeout(timer);
  }, [
    profileId,
    versionError,
    versionLoading,
    versions.length,
    service?.available,
  ]);

  useEffect(() => {
    setTranscript("");
    setQuestion("");
    setFacts([]);
    setBasis(null);
    setQuestions([]);
    setQuick(null);
    setRun(null);
    setFactText("");
    setEvidenceText("");
    setNotice("");
    setError("");
    setFeedbackNote("");
  }, [roomId]);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void api<{
        facts: Fact[];
        productName: string;
        contentBound: boolean;
        stale: boolean;
      }>(`/merchant/rooms/${encodeURIComponent(roomId)}/agent/basis`)
        .then((response) => {
          if (!cancelled && roomRef.current === roomId) {
            setFacts(response.facts.map((f) => ({ ...f, roomId })));
            setBasis(response);
            setFactsError("");
          }
        })
        .catch((failure) => {
          if (!cancelled) setFactsError(messageOf(failure));
        });
      void api<{ questions: Question[] }>(
        `/merchant/rooms/${encodeURIComponent(roomId)}/questions`,
      )
        .then((response) => {
          if (!cancelled && roomRef.current === roomId) {
            setQuestions(response.questions);
            setQuestionsError("");
          }
        })
        .catch((failure) => {
          if (!cancelled) setQuestionsError(messageOf(failure));
        });
    };
    refresh();
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") refresh();
    }, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomId, factRefresh]);

  useEffect(() => {
    let cancelled = false;
    setQuickError("");
    setQuickBusy(quickKey);
    const timer = setTimeout(() => {
      void api<CopilotResult>(
        `/merchant/rooms/${encodeURIComponent(roomId)}/copilot`,
        "POST",
        { transcript, question: question || undefined },
      )
        .then((result) => {
          if (!cancelled && quickKeyRef.current === quickKey)
            setQuick({ key: quickKey, result });
        })
        .catch((failure) => {
          if (!cancelled && quickKeyRef.current === quickKey)
            setQuickError(messageOf(failure));
        })
        .finally(() => {
          if (!cancelled && quickKeyRef.current === quickKey) setQuickBusy("");
        });
    }, 600);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [quickKey, roomId, transcript, question]);

  useEffect(() => {
    runSequence.current++;
    if (pollTimer.current) clearTimeout(pollTimer.current);
    setRunningKey("");
    setFeedbackNote("");
  }, [runKey]);

  useEffect(() => {
    if (!currentRun || currentRun.status !== "completed" || currentRun.stale)
      return;
    let cancelled = false;
    const id = currentRun.id,
      key = runKey;
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      void api<{ run: AgentRun }>(
        `/merchant/agent/runs/${encodeURIComponent(id)}`,
      )
        .then((response) => {
          if (!cancelled && mounted.current && runKeyRef.current === key)
            setRun({ key, value: response.run });
        })
        .catch(() => {
          /* A temporary refresh failure does not replace a completed result. */
        });
    }, 10000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [currentRun?.id, currentRun?.status, currentRun?.stale, runKey]);

  useEffect(() => {
    if (
      !currentRun ||
      currentRun.mode !== "live" ||
      currentRun.status !== "completed" ||
      currentRun.stale
    )
      return;
    const id = currentRun.id,
      key = runKey;
    const timer = setTimeout(
      () => {
        setRun((existing) =>
          existing?.key === key && existing.value.id === id
            ? {
                key,
                value: {
                  ...existing.value,
                  stale: true,
                  staleReason:
                    "直播建议已超过两分钟，请根据当前直播情况重新生成。",
                },
              }
            : existing,
        );
      },
      Math.max(0, 120000 - (Date.now() - currentRun.createdAt)),
    );
    return () => clearTimeout(timer);
  }, [
    currentRun?.id,
    currentRun?.mode,
    currentRun?.status,
    currentRun?.stale,
    runKey,
  ]);

  async function saveDraft() {
    if (!profileId || !savedVersion || editorBusy || promptTooLarge) return;
    const target = profileId;
    setEditorBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await api<{ version: PromptVersion }>(
        `/merchant/agent/profiles/${encodeURIComponent(target)}/versions`,
        "POST",
        draft,
      );
      if (!mounted.current || profileRef.current !== target) return;
      setVersions((existing) => [
        response.version,
        ...existing.filter((item) => item.version !== response.version.version),
      ]);
      setSelectedVersion(response.version.version);
      setDraft(contentOf(response.version));
      setProfiles((existing) =>
        existing.map((item) =>
          item.id === target
            ? { ...item, latestVersion: response.version.version }
            : item,
        ),
      );
      setNotice(`已保存草稿 V${response.version.version}，可以开始试演。`);
    } catch (failure) {
      if (mounted.current && profileRef.current === target)
        setError(messageOf(failure));
    } finally {
      if (mounted.current) setEditorBusy(false);
    }
  }

  async function publishVersion() {
    if (!profileId || selectedVersion === null || dirty || editorBusy) return;
    const target = profileId,
      version = selectedVersion;
    setEditorBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await api<{ profile: AgentProfile }>(
        `/merchant/agent/profiles/${encodeURIComponent(target)}/versions/${version}/publish`,
        "POST",
        {},
      );
      if (!mounted.current) return;
      setProfiles((existing) =>
        existing.map((item) => (item.id === target ? response.profile : item)),
      );
      if (profileRef.current === target)
        setNotice(`V${version} 已发布，直播建议将使用这个版本。`);
    } catch (failure) {
      if (mounted.current && profileRef.current === target)
        setError(messageOf(failure));
    } finally {
      if (mounted.current) setEditorBusy(false);
    }
  }

  async function createBrand(event: React.FormEvent) {
    event.preventDefault();
    if (!brandName.trim() || editorBusy || promptTooLarge) return;
    setEditorBusy(true);
    setError("");
    try {
      const response = await api<{
        profile: AgentProfile;
        version: PromptVersion;
      }>("/merchant/agent/profiles", "POST", {
        name: brandName.trim(),
        kind: "brand",
        ...draft,
      });
      if (!mounted.current) return;
      setProfiles((existing) => [...existing, response.profile]);
      setProfileId(response.profile.id);
      setBrandName("");
      setNotice("品牌风格已建立。保存场景样例后试演，再发布到直播。");
    } catch (failure) {
      if (mounted.current) setError(messageOf(failure));
    } finally {
      if (mounted.current) setEditorBusy(false);
    }
  }

  async function startRun(mode: "rehearsal" | "live") {
    if (
      !profile ||
      profile.revocation ||
      running ||
      !service?.available ||
      versionLoading ||
      (mode === "rehearsal" && (selectedVersion === null || dirty)) ||
      (mode === "live" && profile.publishedVersion === null)
    )
      return;
    const key = runKey,
      sequence = ++runSequence.current,
      startedAt = Date.now();
    if (pollTimer.current) clearTimeout(pollTimer.current);
    const isCurrent = () =>
      mounted.current &&
      runKeyRef.current === key &&
      runSequence.current === sequence;
    setRunningKey(key);
    setRun(null);
    setError("");
    setNotice("");
    const receive = (value: AgentRun) => {
      if (!isCurrent()) return;
      setRun({ key, value });
      if (value.status === "completed" || value.status === "failed") {
        setRunningKey("");
        if (value.status === "failed")
          setError(value.error || "本次生成未完成，请稍后重试。");
        return;
      }
      if (Date.now() - startedAt > 180000) {
        setRunningKey("");
        setError("本次任务等待较久，请稍后重新试演。");
        return;
      }
      pollTimer.current = setTimeout(() => {
        if (!isCurrent()) return;
        void api<{ run: AgentRun }>(
          `/merchant/agent/runs/${encodeURIComponent(value.id)}`,
        )
          .then((response) => receive(response.run))
          .catch((failure) => {
            if (isCurrent()) {
              setRunningKey("");
              setError(messageOf(failure));
            }
          });
      }, 1100);
    };
    try {
      const response = await api<{ run: AgentRun }>(
        `/merchant/rooms/${encodeURIComponent(roomId)}/agent/runs`,
        "POST",
        {
          profileId: profile.id,
          version: mode === "rehearsal" ? selectedVersion : undefined,
          transcript,
          question: question || undefined,
          mode,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      receive(response.run);
    } catch (failure) {
      if (isCurrent()) {
        setRunningKey("");
        setError(messageOf(failure));
      }
    }
  }

  async function sendFeedback(rating: "useful" | "needs_work") {
    if (!currentRun || currentRun.status !== "completed" || feedbackBusy)
      return;
    const key = runKey,
      id = currentRun.id;
    setFeedbackBusy(true);
    setError("");
    try {
      const response = await api<{ run: AgentRun }>(
        `/merchant/agent/runs/${encodeURIComponent(id)}/feedback`,
        "POST",
        { rating, note: feedbackNote },
      );
      if (mounted.current && runKeyRef.current === key) {
        setRun({ key, value: response.run });
        setNotice("反馈已记录，可据此调整下一版提示词。");
      }
    } catch (failure) {
      if (mounted.current && runKeyRef.current === key)
        setError(messageOf(failure));
    } finally {
      if (mounted.current) setFeedbackBusy(false);
    }
  }

  async function addFact(event: React.FormEvent) {
    event.preventDefault();
    const target = roomId;
    if (factBusy) return;
    setFactBusy(true);
    setFactsError("");
    try {
      await api(`/merchant/rooms/${encodeURIComponent(target)}/facts`, "POST", {
        text: factText.trim(),
        evidence: evidenceText.trim(),
        approved: false,
      });
      if (mounted.current && roomRef.current === target) {
        setFactText("");
        setEvidenceText("");
        setFactRefresh((value) => value + 1);
      }
    } catch (failure) {
      if (mounted.current && roomRef.current === target)
        setFactsError(messageOf(failure));
    } finally {
      if (mounted.current) setFactBusy(false);
    }
  }

  async function reviewFact(fact: Fact) {
    const target = roomId;
    if (factBusy) return;
    setFactBusy(true);
    setFactsError("");
    try {
      await api(`/merchant/facts/${encodeURIComponent(fact.id)}`, "PATCH", {
        approved: !fact.approved,
      });
      if (mounted.current && roomRef.current === target)
        setFactRefresh((value) => value + 1);
    } catch (failure) {
      if (mounted.current && roomRef.current === target)
        setFactsError(messageOf(failure));
    } finally {
      if (mounted.current) setFactBusy(false);
    }
  }

  const presenterReady =
    !draft.presenter ||
    (draft.presenter.authorizationConfirmed &&
      draft.presenter.displayName.trim() &&
      draft.presenter.roleDescription.trim() &&
      draft.presenter.speakingStyle.trim() &&
      draft.presenter.authorizationReference.trim());
  return (
    <div className={`aw-workbench${focus ? " aw-focus" : ""}`}>
      <div className="aw-service" role="status">
        <div>
          <span
            className={`aw-status-dot ${service?.available ? "aw-online" : ""}`}
          />
          <strong>直播 Agent</strong>
          <span>
            {!service && !serviceError
              ? "正在连接独立服务…"
              : service?.available
                ? "独立服务已连接"
                : "独立服务暂不可用"}
          </span>
        </div>
        <span>
          {!service && !serviceError
            ? "正在读取模型配置…"
            : service?.modelConfigured
              ? "已配置生成模型"
              : "生成模型尚未配置 · 可先调试提示词与事实规则"}
        </span>
      </div>
      {(serviceError || service?.message) && (
        <p className="aw-service-note">
          {serviceError || service?.message}；当前话术快检仍可单独使用。
        </p>
      )}
      {profile?.revocation && (
        <p className="aw-inline-error" role="alert">
          此表达方案已撤回授权，所有提示词版本停止新建任务。原因：
          {profile.revocation.reason} ·{" "}
          {new Date(profile.revocation.createdAt).toLocaleString()}
          。请选择其他获授权方案。
        </p>
      )}
      {versionError && (
        <p className="aw-inline-error" role="status">
          版本暂未读取，服务可用时会自动重试。{versionError}
        </p>
      )}
      {error && (
        <div className="aw-message aw-error" role="alert">
          {error}
          <button
            type="button"
            aria-label="关闭错误提示"
            onClick={() => setError("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      {notice && (
        <div className="aw-message aw-success" role="status">
          {notice}
          <button
            type="button"
            aria-label="关闭状态提示"
            onClick={() => setNotice("")}
          >
            <X size={16} />
          </button>
        </div>
      )}
      <div className="aw-columns">
        <div className="aw-main">
          <section className="aw-prompter" aria-label="下一句建议">
            <div className="aw-heading">
              <h2>
                <Sparkles size={18} /> 主播提词
              </h2>
              <button
                type="button"
                className="aw-text-button"
                onClick={() => setFocus(!focus)}
              >
                {focus ? "退出专注" : "专注模式"}
              </button>
            </div>
            <div className="aw-result-label">
              {agentResult
                ? `${currentRun?.mode === "live" ? "直播建议" : "试演结果"} · V${currentRun?.promptVersion}`
                : "事实规则建议"}
              {running ? " · 正在生成与复核" : ""}
            </div>
            <p className="aw-script">
              {visibleResult?.suggestion ||
                "先添加并审核商品事实，再试演你的第一句话。"}
            </p>
            {!!visibleResult?.evidence.length && (
              <div className="aw-evidence-tags">
                {visibleResult.evidence.map((item, index) => (
                  <span key={`${index}-${item}`}>
                    <Check size={13} />
                    {item}
                  </span>
                ))}
              </div>
            )}
            {agentResult?.abstained && (
              <p className="aw-abstained">
                依据不足，本次保留回答。请补充可核验的商品事实。
              </p>
            )}
            <div className="aw-next">
              <span>下一环节</span>
              <p>
                {visibleResult?.nextCue || "介绍商品 → 回答问题 → 说明活动"}
              </p>
            </div>
            <div className="aw-prompter-foot">
              <span>
                仅主播可见 ·{" "}
                {agentResult?.provider === "remote-model"
                  ? "模型生成后经过事实复核"
                  : "当前为本地事实规则"}
              </span>
              <button
                type="button"
                className="aw-text-button"
                disabled={!visibleResult?.suggestion || !!currentRun?.stale}
                onClick={() => {
                  if (!navigator.clipboard) {
                    setError(
                      "当前浏览器无法自动复制，请直接选择提词文字复制。",
                    );
                    return;
                  }
                  if (visibleResult?.suggestion)
                    void navigator.clipboard
                      .writeText(visibleResult.suggestion)
                      .then(() => setNotice("建议已复制。"))
                      .catch(() =>
                        setError("复制未完成，可直接选择提词文字复制。"),
                      );
                }}
              >
                <Copy size={14} />
                复制
              </button>
            </div>
          </section>

          <section className="aw-card aw-transcript">
            <div className="aw-heading">
              <h2>
                <Mic size={18} /> 当前话术
              </h2>
              <span className="aw-muted">
                {quickBusy === quickKey ? "快检中…" : "输入后自动快检"}
              </span>
            </div>
            <label className="sr-only" htmlFor="aw-transcript">
              当前正在说的话
            </label>
            <textarea
              id="aw-transcript"
              rows={3}
              value={transcript}
              maxLength={4000}
              onChange={(event) => setTranscript(event.target.value)}
              placeholder={`输入你准备介绍「${basis?.productName || productName}」的话，或粘贴一段需要改进的话术。`}
            />
            {question && (
              <div className="aw-selected-question">
                <span>正在回答：{question}</span>
                <button
                  type="button"
                  aria-label="清除当前问题"
                  onClick={() => setQuestion("")}
                >
                  <X size={16} />
                </button>
              </div>
            )}
            <div className="aw-run-controls">
              <label>
                表达风格
                <select
                  value={profileId}
                  disabled={editorBusy || !profiles.length}
                  onChange={(event) => {
                    setProfileId(event.target.value);
                    setError("");
                    setNotice("");
                  }}
                >
                  <option value="" disabled>
                    选择风格
                  </option>
                  <optgroup label="通用风格">
                    {profiles
                      .filter((item) => item.kind === "standard")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.revocation ? "（授权已撤回）" : ""}
                        </option>
                      ))}
                  </optgroup>
                  <optgroup label="品牌风格">
                    {profiles
                      .filter((item) => item.kind === "brand")
                      .map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name}
                          {item.revocation ? "（授权已撤回）" : ""}
                        </option>
                      ))}
                  </optgroup>
                </select>
              </label>
              <div className="aw-run-buttons">
                <button
                  type="button"
                  className="aw-primary"
                  disabled={
                    !!profile?.revocation ||
                    !service?.available ||
                    !savedVersion ||
                    dirty ||
                    versionLoading ||
                    running ||
                    editorBusy
                  }
                  onClick={() => void startRun("rehearsal")}
                >
                  <FlaskConical size={17} />
                  {running && currentRun?.mode !== "live"
                    ? "试演中…"
                    : "试演当前版本"}
                </button>
                <button
                  type="button"
                  className="aw-secondary"
                  disabled={
                    !!profile?.revocation ||
                    !service?.available ||
                    !profile?.publishedVersion ||
                    running ||
                    editorBusy ||
                    versionLoading
                  }
                  onClick={() => void startRun("live")}
                >
                  <Radio size={17} />
                  生成直播建议
                </button>
              </div>
            </div>
            <p className="aw-help">
              试演使用已保存的 V{selectedVersion ?? "—"}；直播建议只使用
              {profile?.publishedVersion
                ? `已发布的 V${profile.publishedVersion}`
                : "已发布版本（当前未发布）"}
              。{dirty ? "有未保存修改，请先保存新草稿。" : ""}
            </p>
            {running && (
              <div className="aw-job-progress" role="status">
                <span className="aw-spinner" />
                {currentRun?.status === "queued"
                  ? "已加入队列，等待生成"
                  : "正在生成，并核对事实依据与风险"}
                <span>内容改变后，本次结果将不再显示。</span>
              </div>
            )}
            {quickError && (
              <p className="aw-inline-error" role="alert">
                快检暂未完成：{quickError}
              </p>
            )}
          </section>

          {currentRun?.stale && (
            <section className="aw-message aw-stale" role="status">
              <div>
                <strong>这次建议已过期，请重新生成</strong>
                <p>
                  {currentRun.staleReason ||
                    "直播场次或事实依据已变化，不应继续使用旧建议。"}
                </p>
                {completedResult && (
                  <details>
                    <summary>查看历史建议（仅供复盘）</summary>
                    <p>{completedResult.suggestion}</p>
                  </details>
                )}
              </div>
            </section>
          )}

          {agentResult && (
            <section className="aw-card aw-review">
              <div className="aw-heading">
                <h2>
                  <FileCheck2 size={18} /> 这次建议的依据
                </h2>
                <span
                  className={`aw-badge${agentResult.needsReview ? " aw-badge-review" : ""}`}
                >
                  {agentResult.needsReview ? "需要人工复核" : "事实复核已完成"}
                </span>
              </div>
              <ol className="aw-stages">
                {agentResult.stages.map((stage, index) => (
                  <li key={`${index}-${stage.name}`}>
                    <span
                      className={`aw-stage-marker aw-stage-${stage.status}`}
                    >
                      {index + 1}
                    </span>
                    <div>
                      <strong>{stage.name}</strong>
                      <p>{stage.summary}</p>
                    </div>
                    <span className="aw-stage-status">
                      {stage.status === "passed"
                        ? "已核对"
                        : stage.status === "blocked"
                          ? "已拦截"
                          : "待复核"}
                    </span>
                  </li>
                ))}
              </ol>
              {!!agentResult.decisionSummary.length && (
                <details className="aw-decision">
                  <summary>查看简要决策记录</summary>
                  <ul>
                    {agentResult.decisionSummary.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                </details>
              )}
              <div className="aw-feedback">
                <label>
                  这次建议怎么样？
                  <input
                    value={feedbackNote}
                    maxLength={500}
                    onChange={(event) => setFeedbackNote(event.target.value)}
                    placeholder="可选：记下语气、节奏或依据需要改进的地方"
                  />
                </label>
                <div>
                  <button
                    type="button"
                    className={
                      currentRun?.feedback?.rating === "useful"
                        ? "aw-feedback-selected"
                        : "aw-secondary"
                    }
                    disabled={feedbackBusy}
                    onClick={() => void sendFeedback("useful")}
                  >
                    有帮助
                  </button>
                  <button
                    type="button"
                    className={
                      currentRun?.feedback?.rating === "needs_work"
                        ? "aw-feedback-selected"
                        : "aw-secondary"
                    }
                    disabled={feedbackBusy}
                    onClick={() => void sendFeedback("needs_work")}
                  >
                    还需改进
                  </button>
                </div>
                <small>反馈用于复盘与改写提示词，不会自动训练模型。</small>
              </div>
            </section>
          )}

          <details className="aw-card aw-editor">
            <summary>
              <div>
                <h2>提示词与风格调试</h2>
                <span>
                  {profile?.name || "选择一种表达风格"} ·{" "}
                  {dirty ? "有未保存修改" : `当前 V${selectedVersion ?? "—"}`}
                </span>
              </div>
              <ChevronRight size={19} />
            </summary>
            <div className="aw-editor-content">
              <div className="aw-version-row">
                <label>
                  查看版本
                  <select
                    value={selectedVersion ?? ""}
                    disabled={versionLoading || editorBusy}
                    onChange={(event) => {
                      const version = versions.find(
                        (item) => item.version === Number(event.target.value),
                      );
                      if (version) {
                        setSelectedVersion(version.version);
                        setDraft(contentOf(version));
                        setNotice("");
                      }
                    }}
                  >
                    {!versions.length && (
                      <option value="">
                        {versionLoading ? "正在读取…" : "暂无版本"}
                      </option>
                    )}
                    {versions.map((item) => (
                      <option key={item.version} value={item.version}>
                        V{item.version}
                        {profile?.publishedVersion === item.version
                          ? " · 已发布"
                          : " · 草稿"}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="aw-help">
                  每次保存生成新版本，便于反复试演与比较。
                </span>
              </div>
              {canRevoke &&
                profile &&
                profile.id !== "standard" &&
                !profile.revocation && (
                  <details>
                    <summary>撤回此方案授权</summary>
                    <p>
                      将停止此方案所有版本的新任务及待完成任务，历史资料保留；此操作不能恢复。已导入或复制的讲稿还需要单独核对并下架。
                    </p>
                    <label>
                      撤回原因
                      <input
                        maxLength={500}
                        value={revokeReason}
                        onChange={(e) => setRevokeReason(e.target.value)}
                      />
                    </label>
                    <button
                      disabled={editorBusy || !revokeReason.trim()}
                      onClick={async () => {
                        setEditorBusy(true);
                        setError("");
                        try {
                          const r = await api<{ profile: AgentProfile }>(
                            `/merchant/agent/profiles/${profile.id}/revoke`,
                            "POST",
                            { reason: revokeReason },
                          );
                          setProfiles((old) =>
                            old.map((p) =>
                              p.id === r.profile.id ? r.profile : p,
                            ),
                          );
                          setRun(null);
                          setQuick(null);
                          setRevokeReason("");
                          setNotice("表达方案已撤回，旧版本不能再次发起任务。");
                        } catch (e) {
                          setError(messageOf(e));
                        } finally {
                          setEditorBusy(false);
                        }
                      }}
                    >
                      确认撤回全部版本授权
                    </button>
                  </details>
                )}
              <fieldset
                disabled={
                  versionLoading ||
                  editorBusy ||
                  !savedVersion ||
                  !!profile?.revocation
                }
              >
                <PresenterEditor
                  value={draft.presenter}
                  onChange={(presenter) =>
                    setDraft((current) => ({ ...current, presenter }))
                  }
                />
                <label>
                  系统提示词
                  <textarea
                    rows={6}
                    maxLength={6000}
                    value={draft.systemPrompt}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        systemPrompt: event.target.value,
                      }))
                    }
                    placeholder="定义主播助理的角色、讲述方式、事实边界和缺少依据时的处理方式。"
                  />
                </label>
                <label>
                  风格目标
                  <textarea
                    rows={3}
                    maxLength={3000}
                    value={draft.styleGuide}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        styleGuide: event.target.value,
                      }))
                    }
                    placeholder="例如：亲切克制、短句交流，先回答问题，再引用有依据的商品特点。"
                  />
                </label>
                <label>
                  面向的观众
                  <input
                    maxLength={500}
                    value={draft.audience}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        audience: event.target.value,
                      }))
                    }
                    placeholder="例如：第一次了解产品、重视实际使用体验的消费者"
                  />
                </label>
                <div className="aw-heading">
                  <h3>场景样例</h3>
                  <span className="aw-muted">少量、有代表性的示范即可</span>
                </div>
                {draft.examples.map((example, index) => (
                  <div className="aw-example" key={index}>
                    <div className="aw-heading">
                      <strong>样例 {index + 1}</strong>
                      <button
                        type="button"
                        className="aw-text-button"
                        aria-label={`删除样例 ${index + 1}`}
                        onClick={() =>
                          setDraft((current) => ({
                            ...current,
                            examples: current.examples.filter(
                              (_, position) => position !== index,
                            ),
                          }))
                        }
                      >
                        <X size={16} />
                      </button>
                    </div>
                    <label>
                      场景
                      <input
                        value={example.situation}
                        maxLength={500}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            examples: current.examples.map((item, position) =>
                              position === index
                                ? { ...item, situation: event.target.value }
                                : item,
                            ),
                          }))
                        }
                        placeholder="例如：观众追问能否保证效果"
                      />
                    </label>
                    <label>
                      期望表达
                      <textarea
                        rows={3}
                        value={example.response}
                        maxLength={1200}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            examples: current.examples.map((item, position) =>
                              position === index
                                ? { ...item, response: event.target.value }
                                : item,
                            ),
                          }))
                        }
                        placeholder="写下希望 Agent 学习的表达方式；不能把样例当作未经审核的商品事实。"
                      />
                    </label>
                  </div>
                ))}
                <button
                  type="button"
                  className="aw-secondary"
                  disabled={draft.examples.length >= 12}
                  onClick={() =>
                    setDraft((current) => ({
                      ...current,
                      examples: [
                        ...current.examples,
                        { situation: "", response: "" },
                      ],
                    }))
                  }
                >
                  <Plus size={16} />
                  添加场景样例
                </button>
              </fieldset>
              <div className="aw-editor-actions">
                <button
                  type="button"
                  className="aw-primary"
                  disabled={
                    !savedVersion ||
                    !!profile?.revocation ||
                    !draft.systemPrompt.trim() ||
                    !presenterReady ||
                    promptTooLarge ||
                    !dirty ||
                    editorBusy
                  }
                  onClick={() => void saveDraft()}
                >
                  {editorBusy ? "处理中…" : "保存为新草稿"}
                </button>
                <button
                  type="button"
                  className="aw-secondary"
                  disabled={
                    !savedVersion ||
                    dirty ||
                    editorBusy ||
                    profile?.publishedVersion === selectedVersion
                  }
                  onClick={() => void publishVersion()}
                >
                  发布 V{selectedVersion ?? "—"} 到直播
                </button>
              </div>
              {promptTooLarge && (
                <p className="aw-inline-error" role="alert">
                  提示内容较长，请精简系统提示词或场景样例后再保存。
                </p>
              )}
              <form className="aw-brand-form" onSubmit={createBrand}>
                <label>
                  建立独立品牌风格
                  <input
                    value={brandName}
                    maxLength={80}
                    onChange={(event) => setBrandName(event.target.value)}
                    placeholder="品牌名称，例如：山野生活"
                    required
                  />
                </label>
                <button
                  type="submit"
                  className="aw-secondary"
                  disabled={
                    editorBusy ||
                    !savedVersion ||
                    !!profile?.revocation ||
                    !draft.systemPrompt.trim() ||
                    !presenterReady ||
                    promptTooLarge ||
                    !brandName.trim()
                  }
                >
                  <Plus size={16} />
                  以当前内容建立
                </button>
              </form>
              <p className="aw-help">
                这里调整提示词和场景样例，模型接口可随后配置。风格示范不替代商品证据，也不解除事实与合规复核。
              </p>
            </div>
          </details>
        </div>

        <aside className="aw-side">
          <section className="aw-card aw-compliance">
            <div className="aw-heading">
              <h2>
                <ShieldCheck size={18} /> 话术快检
              </h2>
              <span className="aw-badge">事实规则</span>
            </div>
            {quickResult?.alerts.length ? (
              quickResult.alerts.map((alert, index) => (
                <div className={`aw-risk aw-risk-${alert.level}`} key={index}>
                  <strong>
                    {alert.level === "high" ? "重点核实" : "待复核"} ·{" "}
                    {alert.phrase}
                  </strong>
                  <p>{alert.reason}</p>
                </div>
              ))
            ) : (
              <p className="aw-empty">
                {transcript
                  ? quickResult
                    ? "当前规则未发现明显风险，仍需结合商品资质与完整语境复核。"
                    : quickError
                      ? "快检暂未完成，请重试或人工复核当前话术。"
                      : "正在核对当前话术，请稍候。"
                  : "输入当前话术后，自动提示夸大承诺和缺少依据的表达。"}
              </p>
            )}
            {!!agentResult?.alerts.length && (
              <div className="aw-agent-alerts">
                <h3>本次生成复核</h3>
                {agentResult.alerts.map((alert, index) => (
                  <div className={`aw-risk aw-risk-${alert.level}`} key={index}>
                    <strong>{alert.phrase}</strong>
                    <p>{alert.reason}</p>
                  </div>
                ))}
              </div>
            )}
            <p className="aw-help">
              按主张、证据和上下文核查，不用同义词包装违规承诺。
            </p>
          </section>
          <section className="aw-card">
            <div className="aw-heading">
              <h2>
                <MessageCircle size={18} /> 观众在问
              </h2>
              <span className="aw-muted">点击带入试演</span>
            </div>
            {questionsError && (
              <p className="aw-inline-error" role="alert">
                {questionsError}
              </p>
            )}
            {questions.length ? (
              questions.slice(0, 5).map((item) => (
                <button
                  type="button"
                  className="aw-question"
                  key={item.id}
                  onClick={() => setQuestion(item.text)}
                >
                  <span>{item.text}</span>
                  <b>×{item.count}</b>
                </button>
              ))
            ) : (
              <p className="aw-empty">观众发送的问题将在这里汇总。</p>
            )}
          </section>
          <details className="aw-card aw-facts" open={!facts.length}>
            <summary>
              <div>
                <h2>
                  {basis?.contentBound
                    ? "本场定稿的商品依据"
                    : "房间备用事实库"}
                </h2>
                <span>
                  {facts.filter((item) => item.approved).length} 条已审核 ·{" "}
                  {basis?.productName || productName}
                </span>
              </div>
              <ChevronRight size={19} />
            </summary>
            <div className="aw-facts-content">
              {basis?.contentBound && (
                <p className="aw-help">
                  {basis.stale
                    ? "商品依据已改变，暂停使用旧定稿事实。请在“商品与课程”中重新审改、定稿并绑定。"
                    : "使用已绑定定稿的商品证据版本。修改商品资料请到“商品与课程”；此处只读。"}
                </p>
              )}
              {factsError && (
                <p className="aw-inline-error" role="alert">
                  {factsError}
                </p>
              )}
              {facts.length ? (
                facts.map((fact) => (
                  <div className="aw-fact" key={fact.id}>
                    <strong>{fact.text}</strong>
                    <p>{fact.evidence}</p>
                    <button
                      type="button"
                      disabled={factBusy || basis?.contentBound}
                      className={fact.approved ? "aw-approved" : "aw-secondary"}
                      onClick={() => void reviewFact(fact)}
                    >
                      {basis?.contentBound
                        ? "定稿依据 · 只读"
                        : fact.approved
                          ? "已审核 · 撤回"
                          : "审核通过"}
                    </button>
                  </div>
                ))
              ) : (
                <p className="aw-empty">
                  添加商品标签、检测报告或活动规则中的事实，再由商家审核。
                </p>
              )}
              {!basis?.contentBound && (
                <form onSubmit={addFact}>
                  <label>
                    事实内容
                    <input
                      value={factText}
                      onChange={(event) => setFactText(event.target.value)}
                      maxLength={400}
                      required
                      placeholder="例如：容量为 500 mL"
                    />
                  </label>
                  <label>
                    依据与出处
                    <input
                      value={evidenceText}
                      onChange={(event) => setEvidenceText(event.target.value)}
                      maxLength={500}
                      required
                      placeholder="文件名称、页码或可核验链接"
                    />
                  </label>
                  <button
                    type="submit"
                    className="aw-secondary"
                    disabled={
                      factBusy || !factText.trim() || !evidenceText.trim()
                    }
                  >
                    <Plus size={16} />
                    添加待审核事实
                  </button>
                </form>
              )}
            </div>
          </details>
        </aside>
      </div>
    </div>
  );
}
