import { useState } from "react";
import { api, duration } from "../shared/api.js";
interface Recording {
  id: string;
  startedAt: number;
  completedAt: number;
  durationSeconds: number;
  bytes: number;
  sha256: string;
  registeredAt: number;
}
interface Page {
  configured: boolean;
  items: Recording[];
  nextAfter: string | null;
  ingestErrorCount: number;
}
export function RecordingsPanel({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<Page | null>(null),
    [items, setItems] = useState<Recording[]>([]),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function refresh(more = false) {
    setBusy(true);
    setError("");
    try {
      const result = await api<Page>(
        `/merchant/rooms/${roomId}/recordings` +
          (more && page?.nextAfter ? `?after=${page.nextAfter}` : ""),
      );
      setPage(result);
      setItems((old) => (more ? [...old, ...result.items] : result.items));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="card">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        录像留存
      </button>
      {open && (
        <>
          <p>
            这里只列出收到完成回执、文件校验通过的片段，不代表整场录像完整。下载前会重新核对文件。
          </p>
          {error && <p role="alert">{error}</p>}
          {page && !page.configured && (
            <p>尚未配置录像目录和完成回执队列，请联系管理员。</p>
          )}
          {Boolean(page?.ingestErrorCount) && (
            <p role="alert">
              本商家有 {page!.ingestErrorCount}{" "}
              个录像登记异常，请管理员检查隔离队列。
            </p>
          )}
          <button disabled={busy} onClick={() => void refresh()}>
            刷新录像列表
          </button>
          {!items.length && <p>暂无已登记录像片段。</p>}
          {items.map((item) => (
            <article key={item.id}>
              <h3>{new Date(item.startedAt).toLocaleString()}</h3>
              <p>
                {duration(Math.round(item.durationSeconds))} ·{" "}
                {(item.bytes / 1048576).toFixed(2)} MiB
              </p>
              <p style={{ overflowWrap: "anywhere" }}>SHA-256：{item.sha256}</p>
              <a
                href={`${import.meta.env.BASE_URL}api/merchant/recordings/${item.id}/download`}
                target="_blank"
                rel="noreferrer"
              >
                校验并下载片段
              </a>
            </article>
          ))}
          {page?.nextAfter && (
            <button disabled={busy} onClick={() => void refresh(true)}>
              更早录像
            </button>
          )}
        </>
      )}
    </section>
  );
}
