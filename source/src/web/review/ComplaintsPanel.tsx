import { useState } from "react";
import { api } from "../shared/api.js";
import {
  complaintAppealStates,
  complaintCategories,
  complaintStates,
  type Complaint,
  type ComplaintPage,
} from "../../shared/complaints.js";
import type { MemberRole } from "../../shared/membership.js";
export function ComplaintsPanel({
  roomId,
  merchant = false,
  role,
}: {
  roomId: string;
  merchant?: boolean;
  role?: MemberRole;
}) {
  const [items, setItems] = useState<Complaint[]>([]),
    [after, setAfter] = useState<string | null>(null),
    [body, setBody] = useState(""),
    [category, setCategory] = useState("content"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [opened, setOpened] = useState(false),
    [key, setKey] = useState(() => crypto.randomUUID());
  const base = merchant
    ? `/merchant/complaints/rooms/${roomId}`
    : `/viewer/rooms/${roomId}/complaints`;
  async function refresh(more = false) {
    const page = await api<ComplaintPage>(
      base + (more && after ? `?after=${after}` : ""),
    );
    setItems((old) => (more ? [...old, ...page.items] : page.items));
    setAfter(page.nextAfter);
  }
  async function act(fn: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await fn();
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
          setOpened(!opened);
          if (!opened) void act(() => refresh());
        }}
      >
        {merchant ? "投诉受理与回执" : "投诉举报与处理结果"}
      </button>
      {opened && (
        <div className="complaints-body">
          <p>
            提交内容仅供处理人员核查。请勿填写身份证、银行卡等敏感信息。可在此查询回执；清除浏览器会话后暂不能找回记录。
          </p>
          {error && <p role="alert">{error}</p>}
          {!merchant && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api(base, "POST", {
                    category,
                    body,
                    idempotencyKey: key,
                  });
                  setBody("");
                  setKey(crypto.randomUUID());
                  await refresh();
                });
              }}
            >
              <label>
                问题类型
                <select
                  value={category}
                  onChange={(e) => {
                    setCategory(e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                >
                  {Object.entries(complaintCategories).map(([v, t]) => (
                    <option key={v} value={v}>
                      {t}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                问题描述
                <textarea
                  required
                  minLength={5}
                  maxLength={2000}
                  value={body}
                  onChange={(e) => {
                    setBody(e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                  placeholder="描述问题及发生时间，至少 5 个字"
                />
              </label>
              <button disabled={busy || body.trim().length < 5}>
                提交投诉
              </button>
            </form>
          )}
          <button disabled={busy} onClick={() => void act(() => refresh())}>
            刷新处理结果
          </button>
          {!items.length && <p>暂无投诉记录。</p>}
          {items.map((item) => (
            <article key={item.id}>
              <h3>
                {complaintCategories[item.category]} ·{" "}
                {complaintStates[item.events.at(-1)!.state]}
              </h3>
              <small>编号：{item.id}</small>
              <p>{item.body}</p>
              <p className={item.overdue ? "complaint-overdue" : "muted"}>
                首次处理目标：{new Date(item.responseDueAt).toLocaleString()}
                {item.overdue ? " · 已超时" : ""}
              </p>
              {item.events.map((event) => (
                <p key={event.version}>
                  {new Date(event.createdAt).toLocaleString()} ·{" "}
                  {complaintStates[event.state]}：{event.reply}
                </p>
              ))}
              {merchant && role === "owner" && (
                <Reply
                  key={item.events.length}
                  item={item}
                  busy={busy}
                  submit={(reply, state) =>
                    void act(async () => {
                      await api(
                        `/merchant/complaints/${item.id}/reply`,
                        "POST",
                        {
                          previousVersion: item.events.at(-1)!.version,
                          reply,
                          state,
                        },
                      );
                      await refresh();
                    })
                  }
                />
              )}
              {!merchant &&
                item.events.at(-1)?.state === "resolved" &&
                !item.appeal && (
                  <Appeal
                    busy={busy}
                    submit={(reason, idempotencyKey) =>
                      void act(async () => {
                        await api(
                          `/viewer/rooms/${roomId}/complaints/${item.id}/appeals`,
                          "POST",
                          { reason, idempotencyKey },
                        );
                        await refresh();
                      })
                    }
                  />
                )}
              {item.appeal && (
                <section className="complaint-appeal">
                  <h4>
                    申诉 ·{" "}
                    {complaintAppealStates[item.appeal.events.at(-1)!.state]}
                  </h4>
                  <p>{item.appeal.reason}</p>
                  <p
                    className={
                      item.appeal.overdue ? "complaint-overdue" : "muted"
                    }
                  >
                    复核目标：
                    {new Date(item.appeal.reviewDueAt).toLocaleString()}
                    {item.appeal.overdue ? " · 已超时" : ""}
                  </p>
                  {item.appeal.events.map((event) => (
                    <p key={event.version}>
                      {new Date(event.createdAt).toLocaleString()} ·{" "}
                      {complaintAppealStates[event.state]}：{event.reply}
                    </p>
                  ))}
                  {merchant &&
                    role === "reviewer" &&
                    item.appeal.events.at(-1)?.state !== "resolved" && (
                      <Reply
                        item={item}
                        busy={busy}
                        appeal
                        submit={(reply, state) =>
                          void act(async () => {
                            await api(
                              `/merchant/complaints/${item.id}/appeals/${item.appeal!.id}/reply`,
                              "POST",
                              {
                                previousVersion:
                                  item.appeal!.events.at(-1)!.version,
                                reply,
                                state,
                              },
                            );
                            await refresh();
                          })
                        }
                      />
                    )}
                  {merchant && role === "owner" && (
                    <p className="muted">申诉由独立审核员复核。</p>
                  )}
                </section>
              )}
            </article>
          ))}
          {after && (
            <button
              disabled={busy}
              onClick={() => void act(() => refresh(true))}
            >
              更多投诉
            </button>
          )}
        </div>
      )}
    </section>
  );
}
function Reply({
  item,
  busy,
  submit,
  appeal = false,
}: {
  item: Complaint;
  busy: boolean;
  submit: (reply: string, state: string) => void;
  appeal?: boolean;
}) {
  const [reply, setReply] = useState(""),
    [state, setState] = useState("reviewing");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        submit(reply, state);
      }}
    >
      <label>
        处理状态
        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="reviewing">
            {appeal ? "复核中" : "处理中 / 重新受理"}
          </option>
          <option value="resolved">{appeal ? "复核完成" : "已答复"}</option>
        </select>
      </label>
      <label>
        给观众的回执
        <textarea
          aria-label={`投诉 ${item.id} 的${appeal ? "申诉" : "处理"}回执`}
          required
          minLength={5}
          maxLength={2000}
          value={reply}
          onChange={(e) => setReply(e.target.value)}
        />
      </label>
      <button disabled={busy || reply.trim().length < 5}>保存并反馈</button>
    </form>
  );
}

function Appeal({
  busy,
  submit,
}: {
  busy: boolean;
  submit: (reason: string, idempotencyKey: string) => void;
}) {
  const [reason, setReason] = useState(""),
    [key, setKey] = useState(() => crypto.randomUUID());
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        submit(reason, key);
      }}
    >
      <label>
        对处理结果申诉
        <textarea
          required
          minLength={5}
          maxLength={2000}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            setKey(crypto.randomUUID());
          }}
          placeholder="说明仍有异议的原因，至少 5 个字"
        />
      </label>
      <button disabled={busy || reason.trim().length < 5}>提交独立复核</button>
    </form>
  );
}
