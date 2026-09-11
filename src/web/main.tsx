import { homeDestinations } from "../shared/home.js";
import { PersonalHome, type Destination } from "./PersonalHome.js";
import { Home } from "lucide-react";
import { RecordingsPanel } from "./RecordingsPanel.js";
import { ModerationPanel } from "./ModerationPanel.js";
import { AdmissionPanel } from "./AdmissionPanel.js";
import { MerchantDisclosure } from "./DisclosurePanel.js";
import { ComplaintsPanel } from "./ComplaintsPanel.js";
import { MerchantEngagement } from "./EngagementPanel.js";
import { AttributionPanel } from "./AttributionPanel.js";
import { Audience } from "./Audience.js";
import { memberRoleNames, type MemberRole } from "../shared/membership.js";
import { BoundScriptPanel } from "./BoundScriptPanel.js";
import { ContentWorkbench } from "./ContentWorkbench.js";
import { TrainingWorkbench } from "./TrainingWorkbench.js";
import { AgentWorkbench } from "./AgentWorkbench.js";
import { AgentLiveCard } from "./AgentLiveCard.js";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Activity,
  ArrowUpRight,
  Check,
  CheckCheck,
  ChevronRight,
  Clipboard,
  Eye,
  FileCheck2,
  Gift,
  Layers,
  LogOut,
  MessageCircle,
  Mic,
  Pause,
  Play,
  Plus,
  Radio,
  ShieldCheck,
  Sparkles,
  Video,
  X,
} from "lucide-react";
import type {
  Analytics,
  Campaign,
  Claim,
  LedgerEntry,
  Question,
  Room,
  StreamConfig,
  StreamState,
} from "../shared/types";
import { api, duration, money } from "./api";
import { Player } from "./Player";
import "./styles.css";
import "./merchant-density.css";
import "./live-stage.css";

