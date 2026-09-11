import { Activity, Eye, Gift, Radio } from "lucide-react";
import type { Analytics } from "../../shared/types.js";
import { duration, money } from "../shared/api.js";
export function Stats({ analytics: a }: { analytics: Analytics | null }) {
  return (
    <div className="stats">
      <div className="stat">
        <span>
          <Eye size={16} />
          当前在线
        </span>
        <strong>
          {a?.onlineViewers ?? "—"}
          <small>人</small>
        </strong>
        <p>近 30 秒活跃会话</p>
      </div>
      <div className="stat">
        <span>
          <Radio size={16} />
          累计观众
        </span>
        <strong>
          {a?.uniqueViewers ?? "—"}
          <small>人</small>
        </strong>
        <p>当前直播间去重访客</p>
      </div>
      <div className="stat">
        <span>
          <Activity size={16} />
          平均停留
        </span>
        <strong>{a ? duration(a.averageWatchSeconds) : "—"}</strong>
        <p>有效观看心跳时长</p>
      </div>
      <div className="stat">
        <span>
          <Gift size={16} />
          红包领取
        </span>
        <strong>
          {a?.claims ?? "—"}
          <small>次</small>
        </strong>
        <p>演示金额 {money(a?.reservedCents || 0)}</p>
      </div>
    </div>
  );
}
