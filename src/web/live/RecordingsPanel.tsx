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
  deleted: number;
}
interface Page {
  configured: boolean;
  items: Recording[];
  nextAfter: string | null;
  ingestErrorCount: number;
}

interface Retention {
  recordingId: string;
  policyConfigured: boolean;
  liveContentDays: number | null;
  eligibleAt: number | null;
  roomStatus: string;
  openDispute: boolean;
  deleted: boolean;
  deletionBlockers: string[];
  permissions: {
    canManageHold: boolean;
    canRequestDeletion: boolean;
    canReviewDeletion: boolean;
    actorId: string;
  };
  holds: Array<{
    id: string;
    kind: "dispute" | "regulatory" | "business";
    reason: string;
    createdBy: string;
    version: number;
    state: "active" | "released";
    note: string;
  }>;
  requests: Array<{
    id: string;
    reason: string;
    requestedBy: string;
    version: number;
    state:
      "requested" | "approved" | "rejected" | "deleting" | "deleted" | "failed";
    note: string;
  }>;
}

const holdKind = {
  dispute: "争议保留",
  regulatory: "监管调取保留",
  business: "业务核查保留",
};
const requestState = {
  requested: "等待复核",
  approved: "已批准，待执行",
  rejected: "已退回",
  deleting: "删除执行中",
  deleted: "已删除文件",
  failed: "执行失败，等待核对",
};

