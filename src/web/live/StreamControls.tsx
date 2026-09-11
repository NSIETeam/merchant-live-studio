import { Clipboard } from "lucide-react";
import React, { useCallback, useEffect, useState } from "react";
import { Activity, ArrowUpRight, Check, ChevronDown, Copy, Gift, Link, MessageCircle, Radio, RefreshCw, Settings, Users, Video, X } from "lucide-react";
import type { Analytics, Campaign, Claim, Question, Room, StreamConfig, StreamState } from "../../shared/types.js";
import { api, duration, money } from "../shared/api.js";
import { useClock } from "../shared/useClock.js";
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
export function Signal({ roomId }: { roomId: string }) {
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
export function StreamSettings({
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
