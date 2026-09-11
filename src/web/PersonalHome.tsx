import React, { useEffect, useState } from "react";
import { ArrowRight, ArrowUp, ArrowDown, Plus, Settings2 } from "lucide-react";
import type { Room } from "../shared/types";
import "./personal-home.css";
import { api } from "./api.js";
import type {
  Destination,
  HomeModule as Module,
  HomePreferences,
} from "../shared/home.js";
export type { Destination } from "../shared/home.js";
const labels: Record<Module, string> = {
  shortcuts: "常用功能",
  rooms: "我的直播间",
  content: "商品与课程",
  studio: "直播现场",
  copilot: "表达与提示词",
  training: "品牌与评测",
  rewards: "互动活动",
  analytics: "数据复盘",
};
const descriptions: Record<Destination, string> = {
  content: "整理商品资料，审改与定稿。",
  studio: "进入直播现场，查看画面与播讲提示。",
  copilot: "调试表达方式与系统提示词。",
  training: "整理品牌依据，比较评测结果。",
  rewards: "管理活动规则与互动记录。",
  analytics: "查看实际访问、互动与转化记录。",
};
export function PersonalHome({
  merchantId,
  actorId,
  allowed,
  rooms,
  onOpen,
  onRoom,
}: {
  merchantId: string;
  actorId: string;
  allowed: Destination[];
  rooms: Room[];
  onOpen: (id: Destination) => void;
  onRoom: (id: string) => void;
}) {
  const key = `kaopu:home:v1:${encodeURIComponent(merchantId)}:${encodeURIComponent(actorId)}`;
  const available: Module[] = ["shortcuts", "rooms", ...allowed];
  const defaults: Module[] = ["shortcuts", "rooms"];
  const [preferences, setPreferences] = useState<HomePreferences>({
    modules: defaults,
    shortcuts: allowed,
    version: 0,
  });
  const { modules, shortcuts } = preferences;
  const [editing, setEditing] = useState(false);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [legacy, setLegacy] = useState<Module[] | null>(null);
  useEffect(() => {
    let active = true;
    api<HomePreferences>("/merchant/home")
      .then((data) => {
        if (active) {
          setPreferences(data);
          setReady(true);
        }
      })
      .catch((error) => {
        if (active) setNotice(error.message);
      });
    try {
      const saved: unknown = JSON.parse(localStorage.getItem(key) || "null");
      if (Array.isArray(saved))
        setLegacy([
          ...new Set(
            saved.filter((id): id is Module => available.includes(id)),
          ),
        ]);
    } catch {
      /* Old browser preferences are optional. */
    }
    return () => {
      active = false;
    };
  }, [key]);
  async function reload() {
    setBusy(true);
    try {
      setPreferences(await api<HomePreferences>("/merchant/home"));
      setReady(true);
      setNotice("已载入账号保存的布局。");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function save(next: Module[], nextShortcuts = shortcuts) {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const saved = await api<HomePreferences>("/merchant/home", "PUT", {
        modules: next,
        shortcuts: nextShortcuts,
        version: preferences.version,
      });
      setPreferences(saved);
      setNotice("主页已保存，使用此账号登录其他设备也能恢复。");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function move(index: number, delta: number) {
    const next = [...modules];
    [next[index], next[index + delta]] = [next[index + delta], next[index]];
    save(next);
  }
  return (
    <section className="personal-home">
      <div className="home-heading">
        <div>
          <p>
            {new Date().toLocaleDateString("zh-CN", {
              month: "long",
              day: "numeric",
              weekday: "long",
            })}
          </p>
          <h1>你好，{actorId === "demo" ? "演示商家" : actorId}</h1>
          <p>把你最关心的工作，放在手边。</p>
        </div>
        <button className="secondary" onClick={() => setEditing(!editing)}>
          <Settings2 size={16} />
          {editing ? "完成自定义" : "自定义主页"}
        </button>
      </div>
      {editing && (
        <fieldset
          disabled={!ready || busy}
          className="home-customizer"
          aria-label="主页模块设置"
        >
          <h2>添加或隐藏模块</h2>
          <p>布局随当前账号保存。使用卡片上的上下移按钮调整顺序。</p>
          <div className="home-module-options">
            {available.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={modules.includes(id)}
                  onChange={(e) =>
                    save(
                      e.target.checked
                        ? [...modules, id]
                        : modules.filter((x) => x !== id),
                    )
                  }
                />
                {labels[id]}
              </label>
            ))}
          </div>
          <button
            className="text-button"
            onClick={() => save(defaults, allowed)}
          >
            恢复默认布局
          </button>
          <h2>常用功能入口</h2>
          <div className="home-module-options">
            {allowed.map((id) => (
              <label key={id}>
                <input
                  type="checkbox"
                  checked={shortcuts.includes(id)}
                  onChange={(e) =>
                    void save(
                      modules,
                      e.target.checked
                        ? [...shortcuts, id]
                        : shortcuts.filter((x) => x !== id),
                    )
                  }
                />
                {labels[id]}
              </label>
            ))}
          </div>
          {legacy && (
            <button className="text-button" onClick={() => void save(legacy)}>
              导入此浏览器的旧布局
            </button>
          )}
        </fieldset>
      )}
      {notice && (
        <p role="status" className="muted">
          {notice}
        </p>
      )}
      <button
        className="text-button"
        disabled={busy}
        onClick={() => void reload()}
      >
        重新载入布局
      </button>
      {!modules.length && (
        <div className="home-card">
          <h2>从你关心的功能开始</h2>
          <button className="secondary" onClick={() => setEditing(true)}>
            <Plus size={16} />
            添加模块
          </button>
        </div>
      )}
      <div className="home-grid">
        {modules.map((id, index) => (
          <section className="home-card" key={id} aria-label={labels[id]}>
            <header>
              <h2>{labels[id]}</h2>
              {editing && (
                <div className="home-order">
                  <button
                    className="icon-button"
                    aria-label={`上移${labels[id]}`}
                    disabled={!index || busy || !ready}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`下移${labels[id]}`}
                    disabled={index === modules.length - 1 || busy || !ready}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown size={16} />
                  </button>
                  <button
                    className="text-button"
                    disabled={busy || !ready}
                    onClick={() => save(modules.filter((x) => x !== id))}
                  >
                    隐藏
                  </button>
                </div>
              )}
            </header>
            {id === "shortcuts" ? (
              <div className="home-links">
                {shortcuts.map((target) => (
                  <button key={target} onClick={() => onOpen(target)}>
                    <span>
                      {labels[target]}
                      <small>{descriptions[target]}</small>
                    </span>
                    <ArrowRight size={17} />
                  </button>
                ))}
              </div>
            ) : id === "rooms" ? (
              <div className="home-rooms">
                {rooms.length ? (
                  rooms.map((room) => (
                    <button key={room.id} onClick={() => onRoom(room.id)}>
                      <span>
                        <strong>{room.title}</strong>
                        <small>{room.productName}</small>
                      </span>
                      <span className={`status ${room.status}`}>
                        {
                          {
                            live: "直播间开放",
                            draft: "待开播",
                            ended: "已结束",
                          }[room.status]
                        }
                      </span>
                    </button>
                  ))
                ) : (
                  <p className="muted">
                    还没有直播间。准备好后可使用上方按钮创建。
                  </p>
                )}
              </div>
            ) : (
              <>
                <p className="muted">{descriptions[id]}</p>
                <button className="secondary" onClick={() => onOpen(id)}>
                  进入{labels[id]}
                  <ArrowRight size={16} />
                </button>
              </>
            )}
          </section>
        ))}
      </div>
      <details className="home-directory">
        <summary>全部功能</summary>
        <div className="home-links">
          {allowed.map((id) => (
            <button key={id} onClick={() => onOpen(id)}>
              {labels[id]}
              <ArrowRight size={16} />
            </button>
          ))}
        </div>
      </details>
    </section>
  );
}
