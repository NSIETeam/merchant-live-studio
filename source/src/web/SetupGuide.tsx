import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { Destination } from "../shared/home.js";
type Progress = {
  products: number;
  drafts: number;
  rooms: number;
  bindings: number;
};
export function SetupGuide({ onOpen }: { onOpen: (id: Destination) => void }) {
  const [progress, setProgress] = useState<Progress | null>(null),
    [error, setError] = useState("");
  async function refresh() {
    try {
      setProgress(await api<Progress>("/merchant/home/progress"));
      setError("");
    } catch (e) {
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  return (
    <>
      <p className="muted">
        以下仅表示资料和记录已建立，不代表已审核或可以开播。
      </p>
      {error && <p role="alert">{error}</p>}
      {progress && (
        <ol className="setup-steps">
          {[
            {
              title: "建立商品资料",
              detail: "填写名称、SKU、类别及证据",
              count: progress.products,
              target: "content",
            },
            {
              title: "准备课程讲稿",
              detail: "创建课程、保存讲稿并提交审改",
              count: progress.drafts,
              target: "content",
            },
            {
              title: "创建直播间",
              detail: "由管理员在主页创建直播间",
              count: progress.rooms,
              target: "studio",
            },
            {
              title: "绑定定稿",
              detail: "在商品与课程中选择直播间进行绑定",
              count: progress.bindings,
              target: "content",
            },
          ].map((step) => (
            <li key={step.title}>
              <button
                className="text-button"
                onClick={() => onOpen(step.target as Destination)}
              >
                {step.title} ·{" "}
                {step.count > 0 ? `已有 ${step.count} 项` : "待建立"}
              </button>
              <small>{step.detail}</small>
            </li>
          ))}
          <li>
            <button className="text-button" onClick={() => onOpen("studio")}>
              核对开播条件
            </button>
            <small>进入直播现场展开开播准备检查，逐项核实当前房间。</small>
          </li>
        </ol>
      )}
      <button className="text-button" onClick={() => void refresh()}>
        刷新准备进度
      </button>
    </>
  );
}
