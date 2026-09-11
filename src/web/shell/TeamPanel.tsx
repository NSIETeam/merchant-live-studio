import { AccountProvisioning } from "./AccountProvisioning.js";
import { useState } from "react";
import { api } from "../shared/api.js";
import { memberRoleNames, type MemberRole } from "../../shared/membership.js";
type Member = {
  actorId: string;
  managed?: boolean;
  credentialVersion?: number;
  role: MemberRole;
  disabled: boolean;
  version: number;
};
type AccessEvent = {
  id: number;
  targetActorId: string;
  actorId: string;
  disabled: number;
  reason: string;
  version: number;
  createdAt: number;
  fromRole: MemberRole | null;
  toRole: MemberRole | null;
};
type History = { items: AccessEvent[]; nextBefore: number | null };
export function TeamPanel() {
  const [open, setOpen] = useState(false),
    [members, setMembers] = useState<Member[]>([]),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
  const [history, setHistory] = useState<History>({
    items: [],
    nextBefore: null,
  });
  const [showHistory, setShowHistory] = useState(false);
  async function loadHistory(append = false) {
    const result = await api<History>(
      "/merchant/team/events" +
        (append && history.nextBefore ? `?before=${history.nextBefore}` : ""),
    );
    setHistory((old) => ({
      items: append ? [...old.items, ...result.items] : result.items,
      nextBefore: result.nextBefore,
    }));
  }
  async function refresh() {
    setMembers((await api<{ members: Member[] }>("/merchant/team")).members);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await fn();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="home-directory">
      <button
        className="text-button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
          if (!open) void act(refresh);
        }}
      >
        团队成员管理
      </button>
      {open && (
        <>
          <p>
            停用或变更角色后，原会话立即失效，成员须重新登录。可在下方新增普通成员；配置账号的密钥仍由服务器管理。
          </p>
          <label>
            本次变更原因
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              placeholder="至少 5 个字，记录本次成员变更原因"
            />
          </label>
          <AccountProvisioning members={members} onChanged={refresh} />
          {!members.length && <p>暂无其他团队成员。</p>}
          {members.map((m) => (
            <div className="home-card" key={m.actorId}>
              <strong>
                {m.actorId} · {memberRoleNames[m.role]} ·{" "}
                {m.disabled ? "已停用" : "可用"}
              </strong>
              <RoleEditor
                key={m.version}
                member={m}
                disabled={busy || reason.trim().length < 5}
                onSave={(role) =>
                  void act(async () => {
                    await api(
                      `/merchant/team/${encodeURIComponent(m.actorId)}`,
                      "PUT",
                      {
                        role,
                        disabled: m.disabled,
                        version: m.version,
                        reason,
                      },
                    );
                    await refresh();
                    if (showHistory) await loadHistory();
                    setReason("");
                    setMessage("成员角色已更新，原会话已失效。");
                  })
                }
              />
              <button
                className="secondary"
                disabled={busy || reason.trim().length < 5}
                onClick={() =>
                  void act(async () => {
                    await api(
                      `/merchant/team/${encodeURIComponent(m.actorId)}`,
                      "PUT",
                      { disabled: !m.disabled, version: m.version, reason },
                    );
                    await refresh();
                    if (showHistory) await loadHistory();
                    setReason("");
                    setMessage("成员状态已更新，原会话已失效。");
                  })
                }
              >
                {m.disabled ? "恢复成员" : "停用成员"}
              </button>
            </div>
          ))}
          <button
            className="text-button"
            disabled={busy}
            aria-expanded={showHistory}
            onClick={() => {
              setShowHistory(!showHistory);
              if (!showHistory) void act(() => loadHistory());
            }}
          >
            成员变更历史
          </button>
          {showHistory && (
            <section aria-label="成员变更历史">
              <button
                className="text-button"
                disabled={busy}
                onClick={() => void act(() => loadHistory())}
              >
                刷新历史
              </button>
              {!history.items.length && <p>暂无变更记录。</p>}
              {history.items.map((item) => (
                <article className="team-event" key={item.id}>
                  <strong>
                    {item.targetActorId} ·{" "}
                    {item.fromRole &&
                    item.toRole &&
                    item.fromRole !== item.toRole
                      ? `${memberRoleNames[item.fromRole]} → ${memberRoleNames[item.toRole]}`
                      : item.disabled
                        ? "停用"
                        : "恢复"}
                  </strong>
                  <p>{item.reason}</p>
                  <small>
                    {new Date(item.createdAt).toLocaleString()} · 操作人{" "}
                    {item.actorId} · V{item.version}
                  </small>
                </article>
              ))}
              {history.nextBefore && (
                <button
                  className="secondary"
                  disabled={busy}
                  onClick={() => void act(() => loadHistory(true))}
                >
                  更早变更
                </button>
              )}
            </section>
          )}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}

function RoleEditor({
  member,
  disabled,
  onSave,
}: {
  member: Member;
  disabled: boolean;
  onSave: (role: MemberRole) => void;
}) {
  const [role, setRole] = useState(member.role);
  return (
    <div className="team-role-editor">
      <label>
        角色 · {member.actorId}
        <select
          value={role}
          onChange={(e) => setRole(e.target.value as MemberRole)}
        >
          {(["editor", "reviewer", "presenter", "analyst"] as const).map(
            (id) => (
              <option key={id} value={id}>
                {memberRoleNames[id]}
              </option>
            ),
          )}
        </select>
      </label>
      <button
        className="secondary"
        disabled={disabled || role === member.role}
        onClick={() => onSave(role)}
      >
        保存角色
      </button>
    </div>
  );
}
