import { useState } from "react";
import { api } from "./api.js";
import { memberRoleNames, type MemberRole } from "../shared/membership.js";
type Member = {
  actorId: string;
  role: MemberRole;
  disabled: boolean;
  version: number;
};
export function TeamPanel() {
  const [open, setOpen] = useState(false),
    [members, setMembers] = useState<Member[]>([]),
    [reason, setReason] = useState(""),
    [busy, setBusy] = useState(false),
    [message, setMessage] = useState("");
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
            停用立即阻止登录并使现有会话失效。恢复后须重新登录。新增成员与角色调整仍通过服务器配置。
          </p>
          <label>
            本次变更原因
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={1000}
              placeholder="至少 5 个字，记录停用或恢复的原因"
            />
          </label>
          {!members.length && <p>没有配置其他团队成员。</p>}
          {members.map((m) => (
            <div className="home-card" key={m.actorId}>
              <strong>
                {m.actorId} · {memberRoleNames[m.role]} ·{" "}
                {m.disabled ? "已停用" : "可用"}
              </strong>
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
                    setReason("");
                    setMessage("成员状态已更新，原会话已失效。");
                  })
                }
              >
                {m.disabled ? "恢复成员" : "停用成员"}
              </button>
            </div>
          ))}
        </>
      )}
      {message && <p role="status">{message}</p>}
    </section>
  );
}
