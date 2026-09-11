import { useState } from "react";
import { api } from "../shared/api.js";
import {
  complaintCategories,
  complaintStates,
  type Complaint,
  type ComplaintPage,
} from "../../shared/complaints.js";
export function ComplaintsPanel({
  roomId,
  merchant = false,
}: {
  roomId: string;
  merchant?: boolean;
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
              {item.events.map((event) => (
                <p key={event.version}>
                  {new Date(event.createdAt).toLocaleString()} ·{" "}
                  {complaintStates[event.state]}：{event.reply}
                </p>
              ))}
              {merchant && (
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
}: {
  item: Complaint;
  busy: boolean;
  submit: (reply: string, state: string) => void;
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
          <option value="reviewing">处理中 / 重新受理</option>
          <option value="resolved">已答复</option>
        </select>
      </label>
      <label>
        给观众的回执
        <textarea
          aria-label={`投诉 ${item.id} 的回执`}
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