type Tab = "home" | Destination;
const statusText = { draft: "待开播", live: "直播间开放", ended: "已结束" };
function useClock() {
  const [now, set] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => set(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
function Notice({ children }: { children: React.ReactNode }) {
  return (
    <div className="notice" role="status">
      {children}
    </div>
  );
}
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
    [tab, setTab] = useState<Tab>("home"),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [creating, setCreating] = useState(false),
    [title, setTitle] = useState(""),
    [product, setProduct] = useState(""),
    [saving, setSaving] = useState(false);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [liveTool, setLiveTool] = useState<"script" | "questions" | "agent">(
    "script",
  );
  const [admissionRevision, setAdmissionRevision] = useState(0);
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
    { id: "home", label: "我的主页", icon: Home },
    { id: "content", label: "商品与课程", icon: Layers },
    { id: "studio", label: "直播现场", icon: Video },
    { id: "copilot", label: "表达与提示词", icon: Sparkles },
    { id: "training", label: "品牌与评测", icon: FileCheck2 },
    { id: "rewards", label: "互动活动", icon: Gift },
    { id: "analytics", label: "数据复盘", icon: Activity },
  ];
  const allowed = homeDestinations(memberRole);
  const watchUrl = selected
    ? `${location.origin}${import.meta.env.BASE_URL}watch/${selected.id}`
    : "";
  return (
    <div className={`workspace ${tab === "studio" ? "live-workspace" : ""}`}>
      <aside className="sidebar">
        <Brand />
        <div className="workspace-label">准备 · 播讲 · 复盘</div>
        <nav aria-label="工作台导航">
          {tabs
            .filter(
              (t) =>
                t.id === "home" ||
                (allowed.includes(t.id as Destination) &&
                  (memberRole === "analyst"
                    ? t.id === "analytics"
                    : ["content", "studio"].includes(t.id))),
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
          {tab === "content" && (
            <MerchantDisclosure
              key={actorId}
              actorId={actorId}
              role={memberRole}
            />
          )}
          {tab !== "home" && (
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
          )}
          {tab !== "home" && tab !== "content" && (
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
          {tab === "home" && (
            <>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                {memberRole === "owner" && (
                  <button className="primary" onClick={() => setCreating(true)}>
                    <Plus size={16} />
                    创建直播间
                  </button>
                )}
              </div>
              <PersonalHome
                key={merchantId + ":" + actorId}
                merchantId={merchantId}
                actorId={actorId}
                allowed={allowed}
                rooms={rooms}
                onOpen={setTab}
                onRoom={(id) => {
                  setRoomId(id);
                  setTab(memberRole === "analyst" ? "analytics" : "studio");
                }}
              />
            </>
          )}
          {tab === "home" || tab === "content" ? null : !selected ? (
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
                  <div className="studio-grid">
                    <section className="live-stage" aria-label="直播画面与控制">
                      <div className="section-title">
                        <h2>直播预览</h2>
                        <span className="muted">{selected.productName}</span>
                      </div>
                      <Player
                        key={selected.id}
                        url={selected.playbackUrl}
                        live={selected.status === "live"}
                      />
                      <Signal
                        key={selected.id + selected.status}
                        roomId={selected.id}
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
                    <aside className="studio-side" aria-label="直播辅助工具">
                      <div
                        className="live-tool-tabs"
                        role="tablist"
                        aria-label="直播辅助工具切换"
                      >
                        {(["script", "questions", "agent"] as const).map(
                          (id) => (
                            <button
                              key={id}
                              id={`tool-${id}`}
                              role="tab"
                              aria-selected={liveTool === id}
                              aria-controls={`panel-${id}`}
                              onClick={() => setLiveTool(id)}
                            >
                              {
                                {
                                  script: "提词器",
                                  questions: "观众提问",
                                  agent: "Agent 建议",
                                }[id]
                              }
                            </button>
                          ),
                        )}
                      </div>
                      <div
                        role="tabpanel"
                        id="panel-script"
                        aria-labelledby="tool-script"
                        hidden={liveTool !== "script"}
                      >
                        <BoundScriptPanel
                          key={selected.id}
                          roomId={selected.id}
                          onOpenContent={() => setTab("content")}
                        />
                      </div>
                      <div
                        role="tabpanel"
                        id="panel-questions"
                        aria-labelledby="tool-questions"
                        hidden={liveTool !== "questions"}
                      >
                        <Questions
                          roomId={selected.id}
                          onChoose={() => {
                            if (allowed.includes("copilot")) setTab("copilot");
                          }}
                        />
                      </div>
                      <div
                        role="tabpanel"
                        id="panel-agent"
                        aria-labelledby="tool-agent"
                        hidden={liveTool !== "agent"}
                      >
                        {allowed.includes("copilot") ? (
                          <AgentLiveCard
                            roomId={selected.id}
                            onOpen={() => setTab("copilot")}
                          />
                        ) : (
                          <p className="muted">当前角色使用已审核定稿播讲。</p>
                        )}
                      </div>
                    </aside>
                  </div>
                  <details className="live-management">
                    <summary>开播检查与现场处置</summary>
                    <AdmissionPanel
                      key={selected.id + selected.status + admissionRevision}
                      roomId={selected.id}
                    />
                    <ModerationPanel
                      key={selected.id + "-moderation"}
                      onChanged={async () => {
                        await refreshRooms();
                        setAdmissionRevision((value) => value + 1);
                      }}
                      roomId={selected.id}
                      actorId={actorId}
                      editable={["owner", "reviewer"].includes(memberRole)}
                    />
                  </details>
                  <details className="live-management">
                    <summary>直播管理 · 投诉、录像与数据</summary>
                    {memberRole === "owner" && (
                      <ComplaintsPanel
                        key={selected.id}
                        roomId={selected.id}
                        merchant
                      />
                    )}
                    <Stats analytics={analytics} />
                    {["owner", "reviewer"].includes(memberRole) && (
                      <RecordingsPanel
                        key={selected.id + "-recordings"}
                        roomId={selected.id}
                      />
                    )}
                  </details>
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
                  canRevoke={memberRole === "owner"}
                  key={selected.id}
                  roomId={selected.id}
                  productName={selected.productName}
                />
              )}
              {tab === "rewards" && (
                <>
                  {(memberRole === "owner" || memberRole === "analyst") && (
                    <MerchantEngagement
                      key={selected.id}
                      roomId={selected.id}
                      editable={memberRole === "owner"}
                    />
                  )}
                  <Rewards
                    key={selected.id}
                    room={selected}
                    onError={setError}
                  />
                </>
              )}
              {tab === "analytics" && (
                <>
                  {memberRole === "owner" && (
                    <ComplaintsPanel
                      key={selected.id}
                      roomId={selected.id}
                      merchant
                    />
                  )}
                  <Stats analytics={analytics} />
                  {(memberRole === "owner" || memberRole === "analyst") && (
                    <AttributionPanel
                      roomId={selected.id}
                      editable={memberRole === "owner"}
                    />
                  )}
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
                        这些记录不等于实名认证人数。门店成交与成本来自单独登记的线下台账，尚未与收银系统自动核对，也不代表直播直接带来的成交。
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
function SignalBadge({ signal }: { signal: StreamState }) {
  return (
    <div className="signal-status" role="status">
      <Radio size={16} />
      {signal.connected === true
        ? "已收到实时推流"
        : signal.connected === false
          ? "尚未收到实时推流"
          : signal.message || "流状态暂不可用"}
      {signal.connected === true && (
        <small>引擎观看连接 {signal.viewers || 0}</small>
      )}
    </div>
  );
}
function Signal({ roomId }: { roomId: string }) {
  const [signal, setSignal] = useState<StreamState | null>(null);
  useEffect(() => {
    let active = true;
    const poll = () =>
      api<StreamState>(`/merchant/rooms/${roomId}/signal`)
        .then((v) => {
          if (active) setSignal(v);
        })
        .catch(() => {
          if (active)
            setSignal({
              configured: true,
              connected: null,
              checkedAt: Date.now(),
              message: "流状态暂不可用",
            });
        });
    void poll();
    const timer = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [roomId]);
  return signal ? <SignalBadge signal={signal} /> : null;
}
function StreamSettings({
  roomId,
  copy,
  canRotate,
  onError,
  onNotice,
}: {
  roomId: string;
  copy: (text: string) => void;
  canRotate: boolean;
  onError: (m: string) => void;
  onNotice: (m: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [stream, setStream] = useState<StreamConfig | null>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    api<StreamConfig>(`/merchant/rooms/${roomId}/stream`)
      .then((s) => {
        if (!cancelled) setStream(s);
      })
      .catch((e) => {
        if (!cancelled) onError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [roomId, open, onError]);
  return (
    <details
      className="card stream-settings"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>
        推流配置 <span>OBS / 手机推流工具</span>
      </summary>
      {open && !stream && <p className="muted">正在读取推流配置…</p>}
      {stream && (
        <>
          <p className="muted">
            {stream.provider.toUpperCase()} ·{" "}
            {stream.authEnabled
              ? "已配置回调鉴权密钥，仍需在流媒体引擎启用回调"
              : "本机开发配置，未启用推流鉴权"}
          </p>
          <label>
            服务器地址
            <div className="copy-field">
              <input readOnly value={stream.server} />
              <button
                aria-label="复制服务器地址"
                onClick={() => copy(stream.server)}
              >
                <Clipboard size={16} />
              </button>
            </div>
          </label>
          <label>
            推流密钥
            <div className="copy-field">
              <input type="password" readOnly value={stream.streamKey} />
              <button
                aria-label="复制推流密钥"
                onClick={() => copy(stream.streamKey)}
              >
                <Clipboard size={16} />
              </button>
            </div>
          </label>
          <button
            className="text-button"
            disabled={!canRotate}
            onClick={async () => {
              try {
                const rotation = await api<{
                  streamAction: { disconnected: boolean; message?: string };
                }>(`/merchant/rooms/${roomId}/stream/rotate`, "POST", {});
                setStream(
                  await api<StreamConfig>(`/merchant/rooms/${roomId}/stream`),
                );
                onNotice(
                  `推流密钥已更新。${rotation.streamAction.disconnected ? "已断开旧推流，请使用新密钥连接。" : rotation.streamAction.message}`,
                );
              } catch (e) {
                onError((e as Error).message);
              }
            }}
          >
            更新推流密钥
          </button>
        </>
      )}
    </details>
  );
}
function Stats({ analytics: a }: { analytics: Analytics | null }) {
  return (
    <div className="stats">
      <div className="stat">
        <span>
          <Eye size={16} />
          当前在线
        </span>
        <strong>
          {a?.onlineViewers ?? "—"}
          <small>人</small>
        </strong>
        <p>近 30 秒活跃会话</p>
      </div>
      <div className="stat">
        <span>
          <Radio size={16} />
          累计观众
        </span>
        <strong>
          {a?.uniqueViewers ?? "—"}
          <small>人</small>
        </strong>
        <p>当前直播间去重访客</p>
      </div>
      <div className="stat">
        <span>
          <Activity size={16} />
          平均停留
        </span>
        <strong>{a ? duration(a.averageWatchSeconds) : "—"}</strong>
        <p>有效观看心跳时长</p>
      </div>
      <div className="stat">
        <span>
          <Gift size={16} />
          红包领取
        </span>
        <strong>
          {a?.claims ?? "—"}
          <small>次</small>
        </strong>
        <p>演示金额 {money(a?.reservedCents || 0)}</p>
      </div>
    </div>
  );
}
function Questions({
  roomId,
  onChoose,
}: {
  roomId: string;
  onChoose: (q: string) => void;
}) {
  const [questions, setQuestions] = useState<Question[]>([]),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    const refresh = () =>
      api<{ questions: Question[] }>(`/merchant/rooms/${roomId}/questions`)
        .then((d) => {
          if (!cancelled) {
            setQuestions(d.questions);
            setError("");
          }
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
  return (
    <section className="card">
      <div className="section-title">
        <h2>
          <MessageCircle size={18} />
          观众在问
        </h2>
        <span className="muted">实时汇总</span>
      </div>
      {error && <Notice>{error}</Notice>}
      {questions.length ? (
        questions.slice(0, 5).map((q) => (
          <button
            className="question"
            key={q.id}
            onClick={() => onChoose(q.text)}
          >
            <span>{q.text}</span>
            <b>×{q.count}</b>
          </button>
        ))
      ) : (
        <p className="empty-copy">还没有提问。观众发送的问题会在这里汇总。</p>
      )}
    </section>
  );
}
function Rewards({
  room,
  onError,
}: {
  room: Room;
  onError: (m: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [entries, setEntries] = useState<LedgerEntry[]>([]),
    [total, setTotal] = useState("100"),
    [count, setCount] = useState(20),
    [watch, setWatch] = useState(10),
    [delay, setDelay] = useState(10),
    [seconds, setSeconds] = useState(600),
    [busy, setBusy] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const now = useClock() + clockOffset;
  const refresh = useCallback(async () => {
    const [c, l] = await Promise.all([
      api<{ campaigns: Campaign[]; serverTime: number }>(
        `/merchant/rooms/${room.id}/campaigns`,
      ),
      api<{ entries: LedgerEntry[] }>(`/merchant/rooms/${room.id}/ledger`),
    ]);
    setCampaigns(c.campaigns);
    setClockOffset(c.serverTime - Date.now());
    setEntries(l.entries);
  }, [room.id]);
  useEffect(() => {
    let active = true;
    const poll = () => {
      if (active)
        refresh().catch((e) => {
          if (active) onError(e.message);
        });
    };
    poll();
    const timer = setInterval(poll, 4000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [refresh, onError]);
  async function create(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      if (!/^\d+(\.\d{1,2})?$/.test(total))
        throw new Error("金额最多支持两位小数");
      await api(`/merchant/rooms/${room.id}/campaigns`, "POST", {
        totalCents: Math.round(Number(total) * 100),
        count,
        minWatchSeconds: watch,
        delaySeconds: delay,
        durationSeconds: seconds,
      });
      await refresh();
    } catch (e) {
      onError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const labels: Record<string, string> = {
    simulation_budget: "演示预算",
    campaign_reserved: "活动预留",
    claim_reserved: "领取预留",
    simulation_settled: "演示处理",
    simulation_budget_returned: "演示退回",
  };
  return (
    <>
      <div className="simulation-banner">
        <Gift size={21} />
        <div>
          <strong>演示红包 · 不发生真实转账</strong>
          <p>
            验证活动规则、领取资格和账本。正式发放需另行接入获批的微信支付能力。
          </p>
        </div>
      </div>
      <div className="rewards-layout">
        <section className="card">
          <h2>新建红包活动</h2>
          <form onSubmit={create}>
            <label>
              红包总额（元）
              <input
                type="number"
                min="0.01"
                max="100000"
                step="0.01"
                value={total}
                onChange={(e) => setTotal(e.target.value)}
                required
              />
            </label>
            <div className="two-fields">
              <label>
                红包个数
                <input
                  type="number"
                  min="1"
                  max="10000"
                  value={count}
                  onChange={(e) => setCount(Number(e.target.value))}
                  required
                />
              </label>
              <label>
                观看门槛（秒）
                <input
                  type="number"
                  min="0"
                  max="7200"
                  value={watch}
                  onChange={(e) => setWatch(Number(e.target.value))}
                  required
                />
              </label>
            </div>
            <div className="two-fields">
              <label>
                开始倒计时（秒）
                <input
                  type="number"
                  min="0"
                  max="86400"
                  value={delay}
                  onChange={(e) => setDelay(Number(e.target.value))}
                  required
                />
              </label>
              <label>
                领取持续（秒）
                <input
                  type="number"
                  min="30"
                  max="86400"
                  value={seconds}
                  onChange={(e) => setSeconds(Number(e.target.value))}
                  required
                />
              </label>
            </div>
            <p className="fine-print">
              随机分配 · 每个浏览器会话限领一次 · 未领完的演示金额结束后自动退回
            </p>
            <button
              className="primary full"
              disabled={busy || room.status === "ended"}
            >
              <Gift size={17} />
              {busy ? "创建中…" : "创建演示活动"}
            </button>
          </form>
        </section>
        <section>
          <div className="section-title">
            <h2>活动记录</h2>
            <span className="muted">{campaigns.length} 场</span>
          </div>
          {!campaigns.length ? (
            <div className="card empty-state small">
              <Gift size={34} />
              <p>还没有红包活动</p>
            </div>
          ) : (
            campaigns.map((c) => (
              <article className="campaign card" key={c.id}>
                <div>
                  <span className="eyebrow">DEMO REWARD</span>
                  <strong>{money(c.totalCents)}</strong>
                  <p>
                    {c.count} 个随机红包 · 观看满 {c.minWatchSeconds} 秒
                  </p>
                </div>
                <div className="campaign-status">
                  <span className="pill">
                    {c.status === "closed" || now >= c.expiresAt
                      ? "已结束"
                      : now < c.opensAt
                        ? `${Math.ceil((c.opensAt - now) / 1000)} 秒后开始`
                        : c.remainingCount === 0
                          ? "已领完"
                          : "领取中"}
                  </span>
                  <p>
                    剩余 {c.remainingCount} 个 / {money(c.remainingCents)}
                  </p>
                  {c.status === "active" && (
                    <button
                      className="text-button"
                      onClick={async () => {
                        try {
                          await api(
                            `/merchant/campaigns/${c.id}/close`,
                            "POST",
                            {},
                          );
                          await refresh();
                        } catch (e) {
                          onError((e as Error).message);
                        }
                      }}
                    >
                      结束活动并退回余量
                    </button>
                  )}
                </div>
              </article>
            ))
          )}
        </section>
      </div>
      <section className="card ledger">
        <div className="section-title">
          <h2>演示账本</h2>
          <span className="muted">最近 200 笔 · 金额以整数分记账</span>
        </div>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>记录编号</th>
                <th>资金流向（演示）</th>
                <th>金额</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.createdAt).toLocaleTimeString("zh-CN")}</td>
                  <td>{e.id.slice(0, 8)}</td>
                  <td>
                    {labels[e.debit]} → {labels[e.credit]}
                  </td>
                  <td>{money(e.amountCents)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!entries.length && (
            <p className="empty-copy">
              创建活动后显示预算预留、领取与处理记录。
            </p>
          )}
        </div>
      </section>
    </>
  );
}
createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
