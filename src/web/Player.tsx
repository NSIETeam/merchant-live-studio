import { useEffect, useRef, useState } from "react";
import type Hls from "hls.js";
import { Radio, Play } from "lucide-react";
export function Player({
  url,
  live,
  compact = false,
}: {
  url: string;
  live: boolean;
  compact?: boolean;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [active, setActive] = useState(false);
  const [message, setMessage] = useState("");
  useEffect(() => {
    setActive(false);
    setMessage("");
  }, [url, live]);
  useEffect(() => {
    const video = ref.current;
    if (!active || !video || !live) return;
    let hls: Hls | undefined,
      cancelled = false;
    const play = () =>
      video.play().catch(() => {
        if (!cancelled) setMessage("请点击画面中的播放按钮开始观看。");
      });
    if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = url;
      void play();
    } else
      void import("hls.js")
        .then(({ default: Hls }) => {
          if (cancelled) return;
          if (!Hls.isSupported()) {
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
            if (data.fatal && !cancelled)
              setMessage("暂未收到直播信号，请确认主播已推流后重试。");
          });
        })
        .catch(() => {
          if (!cancelled) setMessage("播放器载入失败，请刷新页面重试。");
        });
    return () => {
      cancelled = true;
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url, live, active]);
  return (
    <div className={`player ${compact ? "compact" : ""}`}>
      {active && live ? (
        <video
          ref={ref}
          controls
          playsInline
          muted
          onPlaying={() => setMessage("")}
          onError={() => setMessage("暂未收到直播信号，请确认推流与播放地址。")}
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
        <div className="player-message">
          {message}
          <button onClick={() => setActive(false)}>重试</button>
        </div>
      )}
      <span className="player-label">
        {live ? "LIVE ROOM" : "STANDBY"}
        <span>观众画面</span>
      </span>
    </div>
  );
}
