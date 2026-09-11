import {
  Activity,
  ArrowUpRight,
  CheckCheck,
  ChevronRight,
  Clipboard,
  FileCheck2,
  Gift,
  Layers,
  LogOut,
  Pause,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { memberRoleNames, type MemberRole } from "../../shared/membership.js";
import type { Analytics, Room } from "../../shared/types";
import { AgentLiveCard } from "../agent/AgentLiveCard.js";
import { AgentWorkbench } from "../agent/AgentWorkbench.js";
import { TrainingWorkbench } from "../agent/TrainingWorkbench.js";
import { Stats } from "../analytics/Stats.js";
import { ContentWorkbench } from "../content/ContentWorkbench.js";
import { Questions, Rewards } from "../engagement/Interactions.js";
import { Audience } from "../live/Audience.js";
import { BoundScriptPanel } from "../live/BoundScriptPanel.js";
import { Player } from "../live/Player";
import { Signal, StreamSettings } from "../live/StreamControls.js";
import { api, money } from "../shared/api";
import { Notice } from "../shared/Notice.js";
import "./merchant-density.css";
import "./styles.css";

type Tab =
  "content" | "studio" | "copilot" | "training" | "rewards" | "analytics";
const statusText = { draft: "待开播", live: "直播间开放", ended: "已结束" };

function App() {
  const base = import.meta.env.BASE_URL;
  const path = window.location.pathname.startsWith(base)
    ? "/" + window.location.pathname.slice(base.length)
    : window.location.pathname;
  if (path.startsWith("/watch/"))
    return <Audience id={decodeURIComponent(path.slice(7))} />;
  return <Merchant />;
}
function Merchant() {
  const [auth, setAuth] = useState<{
      merchantId: string | null;
      demoMode: boolean;
      actorId?: string;
      memberRole?: MemberRole;
    } | null>(null),
    [error, setError] = useState("");
  const [loginId, setLoginId] = useState(""),
    [token, setToken] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => {
    api<{ merchantId: string | null; demoMode: boolean }>("/auth/me")
      .then(setAuth)
      .catch((e) => setError(e.message));
  }, []);
  async function login(demo: boolean) {
    setBusy(true);
    setError("");
    try {
      const data = await api<{
        merchantId: string;
        actorId?: string;
        memberRole?: MemberRole;
      }>(
        demo ? "/auth/demo" : "/auth/merchant",
        "POST",
        demo ? {} : { merchantId: loginId, token },
      );
      setAuth({
        merchantId: data.merchantId,
        actorId: data.actorId,
        memberRole: data.memberRole,
        demoMode: auth?.demoMode || false,
      });
      setToken("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  if (!auth?.merchantId)
    return (
      <div className="login-page">
        <div className="login-card">
          <Brand />
          <span className="eyebrow">内容与直播工作台</span>
          <h1>
            把内容准备好，
            <br />
            再从容开播。
          </h1>
          <p>从商品依据、课程讲稿到真人直播，把每一次表达准备充分。</p>
          {!auth && !error ? (
            <Notice>正在连接工作台…</Notice>
          ) : (
            <>
              {auth?.demoMode && (
                <>
                  <button
                    className="primary full"
                    disabled={busy}
                    onClick={() => login(true)}
                  >
                    进入演示工作台 <ArrowUpRight size={18} />
                  </button>
                  <small>本地演示 · 红包不发生实际转账</small>
                  <div className="divider">或使用商家凭证</div>
                </>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void login(false);
                }}
              >
                <label>
                  登录账号
                  <input
                    value={loginId}
                    onChange={(e) => setLoginId(e.target.value)}
                    required
                    autoComplete="username"
                  />
                </label>
                <label>
                  访问密钥
                  <input
                    type="password"
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    required
                    autoComplete="current-password"
                  />
                </label>
                <button className="secondary full" disabled={busy}>
                  登录
                </button>
              </form>
            </>
          )}
          {error && <Notice>{error}</Notice>}
        </div>
        <div className="login-side">
          <Radio size={64} />
          <h2>
            开播有序
            <br />
            表达有据
            <br />
            互动有数
          </h2>
          <span>靠谱 · 内容有据，表达有温度</span>
        </div>
      </div>
    );
  return (
    <Workspace
      merchantId={auth.merchantId}
      actorId={auth.actorId || auth.merchantId}
      memberRole={auth.memberRole || "owner"}
      demoMode={auth.demoMode}
      onLogout={() =>
        api("/auth/logout", "POST", {})
          .then(() => setAuth({ ...auth, merchantId: null }))
          .catch((e) => setError(e.message))
      }
    />
  );
}
function Brand() {
  return (
    <div className="brand">
      <span className="brand-mark">
        <Radio size={22} />
      </span>
      <span>
        靠谱
        <small>内容与直播工作台</small>
      </span>
    </div>
  );
}
function Workspace({
  merchantId,
  actorId,
  memberRole,
  demoMode,
  onLogout,
}: {
  merchantId: string;
  actorId: string;
  memberRole: MemberRole;
  demoMode: boolean;
  onLogout: () => void;
}) {
  const [rooms, setRooms] = useState<Room[]>([]),
    [roomId, setRoomId] = useState(""),
    [tab, setTab] = useState<Tab>(
      memberRole === "analyst"
        ? "analytics"
        : memberRole === "presenter"
          ? "studio"
          : "content",
    ),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [product, setProduct] = useState(""),
    [saving, setSaving] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const selected = rooms.find((r) => r.id === roomId);
  const refreshRooms = useCallback(async () => {
    const data = await api<{ rooms: Room[] }>("/merchant/rooms");
    setRooms(data.rooms);
    setRoomId((current) =>
      data.rooms.some((r) => r.id === current)
        ? current
        : data.rooms[0]?.id || "",
    );
  }, []);
  useEffect(() => {
    const refresh = () => refreshRooms().catch((e) => setError(e.message));
    void refresh();
    const timer = setInterval(refresh, 10000);
    return () => clearInterval(timer);
  }, [refreshRooms]);
  useEffect(() => {
    setAnalytics(null);
    if (!roomId) return;
    let cancelled = false;
    const refresh = () =>
      api<Analytics>(`/merchant/rooms/${roomId}/analytics`)
        .then((x) => {
          if (!cancelled) setAnalytics(x);
        })
        .catch((e) => {
          if (!cancelled) setError(e.message);
        });
    void refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [roomId]);
  async function createRoom(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const result = await api<{ room: Room }>("/merchant/rooms", "POST", {
        title,
        productName: product,
      });
      await refreshRooms();
      setRoomId(result.room.id);
      setCreating(false);
      setTitle("");
      setProduct("");
      setNotice("直播间已创建。可在“商品与课程”中绑定已定稿讲稿。");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function setStatus(status: Room["status"]) {
    if (!selected) return;
    setSaving(true);
    try {
      const update = await api<{
        streamAction?: { disconnected: boolean; message?: string };
      }>(`/merchant/rooms/${selected.id}`, "PATCH", { status });
      await refreshRooms();
      setNotice(
        status === "live"
          ? "直播间已开放，请使用推流配置连接 OBS。"
          : status === "ended"
            ? `直播间已结束，未领取的演示预算已退回。${update.streamAction?.disconnected ? "已断开推流连接。" : update.streamAction?.message || "请停止 OBS 推流。"}`
            : "已重置为待开播。",
      );
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSaving(false);
    }
  }
  async function copy(text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setNotice("已复制");
    } catch {
      setNotice(`请手动复制：${text}`);
    }
  }
  const tabs: { id: Tab; label: string; icon: typeof Radio }[] = [
    { id: "content", label: "商品与课程", icon: Layers },
    { id: "studio", label: "直播现场", icon: Video },
    { id: "copilot", label: "表达与提示词", icon: Sparkles },
    { id: "training", label: "品牌与评测", icon: FileCheck2 },
    { id: "rewards", label: "互动活动", icon: Gift },
    { id: "analytics", label: "数据复盘", icon: Activity },
  ];
  const watchUrl = selected
    ? `${location.origin}${import.meta.env.BASE_URL}watch/${selected.id}`
    : "";
  return (
    <div className="workspace">
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">准备 · 播讲 · 复盘</div>
        <nav aria-label="工作台导航">
          {tabs
            .filter(
              (t) =>
                memberRole === "owner" ||
                (memberRole === "analyst"
                  ? t.id === "analytics"
                  : memberRole === "reviewer"
                    ? ["content", "analytics"].includes(t.id)
                    : t.id !== "rewards"),
            )
            .map((t) => (
              <button
                key={t.id}
                className={tab === t.id ? "nav-item active" : "nav-item"}
                onClick={() => setTab(t.id)}
              >
                <t.icon size={19} />
                {t.label}
                {tab === t.id && <ChevronRight size={15} />}
              </button>
            ))}
        </nav>
        <div className="sidebar-note">
          <ShieldCheck size={20} />
          <strong>有依据，再表达</strong>
          <p>
            主播提示仅商家可见。
            <br />
            讲稿定稿后再播讲。
          </p>
        </div>
        <div className="account">
          <div className="avatar">{merchantId.slice(0, 1).toUpperCase()}</div>
          <div>
            <strong>
              {demoMode && actorId === "demo" ? "演示商家" : actorId}
            </strong>
            <small>
              {memberRoleNames[memberRole]} · {merchantId}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="退出登录"
            onClick={onLogout}
          >
            <LogOut size={17} />
          </button>
        </div>
      </aside>
      <main className="main">
        <header className="topbar">
          <div className="breadcrumb">
            工作空间 <ChevronRight size={14} />
            <strong>{tabs.find((t) => t.id === tab)?.label}</strong>
          </div>
          <span className="env-badge">MVP · 演示支付</span>
        </header>
        <div className="content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">
                {tab === "content"
                  ? "内容准备"
                  : tab === "studio"
                    ? "ON AIR, IN CONTROL"
                    : tab === "copilot"
                      ? "SPEAK WITH CONFIDENCE"
                      : tab === "training"
                        ? "PREPARE, COMPARE, REVIEW"
                        : tab === "rewards"
                          ? "MAKE EVERY MOMENT COUNT"
                          : "MEASURE WHAT HAPPENED"}
              </span>
              <h1>{tabs.find((t) => t.id === tab)?.label}</h1>
              <p>
                {tab === "content"
                  ? "商品资料 → 课程讲稿 → 审改定稿 → 真人直播"
                  : tab === "studio"
                    ? "查看定稿，准备信号与现场互动。"
                    : tab === "copilot"
                      ? "用已核实的信息，组织下一句话。"
                      : tab === "training"
                        ? "整理商品证据与品牌话术，用场景打磨表达。"
                        : tab === "rewards"
                          ? "设置领取规则，追踪每一笔演示记录。"
                          : "来自当前直播间的实际访问与互动记录。"}
              </p>
            </div>
            <button
              className="primary"
              disabled={memberRole !== "owner"}
              onClick={() => setCreating(true)}
            >
              <Plus size={17} />
              创建直播间
            </button>
          </div>
          {tab !== "content" && (
            <div className="room-bar">
              <label>
                当前直播间
                <select
                  value={roomId}
                  onChange={(e) => {
                    setRoomId(e.target.value);
                    setError("");
                    setNotice("");
                  }}
                >
                  {!rooms.length && <option value="">暂无直播间</option>}
                  {rooms.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.title}
                    </option>
                  ))}
                </select>
              </label>
              {selected && (
                <>
                  <span className={`status ${selected.status}`}>
                    {statusText[selected.status]}
                  </span>
                  <button
                    className="text-button"
                    onClick={() => copy(watchUrl)}
                  >
                    <Clipboard size={15} />
                    复制观看链接
                  </button>
                  <a
                    className="text-button"
                    href={watchUrl}
                    target="_blank"
                    rel="noreferrer"
                  >
                    观众页
                    <ArrowUpRight size={16} />
                  </a>
                </>
              )}
            </div>
          )}
          {error && (
            <div className="alert-banner" role="alert">
              {error}
              <button aria-label="关闭错误提示" onClick={() => setError("")}>
                <X size={16} />
              </button>
            </div>
          )}
          {notice && (
            <Notice>
              {notice}
              <button
                className="icon-button"
                aria-label="关闭提示"
                onClick={() => setNotice("")}
              >
                <X size={14} />
              </button>
            </Notice>
          )}
          {memberRole !== "analyst" && (
            <div hidden={tab !== "content"}>
              <ContentWorkbench rooms={rooms} memberRole={memberRole} />
            </div>
          )}
          {tab === "content" ? null : !selected ? (
            <div className="empty-state">
              <Radio size={44} />
              <h2>准备你的第一场直播</h2>
              <p>创建直播间，获得推流配置和观众链接。</p>
              <button className="primary" onClick={() => setCreating(true)}>
                创建直播间
              </button>
            </div>
          ) : (
            <>
              {tab === "studio" && (
                <>
                  <Stats analytics={analytics} />
                  <div className="studio-grid">
                    <section>
                      <div className="section-title">
                        <h2>直播预览</h2>
                        <span className="muted">{selected.productName}</span>
                      </div>
                      <Signal roomId={selected.id} />
                      <Player
                        key={selected.id}
                        url={selected.playbackUrl}
                        live={selected.status === "live"}
                      />
                      <div className="stream-actions">
                        <div>
                          <strong>{selected.title}</strong>
                          <small>
                            画面以实际推流信号为准；结束时尝试断开连接
                          </small>
                        </div>
                        <button
                          disabled={
                            saving ||
                            !["owner", "presenter"].includes(memberRole)
                          }
                          className={
                            selected.status === "live" ? "danger" : "primary"
                          }
                          onClick={() =>
                            setStatus(
                              selected.status === "live"
                                ? "ended"
                                : selected.status === "ended"
                                  ? "draft"
                                  : "live",
                            )
                          }
                        >
                          {selected.status === "live" ? (
                            <Pause size={16} />
                          ) : (
                            <Play size={16} />
                          )}{" "}
                          {selected.status === "live"
                            ? "结束直播"
                            : selected.status === "ended"
                              ? "重新准备"
                              : "开放直播间"}
                        </button>
                      </div>
                      {["owner", "presenter"].includes(memberRole) && (
                        <StreamSettings
                          key={selected.id}
                          roomId={selected.id}
                          copy={copy}
                          canRotate={memberRole === "owner"}
                          onError={setError}
                          onNotice={setNotice}
                        />
                      )}
                    </section>
                    <div className="studio-side">
                      <BoundScriptPanel
                        key={selected.id}
                        roomId={selected.id}
                        onOpenContent={() => setTab("content")}
                      />
                      <AgentLiveCard
                        roomId={selected.id}
                        onOpen={() => setTab("copilot")}
                      />
                      <section className="card readiness">
                        <span className="eyebrow">BEFORE YOU GO LIVE</span>
                        <h2>开播准备</h2>
                        <div className="check-row">
                          <CheckCheck size={19} />
                          <div>
                            <strong>直播间已创建</strong>
                            <small>观看链接随时可分享</small>
                          </div>
                        </div>
                        <button
                          className="check-row"
                          onClick={() => setTab("copilot")}
                        >
                          <ShieldCheck size={19} />
                          <div>
                            <strong>审核商品事实</strong>
                            <small>为每一句话补充依据</small>
                          </div>
                          <ChevronRight size={16} />
                        </button>
                        <button
                          className="check-row"
                          onClick={() => setTab("rewards")}
                        >
                          <Gift size={19} />
                          <div>
                            <strong>设置红包活动</strong>
                            <small>金额、时间与领取条件</small>
                          </div>
                          <ChevronRight size={16} />
                        </button>
                      </section>
                      <Questions
                        roomId={selected.id}
                        onChoose={() => setTab("copilot")}
                      />
                      <div className="mini-note">
                        <Layers size={20} />
                        <p>
                          红包当前为演示记录。
                          <br />
                          未连接微信支付，不发生资金转账。
                        </p>
                      </div>
                    </div>
                  </div>
                </>
              )}
              {tab === "training" && (
                <TrainingWorkbench
                  roomId={selected.id}
                  productName={selected.productName}
                />
              )}
              {tab === "copilot" && (
                <AgentWorkbench
                  key={selected.id}
                  roomId={selected.id}
                  productName={selected.productName}
                />
              )}
              {tab === "rewards" && (
                <Rewards key={selected.id} room={selected} onError={setError} />
              )}
              {tab === "analytics" && (
                <>
                  <Stats analytics={analytics} />
                  <section className="card analytics-chart">
                    <div className="section-title">
                      <h2>最近 30 分钟 · 活跃观众</h2>
                      <span className="muted">每分钟去重访客</span>
                    </div>
                    {analytics?.timeline.length ? (
                      <div className="bars">
                        {analytics.timeline.map((point) => (
                          <div className="bar-column" key={point.minute}>
                            <span>{point.viewers}</span>
                            <div
                              style={{
                                height: `${Math.max(6, (point.viewers / Math.max(...analytics.timeline.map((x) => x.viewers))) * 140)}px`,
                              }}
                            />
                            <small>
                              {new Date(point.minute).toLocaleTimeString(
                                "zh-CN",
                                { hour: "2-digit", minute: "2-digit" },
                              )}
                            </small>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="empty-chart">
                        <Activity size={30} />
                        <p>
                          还没有观看记录。打开观众链接后，数据将在这里呈现。
                        </p>
                      </div>
                    )}
                  </section>
                  <div className="two-columns">
                    <section className="card">
                      <h2>红包互动</h2>
                      <dl className="metric-list">
                        <div>
                          <dt>领取次数</dt>
                          <dd>{analytics?.claims || 0}</dd>
                        </div>
                        <div>
                          <dt>已领取演示金额</dt>
                          <dd>{money(analytics?.reservedCents || 0)}</dd>
                        </div>
                        <div>
                          <dt>已完成演示处理</dt>
                          <dd>{money(analytics?.simulatedCents || 0)}</dd>
                        </div>
                        <div>
                          <dt>观众提问</dt>
                          <dd>{analytics?.questions || 0}</dd>
                        </div>
                      </dl>
                    </section>
                    <section className="card">
                      <h2>数据口径</h2>
                      <p className="muted">
                        在线人数为近 30
                        秒仍有心跳的浏览器会话。累计观众按匿名会话去重；平均停留按直播间开放期间、页面可见时的有效心跳间隔统计。
                      </p>
                      <p className="muted">
                        这些记录不等于实名认证人数或视频有效播放时长。当前未接订单系统，不计算成交或
                        GMV。
                      </p>
                    </section>
                  </div>
                </>
              )}
            </>
          )}
        </div>
        <footer>
          靠谱 <span>商品 · 课程 · 真人直播</span>
          <a
            href={`${import.meta.env.BASE_URL}brand/index.html`}
            target="_blank"
            rel="noreferrer"
          >
            Logo 候选
          </a>
        </footer>
      </main>
      {creating && (
        <div className="modal-backdrop">
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="create-title"
          >
            <button
              className="modal-close icon-button"
              aria-label="关闭"
              onClick={() => setCreating(false)}
            >
              <X />
            </button>
            <span className="eyebrow">NEW LIVE ROOM</span>
            <h2 id="create-title">创建直播间</h2>
            <form onSubmit={createRoom}>
              <label>
                直播主题
                <input
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  minLength={2}
                  maxLength={100}
                  placeholder="例如：周五新品分享"
                  required
                />
              </label>
              <label>
                本场主要商品
                <input
                  value={product}
                  onChange={(e) => setProduct(e.target.value)}
                  maxLength={100}
                  placeholder="例如：日常随行杯"
                  required
                />
              </label>
              <p className="muted">
                创建后可以设置推流工具、商品事实和红包活动。
              </p>
              <button className="primary full" disabled={saving}>
                {saving ? "创建中…" : "创建直播间"}
              </button>
            </form>
          </section>
        </div>
      )}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