function RetentionControls({
  recordingId,
  onDeleted,
}: {
  recordingId: string;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(false),
    [data, setData] = useState<Retention | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [holdType, setHoldType] = useState<keyof typeof holdKind>("dispute"),
    [holdReason, setHoldReason] = useState(""),
    [actionNote, setActionNote] = useState(""),
    [deletionReason, setDeletionReason] = useState("");
  const base = `/merchant/recordings/${recordingId}`;
  async function refresh() {
    setBusy(true);
    setError("");
    try {
      setData(await api<Retention>(base + "/retention"));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function mutate(path: string, body: unknown) {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ retention: Retention }>(path, "POST", body);
      setData(result.retention);
      if (result.retention.deleted) onDeleted();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }
  const activeHolds =
    data?.holds.filter((item) => item.state === "active") ?? [];
  const releasedHolds =
    data?.holds.filter((item) => item.state === "released") ?? [];
  const eligible = Boolean(
    data && !data.deletionBlockers.length && !data.deleted,
  );
  return (
    <div className="recording-retention">
      <button
        className="text-button"
        onClick={() => {
          setOpen(!open);
          if (!open) void refresh();
        }}
      >
        {open ? "收起保留与删除" : "保留与删除记录"}
      </button>
      {open && (
        <div className="recording-retention-body">
          {busy && !data && <p>正在读取保留状态…</p>}
          {error && <p role="alert">{error}</p>}
          {data && (
            <>
              <p>
                {data.policyConfigured
                  ? `公开保存期限：${data.liveContentDays} 天；最早删除时间：${new Date(data.eligibleAt!).toLocaleString()}`
                  : "尚未配置并核验录像保存期限，禁止删除。"}
              </p>
              {data.roomStatus !== "ended" && (
                <p>直播尚未结束，禁止申请删除。</p>
              )}
              {data.openDispute && (
                <p role="alert">直播间存在未解决投诉或申诉，录像已自动保护。</p>
              )}
              {data.deleted && (
                <p>录像文件已按复核流程删除，登记和审计记录继续保留。</p>
              )}

              <h4>有效保留</h4>
              {!activeHolds.length && <p>当前没有主动保留。</p>}
              {activeHolds.map((hold) => (
                <div className="retention-entry" key={hold.id}>
                  <strong>{holdKind[hold.kind]}</strong>
                  <p>{hold.reason}</p>
                  {data.permissions.canManageHold &&
                    hold.createdBy !== data.permissions.actorId && (
                      <button
                        disabled={busy || actionNote.trim().length < 8}
                        onClick={() =>
                          void mutate(
                            `${base}/retention/holds/${hold.id}/release`,
                            { previousVersion: hold.version, note: actionNote },
                          ).then((ok) => ok && setActionNote(""))
                        }
                      >
                        复核并释放保留
                      </button>
                    )}
                </div>
              ))}
              {releasedHolds.length > 0 && (
                <details>
                  <summary>已释放保留（{releasedHolds.length}）</summary>
                  {releasedHolds.map((hold) => (
                    <div className="retention-entry" key={hold.id}>
                      <strong>{holdKind[hold.kind]} · 已释放</strong>
                      <p>{hold.reason}</p>
                      <p>{hold.note}</p>
                    </div>
                  ))}
                </details>
              )}
              {data.permissions.canManageHold && !data.deleted && (
                <div className="retention-form">
                  <label>
                    保留类型
                    <select
                      value={holdType}
                      onChange={(e) =>
                        setHoldType(e.target.value as keyof typeof holdKind)
                      }
                    >
                      {Object.entries(holdKind).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    保留理由
                    <textarea
                      value={holdReason}
                      maxLength={1000}
                      onChange={(e) => setHoldReason(e.target.value)}
                      placeholder="说明争议、调取或业务核查依据"
                    />
                  </label>
                  <button
                    disabled={busy || holdReason.trim().length < 8}
                    onClick={() =>
                      void mutate(`${base}/retention/holds`, {
                        kind: holdType,
                        reason: holdReason,
                        idempotencyKey: crypto.randomUUID(),
                      }).then((ok) => ok && setHoldReason(""))
                    }
                  >
                    建立录像保留
                  </button>
                </div>
              )}

              <h4>删除复核</h4>
              {!data.requests.length && <p>暂无删除申请。</p>}
              {data.requests.map((request) => (
                <div className="retention-entry" key={request.id}>
                  <strong>{requestState[request.state]}</strong>
                  <p>{request.reason}</p>
                  <p>{request.note}</p>
                  {data.permissions.canReviewDeletion &&
                    ["requested", "failed", "approved", "deleting"].includes(
                      request.state,
                    ) &&
                    request.requestedBy !== data.permissions.actorId && (
                      <div className="retention-actions">
                        <button
                          disabled={busy || actionNote.trim().length < 8}
                          onClick={() =>
                            void mutate(
                              `${base}/deletion-requests/${request.id}/review`,
                              {
                                previousVersion: request.version,
                                decision: "approve",
                                note: actionNote,
                              },
                            ).then((ok) => ok && setActionNote(""))
                          }
                        >
                          复核并执行删除
                        </button>
                        {request.state === "requested" && (
                          <button
                            className="secondary"
                            disabled={busy || actionNote.trim().length < 8}
                            onClick={() =>
                              void mutate(
                                `${base}/deletion-requests/${request.id}/review`,
                                {
                                  previousVersion: request.version,
                                  decision: "reject",
                                  note: actionNote,
                                },
                              ).then((ok) => ok && setActionNote(""))
                            }
                          >
                            退回申请
                          </button>
                        )}
                      </div>
                    )}
                </div>
              ))}
              {(activeHolds.some(
                (hold) => hold.createdBy !== data.permissions.actorId,
              ) ||
                data.requests.some(
                  (request) =>
                    data.permissions.canReviewDeletion &&
                    ["requested", "failed", "approved", "deleting"].includes(
                      request.state,
                    ),
                )) && (
                <label>
                  复核说明
                  <textarea
                    value={actionNote}
                    maxLength={1000}
                    onChange={(e) => setActionNote(e.target.value)}
                    placeholder="至少 8 个字，说明释放、批准或退回依据"
                  />
                </label>
              )}
              {data.permissions.canRequestDeletion && !data.deleted && (
                <div className="retention-form">
                  <label>
                    删除申请理由
                    <textarea
                      value={deletionReason}
                      maxLength={1000}
                      onChange={(e) => setDeletionReason(e.target.value)}
                      placeholder="说明期限和删除范围"
                    />
                  </label>
                  <button
                    disabled={
                      busy || !eligible || deletionReason.trim().length < 8
                    }
                    onClick={() =>
                      void mutate(`${base}/deletion-requests`, {
                        reason: deletionReason,
                        idempotencyKey: crypto.randomUUID(),
                      }).then((ok) => ok && setDeletionReason(""))
                    }
                  >
                    提交删除复核
                  </button>
                  {!eligible && !data.deleted && (
                    <p>
                      {data.deletionBlockers.length
                        ? `当前不能提交：${data.deletionBlockers.join("；")}。`
                        : "当前不能提交删除申请。"}
                    </p>
                  )}
                </div>
              )}
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void refresh()}
              >
                刷新保留状态
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
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
              {item.deleted ? (
                <p>录像文件已按复核流程删除。</p>
              ) : (
                <a
                  href={`${import.meta.env.BASE_URL}api/merchant/recordings/${item.id}/download`}
                  target="_blank"
                  rel="noreferrer"
                >
                  校验并下载片段
                </a>
              )}
              <RetentionControls
                recordingId={item.id}
                onDeleted={() =>
                  setItems((old) =>
                    old.map((row) =>
                      row.id === item.id ? { ...row, deleted: 1 } : row,
                    ),
                  )
                }
              />
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
