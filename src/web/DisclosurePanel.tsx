import { useEffect, useState } from "react";
import { api } from "./api.js";
import type {
  Disclosure,
  DisclosureState,
  PublicDisclosure,
} from "../shared/disclosure.js";
import type { MemberRole } from "../shared/membership.js";
const fields = {
  name: "企业名称",
  creditCode: "统一社会信用代码",
  address: "实际经营地址",
  contact: "公开联系方式",
  licenses: "行政许可与备案信息（按适用情况填写）",
};
const empty = () => ({
  name: "",
  creditCode: "",
  address: "",
  contact: "",
  licenses: "",
});
function Details({ data }: { data: Disclosure }) {
  return (
    <>
      {(["operator", "seller"] as const).map((kind) => (
        <section key={kind}>
          <h3>{kind === "operator" ? "直播间运营者" : "实际销售者"}</h3>
          <dl>
            {Object.entries(fields).map(([key, title]) => (
              <div key={key}>
                <dt>{title}</dt>
                <dd>{data[kind][key as keyof typeof fields]}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
      <h3>投诉与售后联系</h3>
      <p>{data.complaintContact}</p>
    </>
  );
}
export function PublicDisclosurePanel({ roomId }: { roomId: string }) {
  const [data, setData] = useState<PublicDisclosure | null>(null),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(true);
  useEffect(() => {
    let alive = true;
    async function refresh() {
      try {
        const result = await api<{ disclosure: PublicDisclosure | null }>(
          `/public/rooms/${roomId}/disclosure`,
        );
        if (alive) {
          setData(result.disclosure);
          setError("");
        }
      } catch (e) {
        if (alive) {
          setData(null);
          setError((e as Error).message);
        }
      } finally {
        if (alive) setLoading(false);
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [roomId]);
  return (
    <section className="disclosure-panel">
      <h2>经营者信息</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : loading ? (
        <p>正在读取公示资料…</p>
      ) : data ? (
        <>
          <p>
            公示 V{data.version} · {new Date(data.publishedAt).toLocaleString()}
          </p>
          <Details data={data.data} />
        </>
      ) : (
        <p>
          尚无有效公示资料，请向直播间运营者核实。此页面不代表资质已获批准。
        </p>
      )}
    </section>
  );
}
export function MerchantDisclosure({
  role,
  actorId,
}: {
  role: MemberRole;
  actorId: string;
}) {
  const [state, setState] = useState<DisclosureState | null>(null),
    [data, setData] = useState<Disclosure>({
      operator: empty(),
      seller: empty(),
      complaintContact: "",
    }),
    [evidence, setEvidence] = useState(""),
    [note, setNote] = useState(""),
    [ack, setAck] = useState(false),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [open, setOpen] = useState(false);
  const dirty = Boolean(
    state?.latest &&
    (JSON.stringify(data) !== JSON.stringify(state.latest.data) ||
      evidence !== state.latest.evidenceReference),
  );
  const editable = role === "owner" || role === "editor",
    reviewable = role === "owner" || role === "reviewer";
  async function refresh() {
    const result = await api<DisclosureState>("/merchant/disclosure");
    setState(result);
    if (result.latest) {
      setData(result.latest.data);
      setEvidence(result.latest.evidenceReference);
    }
    setAck(false);
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
  async function review(action: "publish" | "withdraw") {
    await api(
      `/merchant/disclosure/${action === "publish" ? state!.latest!.version : state!.publication!.version}/review`,
      "POST",
      { action, note, acknowledged: ack },
    );
    setNote("");
    await refresh();
  }
  return (
    <section className="card disclosure-panel">
      <button
        onClick={() => {
          setOpen(!open);
          if (!open) void act(refresh);
        }}
      >
        经营者公示资料
      </button>
      {open && (
        <>
          <p>
            仅填写可对外公开的企业资料。依据文件编号仅供内部复核，不对观众展示；填写资料不等于取得许可。发布必须由另一账号完成。
          </p>
          {error && <p role="alert">{error}</p>}
          <p>
            当前公示：
            {state?.publication?.action === "publish"
              ? `V${state.publication.version}`
              : "未公示 / 已撤回"}
            ；最新草稿：{state?.latest ? `V${state.latest.version}` : "暂无"}
          </p>
          <button disabled={busy} onClick={() => void act(refresh)}>
            刷新公示资料
          </button>
          {editable ? (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(async () => {
                  await api("/merchant/disclosure", "POST", {
                    previousVersion: state?.latest?.version || 0,
                    data,
                    evidenceReference: evidence,
                  });
                  await refresh();
                });
              }}
            >
              {(["operator", "seller"] as const).map((kind) => (
                <fieldset disabled={busy} key={kind}>
                  <legend>
                    {kind === "operator" ? "直播间运营者" : "实际销售者"}
                  </legend>
                  {Object.entries(fields).map(([key, title]) => (
                    <label key={key}>
                      {title}
                      <input
                        required
                        value={data[kind][key as keyof typeof fields]}
                        maxLength={
                          key === "licenses"
                            ? 1000
                            : key === "address"
                              ? 240
                              : 120
                        }
                        onChange={(e) =>
                          setData({
                            ...data,
                            [kind]: { ...data[kind], [key]: e.target.value },
                          })
                        }
                      />
                    </label>
                  ))}
                </fieldset>
              ))}
              <label>
                投诉与售后联系
                <input
                  required
                  maxLength={240}
                  value={data.complaintContact}
                  onChange={(e) =>
                    setData({ ...data, complaintContact: e.target.value })
                  }
                />
              </label>
              <label>
                内部依据编号或受控文件位置
                <input
                  required
                  minLength={5}
                  maxLength={1000}
                  value={evidence}
                  onChange={(e) => setEvidence(e.target.value)}
                />
              </label>
              <button disabled={busy}>保存公示草稿</button>
            </form>
          ) : (
            state?.latest && <Details data={state.latest.data} />
          )}
          {state?.latest && (
            <p>
              资料保存者：{state.latest.authorId} · 内部依据：
              {state.latest.evidenceReference}
            </p>
          )}
          {reviewable && (
            <fieldset disabled={busy}>
              <legend>复核与发布</legend>
              <label>
                复核说明
                <textarea
                  minLength={5}
                  maxLength={1000}
                  value={note}
                  onChange={(e) => {
                    setNote(e.target.value);
                    setAck(false);
                  }}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(e) => setAck(e.target.checked)}
                />
                已核对当前版本及依据，确认此次操作
              </label>
              <button
                disabled={
                  !ack ||
                  note.trim().length < 5 ||
                  !state?.latest ||
                  state.latest.authorId === actorId ||
                  dirty ||
                  Boolean(
                    state.events.some(
                      (e) => e.version === state.latest?.version,
                    ),
                  )
                }
                onClick={() => void act(() => review("publish"))}
              >
                复核并公示
              </button>
              <button
                disabled={
                  !ack ||
                  note.trim().length < 5 ||
                  state?.publication?.action !== "publish"
                }
                onClick={() => void act(() => review("withdraw"))}
              >
                撤回当前公示
              </button>
            </fieldset>
          )}
          <h3>最近处理记录</h3>
          {state?.events.map((event) => (
            <p key={event.id}>
              V{event.version} · {event.action === "publish" ? "公示" : "撤回"}{" "}
              · {event.actorId} · {event.note}
            </p>
          ))}
        </>
      )}
    </section>
  );
}
