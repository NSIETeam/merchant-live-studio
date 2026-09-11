import { useEffect, useRef, useState } from "react";
import { Player } from "./Player.js";
import { LocalCameraSession } from "./local-camera.js";
export function StudioVideo({
  url,
  live,
  canPreview,
}: {
  url: string;
  live: boolean;
  canPreview: boolean;
}) {
  const session = useRef<LocalCameraSession | null>(null);
  if (!session.current)
    session.current = new LocalCameraSession((c) =>
      navigator.mediaDevices.getUserMedia(c),
    );
  const video = useRef<HTMLVideoElement>(null);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [pending, setPending] = useState(false),
    [error, setError] = useState("");
  const [facing, setFacing] = useState<"user" | "environment">("user");
  useEffect(() => () => session.current?.stop(), []);
  useEffect(() => {
    if (live || !canPreview) {
      session.current?.stop();
      setStream(null);
      setPending(false);
    }
  }, [live, canPreview]);
  useEffect(() => {
    const element = video.current;
    if (!stream || !element) return;
    element.srcObject = stream;
    const ended = () => {
      session.current?.stop();
      setStream(null);
      setError("摄像头已断开，请检查设备后重试。");
    };
    stream
      .getVideoTracks()
      .forEach((track) => track.addEventListener("ended", ended));
    void element.play().catch(() => setError("请点击画面播放预览。"));
    return () => {
      stream
        .getVideoTracks()
        .forEach((track) => track.removeEventListener("ended", ended));
      element.srcObject = null;
    };
  }, [stream]);
  function stop() {
    session.current?.stop();
    setStream(null);
    setPending(false);
    setError("");
  }
  async function start() {
    if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
      setError("当前环境不能使用摄像头，请通过 HTTPS 或本机地址打开。");
      return;
    }
    setError("");
    setPending(true);
    try {
      const next = await session.current!.start(facing);
      if (next) {
        setStream(next);
        setPending(false);
      }
    } catch (e) {
      setPending(false);
      const name = (e as DOMException).name;
      setError(
        name === "NotAllowedError"
          ? "未获得摄像头权限，可在浏览器设置中允许后重试。"
          : name === "NotFoundError"
            ? "未找到摄像头，请连接设备后重试。"
            : "摄像头暂不可用，请检查是否被其他程序占用。",
      );
    }
  }
  return (
    <>
      {stream && !live ? (
        <div className="player local-camera-preview">
          <video
            ref={video}
            autoPlay
            muted
            playsInline
            controls
            aria-label="本机摄像头预览"
          />
          <span className="local-camera-label">本机预览 · 未推流</span>
        </div>
      ) : (
        <Player url={url} live={live} />
      )}
      {canPreview && !live && (
        <div className="camera-controls">
          <details>
            <summary>开播前检查摄像头</summary>
            <p className="muted">
              仅在本机预览，不录音、不录像、不推流。正式直播仍使用下方推流配置。
            </p>
            <label>
              摄像头方向
              <select
                value={facing}
                disabled={pending || !!stream}
                onChange={(e) =>
                  setFacing(e.target.value as "user" | "environment")
                }
              >
                <option value="user">前置 / 默认摄像头</option>
                <option value="environment">后置摄像头（设备支持时）</option>
              </select>
            </label>
            {!stream && !pending ? (
              <button className="secondary" onClick={() => void start()}>
                开启本机预览
              </button>
            ) : (
              <button className="secondary" onClick={stop}>
                {pending ? "取消摄像头请求" : "关闭本机预览"}
              </button>
            )}
            {pending && <p role="status">请在浏览器中处理摄像头权限请求。</p>}
            {error && <p role="alert">{error}</p>}
          </details>
        </div>
      )}
    </>
  );
}
