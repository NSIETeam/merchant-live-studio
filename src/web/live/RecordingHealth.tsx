import { useEffect, useState } from "react";
import { api } from "../shared/api.js";
type Health = {
  storage: "unconfigured" | "available" | "low-space" | "unavailable";
  ingestErrorCount: number;
  checkedAt: number;
};
export function RecordingHealth() {
  const [health, setHealth] = useState<Health | null>(null),
    [error, setError] = useState(false),
    [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    async function refresh() {
      try {
        const next = await api<Health>("/merchant/recordings/health");
        if (active) {
          setHealth(next);
          setError(false);
        }
      } catch {
        if (active) setError(true);
      } finally {
        if (active) timer = setTimeout(refresh, 30000);
      }
    }
    void refresh();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [revision]);
  if (
    !error &&
    (!health || (health.storage === "available" && !health.ingestErrorCount))
  )
    return null;
  return (
    <aside className="notice recording-health" aria-label="录像运行提示">
      {error ? (
        <p role="alert">暂时无法核对录像存储状态，请检查后重试。</p>
      ) : (
        <>
          {health?.storage === "unconfigured" && <p>录像留存尚未配置。</p>}
          {health?.storage === "unavailable" && (
            <p role="alert">
              录像或回执目录暂不可用，请联系管理员检查权限和挂载。
            </p>
          )}
          {health?.storage === "low-space" && (
            <p role="alert">
              录像或回执存储可用空间低于 10%，请及时处理，避免录制中断。
            </p>
          )}
          {!!health?.ingestErrorCount && (
            <p role="alert">
              本商家有 {health.ingestErrorCount}{" "}
              个录像登记异常，请检查隔离队列。
            </p>
          )}
        </>
      )}
      <button className="text-button" onClick={() => setRevision((v) => v + 1)}>
        重新检查录像状态
      </button>
    </aside>
  );
}
