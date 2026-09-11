import { useEffect, useState } from "react";
import type { BindingHistoryEntry } from "../../shared/content-diff.js";
import "../review/review-history.css";
import { api } from "../shared/api.js";

export function BindingHistory({ roomId }: { roomId: string }) {
  const [open, setOpen] = useState(false),
    [refresh, setRefresh] = useState(0);
  const [cursor, setCursor] = useState<number | null>(null),
    [next, setNext] = useState<number | null>(null);
  const [entries, setEntries] = useState<BindingHistoryEntry[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setBusy(true);
    setError("");
    if (!cursor) setEntries([]);
    api<{ history: BindingHistoryEntry[]; nextBefore: number | null }>(
      `/merchant/content/rooms/${encodeURIComponent(roomId)}/binding-history${cursor ? `?before=${cursor}` : ""}`,
    )
      .then((data) => {
        if (alive) {
          setEntries((old) =>
            cursor
              ? [
                  ...old,
                  ...data.history.filter(
                    (row) => !old.some((e) => e.id === row.id),
                  ),
                ]
              : data.history,
          );
          setNext(data.nextBefore);
        }
      })
      .catch((e) => {
        if (alive) setError(e.message);
      })
      .finally(() => {
        if (alive) setBusy(false);
      });
    return () => {
      alive = false;
    };
  }, [roomId, open, cursor, refresh]);
  return (
    <details
      className="binding-history"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>讲稿绑定记录</summary>
      {open && (
        <div>
          <p>记录这个直播间绑定过的稿件；绑定记录不代表已经实际开播或播讲。</p>
          <button
            className="secondary"
            disabled={busy}
            onClick={() => {
              setCursor(null);
              setRefresh((n) => n + 1);
            }}
          >
            刷新绑定记录
          </button>
          {error && <p role="alert">{error}</p>}
          {!busy && !error && !entries.length && <p>尚无讲稿绑定记录。</p>}
          <ol>
            {entries.map((row) => (
              <li key={row.id}>
                <strong>
                  {row.courseTitle} · 讲稿 V{row.scriptVersion}
                </strong>
                <p>
                  {row.productName} ·{" "}
                  {new Date(row.boundAt).toLocaleString("zh-CN")}
                </p>
                <small>
                  {row.source === "legacy_snapshot"
                    ? "升级时保留的原有绑定，操作者及更早记录未保存"
                    : `操作账号：${row.actorId}`}
                </small>
                <p>
                  {row.source === "legacy_snapshot"
                    ? "迁移时直播间"
                    : "绑定时直播间"}
                  ：{row.roomTitle}
                </p>
              </li>
            ))}
          </ol>
          {busy && <p role="status">正在读取绑定记录…</p>}
          {next && !error && (
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setCursor(next)}
            >
              加载更早记录
            </button>
          )}
        </div>
      )}
    </details>
  );
}
