import { Notice } from "../shared/Notice.js";
import React, { useCallback, useEffect, useState } from "react";
import { Activity, ArrowUpRight, Check, ChevronDown, Copy, Gift, Link, MessageCircle, Radio, RefreshCw, Settings, Users, Video, X } from "lucide-react";
import type { Analytics, Campaign, Claim, Question, Room, StreamConfig, StreamState } from "../../shared/types.js";
import { api, duration, money } from "../shared/api.js";
import { useClock } from "../shared/useClock.js";
import { LedgerPanel } from "../payments/LedgerPanel.js";
export function Questions({
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
export function Rewards({
  room,
  onError,
}: {
  room: Room;
  onError: (m: string) => void;
}) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [total, setTotal] = useState("100"),
    [count, setCount] = useState(20),
    [watch, setWatch] = useState(10),
    [delay, setDelay] = useState(10),
    [seconds, setSeconds] = useState(600),
    [busy, setBusy] = useState(false);
  const [clockOffset, setClockOffset] = useState(0);
  const now = useClock() + clockOffset;
  const refresh = useCallback(async () => {
    const c = await api<{ campaigns: Campaign[]; serverTime: number }>(
      `/merchant/rooms/${room.id}/campaigns`,
    );
    setCampaigns(c.campaigns);
    setClockOffset(c.serverTime - Date.now());
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
      <LedgerPanel key={room.id} roomId={room.id} />
    </>
  );
}
