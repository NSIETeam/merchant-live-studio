import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { Radio, Play } from "lucide-react";
export function Player({
  url,
  live,
  compact = false,
  onPlayback,
}: {
  url: string;
  live: boolean;
  compact?: boolean;
  onPlayback?: (playing: boolean) => void;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const callback = useRef(onPlayback);
  callback.current = onPlayback;
  const [active, setActive] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [phase, setPhase] = useState<
    "connecting" | "playing" | "buffering" | "paused" | "ended" | "error"
  >("connecting");
  const [message, setMessage] = useState("");
  useEffect(() => {
    setActive(false);
    setPhase("connecting");
    setMessage("");
  }, [url, live]);
  useEffect(() => {
    if (!active || !live || (phase !== "connecting" && phase !== "buffering"))
      return;
    const timeout = setTimeout(() => {
      callback.current?.(false);
      setPhase("error");
      setMessage("长时间未收到可播放画面，请检查网络或重新连接。");
    }, 15000);
    return () => clearTimeout(timeout);
  }, [active, live, phase, attempt]);
  useEffect(() => {
    const video = ref.current;
    if (!active || !video || !live) return;
    let hls: Hls | undefined,
      cancelled = false;
    const play = () =>
      video.play().catch(() => {
        if (!cancelled) {
          setPhase("paused");
          setMessage("请点击画面中的播放按钮开始观看。");
        }
      });
    // Some Chromium versions advertise native HLS but cannot play all TS streams.
    // Prefer MSE playback; retain native HLS for browsers without MSE support.
    void import("hls.js")
      .then(({ default: Hls }) => {
        if (cancelled) return;
        if (!Hls.isSupported()) {
          if (video.canPlayType("application/vnd.apple.mpegurl")) {
            video.src = url;
            void play();
            return;
          }
          setPhase("error");
          setMessage(
            "当前浏览器暂不支持 HLS 播放，请使用 Safari 或更新浏览器。",
          );
          return;
        }
        hls = new Hls({ maxBufferLength: 20 });
        hls.loadSource(url);
        hls.attachMedia(video);
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          void play();
        });
        hls.on(Hls.Events.ERROR, (_, data) => {
          if (data.fatal && !cancelled) {
            callback.current?.(false);
            setPhase("error");
            setMessage("暂未收到直播信号，请确认主播已推流后重试。");
          }
        });
      })
      .catch(() => {
        if (!cancelled) {
          setPhase("error");
          setMessage("播放器载入失败，请重新连接。");
        }
      });
    return () => {
      cancelled = true;
      callback.current?.(false);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, live, active, attempt]);
  return (
    <div className={`player ${compact ? "compact" : ""}`}>
      {active && live ? (
        <video
          ref={ref}
          key={`${url}:${attempt}`}
          controls
          playsInline
          muted
          onPlaying={() => {
            setPhase("playing");
            setMessage("");
            callback.current?.(true);
          }}
          onPause={() => {
            setPhase("paused");
            callback.current?.(false);
          }}
          onWaiting={() => {
            setPhase("buffering");
            callback.current?.(false);
          }}
          onStalled={() => {
            setPhase("buffering");
            callback.current?.(false);
          }}
          onEnded={() => {
            setPhase("ended");
            setMessage("直播信号已结束，可以重新连接检查当前画面。");
            callback.current?.(false);
          }}
          onError={() => {
            setPhase("error");
            callback.current?.(false);
            setMessage("暂未收到直播信号，请确认推流与播放地址。");
          }}
        />
      ) : (
        <div className="player-empty">
          <div className="signal-icon">
            <Radio size={32} />
          </div>
          <h3>{live ? "直播间已开放" : "等待主播开播"}</h3>
          <p>{live ? "点击连接直播信号" : "开播后，在这里观看直播"}</p>
          {live && (
            <button
              className="primary"
              onClick={() => {
                setMessage("");
                setPhase("connecting");
                setActive(true);
              }}
            >
              <Play size={16} />
              连接直播
            </button>
          )}
        </div>
      )}
      {message && (
        <div className="player-message" role="status">
          {message}
          <button
            onClick={() => {
              setMessage("");
              setPhase("connecting");
              setAttempt((value) => value + 1);
            }}
          >
            重新连接
          </button>
        </div>
      )}
      <span className="player-label">
        {!live
          ? "等待开播"
          : !active
            ? "尚未连接"
            : {
                connecting: "连接中",
                playing: "画面播放中",
                buffering: "正在缓冲",
                paused: "已暂停",
                ended: "信号结束",
                error: "连接异常",
              }[phase]}
        <span>观众画面</span>
      </span>
    </div>
  );
}
