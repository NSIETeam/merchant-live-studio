import { useEffect, useState } from "react";
import type { PlatformComplianceResponse } from "../../shared/platform-compliance.js";
import { api } from "./api.js";

export function PlatformCompliance({ compact = false }: { compact?: boolean }) {
  const [state, setState] = useState<PlatformComplianceResponse | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api<PlatformComplianceResponse>("/platform/compliance")
      .then((result) => {
        if (active) setState(result);
      })
      .catch((reason) => {
        if (active) setError((reason as Error).message);
      });
    return () => {
      active = false;
    };
  }, []);
  return (
    <section className={`platform-compliance ${compact ? "is-compact" : ""}`}>
      <h2>平台信息与隐私</h2>
      {error ? (
        <p role="alert">{error}</p>
      ) : !state ? (
        <p>正在读取平台信息…</p>
      ) : state.data ? (
        <>
          <dl>
            <div>
              <dt>平台运营主体</dt>
              <dd>{state.data.operatorName}</dd>
            </div>
            <div>
              <dt>统一社会信用代码</dt>
              <dd>{state.data.creditCode}</dd>
            </div>
            <div>
              <dt>地址</dt>
              <dd>{state.data.address}</dd>
            </div>
            <div>
              <dt>公开联系方式</dt>
              <dd>{state.data.contact}</dd>
            </div>
            <div>
              <dt>平台投诉渠道</dt>
              <dd>{state.data.complaintContact}</dd>
            </div>
            <div>
              <dt>个人信息与隐私联系</dt>
              <dd>{state.data.privacyContact}</dd>
            </div>
          </dl>
          <p>政策生效日期：{state.data.effectiveDate}</p>
          <nav aria-label="平台政策文件" className="platform-policy-links">
            <a
              href={state.data.privacyPolicyUrl}
              target="_blank"
              rel="noreferrer"
            >
              隐私政策
            </a>
            <a
              href={state.data.serviceTermsUrl}
              target="_blank"
              rel="noreferrer"
            >
              服务协议
            </a>
          </nav>
        </>
      ) : (
        <p className="platform-compliance-missing" role="status">
          平台运营主体、隐私政策和服务协议尚未配置。当前页面不能作为正式提审材料。
        </p>
      )}
      {state && (
        <>
          <h3>当前数据使用说明</h3>
          <ul>
            {state.dataPractices.map((practice) => (
              <li key={practice}>{practice}</li>
            ))}
          </ul>
          <p className="muted">
            这里说明当前软件行为，不替代正式隐私政策、服务协议或主管部门审核。
          </p>
        </>
      )}
    </section>
  );
}

export function PlatformCompliancePage() {
  return (
    <main className="compliance-page">
      <a href={import.meta.env.BASE_URL}>返回靠谱工作台</a>
      <PlatformCompliance />
    </main>
  );
}
