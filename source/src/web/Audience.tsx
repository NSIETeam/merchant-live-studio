import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  Check,
  ChevronRight,
  Gift,
  Info,
  MessageCircle,
  Radio,
  X,
} from "lucide-react";
import type { Campaign, Claim, Room } from "../shared/types.js";
import { api, duration, money } from "./api.js";
import { Player } from "./Player.js";
import "./audience.css";

type RoomData = {
  room: Room;
  campaigns: Campaign[];
  serverTime: number;
  requirePlayback: boolean;
};
type Heartbeat = { watchSeconds: number; counting: boolean };
type Panel = "questions" | "rewards" | "information";
const panelNames: Record<Panel, string> = {
  questions: "向主播提问",
  rewards: "直播红包",
  information: "观看信息",
};

function useClock() {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="audience-panel-notice" role="status">
      {children}
    </p>
  );
}

function roomStatus(room: Room) {
  if (room.status === "ended") return "直播已结束";
  if (room.status === "draft") return "待开播";
  if (room.signal?.connected === true) return "直播中";
  if (room.signal?.connected === false) return "等待信号";
  return "直播间开放";
}

// A room change creates a fresh player, session view and polling lifecycle.
export function Audience({ id }: { id: string }) {
  return <AudienceRoom key={id} id={id} />;
}

