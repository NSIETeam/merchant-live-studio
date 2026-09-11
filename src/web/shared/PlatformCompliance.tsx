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
          <div className="retention-status">
            <h3>记录保存与删除</h3>
            {state.retention.data ? (
              <>
                <dl>
                  <div>
                    <dt>直播发布内容与日志</dt>
                    <dd>至少 {state.retention.data.liveContentDays} 日</dd>
                  </div>
                  <div>
                    <dt>直播电商业务记录</dt>
                    <dd>
                      至少 {state.retention.data.commerceRecordsMonths} 个月
                    </dd>
                  </div>
                  <div>
                    <dt>网络与安全日志</dt>
                    <dd>至少 {state.retention.data.securityLogsMonths} 个月</dd>
                  </div>
                  <div>
                    <dt>删除与争议保留联系</dt>
                    <dd>{state.retention.data.deletionReviewContact}</dd>
                  </div>
                </dl>
                <p>政策生效日期：{state.retention.data.effectiveDate}</p>
              </>
            ) : (
              <p className="platform-compliance-missing" role="status">
                保存期限和删除复核渠道尚未配置，当前不能证明留存政策已由运营方确认。
              </p>
            )}
            <h3>当前执行状态</h3>
            <ul>
              {state.retention.enforcement.map((item) => (
                <li key={item}>{item}</li>
              ))}
            </ul>
            <nav aria-label="记录保存依据" className="platform-policy-links">
              {state.retention.sourceLinks.map((source) => (
                <a
                  href={source.url}
                  key={source.url}
                  target="_blank"
                  rel="noreferrer"
                >
                  {source.label}
                </a>
              ))}
            </nav>
          </div>
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
