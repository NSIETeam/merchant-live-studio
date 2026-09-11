import { useState } from "react";
import { Share2, Clipboard, ArrowUpRight } from "lucide-react";
export function AudienceShare({ url, title }: { url: string; title: string }) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  async function share() {
    if (!navigator.share) {
      setMessage("当前浏览器不支持系统分享，请复制下方链接。");
      return;
    }
    setBusy(true);
    setMessage("");
    try {
      await navigator.share({ title, url });
      setMessage("已完成系统分享操作。");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError"))
        setMessage("系统分享未完成，请复制下方链接。");
    } finally {
      setBusy(false);
    }
  }
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setMessage("观看链接已复制。");
    } catch {
      setMessage("无法自动复制，请长按或选中下方链接复制。");
    }
  }
  return (
    <details className="audience-share">
      <summary>
        <Share2 size={16} />
        分享直播间
      </summary>
      <div className="audience-share-actions">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => void share()}
        >
          系统分享
        </button>
        <button className="secondary" onClick={() => void copy()}>
          <Clipboard size={16} />
          复制链接
        </button>
        <a className="secondary" href={url} target="_blank" rel="noreferrer">
          打开观众页
          <ArrowUpRight size={16} />
        </a>
      </div>
      <label>
        观看链接
        <input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
      </label>
      {message && <p role="status">{message}</p>}
    </details>
  );
}
