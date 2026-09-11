import { useEffect, useState } from "react";
import type { AgentProfile } from "../shared/agent.js";
import type {
  GenerationJob,
  GenerationSummary,
  GenerationStatus,
} from "../shared/generation.js";
import { api } from "./api.js";
const labels: Record<GenerationStatus, string> = {
  waiting_configuration: "等待模型配置",
  queued: "排队中",
  running: "生成中",
  failed: "生成中断",
  cancelled: "已取消",
  completed: "生成完成 · 待人工审改",
};
type Page = {
  jobs: GenerationSummary[];
  configured: boolean;
  nextBefore: number | null;
  imports: { jobId: string; receipt: { scriptVersion: number } | null }[];
};
export function GenerationPanel({
  courseId,
  canEdit,
  dirty,
  onImported,
}: {
  courseId: string;
  canEdit: boolean;
  dirty: boolean;
  onImported: () => void;
}) {
  const [open, setOpen] = useState(false),
    [page, setPage] = useState<Page | null>(null),
    [before, setBefore] = useState<number | null>(null);
  const [profiles, setProfiles] = useState<AgentProfile[]>([]),
    [profileId, setProfileId] = useState("standard");
  const [characters, setCharacters] = useState(4000),
    [chapters, setChapters] = useState(4),
    [key, setKey] = useState(() => crypto.randomUUID());
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0);
  const [preview, setPreview] = useState<GenerationJob | null>(null);
  const base = `/merchant/content/courses/${encodeURIComponent(courseId)}/generation`;
  useEffect(() => {
    if (!open) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    setPage(null);
    setError("");
    async function load() {
      try {
        const [data, agents] = await Promise.all([
          api<Page>(base + (before ? `?before=${before}` : "")),
          api<{ profiles: AgentProfile[] }>("/merchant/agent/profiles"),
        ]);
        if (!alive) return;
        setPage(data);
        setProfiles(agents.profiles);
        setError("");
        if (data.jobs.some((j) => ["queued", "running"].includes(j.status)))
          timer = setTimeout(() => void load(), 2000);
      } catch (e) {
        if (alive) {
          setPage(null);
          setError((e as Error).message);
        }
      }
    }
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
    };
  }, [open, base, before, revision]);
  async function act(
    action: "create" | "cancel" | "resume" | "import" | "preview",
    jobId?: string,
  ) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      if (action === "preview") {
        setPreview(null);
        setPreview(
          (
            await api<{ job: GenerationJob }>(
              base + "/" + encodeURIComponent(jobId!),
            )
          ).job,
        );
      } else {
        if (action === "create") {
          const profile = profiles.find((p) => p.id === profileId);
          if (!profile) throw new Error("请选择可用的提示词方案。");
          await api(base, "POST", {
            profileId,
            promptVersion: profile.latestVersion,
            targetCharacters: characters,
            chapterCount: chapters,
            idempotencyKey: key,
          });
          setKey(crypto.randomUUID());
          setBefore(null);
          setNotice(
            "任务已保存，使用所选提示词的最新保存版本；生成结果需人工审改。",
          );
        } else {
          const result = await api<{ scriptVersion?: number }>(
            base + "/" + encodeURIComponent(jobId!) + "/" + action,
            "POST",
            {},
          );
          if (action === "import") {
            setNotice(
              `已导入 V${result.scriptVersion}，请从版本列表打开新稿，核对全文、引用与风险后提交独立审核。`,
            );
            onImported();
          }
        }
        setPreview(null);
        setRevision((n) => n + 1);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <details
      className="cw-divider"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>完整讲稿生成任务</summary>
      {open && (
        <section aria-label="完整讲稿生成任务">
          <p>
            先生成大纲，再分章写稿。目标字数用于引导生成，不等于直播时长。结果为待审核草稿，未完成章节可继续生成。
          </p>
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          {page && !page.configured && (
            <p role="status">
              模型尚未配置：可保存任务，配置完成后点击继续生成；不会使用固定话术冒充生成结果。
            </p>
          )}
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setRevision((n) => n + 1)}
          >
            刷新生成任务
          </button>
          {canEdit && (
            <fieldset disabled={busy || !page || dirty}>
              <label>
                提示词方案
                <select
                  value={profileId}
                  onChange={(e) => {
                    setProfileId(e.target.value);
                    setKey(crypto.randomUUID());
                  }}
                >
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} · 最新保存 V{p.latestVersion}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                目标字数
                <input
                  type="number"
                  min={500}
                  max={12000}
                  value={characters}
                  onChange={(e) => {
                    setCharacters(Number(e.target.value));
                    setKey(crypto.randomUUID());
                  }}
                />
              </label>
              <label>
                章节数
                <input
                  type="number"
                  min={2}
                  max={8}
                  value={chapters}
                  onChange={(e) => {
                    setChapters(Number(e.target.value));
                    setKey(crypto.randomUUID());
                  }}
                />
              </label>
              <button className="primary" onClick={() => void act("create")}>
                创建讲稿生成任务
              </button>
            </fieldset>
          )}
          {dirty && <p>请先保存或放弃本地编辑，再创建任务或导入新稿。</p>}
          {page?.jobs.map((job) => {
            const receipt = page.imports.find(
              (i) => i.jobId === job.id,
            )?.receipt;
            return (
              <article className="cw-divider" key={job.id}>
                <strong>
                  {labels[job.status]} · {job.completedChapters}/
                  {job.chapterCount} 章
                </strong>
                <p>
                  {new Date(job.createdAt).toLocaleString("zh-CN")}
                  {receipt ? ` · 已导入 V${receipt.scriptVersion}` : ""}
                </p>
                {job.error && <p>{job.error}</p>}
                <div className="cw-actions">
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void act("preview", job.id)}
                  >
                    查看大纲与已生成章节
                  </button>
                  {canEdit &&
                    ["failed", "cancelled", "waiting_configuration"].includes(
                      job.status,
                    ) && (
                      <button
                        className="secondary"
                        disabled={busy || !page.configured}
                        onClick={() => void act("resume", job.id)}
                      >
                        继续生成
                      </button>
                    )}
                  {canEdit &&
                    !["completed", "cancelled"].includes(job.status) && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => void act("cancel", job.id)}
                      >
                        取消生成
                      </button>
                    )}
                  {canEdit && job.status === "completed" && !receipt && (
                    <button
                      className="primary"
                      disabled={busy || dirty}
                      onClick={() => void act("import", job.id)}
                    >
                      导入为待审核草稿
                    </button>
                  )}
                </div>
              </article>
            );
          })}
          {page && !page.jobs.length && <p>本页暂无生成任务。</p>}
          {page?.nextBefore && (
            <button
              className="secondary"
              onClick={() => {
                setPreview(null);
                setBefore(page.nextBefore);
              }}
            >
              更早的生成任务
            </button>
          )}
          {before && (
            <button
              className="secondary"
              onClick={() => {
                setPreview(null);
                setBefore(null);
              }}
            >
              返回最新任务
            </button>
          )}
          {preview && (
            <article aria-label="生成结果预览">
              <h3>生成结果预览 · {labels[preview.status]}</h3>
              <p>
                主播：
                {preview.input.prompt.presenter?.displayName || "通用表达"} ·
                提示词：{preview.input.profileId} V{preview.input.promptVersion}{" "}
                · 商品依据 V{preview.input.productVersion}
              </p>
              <ol>
                {preview.outline?.chapters.map((chapter, i) => (
                  <li key={i}>
                    {chapter.title}：{chapter.objective}
                  </li>
                ))}
              </ol>
              {preview.chapters.map((chapter, i) => (
                <section key={i}>
                  <h4>{chapter.title}</h4>
                  {chapter.paragraphs.map((p) => (
                    <div key={p.id}>
                      <p style={{ whiteSpace: "pre-wrap" }}>{p.text}</p>
                      {p.factIds.map((id) => (
                        <small key={id}>
                          依据：
                          {preview.input.facts.find((f) => f.id === id)
                            ?.evidence || "未找到"}
                        </small>
                      ))}
                    </div>
                  ))}
                </section>
              ))}
              {!preview.chapters.length && <p>尚无已生成章节。</p>}
            </article>
          )}
        </section>
      )}
    </details>
  );
}
