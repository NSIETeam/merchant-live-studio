import { ModerationResults } from "./ModerationResults.js";
import { pollResource } from "../shared/poll-resource.js";
import { useEffect, useRef, useState } from "react";
import { api } from "../shared/api.js";
import {
  moderationLabels,
  type ModerationState,
} from "../../shared/moderation.js";
export function ModerationPanel({
  roomId,
  actorId,
  editable,
  onChanged,
}: {
  roomId: string;
  actorId: string;
  editable: boolean;
  onChanged?: () => Promise<void>;
}) {
  const [state, setState] = useState<ModerationState | null>(null),
    [kind, setKind] = useState<"note" | "stop" | "release">("note"),
    [note, setNote] = useState(""),
    [evidence, setEvidence] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID()),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [expanded, setExpanded] = useState(false),
    [history, setHistory] = useState<ModerationState["items"]>([]),
    [before, setBefore] = useState<number | null>(null);
  const polling = useRef<ReturnType<typeof pollResource> | null>(null);
  const base = `/merchant/rooms/${roomId}/moderation`;
  async function refresh() {
    const value = await api<ModerationState>(base);
    setState(value);
    setHistory(value.items);
    setBefore(value.nextBefore);
  }
  useEffect(() => {
    const task = pollResource<ModerationState>({
      read: signal => api<ModerationState>(base, "GET", undefined, { signal }),
      onValue: value => { setState(value); setError(""); },
      onError: e => { setState(null); setError(e.message); },
      intervalMs: 5000,
      timeoutMs: 8000,
      timeoutMessage: "现场处置状态核对超时，请检查网络后重试。",
    });
    polling.current = task;
    return () => { task.stop(); polling.current = null; };
  }, [base]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    polling.current?.pause();
    setBusy(true);
    setError("");
    try {
      await fn();
      await refresh();
      await onChanged?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      polling.current?.refresh();
    }
  }
  const hold = state?.hold,
    releaseAllowed =
      hold &&
      !hold.processing &&
      hold.result?.disconnected === 1 &&
      hold.actorId !== actorId;
  return (
    <section
      className={`card live-moderation ${hold ? "has-hold" : ""}`}
      aria-label="现场处置状态"
    >
      <h2>现场处置</h2>
      {error && <p role="alert">{error}</p>}
      {hold ? (
        <div role="alert">
          <strong>本直播间已暂停，重新开播已锁定</strong>
          <p>{hold.note}</p>
          <p>
            {hold.processing
              ? "正在执行断流…"
              : hold.result?.disconnected === 1
                ? "控制服务确认无推流源；恢复前仍需复核现场整改。"
                : hold.result?.message || "尚未获得断流结果，请重试处置。"}
          </p>
          {editable && (
            <button
              disabled={busy || hold.processing}
              onClick={() =>
                void act(async () => {
                  await api(`${base}/${hold.id}/retry`, "POST", {});
                })
              }
            >
              重试断流
            </button>
          )}
        </div>
      ) : (
        <p>{state ? "暂无待解除的暂停记录。发现异常可记录并暂停直播。" : "尚未确认现场处置状态，正在重新核对。"}</p>
      )}
      <details className="moderation-tools">
        <summary>记录问题与查看处置历史</summary>
        {editable && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void act(async () => {
                await api(base, "POST", {
                  kind,
                  note,
                  evidenceReference: evidence,
                  idempotencyKey: key,
                  ...(kind === "release" ? { holdId: hold?.id } : {}),
                });
                setNote("");
                setEvidence("");
                setKey(crypto.randomUUID());
                setKind("note");
              });
            }}
          >
            <label>
              处置方式
              <select
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as typeof kind);
                  setKey(crypto.randomUUID());
                }}
              >
                {Object.entries(moderationLabels).map(([v, title]) => (
                  <option key={v} value={v}>
                    {title}
                  </option>
                ))}
              </select>
            </label>
            <label>
              问题、现场更正或复核说明
              <textarea
                required
                minLength={5}
                maxLength={2000}
                value={note}
                onChange={(e) => {
                  setNote(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </label>
            <label>
              内部证据位置（选填）
              <input
                maxLength={1000}
                value={evidence}
                onChange={(e) => {
                  setEvidence(e.target.value);
                  setKey(crypto.randomUUID());
                }}
              />
            </label>
            {kind === "stop" && (
              <p>
                提交后立即结束本场、更新推流密钥并尝试断流。另一账号复核解除前不能重新开播。
              </p>
            )}
            {kind === "release" && (
              <p>
                须先确认断流成功，再由另一审核或管理员账号复核。解除仅恢复开播资格，不会自动开播。
              </p>
            )}
            <button
              className={kind === "stop" ? "danger" : ""}
              disabled={
                busy ||
                note.trim().length < 5 ||
                (kind === "stop" && Boolean(hold)) ||
                (kind === "release" && !releaseAllowed)
              }
            >
              {busy ? "处理中…" : moderationLabels[kind]}
            </button>
          </form>
        )}
        <button
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) void act(async () => {});
          }}
        >
          查看处置记录
        </button>
        {expanded && (
          <>
            {history.map((item) => (
              <article key={item.id}>
                <strong>
                  {moderationLabels[item.kind]} · {item.actorId}
                </strong>
                <p>
                  {new Date(item.createdAt).toLocaleString()} · {item.note}
                </p>
                {item.evidenceReference && (
                  <p>依据：{item.evidenceReference}</p>
                )}
                {item.result && <p>断流结果：{item.result.message}</p>}
                {item.kind === "stop" && <ModerationResults key={`${roomId}-${item.id}`} roomId={roomId} actionId={item.id} />}
              </article>
            ))}
            {before && (
              <button
                disabled={busy}
                onClick={async () => {
                  try {
                    const next = await api<ModerationState>(
                      base + `?before=${before}`,
                    );
                    setHistory((old) => [...old, ...next.items]);
                    setBefore(next.nextBefore);
                  } catch (e) {
                    setError((e as Error).message);
                  }
                }}
              >
                更早记录
              </button>
            )}
          </>
        )}
      </details>
    </section>
  );
}
