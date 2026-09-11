import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "./api.js";
import {
  redemptionNames,
  pointReasons,
  type EngagementState,
  type EngagementProgram,
  type EngagementGift,
  type Redemption,
} from "../shared/engagement.js";
export function ViewerEngagement({
  roomId,
  watch,
  counting,
}: {
  roomId: string;
  watch: number;
  counting: boolean;
}) {
  const [data, setData] = useState<EngagementState | null>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [selected, setSelected] = useState<EngagementGift | null>(null);
  const requestKeys = useRef(new Map<string, string>()),
    base = `/viewer/rooms/${roomId}/engagement`;
  const refresh = useCallback(async () => {
    setData(await api<EngagementState>(base));
  }, [base]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  const p = data?.program;
  return (
    <section className="engagement-panel">
      <h3>签到与积分</h3>
      <p>
        积分仅用于本商家的礼品兑换，不可提现。当前使用匿名浏览器身份，清除登录数据后可能无法找回积分与领取码。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {data && (
        <>
          <strong>可用积分：{data.balance}</strong>
          <p>{data.day} · 上海时间 · 每个直播间每天一次</p>
          {p?.enabled ? (
            <>
              <p>
                本场累计观看满 {p.minWatchSeconds} 秒，签到获得 {p.points}{" "}
                积分；每日最多 {p.dailyLimit} 个名额。
              </p>
              <button
                disabled={
                  busy ||
                  !!data.checkin ||
                  !counting ||
                  watch < p.minWatchSeconds
                }
                onClick={() =>
                  void act(async () => {
                    const result = await api<{ points: number }>(
                      base + "/checkin",
                      "POST",
                      {},
                    );
                    setNotice(`今日已签到，获得 ${result.points} 积分。`);
                  })
                }
              >
                {data.checkin
                  ? `今日已签到 +${data.checkin.points}`
                  : watch < p.minWatchSeconds
                    ? "继续观看后签到"
                    : !counting
                      ? "播放直播后签到"
                      : "今日签到"}
              </button>
            </>
          ) : (
            <p>当前直播间尚未开放签到。</p>
          )}
          <details>
            <summary>积分礼品（{data.gifts.length}）</summary>
            {data.gifts.map((g) => (
              <div key={g.id}>
                <h4>{g.title}</h4>
                <p>{g.description}</p>
                <p>
                  {g.points} 积分 · 剩余 {g.stock} 件
                </p>
                <button
                  disabled={busy || g.stock < 1 || data.balance < g.points}
                  onClick={() => {
                    setSelected(g);
                    setNotice("");
                  }}
                >
                  选择兑换
                </button>
              </div>
            ))}
            {selected && (
              <div role="group" aria-label="确认积分兑换">
                <p>
                  确认扣除 {selected.points} 积分兑换「{selected.title}
                  」？待领取时可以取消并返还积分。
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    void act(async () => {
                      let key = requestKeys.current.get(selected.id);
                      if (!key) {
                        key = crypto.randomUUID();
                        requestKeys.current.set(selected.id, key);
                      }
                      await api(base + "/redeem", "POST", {
                        giftId: selected.id,
                        idempotencyKey: key,
                      });
                      requestKeys.current.delete(selected.id);
                      setSelected(null);
                      setNotice("已预留礼品，请在下方我的兑换中查看领取码。");
                    })
                  }
                >
                  确认扣积分兑换
                </button>
                <button disabled={busy} onClick={() => setSelected(null)}>
                  暂不兑换
                </button>
              </div>
            )}
          </details>
          <details>
            <summary>我的兑换（最近 100 条）</summary>
            {data.redemptions.map((r) => (
              <div key={r.id}>
                <p>
                  {r.title} · {r.points} 积分 · {redemptionNames[r.state]}
                </p>
                {r.state === "reserved" && (
                  <>
                    <p>
                      向商家出示领取码：<code>{r.code}</code>
                    </p>
                    <p>兑换编号：{r.id}</p>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void act(async () => {
                          await api(
                            base + "/redemptions/" + r.id + "/cancel",
                            "POST",
                            {},
                          );
                          setNotice("已取消，积分已返还。");
                        })
                      }
                    >
                      取消并退回积分
                    </button>
                  </>
                )}
              </div>
            ))}
          </details>
          <details>
            <summary>积分明细（最近 100 条）</summary>
            {data.ledger.map((l, i) => (
              <p key={l.referenceId + l.reason + i}>
                {pointReasons[l.reason as keyof typeof pointReasons] ||
                  l.reason}{" "}
                · {l.delta > 0 ? "+" : ""}
                {l.delta} · {new Date(l.createdAt).toLocaleString()}
              </p>
            ))}
          </details>
        </>
      )}
      <button disabled={busy} onClick={() => void act(async () => {})}>
        刷新积分与礼品
      </button>
    </section>
  );
}
export function MerchantEngagement({
  roomId,
  editable,
  view = "checkin",
  hidden = false,
  panelId,
  labelledBy,
}: {
  roomId: string;
  editable: boolean;
  view?: "checkin" | "gifts";
  hidden?: boolean;
  panelId?: string;
  labelledBy?: string;
}) {
  const base = "/merchant/engagement";
  const [showEditor, setShowEditor] = useState(false);
  const [program, setProgram] = useState<EngagementProgram | null>(null),
    [gifts, setGifts] = useState<EngagementGift[]>([]),
    [redemptions, setRedemptions] = useState<Redemption[]>([]),
    [next, setNext] = useState<number | null>(null),
    [checkins, setCheckins] = useState(0),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [editing, setEditing] = useState<EngagementGift | null>(null),
    [events, setEvents] = useState<
      {
        state: Redemption["state"];
        actorId: string;
        note: string;
        createdAt: number;
      }[]
    >([]);
  const [enabled, setEnabled] = useState(false),
    [points, setPoints] = useState(10),
    [watch, setWatch] = useState(60),
    [limit, setLimit] = useState(100);
  const refresh = useCallback(async () => {
    const [p, g, r] = await Promise.all([
      api<{ program: EngagementProgram | null; checkins: number }>(
        base + "/rooms/" + roomId,
      ),
      api<{ gifts: EngagementGift[] }>(base + "/gifts"),
      api<{ redemptions: Redemption[]; nextBefore: number | null }>(
        base + "/redemptions",
      ),
    ]);
    setProgram(p.program);
    setCheckins(p.checkins);
    setEnabled(!!p.program?.enabled);
    setPoints(p.program?.points ?? 10);
    setWatch(p.program?.minWatchSeconds ?? 60);
    setLimit(p.program?.dailyLimit ?? 100);
    setGifts(g.gifts);
    setRedemptions(r.redemptions);
    setNext(r.nextBefore);
  }, [roomId]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作失败");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section
      className="card engagement-panel"
      role="tabpanel"
      tabIndex={0}
      id={panelId}
      aria-labelledby={labelledBy}
      hidden={hidden}
    >
      <h2>{view === "checkin" ? "签到与积分" : "礼品与核销"}</h2>
      <p>
        积分与现金红包独立记账，礼品需人工交付核销。匿名会话不能识别同一个人换浏览器领取；上线真实活动前需接入正式身份与防刷策略。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <div hidden={view !== "checkin"}>
        <p>当前直播间今日签到：{checkins} 次（上海时间）</p>
        {editable ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(base + "/rooms/" + roomId, "POST", {
                  previousVersion: program?.version || 0,
                  enabled,
                  points,
                  minWatchSeconds: watch,
                  dailyLimit: limit,
                });
                setNotice("签到规则已保存，已经发放的积分保持原值。");
              });
            }}
          >
            <label>
              <input
                type="checkbox"
                checked={enabled}
                disabled={busy}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              开放签到
            </label>
            <label>
              每次签到积分
              <input
                type="number"
                min={1}
                max={10000}
                required
                value={points}
                disabled={busy}
                onChange={(e) => setPoints(Number(e.target.value))}
              />
            </label>
            <label>
              本场累计观看要求（秒）
              <input
                type="number"
                min={0}
                max={14400}
                required
                value={watch}
                disabled={busy}
                onChange={(e) => setWatch(Number(e.target.value))}
              />
            </label>
            <label>
              每日签到名额
              <input
                type="number"
                min={1}
                max={100000}
                required
                value={limit}
                disabled={busy}
                onChange={(e) => setLimit(Number(e.target.value))}
              />
            </label>
            <button disabled={busy}>保存签到规则</button>
          </form>
        ) : (
          <p>
            当前规则：{program?.enabled ? "开放" : "关闭"} ·{" "}
            {program?.points || 0} 积分 · {program?.minWatchSeconds || 0} 秒
          </p>
        )}
      </div>
      <div hidden={view !== "gifts"}>
        <details open>
          <summary>礼品与库存</summary>
          {gifts.map((g) => (
            <p key={g.id}>
              {g.title} · {g.points} 积分 · 可用库存 {g.stock} ·{" "}
              {g.enabled ? "上架" : "下架"}{" "}
              {editable && (
                <button
                  disabled={busy}
                  onClick={() => {
                    setEditing(g);
                    setShowEditor(true);
                  }}
                >
                  编辑
                </button>
              )}
            </p>
          ))}
          {editable && (
            <>
              <button
                disabled={busy}
                onClick={() => {
                  setEditing(null);
                  setShowEditor(true);
                }}
              >
                新建礼品
              </button>
              {showEditor && (
                <>
                  <button
                    disabled={busy}
                    onClick={() => {
                      setShowEditor(false);
                      setEditing(null);
                    }}
                  >
                    取消编辑
                  </button>
                  <GiftEditor
                    key={
                      editing?.id +
                      ":" +
                      editing?.version +
                      ":" +
                      editing?.stock
                    }
                    gift={editing}
                    disabled={busy}
                    save={(x) =>
                      void act(async () => {
                        if (editing)
                          await api(base + "/gifts/" + editing.id, "PATCH", {
                            ...x,
                            previousVersion: editing.version,
                            previousStock: editing.stock,
                          });
                        else await api(base + "/gifts", "POST", x);
                        setEditing(null);
                        setShowEditor(false);
                        setNotice("礼品资料已保存。");
                      })
                    }
                  />
                </>
              )}
            </>
          )}
        </details>
        <h3>礼品领取记录</h3>
        {!redemptions.length && <p className="muted">暂无领取记录。</p>}
        {redemptions.map((r) => (
          <div key={r.id}>
            <p>
              {r.title} · {r.points} 积分 · {redemptionNames[r.state]} ·{" "}
              {new Date(r.createdAt).toLocaleString()}
            </p>
            <p>兑换编号：{r.id}</p>
            {editable && r.state === "reserved" && (
              <Fulfillment
                key={r.id}
                disabled={busy}
                onFinish={(state, code, note) =>
                  void act(async () => {
                    await api(
                      base + "/redemptions/" + r.id + "/" + state,
                      "POST",
                      state === "fulfill" ? { code, note } : { note },
                    );
                    setNotice(
                      state === "fulfill"
                        ? "领取已核销。"
                        : "已取消并返还积分、恢复库存。",
                    );
                  })
                }
              />
            )}
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  setEvents(
                    (
                      await api<{ events: typeof events }>(
                        base + "/redemptions/" + r.id + "/history",
                      )
                    ).events,
                  );
                })
              }
            >
              处理历史
            </button>
          </div>
        ))}
        {next && (
          <button
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void api<{
                redemptions: Redemption[];
                nextBefore: number | null;
              }>(base + "/redemptions?before=" + next)
                .then((r) => {
                  setRedemptions((old) => [...old, ...r.redemptions]);
                  setNext(r.nextBefore);
                })
                .catch((e) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            加载更多
          </button>
        )}
        {events.length > 0 && (
          <details open>
            <summary>处理历史</summary>
            {events.map((e, i) => (
              <p key={i}>
                {redemptionNames[e.state]} · {e.actorId} · {e.note} ·{" "}
                {new Date(e.createdAt).toLocaleString()}
              </p>
            ))}
          </details>
        )}
      </div>
      <button disabled={busy} onClick={() => void act(async () => {})}>
        刷新活动数据
      </button>
    </section>
  );
}
function GiftEditor({
  gift,
  disabled,
  save,
}: {
  gift: EngagementGift | null;
  disabled: boolean;
  save: (x: {
    title: string;
    description: string;
    points: number;
    stock: number;
    enabled: boolean;
  }) => void;
}) {
  const [title, setTitle] = useState(gift?.title || ""),
    [description, setDescription] = useState(gift?.description || ""),
    [points, setPoints] = useState(gift?.points || 10),
    [stock, setStock] = useState(gift?.stock || 0),
    [enabled, setEnabled] = useState(!!gift?.enabled);
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        save({ title, description, points, stock, enabled });
      }}
    >
      <h3>{gift ? "编辑礼品" : "新建礼品"}</h3>
      <label>
        礼品名称
        <input
          maxLength={100}
          required
          disabled={disabled}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      </label>
      <label>
        领取说明
        <textarea
          maxLength={500}
          required
          disabled={disabled}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="说明实物、领取地点与方式，不收集地址或电话"
        />
      </label>
      <label>
        兑换积分
        <input
          type="number"
          min={1}
          max={1000000}
          required
          disabled={disabled}
          value={points}
          onChange={(e) => setPoints(Number(e.target.value))}
        />
      </label>
      <label>
        可用库存（不含已预留）
        <input
          type="number"
          min={0}
          max={100000}
          required
          disabled={disabled}
          value={stock}
          onChange={(e) => setStock(Number(e.target.value))}
        />
      </label>
      <label>
        <input
          type="checkbox"
          disabled={disabled}
          checked={enabled}
          onChange={(e) => setEnabled(e.target.checked)}
        />
        上架礼品
      </label>
      <button disabled={disabled}>保存礼品</button>
    </form>
  );
}
function Fulfillment({
  disabled,
  onFinish,
}: {
  disabled: boolean;
  onFinish: (state: "fulfill" | "cancel", code: string, note: string) => void;
}) {
  const [code, setCode] = useState(""),
    [note, setNote] = useState("");
  return (
    <details>
      <summary>办理领取或取消</summary>
      <label>
        观众提供的领取码
        <input
          disabled={disabled}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          maxLength={100}
        />
      </label>
      <label>
        交付说明或取消原因
        <input
          disabled={disabled}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
      </label>
      <button
        disabled={disabled || !code.trim() || !note.trim()}
        onClick={() => onFinish("fulfill", code.trim(), note.trim())}
      >
        确认已交付并核销
      </button>
      <button
        disabled={disabled || !note.trim()}
        onClick={() => onFinish("cancel", "", note.trim())}
      >
        取消并返还积分
      </button>
    </details>
  );
}
