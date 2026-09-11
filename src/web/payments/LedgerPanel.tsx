import React, { useEffect, useState } from "react";
import { api } from "../shared/api.js";
import type { LedgerEntry } from "../../shared/types.js";
const labels: Record<string, string> = {
  simulation_budget: "演示预算",
  campaign_reserved: "活动预留",
  claim_reserved: "领取预留",
  simulation_settled: "演示处理",
  simulation_budget_returned: "演示退回",
  merchant_transfer_limit: "商户转账额度",
  merchant_transfer_limit_returned: "未使用额度",
  wechat_settled: "微信已到账",
  wechat_failed_returned: "微信失败退回",
  wechat_cancelled_returned: "微信取消退回",
};
type Page = {
  entries: LedgerEntry[];
  nextBefore: string | null;
  mode?: "simulation" | "wechat";
};
type Transfer = {
  outBillNo: string;
  claimId: string;
  amountCents: number;
  state: string;
  attempts: number;
  lastErrorCode: string;
  updatedAt: number;
};
const transferLabels: Record<string, string> = {
  queued: "等待发起",
  create_unknown: "等待原单核对",
  pending: "微信处理中",
  wait_user_confirm: "等待观众确认",
  paid: "已到账",
  failed: "失败",
  cancelled: "已取消",
};
export function LedgerPanel({ roomId }: { roomId: string }) {
  const [cursors, setCursors] = useState<string[]>([]);
  const [page, setPage] = useState<Page>({ entries: [], nextBefore: null });
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [transfers, setTransfers] = useState<Transfer[]>([]);
  const [revision, setRevision] = useState(0);
  const before = cursors.at(-1);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      setBusy(true);
      try {
        const [data, transferData] = await Promise.all([
          api<Page>(
            `/merchant/rooms/${roomId}/ledger${before ? `?before=${encodeURIComponent(before)}` : ""}`,
          ),
          api<{ transfers: Transfer[] }>(`/merchant/rooms/${roomId}/transfers`),
        ]);
        if (active) {
          setPage(data);
          setTransfers(transferData.transfers);
          setError("");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) {
          setBusy(false);
          if (!before) timer = setTimeout(load, 4000);
        }
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [roomId, before, revision]);
  function navigate(next: string[]) {
    setBusy(true);
    setPage({ entries: [], nextBefore: null });
    setCursors(next);
  }
  return (
    <section
      className="card ledger"
      aria-label={page.mode === "wechat" ? "现金账本" : "演示账本"}
    >
      <div className="section-title">
        <h2>{page.mode === "wechat" ? "现金账本" : "演示账本"}</h2>
        <span className="muted">
          第 {cursors.length + 1} 页 · 每页最多 200 笔
        </span>
      </div>
      <div className="button-row">
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            navigate([]);
            setRevision((v) => v + 1);
          }}
        >
          刷新最新
        </button>
        <button
          className="secondary"
          disabled={busy || !cursors.length}
          onClick={() => navigate(cursors.slice(0, -1))}
        >
          上一页
        </button>
        <button
          className="secondary"
          disabled={busy || !!error || !page.nextBefore}
          onClick={() => navigate([...cursors, page.nextBefore!])}
        >
          更早记录
        </button>
      </div>
      {error && <p role="alert">{error}</p>}
      <div className="table-wrap" aria-busy={busy}>
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>记录编号</th>
              <th>资金流向{page.mode === "wechat" ? "" : "（演示）"}</th>
              <th>金额</th>
            </tr>
          </thead>
          <tbody>
            {page.entries.map((e) => (
              <tr key={e.id}>
                <td>{new Date(e.createdAt).toLocaleString("zh-CN")}</td>
                <td title={e.id}>{e.id.slice(0, 8)}</td>
                <td>
                  {labels[e.debit] || e.debit} → {labels[e.credit] || e.credit}
                </td>
                <td>¥{(e.amountCents / 100).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {!page.entries.length && (
          <p className="empty-copy">
            {busy
              ? "正在载入账本…"
              : error
                ? "账本暂未载入，请重试。"
                : "暂无记录。"}
          </p>
        )}
      </div>
      {page.mode === "wechat" && (
        <div className="payment-transfers">
          <div className="section-title">
            <h3>微信转账单</h3>
            <span className="muted">{transfers.length} 笔</span>
          </div>
          {transfers.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>更新时间</th>
                    <th>商户单号</th>
                    <th>状态</th>
                    <th>金额</th>
                  </tr>
                </thead>
                <tbody>
                  {transfers.map((transfer) => (
                    <tr key={transfer.outBillNo}>
                      <td>
                        {new Date(transfer.updatedAt).toLocaleString("zh-CN")}
                      </td>
                      <td title={transfer.outBillNo}>
                        {transfer.outBillNo.slice(0, 12)}
                      </td>
                      <td>
                        {transferLabels[transfer.state] || transfer.state}
                        {transfer.lastErrorCode
                          ? ` · 重试中（${transfer.attempts}）`
                          : ""}
                      </td>
                      <td>¥{(transfer.amountCents / 100).toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="empty-copy">暂无微信转账单。</p>
          )}
        </div>
      )}
    </section>
  );
}
