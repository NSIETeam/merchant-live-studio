import { useEffect, useState } from "react";
import { api } from "./api.js";
import type { AdmissionCheck } from "../shared/admission.js";
export function AdmissionPanel({ roomId }: { roomId: string }) {
  const [check, setCheck] = useState<AdmissionCheck | null>(null),
    [error, setError] = useState("");
  async function refresh() {
    try {
      setCheck(
        await api<AdmissionCheck>(`/merchant/rooms/${roomId}/admission`),
      );
      setError("");
    } catch (e) {
      setCheck(null);
      setError((e as Error).message);
    }
  }
  useEffect(() => {
    void refresh();
  }, [roomId]);
  return (
    <section className="card">
      <h2>开播准备检查</h2>
      {error && <p role="alert">{error}</p>}
      {check && (
        <>
          <p>
            {check.enforced
              ? "服务器将在开放直播间和接收新推流时重新核对。"
              : "当前是本地演示模式，以下为准备提示；生产环境会强制检查。"}
          </p>
          <ul>
            {check.checks.map((item) => (
              <li key={item.code}>
                <strong>
                  {item.passed ? "已具备" : "待补齐"} · {item.label}
                </strong>
                ：{item.detail}
              </li>
            ))}
          </ul>
          <p>
            {check.ready
              ? "上述技术检查已具备；仍须核实主体资质、人员身份和直播现场。"
              : "请补齐上述事项后重新检查。"}
          </p>
        </>
      )}
      <button onClick={() => void refresh()}>重新检查开播准备</button>
    </section>
  );
}
