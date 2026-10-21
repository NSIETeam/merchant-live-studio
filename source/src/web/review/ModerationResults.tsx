import { useState } from "react";
import { api } from "../shared/api.js";
import type { ModerationResult } from "../../shared/moderation.js";
type Page = { items: ModerationResult[]; nextBefore: number | null };
export function ModerationResults({ roomId, actionId }: { roomId: string; actionId: number }) {
  const [page, setPage] = useState<Page | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const base = `/merchant/rooms/${encodeURIComponent(roomId)}/moderation/${actionId}/results`;
  async function load(before?: number) {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const next = await api<Page>(base + (before ? `?before=${before}` : ""));
      setPage(old => ({ ...next, items: before && old ? [...old.items, ...next.items] : next.items }));
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  }
  return <details onToggle={e => { if (e.currentTarget.open && !page && !busy) void load(); }}>
    <summary>全部断流尝试</summary>
    {error && <p role="alert">{error}</p>}
    <button disabled={busy} onClick={() => void load()}>{busy ? "正在读取…" : "刷新执行历史"}</button>
    <a href={`${import.meta.env.BASE_URL}api${base}/export`} download>下载本次处置全部执行记录</a>
    {page?.items.length === 0 && <p>尚无执行结果。</p>}
    {page?.items.map(item => <p key={item.id}>#{item.id} · {new Date(item.createdAt).toLocaleString()} · {item.actorId} · {item.disconnected === 1 ? "确认断流" : "未确认断流"}：{item.message}</p>)}
    {page?.nextBefore && <button disabled={busy} onClick={() => void load(page.nextBefore!)}>更早执行结果</button>}
  </details>;
}
