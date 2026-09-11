import { useCallback, useEffect, useRef, useState } from "react";
import { api, money, duration } from "./api.js";
import type {
  Store,
  SourceLink,
  OfflineRecord,
  OfflineInput,
  ImportPreview,
  StoreMetrics,
} from "../shared/attribution.js";
const base = "/merchant/attribution";
const matchNames = {
  linked_source: "已关联来源",
  missing_source: "未提供来源",
  unknown_source: "来源未识别",
  store_mismatch: "门店不符",
  outside_source_period: "不在来源有效期",
};
const kinds = { visit: "到店", order: "成交", cost: "成本" };
export function AttributionPanel({
  roomId,
  editable,
}: {
  roomId: string;
  editable: boolean;
}) {
  const [stores, setStores] = useState<Store[]>([]),
    [storeId, setStoreId] = useState(""),
    [metrics, setMetrics] = useState<StoreMetrics[]>([]),
    [sources, setSources] = useState<SourceLink[]>([]),
    [records, setRecords] = useState<OfflineRecord[]>([]),
    [next, setNext] = useState<number | null>(null);
  const [name, setName] = useState(""),
    [ref, setRef] = useState(""),
    [label, setLabel] = useState(""),
    [text, setText] = useState(""),
    [sourceName, setSourceName] = useState("门店台账"),
    [preview, setPreview] = useState<ImportPreview | null>(null),
    [history, setHistory] = useState<OfflineRecord[]>([]),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [key, setKey] = useState(crypto.randomUUID());
  const activeStore = useRef(storeId);
  activeStore.current = storeId;
  const refresh = useCallback(async () => {
    const [s, m] = await Promise.all([
      api<{ stores: Store[] }>(base + "/stores"),
      api<{ metrics: StoreMetrics[] }>(base + "/summary"),
    ]);
    setStores(s.stores);
    setMetrics(m.metrics);
    setStoreId((old) =>
      s.stores.some((s) => s.id === old) ? old : s.stores[0]?.id || "",
    );
  }, []);
  const load = useCallback(async () => {
    if (!storeId) return;
    const [s, r] = await Promise.all([
      api<{ sources: SourceLink[] }>(base + "/sources?storeId=" + storeId),
      api<{ records: OfflineRecord[]; nextBefore: number | null }>(
        base + "/records?storeId=" + storeId,
      ),
    ]);
    if (activeStore.current !== storeId) return;
    setSources(s.sources);
    setRecords(r.records);
    setNext(r.nextBefore);
  }, [storeId]);
  useEffect(() => {
    void refresh().catch((e) => setError(e.message));
  }, [refresh]);
  useEffect(() => {
    setSources([]);
    setRecords([]);
    setHistory([]);
    setNext(null);
    setText("");
    setKey(crypto.randomUUID());
    setPreview(null);
    void load().catch((e) => setError(e.message));
  }, [load]);
  async function act(fn: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "操作未完成");
    } finally {
      setBusy(false);
    }
  }
  function change(value: string) {
    setText(value);
    setPreview(null);
    setKey(crypto.randomUUID());
  }
  function input() {
    const rows: unknown = JSON.parse(text);
    if (!Array.isArray(rows) || rows.length < 1 || rows.length > 100)
      throw new Error("每批需为 1–100 条记录的 JSON 数组。");
    const value = { storeId, sourceName, rows };
    if (new TextEncoder().encode(JSON.stringify(value)).length > 24000)
      throw new Error("此批资料过大，请拆分为更小批次。");
    return value;
  }
  function download() {
    const blob = new Blob([JSON.stringify(records, null, 2)], {
        type: "application/json",
      }),
      url = URL.createObjectURL(blob),
      a = document.createElement("a");
    a.href = url;
    a.download = "门店记录-当前已加载.json";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function correct(r: OfflineRecord) {
    const row: OfflineInput = {
      kind: r.kind,
      externalId: r.externalId,
      occurredAt: new Date(r.occurredAt).toISOString(),
      amountYuan: (r.amountCents / 100).toFixed(2),
      sourceCode: r.sourceCode,
      customerRef: r.customerRef,
      previousVersion: r.revision,
      voided: !!r.voided,
      note: "",
    };
    change(JSON.stringify([row], null, 2));
    setNotice(
      "已带入当前版本。修改金额或将 voided 改为 true 作废，并填写 note 修订原因，再预览。",
    );
  }
  return (
    <section className="card">
      <h2>门店与线下复盘</h2>
      <p className="muted">
        来源访客按浏览器去重，不能等同真实人数。线下金额来自门店登记；关联来源不证明直播促成成交。
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <button
        disabled={busy}
        onClick={() =>
          void act(async () => {
            await refresh();
            await load();
          })
        }
      >
        刷新门店数据
      </button>
      <div style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>门店</th>
              <th>来源访客</th>
              <th>观看时长</th>
              <th>到店记录</th>
              <th>订单</th>
              <th>成交净额</th>
              <th>已登记成本</th>
              <th>未关联成交</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => (
              <tr key={m.storeId}>
                <td>{m.name}</td>
                <td>{m.sourceViewers}</td>
                <td>{duration(m.watchSeconds)}</td>
                <td>{m.visits}</td>
                <td>{m.orders}</td>
                <td>{money(m.salesCents)}</td>
                <td>{money(m.costCents)}</td>
                <td>{money(m.unlinkedSalesCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {editable && (
        <details>
          <summary>新增门店</summary>
          <label>
            门店名称
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label>
            业务门店编号
            <input value={ref} onChange={(e) => setRef(e.target.value)} />
          </label>
          <button
            disabled={busy || !name.trim() || !ref.trim()}
            onClick={() =>
              void act(async () => {
                const r = await api<{ store: { id: string } }>(
                  base + "/stores",
                  "POST",
                  { name, externalRef: ref },
                );
                await refresh();
                setStoreId(r.store.id);
                setName("");
                setRef("");
              })
            }
          >
            保存门店
          </button>
        </details>
      )}
      <label>
        查看门店
        <select
          value={storeId}
          disabled={busy}
          onChange={(e) => setStoreId(e.target.value)}
        >
          <option value="">请选择</option>
          {stores.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.externalRef}
            </option>
          ))}
        </select>
      </label>
      {storeId && (
        <>
          <details>
            <summary>来源链接（群组或员工）</summary>
            <p>
              每个浏览器在同一直播间保留首个有效来源。停用后不能新增归属，历史记录保留。
            </p>
            {sources.map((s) => (
              <p key={s.code}>
                {s.label}{" "}
                {s.disabledAt ? (
                  "（已停用）"
                ) : (
                  <a
                    href={`${import.meta.env.BASE_URL}watch/${s.roomId}?source=${s.code}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    打开观众链接
                  </a>
                )}
                <input
                  aria-label={`${s.label}的分享地址`}
                  readOnly
                  value={`${location.origin}${import.meta.env.BASE_URL}watch/${s.roomId}?source=${s.code}`}
                />
                {editable && !s.disabledAt && (
                  <button
                    disabled={busy}
                    onClick={() =>
                      void act(async () => {
                        await api(
                          base + "/sources/" + s.code + "/disable",
                          "POST",
                          {},
                        );
                        await load();
                      })
                    }
                  >
                    停用此来源
                  </button>
                )}
              </p>
            ))}
            {editable && (
              <>
                <label>
                  当前直播间的来源名称
                  <input
                    value={label}
                    onChange={(e) => setLabel(e.target.value)}
                    placeholder="例如：一店 · 员工小张社群"
                  />
                </label>
                <button
                  disabled={busy || !label.trim()}
                  onClick={() =>
                    void act(async () => {
                      await api(base + "/sources", "POST", {
                        storeId,
                        roomId,
                        label,
                      });
                      setLabel("");
                      await load();
                    })
                  }
                >
                  创建分享来源
                </button>
              </>
            )}
          </details>
          {editable && (
            <details>
              <summary>登记、导入或修订线下记录</summary>
              <OfflineEntry
                key={storeId}
                sources={sources}
                disabled={busy}
                onReady={(row) => {
                  change(JSON.stringify([row], null, 2));
                  setNotice("已填入下方待检查记录，请点击检查导入内容。");
                }}
              />
              <details>
                <summary>高级：批量文件与修订内容</summary>
                <p>
                  每批最多 100
                  条。业务编号用于去重；修订需当前版本号和原因。金额填元，到店填
                  0。customerRef 仅填写内部匿名编号。
                </p>
                <button
                  disabled={busy}
                  onClick={() =>
                    change(
                      JSON.stringify(
                        [
                          {
                            kind: "order",
                            externalId: "请填写真实业务编号",
                            occurredAt: new Date().toISOString(),
                            amountYuan: "0.00",
                            sourceCode: "",
                            customerRef: "",
                            note: "",
                          },
                        ],
                        null,
                        2,
                      ),
                    )
                  }
                >
                  填入格式示例
                </button>
                <label>
                  台账名称
                  <input
                    value={sourceName}
                    disabled={busy}
                    onChange={(e) => {
                      setSourceName(e.target.value);
                      setPreview(null);
                      setKey(crypto.randomUUID());
                    }}
                  />
                </label>
                <label>
                  导入 JSON 文件
                  <input
                    type="file"
                    accept=".json,application/json"
                    disabled={busy}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      if (file)
                        void act(async () => {
                          if (file.size > 24000)
                            throw new Error("文件过大，请拆分到 24KB 以内。");
                          change(await file.text());
                        });
                      e.target.value = "";
                    }}
                  />
                </label>
                <label>
                  记录数组
                  <textarea
                    rows={12}
                    value={text}
                    disabled={busy}
                    onChange={(e) => change(e.target.value)}
                  />
                </label>
              </details>
              <button
                disabled={busy || !text}
                onClick={() =>
                  void act(async () => {
                    setPreview(
                      await api<ImportPreview>(
                        base + "/imports/preview",
                        "POST",
                        input(),
                      ),
                    );
                  })
                }
              >
                检查导入内容
              </button>
              {preview && (
                <>
                  <ul>
                    {preview.rows.map((r) => (
                      <li key={r.index}>
                        {r.index}. {kinds[r.kind]} · {r.externalId} ·{" "}
                        {money(r.amountCents)} ·{" "}
                        {new Date(r.occurredAt).toLocaleString()}：{r.message} ·{" "}
                        {matchNames[r.matchState]}
                      </li>
                    ))}
                  </ul>
                  <button
                    disabled={busy || !preview.canImport}
                    onClick={() =>
                      void act(async () => {
                        const result = await api<{
                          receipt: {
                            inserted: number;
                            skipped: number;
                            unlinked: number;
                          };
                        }>(base + "/imports", "POST", {
                          ...input(),
                          idempotencyKey: key,
                          acknowledged: true,
                        });
                        setNotice(
                          `已保存 ${result.receipt.inserted} 条，跳过重复 ${result.receipt.skipped} 条；未关联来源 ${result.receipt.unlinked} 条。`,
                        );
                        setPreview(null);
                        await refresh();
                        await load();
                      })
                    }
                  >
                    确认资料无误并保存
                  </button>
                </>
              )}
            </details>
          )}
          <h3>当前记录</h3>
          <button disabled={!records.length} onClick={download}>
            导出已加载的 {records.length} 条记录
          </button>
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>类型 / 编号</th>
                  <th>金额</th>
                  <th>版本</th>
                  <th>来源</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                {records.map((r) => (
                  <tr key={r.id}>
                    <td>
                      {kinds[r.kind]} · {r.externalId}
                      {r.voided ? "（已作废）" : ""}
                    </td>
                    <td>{money(r.amountCents)}</td>
                    <td>V{r.revision}</td>
                    <td>{matchNames[r.matchState]}</td>
                    <td>
                      <button
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            setHistory(
                              (
                                await api<{ records: OfflineRecord[] }>(
                                  base + "/records/" + r.id + "/history",
                                )
                              ).records,
                            );
                          })
                        }
                      >
                        历史
                      </button>
                      {editable && (
                        <button disabled={busy} onClick={() => correct(r)}>
                          修订
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {next && (
            <button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  const r = await api<{
                    records: OfflineRecord[];
                    nextBefore: number | null;
                  }>(base + "/records?storeId=" + storeId + "&before=" + next);
                  setRecords((old) => [...old, ...r.records]);
                  setNext(r.nextBefore);
                })
              }
            >
              加载更多记录
            </button>
          )}
          {history.length > 0 && (
            <div>
              <h3>{history[0].externalId} · 修订历史</h3>
              {history.map((r) => (
                <p key={r.id}>
                  V{r.revision} · {money(r.amountCents)} ·{" "}
                  {r.voided ? "作废" : "有效"} · {r.actorId} ·{" "}
                  {new Date(r.createdAt).toLocaleString()} ·{" "}
                  {r.note || "首次登记"}
                </p>
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function OfflineEntry({
  sources,
  disabled,
  onReady,
}: {
  sources: SourceLink[];
  disabled: boolean;
  onReady: (row: OfflineInput) => void;
}) {
  const [kind, setKind] = useState<OfflineInput["kind"]>("visit"),
    [externalId, setExternalId] = useState(""),
    [amount, setAmount] = useState(""),
    [sourceCode, setSourceCode] = useState(""),
    [note, setNote] = useState(""),
    [customerRef, setCustomerRef] = useState(""),
    [date, setDate] = useState(() => {
      const d = new Date();
      return new Date(d.getTime() - d.getTimezoneOffset() * 60000)
        .toISOString()
        .slice(0, 16);
    }),
    [error, setError] = useState("");
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError("");
        const when = new Date(date);
        if (!Number.isFinite(when.getTime())) {
          setError("请选择发生时间");
          return;
        }
        if (
          kind !== "visit" &&
          !/^(0|[1-9]\d{0,6})(\.\d{1,2})?$/.test(amount)
        ) {
          setError("请输入金额，最多两位小数");
          return;
        }
        onReady({
          kind,
          externalId,
          occurredAt: when.toISOString(),
          amountYuan: kind === "visit" ? "0" : amount,
          sourceCode,
          customerRef,
          note,
        });
      }}
    >
      <h3>单条登记</h3>
      <label>
        记录类型
        <select
          disabled={disabled}
          value={kind}
          onChange={(e) => setKind(e.target.value as OfflineInput["kind"])}
        >
          <option value="visit">到店</option>
          <option value="order">成交订单</option>
          <option value="cost">成本支出</option>
        </select>
      </label>
      <label>
        业务编号
        <input
          required
          maxLength={100}
          disabled={disabled}
          value={externalId}
          onChange={(e) => setExternalId(e.target.value)}
          placeholder="例如：收银订单编号或到店登记编号"
        />
      </label>
      <label>
        发生时间
        <input
          type="datetime-local"
          required
          disabled={disabled}
          value={date}
          onChange={(e) => setDate(e.target.value)}
        />
      </label>
      {kind !== "visit" && (
        <label>
          {kind === "order" ? "订单净额（元）" : "成本金额（元）"}
          <input
            inputMode="decimal"
            required
            disabled={disabled}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="例如 19.99"
          />
        </label>
      )}
      <label>
        业务记录中的来源
        <select
          disabled={disabled}
          value={sourceCode}
          onChange={(e) => setSourceCode(e.target.value)}
        >
          <option value="">未能确认，保留未关联</option>
          {sources.map((s) => (
            <option key={s.code} value={s.code}>
              {s.label}
              {s.disabledAt ? "（已停用，仅用于历史记录）" : ""}
            </option>
          ))}
        </select>
      </label>
      <label>
        内部顾客编号（可选）
        <input
          disabled={disabled}
          maxLength={100}
          value={customerRef}
          onChange={(e) => setCustomerRef(e.target.value)}
          placeholder="匿名编号，无需姓名或手机号"
        />
      </label>
      <label>
        备注
        <input
          disabled={disabled}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
      </label>
      {error && <p role="alert">{error}</p>}
      <button disabled={disabled}>加入待检查记录</button>
    </form>
  );
}