function AudienceRoom({ id }: { id: string }) {
  const [data, setData] = useState<RoomData | null>(null);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [watch, setWatch] = useState(0);
  const [counting, setCounting] = useState(false);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [interactionError, setInteractionError] = useState("");
  const [question, setQuestion] = useState("");
  const [questionPending, setQuestionPending] = useState(false);
  const [pending, setPending] = useState("");
  const [ready, setReady] = useState(false);
  const [interactive, setInteractive] = useState(false);
  const [authAttempt, setAuthAttempt] = useState(0);
  const [authConnecting, setAuthConnecting] = useState(false);
  const [offset, setOffset] = useState(0);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const now = useClock() + offset;
  const playing = useRef(false);
  const mounted = useRef(false);
  const pulse = useRef<(forceInactive?: boolean) => void>(() => {});
  const panelHeading = useRef<HTMLHeadingElement>(null);
  const panelTrigger = useRef<HTMLElement | null>(null);
  const rewardsButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setInteractionError("");
    setAuthConnecting(true);
    setInteractive(false);
    api("/auth/viewer", "POST", {})
      .then(() => {
        if (active) {
          setReady(true);
          pulse.current();
        }
      })
      .catch((e) => {
        if (active)
          setInteractionError("暂时无法连接互动服务：" + (e as Error).message);
      })
      .finally(() => {
        if (active) setAuthConnecting(false);
      });
    return () => {
      active = false;
    };
  }, [authAttempt]);

  const refresh = useCallback(async () => {
    const next = await api<RoomData>(`/public/rooms/${id}`);
    if (mounted.current) {
      setData(next);
      setOffset(next.serverTime - Date.now());
    }
  }, [id]);

  useEffect(() => {
    let active = true,
      inFlight = false;
    const poll = async () => {
      if (!active || inFlight || document.visibilityState !== "visible") return;
      inFlight = true;
      try {
        await refresh();
        if (active) setLoadError("");
      } catch (e) {
        if (active) setLoadError((e as Error).message);
      } finally {
        inFlight = false;
      }
    };
    void poll();
    const timer = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", poll);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", poll);
    };
  }, [refresh]);

  useEffect(() => {
    if (!ready) return;
    let active = true,
      inFlight = false,
      followUp = false,
      queuedInactive = false;
    let lastHeartbeat: Promise<Heartbeat> | undefined;
    const poll = async () => {
      if (!active) return;
      if (inFlight) {
        followUp = true;
        return;
      }
      inFlight = true;
      try {
        const visible = document.visibilityState === "visible";
        // Only actual foreground playback contributes, also on demo servers
        // that accept visibility-only heartbeats from other clients.
        const mustStop = queuedInactive;
        queuedInactive = false;
        const watching = visible && playing.current && !mustStop;
        // Preserve a pause/hidden transition even if playback resumed while an
        // earlier request was in flight. The next active update starts afresh.
        if (mustStop && visible && playing.current) followUp = true;
        lastHeartbeat = api<Heartbeat>(
          `/viewer/rooms/${id}/heartbeat`,
          "POST",
          {
            visible: watching,
            playing: watching,
          },
        );
        const heartbeat = await lastHeartbeat;
        if (active) {
          setWatch(heartbeat.watchSeconds);
          setCounting(
            heartbeat.counting &&
              document.visibilityState === "visible" &&
              playing.current &&
              !queuedInactive,
          );
          setInteractive(true);
          setInteractionError("");
        }
        if (visible && active) {
          const result = await api<{ claims: Claim[] }>(
            `/viewer/rooms/${id}/claims`,
          );
          if (active) setClaims(result.claims);
        }
      } catch (e) {
        if (active) {
          setInteractive(false);
          setCounting(false);
          setInteractionError(
            "互动暂不可用，直播可继续观看：" + (e as Error).message,
          );
        }
      } finally {
        inFlight = false;
        if (followUp && active) {
          followUp = false;
          void poll();
        }
      }
    };
    const onVisibility = () => {
      if (document.visibilityState !== "visible") {
        setCounting(false);
        queuedInactive = true;
      }
      void poll();
    };
    pulse.current = (forceInactive = false) => {
      if (forceInactive) queuedInactive = true;
      void poll();
    };
    void poll();
    const timer = setInterval(poll, 5000);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      active = false;
      pulse.current = () => {};
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisibility);
      // Place the inactive update after the last heartbeat, so a late response
      // from the old room cannot restart its qualification clock.
      void Promise.resolve(lastHeartbeat)
        .catch(() => undefined)
        .then(() =>
          api(`/viewer/rooms/${id}/heartbeat`, "POST", {
            visible: false,
            playing: false,
          }),
        )
        .catch(() => {});
    };
  }, [ready, id]);

  const onPlayback = useCallback((value: boolean) => {
    playing.current = value;
    setIsPlaying(value);
    if (!value) setCounting(false);
    pulse.current(!value);
  }, []);

  useEffect(() => {
    playing.current = false;
    setIsPlaying(false);
    setCounting(false);
    pulse.current(true);
  }, [data?.room.playbackUrl, data?.room.status]);

  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 6500);
    return () => clearTimeout(timer);
  }, [notice]);

  const closePanel = useCallback(() => {
    setPanel(null);
    if (panelTrigger.current?.isConnected) panelTrigger.current.focus();
    else rewardsButton.current?.focus();
  }, []);

  useEffect(() => {
    if (!panel) return;
    panelHeading.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closePanel();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [panel, closePanel]);

  function openPanel(next: Panel, trigger: HTMLElement) {
    panelTrigger.current = trigger;
    if (panel === next) closePanel();
    else setPanel(next);
  }

  async function claim(campaign: Campaign) {
    if (pending) return;
    setPending(campaign.id);
    setError("");
    try {
      const result = await api<{ claim: Claim }>(
        `/viewer/campaigns/${campaign.id}/claim`,
        "POST",
        {},
      );
      if (!mounted.current) return;
      setClaims((previous) => [
        ...previous.filter((item) => item.campaignId !== campaign.id),
        result.claim,
      ]);
      setNotice(
        `已领取演示红包 ${money(result.claim.amountCents)}，不发生真实转账。`,
      );
      await refresh();
      const records = await api<{ claims: Claim[] }>(
        `/viewer/rooms/${id}/claims`,
      );
      if (mounted.current) setClaims(records.claims);
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setPending("");
    }
  }

  async function sendQuestion() {
    if (!question.trim() || questionPending) return;
    setQuestionPending(true);
    setError("");
    try {
      await api(`/viewer/rooms/${id}/questions`, "POST", {
        text: question.trim(),
      });
      if (mounted.current) {
        setQuestion("");
        setNotice("问题已送达主播工作台。");
      }
    } catch (e) {
      if (mounted.current) setError((e as Error).message);
    } finally {
      if (mounted.current) setQuestionPending(false);
    }
  }

  const live = data?.room.status === "live";
  const displayError = error || loadError;
  const available =
    data?.campaigns.filter(
      (campaign) =>
        campaign.remainingCount > 0 &&
        campaign.expiresAt > now &&
        !claims.some((record) => record.campaignId === campaign.id),
    ) ?? [];
  const openReward = available.find((campaign) => campaign.opensAt <= now);
  const nextReward = [...available].sort((a, b) => a.opensAt - b.opensAt)[0];
  const nudge =
    live && nextReward
      ? openReward
        ? "红包已开启"
        : `红包 ${duration(Math.max(0, Math.ceil((nextReward.opensAt - now) / 1000)))} 后开启`
      : "";

  return (
    <div className="audience-view">
      <header className="audience-topbar">
        <span className="audience-brand">
          <Radio size={20} aria-hidden="true" />
          靠谱
        </span>
        <h1 title={data?.room.title}>{data?.room.title || "观众直播间"}</h1>
        {data && (
          <span
            className={`audience-live-status ${live && data.room.signal?.connected ? "is-live" : ""}`}
          >
            <i aria-hidden="true" />
            {roomStatus(data.room)}
          </span>
        )}
      </header>

      <main className="audience-stage" aria-label="直播画面">
        {!data || data.room.status === "ended" ? (
          <div className="audience-stage-state">
            <Radio size={40} aria-hidden="true" />
            <h2>
              {data
                ? "本场直播已结束"
                : loadError
                  ? "暂时无法打开直播间"
                  : "正在连接直播间…"}
            </h2>
            <p>{data ? "感谢观看，下次直播见。" : "普通观看无需下载应用。"}</p>
            {!data && loadError && (
              <button
                className="audience-action"
                onClick={() =>
                  void refresh()
                    .then(() => setLoadError(""))
                    .catch((e) => setLoadError(e.message))
                }
              >
                重新连接
              </button>
            )}
          </div>
        ) : (
          <Player
            url={data.room.playbackUrl}
            live={data.room.status === "live"}
            onPlayback={onPlayback}
          />
        )}

        {nudge && panel !== "rewards" && (
          <button
            className={`audience-reward-nudge ${openReward ? "is-open" : ""}`}
            onClick={(event) => openPanel("rewards", event.currentTarget)}
            aria-controls="audience-panel"
            aria-expanded={false}
          >
            <Gift size={19} aria-hidden="true" />
            <span>
              {nudge}
              <small>演示活动</small>
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </button>
        )}

        {(displayError || notice) && (
          <div
            className="audience-feedback"
            role={displayError ? "alert" : "status"}
          >
            <span>{displayError || notice}</span>
            <button
              aria-label="关闭提示"
              onClick={() => {
                setError("");
                setLoadError("");
                setNotice("");
              }}
            >
              <X size={20} />
            </button>
          </div>
        )}

        {panel && (
          <aside
            className="audience-drawer"
            id="audience-panel"
            aria-labelledby="audience-panel-heading"
          >
            <div className="audience-drawer-heading">
              <h2 id="audience-panel-heading" ref={panelHeading} tabIndex={-1}>
                {panelNames[panel]}
              </h2>
              <button
                className="audience-close"
                onClick={closePanel}
                aria-label="收起面板"
              >
                <X size={23} />
              </button>
            </div>
            <div className="audience-drawer-body">
              {interactionError && <Notice>{interactionError}</Notice>}
              {(interactionError || authConnecting) && (
                <button
                  className="audience-action audience-secondary"
                  disabled={authConnecting}
                  onClick={() => {
                    setAuthAttempt((attempt) => attempt + 1);
                  }}
                >
                  {authConnecting ? "正在连接互动…" : "重试互动连接"}
                </button>
              )}

              {panel === "questions" && (
                <>
                  <p className="audience-help">
                    想了解商品的哪些信息？你的问题会发送给商家。
                  </p>
                  <form
                    className="audience-question-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      void sendQuestion();
                    }}
                  >
                    <label htmlFor="audience-question">填写问题</label>
                    <textarea
                      id="audience-question"
                      value={question}
                      onChange={(event) => setQuestion(event.target.value)}
                      maxLength={200}
                      rows={4}
                      placeholder="例如：请介绍一下配料和规格。"
                      required
                    />
                    <div className="audience-question-meta">
                      <span>{question.length}/200</span>
                      <span>请勿填写手机号等个人信息</span>
                    </div>
                    <button
                      className="audience-action"
                      disabled={
                        !interactive ||
                        !live ||
                        questionPending ||
                        !question.trim()
                      }
                    >
                      {questionPending ? "发送中…" : "发送给主播"}
                    </button>
                  </form>
                  {!live && <Notice>直播进行中可以向主播提问。</Notice>}
                </>
              )}

              {panel === "rewards" && (
                <>
                  <p className="audience-help">
                    本场有效观看 <strong>{duration(watch)}</strong>
                    。红包为演示，不发生真实转账。
                  </p>
                  {data?.campaigns.length ? (
                    data.campaigns.map((campaign) => {
                      const mine = claims.find(
                        (record) => record.campaignId === campaign.id,
                      );
                      const waiting = now < campaign.opensAt;
                      const expired = now >= campaign.expiresAt;
                      const eligible = watch >= campaign.minWatchSeconds;
                      const label = mine
                        ? `已领取 ${money(mine.amountCents)}`
                        : pending === campaign.id
                          ? "领取中…"
                          : !live
                            ? "直播尚未开始或已结束"
                            : expired
                              ? "活动已结束"
                              : campaign.remainingCount === 0
                                ? "已领完"
                                : waiting
                                  ? `${Math.max(0, Math.ceil((campaign.opensAt - now) / 1000))} 秒后开启`
                                  : !interactive
                                    ? "互动暂不可用"
                                    : !isPlaying
                                      ? "请先播放直播"
                                      : !counting
                                        ? "等待观看资格确认"
                                        : !eligible
                                          ? `还需观看 ${duration(campaign.minWatchSeconds - watch)}`
                                          : "领取演示红包";
                      return (
                        <article
                          className="audience-reward-card"
                          key={campaign.id}
                        >
                          <div className="audience-reward-total">
                            <Gift size={22} aria-hidden="true" />
                            <span>演示红包总额</span>
                            <strong>{money(campaign.totalCents)}</strong>
                          </div>
                          <p>
                            共 {campaign.count} 个 · 剩余{" "}
                            {campaign.remainingCount} 个
                          </p>
                          <div className="audience-eligibility">
                            <span>观看满 {campaign.minWatchSeconds} 秒</span>
                            {eligible ? (
                              <span>
                                <Check size={17} />
                                已达时长
                              </span>
                            ) : (
                              <span>{duration(watch)}</span>
                            )}
                          </div>
                          <progress
                            aria-label="红包观看时长进度"
                            max={Math.max(1, campaign.minWatchSeconds)}
                            value={
                              campaign.minWatchSeconds === 0
                                ? 1
                                : Math.min(watch, campaign.minWatchSeconds)
                            }
                          />
                          <button
                            className="audience-action audience-claim"
                            disabled={
                              !interactive ||
                              !live ||
                              !isPlaying ||
                              !counting ||
                              !!mine ||
                              !!pending ||
                              waiting ||
                              expired ||
                              !eligible ||
                              campaign.remainingCount === 0
                            }
                            onClick={() => void claim(campaign)}
                          >
                            {label}
                          </button>
                          <small>演示记录不会进入微信零钱。</small>
                        </article>
                      );
                    })
                  ) : (
                    <div className="audience-panel-empty">
                      <Gift size={30} aria-hidden="true" />
                      <p>暂无红包活动，继续观看精彩内容。</p>
                    </div>
                  )}
                  {claims.length > 0 && (
                    <details className="audience-records">
                      <summary>我的演示记录（{claims.length}）</summary>
                      {claims.map((record) => (
                        <div className="audience-claim-record" key={record.id}>
                          <strong>{money(record.amountCents)}</strong>
                          <span>
                            {record.status === "simulated"
                              ? "演示处理完成"
                              : "等待演示处理"}
                          </span>
                        </div>
                      ))}
                    </details>
                  )}
                </>
              )}

              {panel === "information" && (
                <>
                  <dl className="audience-information">
                    <div>
                      <dt>直播主题</dt>
                      <dd>{data?.room.title || "正在连接"}</dd>
                    </div>
                    <div>
                      <dt>本场商品</dt>
                      <dd>{data?.room.productName || "—"}</dd>
                    </div>
                    <div>
                      <dt>直播状态</dt>
                      <dd>{data ? roomStatus(data.room) : "正在连接"}</dd>
                    </div>
                    <div>
                      <dt>有效观看</dt>
                      <dd>
                        {duration(watch)}
                        <span className="audience-counting">
                          {counting ? "正在累计" : "暂未累计"}
                        </span>
                      </dd>
                    </div>
                  </dl>
                  <p className="audience-help">
                    视频正常播放且页面处于前台时累计观看时长。暂停、切换页面或等待信号时不累计；活动资格以服务器记录为准。
                  </p>
                  <p className="audience-help">
                    如没有声音，请在视频控制栏打开声音。横屏或使用视频的全屏按钮，可以看得更大。
                  </p>
                  <p className="audience-help">
                    本页使用匿名浏览器身份记录互动，仅用于演示，不能用于真实提现。
                  </p>
                </>
              )}
            </div>
          </aside>
        )}
      </main>

      <nav className="audience-toolbar" aria-label="直播互动">
        <button
          onClick={(event) => openPanel("questions", event.currentTarget)}
          aria-expanded={panel === "questions"}
          aria-controls="audience-panel"
          className={panel === "questions" ? "is-selected" : ""}
        >
          <MessageCircle size={22} aria-hidden="true" />
          <span>提问</span>
        </button>
        <button
          ref={rewardsButton}
          onClick={(event) => openPanel("rewards", event.currentTarget)}
          aria-expanded={panel === "rewards"}
          aria-controls="audience-panel"
          className={panel === "rewards" ? "is-selected" : ""}
        >
          <span className="audience-toolbar-icon">
            <Gift size={22} aria-hidden="true" />
            {openReward && <i aria-hidden="true" />}
          </span>
          <span>红包{openReward ? " · 已开启" : ""}</span>
        </button>
        <button
          onClick={(event) => openPanel("information", event.currentTarget)}
          aria-expanded={panel === "information"}
          aria-controls="audience-panel"
          className={panel === "information" ? "is-selected" : ""}
        >
          <Info size={22} aria-hidden="true" />
          <span>观看信息</span>
        </button>
      </nav>
    </div>
  );
}
