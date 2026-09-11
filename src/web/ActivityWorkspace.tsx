import { useId, useState, type ReactNode } from "react";
import { MerchantEngagement } from "./EngagementPanel.js";
const sections = [
  { id: "checkin", label: "签到与积分" },
  { id: "gifts", label: "礼品与核销" },
  { id: "rewards", label: "演示红包" },
] as const;
export function ActivityWorkspace({
  roomId,
  editable,
  showEngagement,
  children,
}: {
  roomId: string;
  editable: boolean;
  showEngagement: boolean;
  children: ReactNode;
}) {
  const [selected, setSelected] = useState<string>(
    showEngagement ? "checkin" : "rewards",
  );
  const id = useId();
  const tabs = showEngagement ? sections : sections.slice(2);
  return (
    <div className="activity-workspace">
      <div className="activity-tabs" role="tablist" aria-label="互动活动类型">
        {tabs.map((tab, index) => (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={`${id}-${tab.id}`}
            aria-selected={selected === tab.id}
            aria-controls={`${id}-${tab.id === "rewards" ? "rewards" : "engagement"}-panel`}
            tabIndex={selected === tab.id ? 0 : -1}
            onClick={() => setSelected(tab.id)}
            onKeyDown={(event) => {
              let next = index;
              if (event.key === "ArrowRight") next = (index + 1) % tabs.length;
              else if (event.key === "ArrowLeft")
                next = (index + tabs.length - 1) % tabs.length;
              else if (event.key === "Home") next = 0;
              else if (event.key === "End") next = tabs.length - 1;
              else return;
              event.preventDefault();
              setSelected(tabs[next].id);
              (
                event.currentTarget.parentElement?.children[
                  next
                ] as HTMLButtonElement
              )?.focus();
            }}
          >
            {tab.label}
          </button>
        ))}
      </div>
      {showEngagement && (
        <MerchantEngagement
          roomId={roomId}
          editable={editable}
          view={selected === "gifts" ? "gifts" : "checkin"}
          hidden={selected === "rewards"}
          panelId={`${id}-engagement-panel`}
          labelledBy={`${id}-${selected === "gifts" ? "gifts" : "checkin"}`}
        />
      )}
      <div
        role="tabpanel"
        tabIndex={0}
        id={`${id}-rewards-panel`}
        aria-labelledby={`${id}-rewards`}
        hidden={selected !== "rewards"}
      >
        {children}
      </div>
    </div>
  );
}
