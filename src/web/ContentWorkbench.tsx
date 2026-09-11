import { GenerationPanel } from "./GenerationPanel.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ScriptComparison } from "./ScriptComparison.js";
import { ReviewQueue } from "./ReviewQueue.js";
import { ScriptReviewPanel } from "./ScriptReviewPanel.js";
import type { MemberRole } from "../shared/membership.js";
import {
  BookOpen,
  Check,
  ChevronRight,
  FileText,
  Plus,
  Save,
  Trash2,
  Upload,
} from "lucide-react";
import {
  CONTENT_LIMITS,
  type ContentProduct,
  type ProductInput,
  type ProductVersion,
  type ProductFactInput,
  type ContentPlan,
  type PlanInput,
  type ContentCourse,
  type CourseInput,
  type CourseDetail,
  type ScriptParagraph,
  type ScriptInput,
  type ScriptVersion,
  type ContentBinding,
} from "../shared/content";
import type { Room } from "../shared/types";
import { api } from "./api";
import "./content.css";

const path = (route: string) => `/merchant/content${route}`;
const esc = encodeURIComponent;
const date = (time: number) =>
  new Date(time).toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
const reason = (error: unknown) =>
  error instanceof Error ? error.message : "操作未完成，请重试。";
const bodyBytes = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)).length;
async function contentApi<T>(
  route: string,
  method = "GET",
  body?: unknown,
): Promise<T> {
  if (body !== undefined && bodyBytes(body) > CONTENT_LIMITS.requestBytes)
    throw new Error("本次资料超过可保存大小，请减少内容后重试。");
  return api<T>(path(route), method, body);
}
function useAlive() {
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  return alive;
}
function Feedback({ error, notice }: { error?: string; notice?: string }) {
  return (
    <>
      {error && (
        <p className="cw-alert" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="cw-notice" role="status">
          {notice}
        </p>
      )}
    </>
  );
}
const emptyFact = (): ProductFactInput => ({
  id: crypto.randomUUID(),
  text: "",
  evidence: "",
  approved: false,
});
const emptyParagraph = (): ScriptParagraph => ({
  id: crypto.randomUUID(),
  kind: "fact",
  text: "",
  factIds: [],
});
const titleState = (script: ScriptVersion) =>
  script.stale
    ? "依据已变化"
    : script.state === "final"
      ? "已人工定稿"
      : script.state === "pending_review"
        ? "待独立审核"
        : script.state === "changes_requested"
          ? "已退回修改"
          : script.state === "needs_review"
            ? "需要审改"
            : "草稿";
type Draft = {
  paragraphs: ScriptParagraph[];
  changeNote: string;
  selectedVersion: number;
  baseline: string;
};

export function ContentWorkbench({
  rooms,
  memberRole = "owner",
  onBound,
}: {
  rooms: Room[];
  memberRole?: MemberRole;
  onBound?: (binding: ContentBinding) => void;
}) {
  const alive = useAlive();
  const canEdit = memberRole === "owner" || memberRole === "editor";
  const [products, setProducts] = useState<ContentProduct[]>([]),
    [productId, setProductId] = useState("");
  const [loading, setLoading] = useState(true),
    [create, setCreate] = useState(false),
    [error, setError] = useState("");
  const drafts = useRef(new Map<string, Draft>());
  async function refresh() {
    try {
      const result = await contentApi<{ products: ContentProduct[] }>(
        "/products",
      );
      if (alive.current) {
        setProducts(result.products);
        setProductId((old) =>
          result.products.some((p) => p.id === old)
            ? old
            : result.products[0]?.id || "",
        );
        setError("");
      }
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);
  const product = products.find((item) => item.id === productId);
  return (
    <div className="cw-root">
      {["owner", "reviewer"].includes(memberRole) && <ReviewQueue />}
      <div className="cw-toolbar">
        <label>
          当前商品
          <select
            value={productId}
            disabled={create}
            onChange={(e) => setProductId(e.target.value)}
          >
            {!products.length && (
              <option value="">
                {loading ? "正在读取商品…" : "尚未建立商品"}
              </option>
            )}
            {products.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
                {item.sku ? ` · ${item.sku}` : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="secondary"
          disabled={create || !canEdit}
          onClick={() => setCreate(true)}
        >
          <Plus size={14} />
          新增商品
        </button>
        <button
          type="button"
          className="secondary"
          onClick={() => void refresh()}
        >
          刷新
        </button>
        <span className="cw-meta">
          {product
            ? `${product.category} · 资料 V${product.latestVersion}`
            : "先整理商品资料，无需先创建直播间。"}
        </span>
      </div>
      <div className="cw-flow" aria-label="内容制作流程">
        <span>商品资料</span>
        <ChevronRight size={12} />
        <span>课程讲稿</span>
        <ChevronRight size={12} />
        <span>审改定稿</span>
        <ChevronRight size={12} />
        <span>真人直播</span>
      </div>
      <Feedback error={error} />
      {create && (
        <ProductForm
          onCancel={() => setCreate(false)}
          onSaved={(saved) => {
            setProducts((old) => [
              saved,
              ...old.filter((item) => item.id !== saved.id),
            ]);
            setProductId(saved.id);
            setCreate(false);
          }}
        />
      )}
      {product ? (
        <ProductWorkspace
          key={product.id}
          product={product}
          memberRole={memberRole}
          rooms={rooms}
          drafts={drafts.current}
          onUpdated={(updated) =>
            setProducts((old) =>
              old.map((item) => (item.id === updated.id ? updated : item)),
            )
          }
          onBound={onBound}
        />
      ) : (
        !loading &&
        !create && (
          <div className="cw-empty">
            先建立真实商品的名称、SKU、类别和依据，再安排课程与撰写讲稿。资料与样例均由商家提供，系统不会自动填入产品功效。
          </div>
        )
      )}
    </div>
  );
}
function ProductForm({
  product,
  version,
  onCancel,
  onSaved,
}: {
  product?: ContentProduct;
  version?: ProductVersion;
  onCancel: () => void;
  onSaved: (product: ContentProduct, version: ProductVersion) => void;
}) {
  const formPanel = useRef<HTMLElement>(null);
  useEffect(() => {
    if (window.matchMedia("(max-width: 700px)").matches) {
      formPanel.current?.scrollIntoView({
        block: "start",
        behavior: "instant",
      });
      formPanel.current?.focus({ preventScroll: true });
    }
  }, []);
  const alive = useAlive();
  const [input, setInput] = useState<ProductInput>({
    name: version?.name || "",
    sku: version?.sku || "",
    category: version?.category || "",
    facts: structuredClone(version?.facts || []),
  });
  const [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  function editFact(index: number, patch: Partial<ProductFactInput>) {
    setInput((old) => ({
      ...old,
      facts: old.facts.map((fact, at) =>
        at === index
          ? {
              ...fact,
              ...patch,
              ...("text" in patch || "evidence" in patch
                ? { approved: false }
                : {}),
            }
          : fact,
      ),
    }));
  }
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await contentApi<{
        product: ContentProduct;
        version: ProductVersion;
      }>(
        product ? `/products/${esc(product.id)}/versions` : "/products",
        "POST",
        product ? { baseVersion: version!.version, ...input } : input,
      );
      if (alive.current) onSaved(result.product, result.version);
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section
      className="cw-form-panel"
      ref={formPanel}
      tabIndex={-1}
      aria-label="商品资料编辑"
    >
      <div className="cw-section-header">
        <h2>{product ? "编辑商品资料" : "建立商品资料"}</h2>
        <small>
          {product
            ? `以 V${version?.version} 为基础保存新版本`
            : "资料审核由商家负责"}
        </small>
      </div>
      <fieldset disabled={busy}>
        <div className="cw-three">
          <label>
            商品名称
            <input
              value={input.name}
              maxLength={120}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
            />
          </label>
          <label>
            SKU / 商品编码
            <input
              value={input.sku}
              maxLength={80}
              onChange={(e) => setInput({ ...input, sku: e.target.value })}
            />
          </label>
          <label>
            商品类别
            <input
              value={input.category}
              maxLength={80}
              onChange={(e) => setInput({ ...input, category: e.target.value })}
              placeholder="按真实标签填写类别"
            />
          </label>
        </div>
        <div className="cw-section-header">
          <h3>
            事实与证据 · {input.facts.length} / {CONTENT_LIMITS.facts}
          </h3>
          <button
            type="button"
            className="secondary"
            disabled={input.facts.length >= CONTENT_LIMITS.facts}
            onClick={() =>
              setInput({ ...input, facts: [...input.facts, emptyFact()] })
            }
          >
            <Plus size={13} />
            添加事实
          </button>
        </div>
        <div className="cw-facts">
          {input.facts.map((fact, index) => (
            <div className="cw-fact" key={fact.id || index}>
              <div className="cw-two">
                <label>
                  事实 {index + 1}
                  <textarea
                    rows={2}
                    maxLength={400}
                    value={fact.text}
                    onChange={(e) => editFact(index, { text: e.target.value })}
                    placeholder="从商品标签或原始材料中摘录可核实内容"
                  />
                </label>
                <label>
                  依据与出处
                  <textarea
                    rows={2}
                    maxLength={500}
                    value={fact.evidence}
                    onChange={(e) =>
                      editFact(index, { evidence: e.target.value })
                    }
                    placeholder="原始文件名称、页码、日期或官方链接"
                  />
                </label>
              </div>
              <div className="cw-actions">
                <label className="cw-check">
                  <input
                    type="checkbox"
                    checked={fact.approved}
                    disabled={!fact.text.trim() || !fact.evidence.trim()}
                    onChange={(e) =>
                      editFact(index, { approved: e.target.checked })
                    }
                  />
                  我已核对原始依据，确认该事实适用于此商品
                </label>
                <button
                  type="button"
                  className="secondary"
                  aria-label={`移除事实 ${index + 1}`}
                  onClick={() =>
                    setInput({
                      ...input,
                      facts: input.facts.filter((_, at) => at !== index),
                    })
                  }
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="cw-meta">
          修改事实文字或出处会撤回这一条的核对状态。保存商品新版本后，旧讲稿需要按当前资料重新复核。
        </p>
        <div className="cw-actions">
          <button
            type="button"
            className="primary"
            disabled={
              !input.name.trim() ||
              !input.sku.trim() ||
              !input.category.trim() ||
              input.facts.some(
                (fact) => !fact.text.trim() || !fact.evidence.trim(),
              )
            }
            onClick={() => void save()}
          >
            <Save size={14} />
            {busy ? "正在保存…" : "保存商品资料"}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            取消编辑
          </button>
        </div>
      </fieldset>
      <Feedback error={error} />
    </section>
  );
}
function ProductWorkspace({
  product,
  memberRole,
  rooms,
  drafts,
  onUpdated,
  onBound,
}: {
  product: ContentProduct;
  memberRole: MemberRole;
  rooms: Room[];
  drafts: Map<string, Draft>;
  onUpdated: (product: ContentProduct) => void;
  onBound?: (binding: ContentBinding) => void;
}) {
  const alive = useAlive();
  const canEdit = memberRole === "owner" || memberRole === "editor";
  const [versions, setVersions] = useState<ProductVersion[]>([]),
    [plans, setPlans] = useState<ContentPlan[]>([]),
    [planId, setPlanId] = useState("");
  const [courses, setCourses] = useState<ContentCourse[]>([]),
    [courseId, setCourseId] = useState("");
  const [view, setView] = useState<"facts" | "plan" | "script">("facts"),
    [editing, setEditing] = useState(false),
    [newPlan, setNewPlan] = useState(false),
    [newCourse, setNewCourse] = useState(false);
  const [editingPlan, setEditingPlan] = useState<ContentPlan | null>(null);
  const [editingCourse, setEditingCourse] = useState<ContentCourse | null>(
    null,
  );
  const [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const current = versions.reduce<ProductVersion | null>(
    (best, item) => (!best || item.version > best.version ? item : best),
    null,
  );
  const plan = plans.find((item) => item.id === planId);
  const course = courses.find((item) => item.id === courseId);
  const planRef = useRef(planId);
  planRef.current = planId;
  const loadSequence = useRef(0);
  const productLoadSequence = useRef(0);
  async function load() {
    const sequence = ++productLoadSequence.current;
    const results = await Promise.allSettled([
      contentApi<{ product: ContentProduct; versions: ProductVersion[] }>(
        `/products/${esc(product.id)}`,
      ),
      contentApi<{ plans: ContentPlan[] }>(
        `/plans?productId=${esc(product.id)}`,
      ),
    ]);
    if (!alive.current || sequence !== productLoadSequence.current) return;
    if (results[0].status === "fulfilled") {
      setVersions(results[0].value.versions);
      onUpdated(results[0].value.product);
    }
    if (results[1].status === "fulfilled") {
      setPlans(results[1].value.plans);
      setPlanId((old) =>
        results[1].status === "fulfilled" &&
        results[1].value.plans.some((item) => item.id === old)
          ? old
          : results[1].status === "fulfilled"
            ? results[1].value.plans[0]?.id || ""
            : old,
      );
    }
    const failed = results.find((item) => item.status === "rejected");
    if (failed?.status === "rejected") setError(reason(failed.reason));
  }
  useEffect(() => {
    void load();
  }, [product.id, product.latestVersion]);
  async function loadCourses(id: string) {
    const sequence = ++loadSequence.current;
    try {
      const result = await contentApi<{
        plan: ContentPlan;
        courses: ContentCourse[];
      }>(`/plans/${esc(id)}`);
      if (
        alive.current &&
        planRef.current === id &&
        sequence === loadSequence.current
      ) {
        setCourses(result.courses);
        setCourseId((old) =>
          result.courses.some((item) => item.id === old)
            ? old
            : result.courses[0]?.id || "",
        );
      }
    } catch (e) {
      if (
        alive.current &&
        planRef.current === id &&
        sequence === loadSequence.current
      )
        setError(reason(e));
    }
  }
  useEffect(() => {
    setCourses([]);
    setCourseId("");
    setNewCourse(false);
    setEditingPlan(null);
    setEditingCourse(null);
    if (planId) void loadCourses(planId);
  }, [planId]);
  const tabs = (
    <nav className="cw-main-tabs" aria-label="课程与讲稿步骤">
      <button
        type="button"
        className={view === "facts" ? "active" : ""}
        onClick={() => setView("facts")}
      >
        商品资料
      </button>
      <button
        type="button"
        className={view === "plan" ? "active" : ""}
        onClick={() => setView("plan")}
      >
        课程课纲
      </button>
      <button
        type="button"
        className={view === "script" ? "active" : ""}
        onClick={() => setView("script")}
      >
        讲稿与审改
      </button>
    </nav>
  );
  return (
    <>
      <Feedback error={error} notice={notice} />
      {editing && current && (
        <ProductForm
          key={current.version}
          product={product}
          version={current}
          onCancel={() => setEditing(false)}
          onSaved={(saved, version) => {
            onUpdated(saved);
            setVersions((old) => [version, ...old]);
            setEditing(false);
            setNotice(
              "已保存商品新版本。请按当前资料检查讲稿的引用与定稿状态。",
            );
          }}
        />
      )}
      <div className="cw-grid">
        <aside className="cw-sidebar">
          <div className="cw-panel-heading">
            <h2>课程目录</h2>
            <button
              type="button"
              className="secondary"
              onClick={() => {
                setNewPlan(true);
                setView("plan");
              }}
              aria-label="建立课程计划"
              disabled={!canEdit}
            >
              <Plus size={13} />
            </button>
          </div>
          <div className="cw-panel-body">
            <div className="cw-courses">
              {plans.map((item) => (
                <button
                  key={item.id}
                  className={`cw-course ${item.id === planId ? "selected" : ""}`}
                  onClick={() => {
                    setPlanId(item.id);
                    setView("plan");
                  }}
                >
                  <strong>{item.name}</strong>
                  <span>
                    {item.totalDays} 天 · {item.audience || "受众待补充"}
                  </span>
                </button>
              ))}
            </div>
            {!plans.length && (
              <p className="cw-meta">
                还没有课程计划。先确定周期和受众，再逐天安排课时。
              </p>
            )}
            {plan && (
              <button
                type="button"
                className="secondary"
                disabled={!canEdit}
                onClick={() => {
                  setNewCourse(true);
                  setView("plan");
                }}
              >
                <Plus size={13} />
                添加课时
              </button>
            )}
          </div>
          <div className="cw-lessons">
            {[...courses]
              .sort(
                (a, b) => a.dayIndex - b.dayIndex || a.createdAt - b.createdAt,
              )
              .map((item) => (
                <button
                  key={item.id}
                  className={`cw-lesson ${item.id === courseId ? "selected" : ""}`}
                  onClick={() => {
                    setCourseId(item.id);
                    setView("script");
                  }}
                >
                  <strong>
                    第 {item.dayIndex} 天 · {item.title}
                  </strong>
                  <span>
                    {item.scheduleLabel || "时间待安排"} ·{" "}
                    {item.durationMinutes} 分钟 ·{" "}
                    {item.latestScriptVersion
                      ? `讲稿 V${item.latestScriptVersion}`
                      : "未写稿"}
                  </span>
                </button>
              ))}
          </div>
        </aside>
        {view === "script" && current && course ? (
          <CourseEditor
            key={`${course.id}:${current.version}`}
            product={product}
            memberRole={memberRole}
            productVersion={current}
            course={course}
            rooms={rooms}
            tabs={tabs}
            drafts={drafts}
            onSaved={() => {
              if (planId) void loadCourses(planId);
            }}
            onBound={onBound}
            onEditCourse={() => {
              setEditingCourse(course);
              setNewCourse(false);
              setView("plan");
            }}
            onRefreshProduct={() => void load()}
          />
        ) : (
          <>
            <main className="cw-main">
              {tabs}
              <div className="cw-section">
                {view === "facts" ? (
                  <>
                    <div className="cw-section-header">
                      <h2>{product.name}</h2>
                      <div className="cw-actions">
                        <button
                          type="button"
                          className="secondary"
                          disabled={!current || editing || !canEdit}
                          onClick={() => setEditing(true)}
                        >
                          编辑与核对资料
                        </button>
                        <button
                          type="button"
                          className="secondary"
                          onClick={() => {
                            setError("");
                            void load();
                          }}
                        >
                          刷新资料
                        </button>
                      </div>
                    </div>
                    <p className="cw-meta">
                      SKU：{product.sku} · {product.category} · 当前 V
                      {current?.version || product.latestVersion}
                    </p>
                    {current ? (
                      <>
                        <div className="cw-facts">
                          {current.facts.map((fact, index) => (
                            <article className="cw-fact" key={fact.id}>
                              <div className="cw-section-header">
                                <strong>事实 {index + 1}</strong>
                                <span
                                  className={`cw-badge ${fact.approved ? "good" : ""}`}
                                >
                                  {fact.approved ? "商家已核对" : "待核对"}
                                </span>
                              </div>
                              <p>{fact.text}</p>
                              <p className="cw-source">{fact.evidence}</p>
                            </article>
                          ))}
                        </div>
                        {!current.facts.length && (
                          <p className="cw-empty">
                            尚未录入商品依据。编辑资料后，可逐条录入事实与出处并核对。
                          </p>
                        )}
                        <details className="cw-compact-details">
                          <summary>商品资料版本 · {versions.length}</summary>
                          <div>
                            {versions.map((version) => (
                              <p className="cw-meta" key={version.version}>
                                V{version.version} · {date(version.createdAt)} ·{" "}
                                {
                                  version.facts.filter((fact) => fact.approved)
                                    .length
                                }{" "}
                                / {version.facts.length} 条已核对
                              </p>
                            ))}
                          </div>
                        </details>
                      </>
                    ) : (
                      <p className="cw-empty">正在读取商品资料…</p>
                    )}
                  </>
                ) : (
                  <>
                    {(newPlan || !plans.length) && (
                      <PlanForm
                        productId={product.id}
                        onCancel={() => setNewPlan(false)}
                        onSaved={(saved) => {
                          setPlans((old) => [saved, ...old]);
                          setPlanId(saved.id);
                          setNewPlan(false);
                          setNotice(
                            `已建立 ${saved.totalDays} 天课程计划。课时和讲稿仍需逐条准备。`,
                          );
                        }}
                      />
                    )}
                    {plan && (
                      <>
                        {editingPlan && (
                          <PlanForm
                            key={editingPlan.id}
                            productId={product.id}
                            existing={editingPlan}
                            onCancel={() => setEditingPlan(null)}
                            onSaved={(saved) => {
                              ++productLoadSequence.current;
                              setPlans((old) =>
                                old.map((item) =>
                                  item.id === saved.id ? saved : item,
                                ),
                              );
                              setEditingPlan(null);
                              setNotice(
                                "课程计划已更新，现有课时与讲稿继续保留。",
                              );
                            }}
                          />
                        )}
                        <div className="cw-section-header">
                          <h2>{plan.name}</h2>
                          <div className="cw-actions">
                            <button
                              type="button"
                              className="secondary"
                              disabled={!canEdit}
                              onClick={() => {
                                setEditingPlan(plan);
                                setNewPlan(false);
                              }}
                            >
                              修改计划
                            </button>
                            <button
                              type="button"
                              className="secondary"
                              disabled={!canEdit}
                              onClick={() => {
                                setNewCourse(true);
                                setEditingCourse(null);
                              }}
                            >
                              <Plus size={13} />
                              添加课时
                            </button>
                          </div>
                        </div>
                        <p className="cw-meta">
                          {plan.totalDays} 天 · {courses.length} 个已安排课时 ·
                          受众：{plan.audience || "未填写"}
                        </p>
                        <p className="cw-meta">
                          课纲记录计划，不会自动生成讲稿或开启直播。同一天可安排多个课时。
                        </p>
                        {(newCourse || editingCourse) && (
                          <CourseForm
                            key={editingCourse?.id || `new:${plan.id}`}
                            plan={plan}
                            existing={editingCourse || undefined}
                            onCancel={() => {
                              setNewCourse(false);
                              setEditingCourse(null);
                            }}
                            onSaved={(saved) => {
                              ++loadSequence.current;
                              setCourses((old) => [
                                ...old.filter((item) => item.id !== saved.id),
                                saved,
                              ]);
                              setCourseId(saved.id);
                              setNewCourse(false);
                              setEditingCourse(null);
                              setView("script");
                            }}
                          />
                        )}
                        <div className="cw-table-scroll">
                          <table className="cw-table">
                            <thead>
                              <tr>
                                <th>日期</th>
                                <th>课时与目标</th>
                                <th>安排</th>
                                <th>讲稿</th>
                              </tr>
                            </thead>
                            <tbody>
                              {[...courses]
                                .sort(
                                  (a, b) =>
                                    a.dayIndex - b.dayIndex ||
                                    a.createdAt - b.createdAt,
                                )
                                .map((item) => (
                                  <tr key={item.id}>
                                    <td>第 {item.dayIndex} 天</td>
                                    <td>
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setCourseId(item.id);
                                          setView("script");
                                        }}
                                      >
                                        {item.title}
                                      </button>
                                      <p className="cw-meta">
                                        {item.objective}
                                      </p>
                                    </td>
                                    <td>
                                      {item.scheduleLabel || "时间待定"}
                                      <br />
                                      {item.durationMinutes} 分钟
                                      <br />
                                      {item.presenterName || "主播待定"}
                                      <br />
                                      <button
                                        type="button"
                                        disabled={!canEdit}
                                        onClick={() => {
                                          setEditingCourse(item);
                                          setNewCourse(false);
                                        }}
                                      >
                                        修改安排
                                      </button>
                                    </td>
                                    <td>
                                      {item.latestScriptVersion
                                        ? `V${item.latestScriptVersion}`
                                        : "未写稿"}
                                    </td>
                                  </tr>
                                ))}
                            </tbody>
                          </table>
                        </div>
                        {!courses.length && (
                          <p className="cw-empty">
                            计划已建立，尚未安排具体课时。添加标题、目标和真人主播安排后开始写稿。
                          </p>
                        )}
                      </>
                    )}
                    {!plan && plans.length > 0 && (
                      <p className="cw-empty">从左侧选择课程计划。</p>
                    )}
                  </>
                )}
              </div>
            </main>
            <details className="cw-review-panel cw-guidance">
              <summary className="cw-panel-heading">
                <h2>{view === "facts" ? "依据先行" : "制作进度"}</h2>
                <BookOpen size={15} />
              </summary>
              <div className="cw-panel-body">
                <p className="cw-meta">
                  {view === "facts"
                    ? "仅已核对的商品事实可用于讲稿引用。改变商品类别、SKU 或证据后，应重新核对旧讲稿。"
                    : "周期天数表示内容计划。只有实际创建的课时和保存的讲稿才会出现在目录中。"}
                </p>
                <div className="cw-divider">
                  <h3>当前制作方式</h3>
                  <p className="cw-meta">
                    人工写稿与导入，保存时按段进行规则检查。长稿任务支持分章生成；模型未配置时等待，不生成示例稿。
                  </p>
                </div>
                <div className="cw-divider">
                  <h3>定稿的边界</h3>
                  <p className="cw-meta">
                    团队和生产空间由另一审核账号批准定稿。替换敏感词不能消除原有功效或比较性承诺。
                  </p>
                </div>
              </div>
            </details>
          </>
        )}
      </div>
    </>
  );
}
function PlanForm({
  productId,
  existing,
  onSaved,
  onCancel,
}: {
  productId: string;
  existing?: ContentPlan;
  onSaved: (plan: ContentPlan) => void;
  onCancel: () => void;
}) {
  const alive = useAlive();
  const [input, setInput] = useState<PlanInput>({
      productId,
      name: existing?.name || "",
      audience: existing?.audience || "",
      totalDays: existing?.totalDays || 45,
    }),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await contentApi<{ plan: ContentPlan }>(
        existing ? `/plans/${esc(existing.id)}` : "/plans",
        existing ? "PATCH" : "POST",
        existing
          ? {
              name: input.name,
              audience: input.audience,
              totalDays: input.totalDays,
              base: {
                name: existing.name,
                audience: existing.audience,
                totalDays: existing.totalDays,
              },
            }
          : input,
      );
      if (alive.current) onSaved(result.plan);
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="cw-inline-editor">
      <h3>{existing ? "修改课程计划" : "建立课程计划"}</h3>
      <fieldset disabled={busy}>
        <div className="cw-two">
          <label>
            课程计划名称
            <input
              value={input.name}
              maxLength={120}
              onChange={(e) => setInput({ ...input, name: e.target.value })}
            />
          </label>
          <label>
            计划周期（天）
            <input
              type="number"
              min={1}
              max={365}
              value={input.totalDays}
              onChange={(e) =>
                setInput({ ...input, totalDays: Number(e.target.value) })
              }
            />
          </label>
        </div>
        <label>
          目标受众
          <textarea
            rows={2}
            maxLength={500}
            value={input.audience}
            onChange={(e) => setInput({ ...input, audience: e.target.value })}
          />
        </label>
        <p className="cw-meta">
          {existing
            ? "修改周期不会删除已安排的课时，周期须覆盖最后一个课时。"
            : "45 天是可调整的默认周期；保存后不会自动产生 45 篇讲稿。"}
        </p>
        <div className="cw-actions">
          <button
            type="button"
            className="primary"
            disabled={
              !input.name.trim() ||
              !Number.isInteger(input.totalDays) ||
              input.totalDays < 1 ||
              input.totalDays > 365
            }
            onClick={() => void save()}
          >
            保存课程计划
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            取消
          </button>
        </div>
      </fieldset>
      <Feedback error={error} />
    </section>
  );
}
function CourseForm({
  plan,
  existing,
  onSaved,
  onCancel,
}: {
  plan: ContentPlan;
  existing?: ContentCourse;
  onSaved: (course: ContentCourse) => void;
  onCancel: () => void;
}) {
  const alive = useAlive();
  const base: CourseInput = {
    title: existing?.title || "",
    dayIndex: existing?.dayIndex || 1,
    objective: existing?.objective || "",
    durationMinutes: existing?.durationMinutes || 45,
    scheduleLabel: existing?.scheduleLabel || "",
    presenterName: existing?.presenterName || "",
  };
  const [input, setInput] = useState<CourseInput>(base),
    [busy, setBusy] = useState(false),
    [error, setError] = useState("");
  async function save() {
    setBusy(true);
    setError("");
    try {
      const result = await contentApi<{ course: ContentCourse }>(
        existing
          ? `/courses/${esc(existing.id)}`
          : `/plans/${esc(plan.id)}/courses`,
        existing ? "PATCH" : "POST",
        existing ? { ...input, base } : input,
      );
      if (alive.current) onSaved(result.course);
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <section className="cw-inline-editor">
      <h3>{existing ? "修改课时安排" : "安排课时"}</h3>
      <fieldset disabled={busy}>
        <label>
          课时标题
          <input
            value={input.title}
            maxLength={120}
            onChange={(e) => setInput({ ...input, title: e.target.value })}
          />
        </label>
        <div className="cw-three">
          <label>
            课程第几天
            <input
              type="number"
              min={1}
              max={plan.totalDays}
              value={input.dayIndex}
              onChange={(e) =>
                setInput({ ...input, dayIndex: Number(e.target.value) })
              }
            />
          </label>
          <label>
            目标时长（分钟）
            <input
              type="number"
              min={1}
              max={180}
              value={input.durationMinutes}
              onChange={(e) =>
                setInput({ ...input, durationMinutes: Number(e.target.value) })
              }
            />
          </label>
          <label>
            计划时间
            <input
              value={input.scheduleLabel}
              maxLength={80}
              onChange={(e) =>
                setInput({ ...input, scheduleLabel: e.target.value })
              }
              placeholder="例如：上午 9:00"
            />
          </label>
        </div>
        <label>
          真人主播安排
          <input
            value={input.presenterName}
            maxLength={80}
            onChange={(e) =>
              setInput({ ...input, presenterName: e.target.value })
            }
            placeholder="可留空，之后由业务确认"
          />
        </label>
        <label>
          本课目标
          <textarea
            rows={2}
            maxLength={1000}
            value={input.objective}
            onChange={(e) => setInput({ ...input, objective: e.target.value })}
          />
        </label>
        <div className="cw-actions">
          <button
            type="button"
            className="primary"
            disabled={
              !input.title.trim() ||
              !Number.isInteger(input.dayIndex) ||
              input.dayIndex < 1 ||
              input.dayIndex > plan.totalDays ||
              !Number.isInteger(input.durationMinutes) ||
              !input.durationMinutes ||
              input.durationMinutes < 1 ||
              input.durationMinutes > 180
            }
            onClick={() => void save()}
          >
            {existing ? "保存课时修改" : "保存课时，开始写稿"}
          </button>
          <button type="button" className="secondary" onClick={onCancel}>
            取消
          </button>
        </div>
      </fieldset>
      <Feedback error={error} />
    </section>
  );
}
function CourseEditor({
  product,
  memberRole,
  productVersion,
  course,
  rooms,
  tabs,
  drafts,
  onSaved,
  onBound,
  onEditCourse,
  onRefreshProduct,
}: {
  product: ContentProduct;
  memberRole: MemberRole;
  productVersion: ProductVersion;
  course: ContentCourse;
  rooms: Room[];
  tabs: ReactNode;
  drafts: Map<string, Draft>;
  onSaved: () => void;
  onBound?: (binding: ContentBinding) => void;
  onEditCourse: () => void;
  onRefreshProduct: () => void;
}) {
  const alive = useAlive();
  const canEdit = memberRole === "owner" || memberRole === "editor";
  const savedDraft = drafts.get(course.id);
  const readSequence = useRef(0);
  const bindingReadSequence = useRef(0);
  const [bindingRefresh, setBindingRefresh] = useState(0);
  const [detail, setDetail] = useState<CourseDetail | null>(null),
    [selectedVersion, setSelectedVersion] = useState(
      savedDraft?.selectedVersion || 0,
    );
  const [paragraphs, setParagraphs] = useState<ScriptParagraph[]>(
      savedDraft?.paragraphs || [emptyParagraph()],
    ),
    [changeNote, setChangeNote] = useState(savedDraft?.changeNote || ""),
    [baseline, setBaseline] = useState(savedDraft?.baseline || "");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [confirmationNote, setConfirmationNote] = useState(""),
    [acknowledged, setAcknowledged] = useState(false);
  const [requiresReview, setRequiresReview] = useState(true);
  const [roomId, setRoomId] = useState(rooms[0]?.id || ""),
    [binding, setBinding] = useState<ContentBinding | null>(null),
    [bindingError, setBindingError] = useState("");
  const [activeParagraph, setActiveParagraph] = useState(
    paragraphs[0]?.id || "",
  );
  const signature = JSON.stringify({ paragraphs, changeNote });
  const dirty =
    signature !== baseline &&
    (paragraphs.some((p) => p.text.trim()) ||
      Boolean(changeNote) ||
      Boolean(baseline));
  const signatureRef = useRef(signature);
  signatureRef.current = signature;
  const latest = detail
    ? Math.max(0, ...detail.versions.map((version) => version.version))
    : 0;
  const selected = detail?.versions.find(
    (version) => version.version === selectedVersion,
  );
  const paragraph =
    paragraphs.find((item) => item.id === activeParagraph) || paragraphs[0];
  const totalCharacters = paragraphs.reduce(
    (sum, item) => sum + item.text.length,
    0,
  );
  const approvedFacts = productVersion.facts.filter((fact) => fact.approved);
  const selectedRoomRef = useRef(roomId);
  selectedRoomRef.current = roomId;
  useEffect(() => {
    if (loading || !detail) return;
    drafts.set(course.id, {
      paragraphs,
      changeNote,
      selectedVersion,
      baseline,
    });
  }, [
    paragraphs,
    changeNote,
    selectedVersion,
    baseline,
    course.id,
    loading,
    detail,
  ]);
  function loadScript(script?: ScriptVersion) {
    const next = script
      ? structuredClone(script.paragraphs)
      : [emptyParagraph()];
    setParagraphs(next);
    setChangeNote(script?.changeNote || "");
    setSelectedVersion(script?.version || 0);
    setBaseline(
      JSON.stringify({
        paragraphs: next,
        changeNote: script?.changeNote || "",
      }),
    );
    setActiveParagraph(next[0]?.id || "");
    setAcknowledged(false);
    setConfirmationNote("");
    setNotice("");
  }
  async function refresh(preserveDraft = true) {
    const sequence = ++readSequence.current;
    try {
      const response = await contentApi<CourseDetail>(
        `/courses/${esc(course.id)}`,
      );
      if (!alive.current || sequence !== readSequence.current) return;
      setDetail(response);
      if (!preserveDraft)
        loadScript(
          [...response.versions].sort((a, b) => b.version - a.version)[0],
        );
      setError("");
    } catch (e) {
      if (alive.current && sequence === readSequence.current)
        setError(reason(e));
    } finally {
      if (alive.current && sequence === readSequence.current) setLoading(false);
    }
  }
  useEffect(() => {
    void refresh(Boolean(savedDraft));
  }, [course.id]);
  useEffect(() => {
    if (!roomId && rooms[0]) setRoomId(rooms[0].id);
  }, [rooms, roomId]);
  useEffect(() => {
    let cancelled = false;
    const sequence = ++bindingReadSequence.current;
    setBinding(null);
    setBindingError("");
    if (roomId)
      contentApi<{ binding: ContentBinding | null }>(
        `/rooms/${esc(roomId)}/binding`,
      )
        .then((response) => {
          if (!cancelled && sequence === bindingReadSequence.current)
            setBinding(response.binding);
        })
        .catch((e) => {
          if (!cancelled && sequence === bindingReadSequence.current)
            setBindingError(reason(e));
        });
    return () => {
      cancelled = true;
    };
  }, [roomId, selected?.stale, productVersion.version, bindingRefresh]);
  function editParagraph(id: string, patch: Partial<ScriptParagraph>) {
    setParagraphs((old) =>
      old.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
    setAcknowledged(false);
  }
  async function upload(file?: File) {
    if (!file) return;
    setBusy(true);
    setError("");
    const captured = signatureRef.current;
    try {
      if (file.size > CONTENT_LIMITS.requestBytes)
        throw new Error("文件过大，请拆分课时后导入。");
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true })
          .decode(await file.arrayBuffer())
          .replace(/^\uFEFF/, "");
      } catch {
        throw new Error("请使用 UTF-8 编码的文字文件。");
      }
      const chunks = text
        .replace(/\r\n/g, "\n")
        .split(/\n\s*\n/)
        .map((part) => part.trim())
        .filter(Boolean);
      if (!chunks.length) throw new Error("文件没有可导入的文字。");
      if (
        chunks.length > CONTENT_LIMITS.paragraphs ||
        chunks.some(
          (part) => part.length > CONTENT_LIMITS.paragraphCharacters,
        ) ||
        chunks.reduce((n, p) => n + p.length, 0) >
          CONTENT_LIMITS.scriptCharacters
      )
        throw new Error(
          `请按空行分段：每段最多 ${CONTENT_LIMITS.paragraphCharacters} 字，每课最多 ${CONTENT_LIMITS.paragraphs} 段、${CONTENT_LIMITS.scriptCharacters} 字。`,
        );
      if (alive.current && captured === signatureRef.current) {
        const next = chunks.map((text) => ({ ...emptyParagraph(), text }));
        setParagraphs(next);
        setActiveParagraph(next[0].id);
        setChangeNote(`导入文件：${file.name}`.slice(0, 500));
        setAcknowledged(false);
        setNotice("文字已导入编辑区，尚未保存。请逐段选择类型并补齐商品依据。");
      }
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function save() {
    ++readSequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const input: ScriptInput = {
        baseVersion: latest,
        productVersion: productVersion.version,
        paragraphs,
        changeNote,
      };
      const result = await contentApi<{ script: ScriptVersion }>(
        `/courses/${esc(course.id)}/scripts`,
        "POST",
        input,
      );
      if (!alive.current) return;
      setDetail((old) =>
        old
          ? {
              ...old,
              versions: [
                result.script,
                ...old.versions.filter(
                  (item) => item.version !== result.script.version,
                ),
              ],
              course: {
                ...old.course,
                latestScriptVersion: result.script.version,
              },
            }
          : old,
      );
      loadScript(result.script);
      setNotice(
        `已保存 V${result.script.version} 草稿，并完成本地规则检查；请查看逐段提示。`,
      );
      onSaved();
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function confirm() {
    if (!selected) return;
    ++readSequence.current;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await contentApi<{ script: ScriptVersion }>(
        `/courses/${esc(course.id)}/scripts/${selected.version}/confirm`,
        "POST",
        { note: confirmationNote, acknowledged: true },
      );
      if (!alive.current) return;
      setDetail((old) =>
        old
          ? {
              ...old,
              versions: old.versions.map((item) =>
                item.version === result.script.version ? result.script : item,
              ),
            }
          : old,
      );
      setNotice("已记录商家本人定稿确认。请选择直播间绑定这一版本。");
      setAcknowledged(false);
    } catch (e) {
      if (alive.current) setError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function bind() {
    if (!selected || !roomId) return;
    ++bindingReadSequence.current;
    setBusy(true);
    setBindingError("");
    try {
      const result = await contentApi<{ binding: ContentBinding }>(
        `/rooms/${esc(roomId)}/binding`,
        "POST",
        { courseId: course.id, scriptVersion: selected.version },
      );
      if (!alive.current) return;
      if (selectedRoomRef.current === result.binding.roomId)
        setBinding(result.binding);
      setNotice("已将定稿讲稿绑定到所选直播间，开播仍由真人主播操作。");
      onBound?.(result.binding);
    } catch (e) {
      if (alive.current) setBindingError(reason(e));
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  return (
    <>
      <main className="cw-main">
        {tabs}
        <div className="cw-section">
          <div className="cw-section-header">
            <div>
              <h2>
                第 {course.dayIndex} 天 · {course.title}
              </h2>
              <p className="cw-meta">
                {course.durationMinutes} 分钟 ·{" "}
                {course.scheduleLabel || "时间待定"} ·{" "}
                {course.presenterName || "主播待定"}
              </p>
            </div>
            <span
              className={`cw-badge ${selected?.state === "final" && !dirty && !selected.stale ? "good" : ""}`}
            >
              {dirty
                ? "编辑未保存"
                : selected
                  ? titleState(selected)
                  : "未写稿"}
            </span>
          </div>
          <div className="cw-actions">
            <button
              type="button"
              className="secondary"
              disabled={busy || !canEdit}
              onClick={onEditCourse}
            >
              修改课时安排
            </button>
          </div>
          {course.objective && (
            <p className="cw-meta">本课目标：{course.objective}</p>
          )}
          <GenerationPanel
            key={course.id}
            courseId={course.id}
            canEdit={canEdit}
            dirty={dirty}
            onImported={() => {
              void refresh(true);
              onSaved();
            }}
          />
          <div className="cw-script-note">
            <span>人工写稿 / 文字导入 · 保存后按段检查</span>
            <span>
              {totalCharacters.toLocaleString()} /{" "}
              {CONTENT_LIMITS.scriptCharacters.toLocaleString()} 字 ·{" "}
              {paragraphs.length} / {CONTENT_LIMITS.paragraphs} 段
            </span>
          </div>
          <fieldset disabled={busy || loading || !canEdit}>
            <label className="cw-upload">
              导入讲稿文字
              <input
                type="file"
                accept=".txt,.md,text/plain,text/markdown"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  void upload(file);
                }}
              />
              <small>按空行分段，UTF-8；导入后在下方核对段落与依据。</small>
            </label>
            <div className="cw-paragraphs">
              {paragraphs.map((item, index) => (
                <article
                  key={item.id}
                  className={`cw-paragraph ${item.id === activeParagraph ? "selected" : ""}`}
                >
                  <div className="cw-section-header">
                    <button
                      type="button"
                      className="cw-paragraph-label"
                      onClick={() => setActiveParagraph(item.id)}
                    >
                      第 {index + 1} 段 ·{" "}
                      {item.kind === "fact" ? "商品事实" : "过渡与互动"}
                    </button>
                    <button
                      type="button"
                      className="secondary"
                      aria-label={`删除第 ${index + 1} 段`}
                      disabled={paragraphs.length === 1}
                      onClick={() => {
                        setParagraphs((old) =>
                          old.filter((p) => p.id !== item.id),
                        );
                        setAcknowledged(false);
                      }}
                    >
                      <Trash2 size={12} />
                    </button>
                  </div>
                  <textarea
                    aria-label={`第 ${index + 1} 段正文`}
                    rows={Math.min(
                      12,
                      Math.max(3, Math.ceil(item.text.length / 42)),
                    )}
                    maxLength={CONTENT_LIMITS.paragraphCharacters}
                    value={item.text}
                    onFocus={() => setActiveParagraph(item.id)}
                    onChange={(e) =>
                      editParagraph(item.id, { text: e.target.value })
                    }
                  />
                  <div className="cw-script-note">
                    <span>
                      {item.kind === "fact"
                        ? `引用 ${item.factIds.length} 条依据`
                        : "不承载产品参数或功效承诺"}
                    </span>
                    <span>
                      {item.text.length} / {CONTENT_LIMITS.paragraphCharacters}{" "}
                      字
                    </span>
                  </div>
                  {selected &&
                    !dirty &&
                    selected.check.issues.some(
                      (issue) => issue.paragraphId === item.id,
                    ) && (
                      <a
                        className="cw-risk-link"
                        href="#content-rule-results"
                        onClick={() => setActiveParagraph(item.id)}
                      >
                        {
                          selected.check.issues.filter(
                            (issue) =>
                              issue.paragraphId === item.id &&
                              issue.level === "block",
                          ).length
                        }{" "}
                        项需修改 ·{" "}
                        {
                          selected.check.issues.filter(
                            (issue) =>
                              issue.paragraphId === item.id &&
                              issue.level === "review",
                          ).length
                        }{" "}
                        项需复核 · 查看检查说明
                      </a>
                    )}
                </article>
              ))}
            </div>
            <div className="cw-actions">
              <button
                type="button"
                className="secondary"
                disabled={paragraphs.length >= CONTENT_LIMITS.paragraphs}
                onClick={() => {
                  const next = emptyParagraph();
                  setParagraphs((old) => [...old, next]);
                  setActiveParagraph(next.id);
                }}
              >
                <Plus size={13} />
                添加段落
              </button>
              <small>选中某段，在右侧设置类型和引用依据。</small>
            </div>
            <label>
              本次修改说明
              <textarea
                rows={2}
                maxLength={500}
                value={changeNote}
                onChange={(e) => setChangeNote(e.target.value)}
                placeholder="记录改了什么、依据是什么"
              />
            </label>
            <div className="cw-actions">
              <button
                type="button"
                className="primary"
                disabled={
                  totalCharacters > CONTENT_LIMITS.scriptCharacters ||
                  paragraphs.some((item) => !item.text.trim()) ||
                  (!dirty && !selected?.stale)
                }
                onClick={() => void save()}
              >
                <Save size={13} />
                {busy ? "正在保存…" : "保存新版本并检查"}
              </button>
              {dirty && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => loadScript(selected)}
                >
                  放弃当前修改
                </button>
              )}
            </div>
          </fieldset>
          <Feedback error={error} notice={notice} />
          {selected && detail && (
            <ScriptComparison
              key={`${course.id}:${selected.version}`}
              versions={detail.versions}
              selected={selected}
              dirty={dirty}
            />
          )}
        </div>
      </main>
      <aside className="cw-review-panel">
        <div className="cw-panel-heading">
          <h2>依据与审改</h2>
          <FileText size={15} />
        </div>
        <div className="cw-panel-body">
          <label>
            讲稿版本
            <select
              value={selectedVersion}
              disabled={busy || dirty || loading}
              onChange={(e) =>
                loadScript(
                  detail?.versions.find(
                    (item) => item.version === Number(e.target.value),
                  ),
                )
              }
            >
              {!detail?.versions.length && (
                <option value={0}>尚未保存版本</option>
              )}
              {detail?.versions.map((version) => (
                <option key={version.version} value={version.version}>
                  V{version.version} · {titleState(version)}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={() => {
              void refresh(true);
              onRefreshProduct();
            }}
          >
            刷新版本与检查状态
          </button>
          {dirty && (
            <p className="cw-meta">有未保存修改，保存或放弃后可切换版本。</p>
          )}
          {paragraph && (
            <div className="cw-divider">
              <h3>
                第{" "}
                {paragraphs.findIndex((item) => item.id === paragraph.id) + 1}{" "}
                段的表达依据
              </h3>
              <label>
                段落类型
                <select
                  value={paragraph.kind}
                  disabled={busy || loading || !canEdit}
                  onChange={(e) =>
                    editParagraph(paragraph.id, {
                      kind: e.target.value as ScriptParagraph["kind"],
                      ...(e.target.value === "transition"
                        ? { factIds: [] }
                        : {}),
                    })
                  }
                >
                  <option value="fact">商品事实 · 需要引用依据</option>
                  <option value="transition">过渡 / 提问 / 互动</option>
                </select>
              </label>
              {paragraph.kind === "fact" ? (
                <div className="cw-evidence-list">
                  {approvedFacts.map((fact, index) => (
                    <label className="cw-check" key={fact.id}>
                      <input
                        type="checkbox"
                        disabled={busy || loading || !canEdit}
                        checked={paragraph.factIds.includes(fact.id)}
                        onChange={(e) =>
                          editParagraph(paragraph.id, {
                            factIds: e.target.checked
                              ? [...paragraph.factIds, fact.id]
                              : paragraph.factIds.filter(
                                  (id) => id !== fact.id,
                                ),
                          })
                        }
                      />
                      <span>
                        <strong>
                          依据 {index + 1} · {fact.text}
                        </strong>
                        <small>{fact.evidence}</small>
                      </span>
                    </label>
                  ))}
                  {!approvedFacts.length && (
                    <p className="cw-warning">
                      当前没有已核对的商品事实。请先完善商品资料。
                    </p>
                  )}
                  {paragraph.factIds.some(
                    (id) => !approvedFacts.some((fact) => fact.id === id),
                  ) && (
                    <p className="cw-warning">
                      本段含已撤回或当前不存在的引用，请清除后重新选择。
                      <button
                        type="button"
                        className="secondary"
                        disabled={busy}
                        onClick={() =>
                          editParagraph(paragraph.id, {
                            factIds: paragraph.factIds.filter((id) =>
                              approvedFacts.some((fact) => fact.id === id),
                            ),
                          })
                        }
                      >
                        清除无效引用
                      </button>
                    </p>
                  )}
                </div>
              ) : (
                <p className="cw-meta">
                  过渡段用于流程衔接或互动。商品参数、健康功效和比较性主张仍应放入事实段并提供依据。
                </p>
              )}
            </div>
          )}
          <div className="cw-divider">
            <h3 id="content-rule-results">本地规则检查</h3>
            {dirty ? (
              <p className="cw-warning">
                当前文字尚未保存检查，下面定稿操作暂不可用。
              </p>
            ) : selected ? (
              <>
                <span
                  className={`cw-badge ${selected.check.blockingCount ? "" : "good"}`}
                >
                  {selected.check.blockingCount} 项阻断 ·{" "}
                  {
                    selected.check.issues.filter(
                      (issue) => issue.level === "review",
                    ).length
                  }{" "}
                  项需复核
                </span>
                <p className="cw-meta">{selected.check.summary}</p>
                <div className="cw-rule-result">
                  {selected.check.issues.map((issue, index) => (
                    <div
                      key={index}
                      className={`cw-risk ${issue.level === "block" ? "high" : ""}`}
                    >
                      <strong>
                        第{" "}
                        {selected.paragraphs.findIndex(
                          (p) => p.id === issue.paragraphId,
                        ) + 1}{" "}
                        段 · {issue.level === "block" ? "需修改" : "需复核"}
                      </strong>
                      <span>{issue.message}</span>
                    </div>
                  ))}
                </div>
                <small>
                  {date(selected.check.checkedAt)} ·{" "}
                  {selected.check.ruleVersion}
                </small>
              </>
            ) : (
              <p className="cw-meta">
                保存讲稿后检查事实引用、功效/比较承诺、情感边界和越权指令。规则检查不等于法律审查。
              </p>
            )}
            {selected?.stale && (
              <p className="cw-warning">
                {selected.authorizationIssue ||
                  "商品资料已变化。请对照当前资料保存新版本并重新复核。"}
              </p>
            )}
          </div>
          {selected && (
            <ScriptReviewPanel
              key={`${course.id}:${selected.version}`}
              script={selected}
              dirty={dirty}
              onPolicy={setRequiresReview}
              onChanged={() => {
                void refresh(true);
                onSaved();
              }}
            />
          )}
          {!requiresReview && (
            <div className="cw-divider">
              <h3>本地单人演示确认</h3>
              {selected?.confirmation && (
                <p className="cw-meta">
                  V{selected.version} 于{" "}
                  {date(selected.confirmation.confirmedAt)} 由{" "}
                  {selected.confirmation.confirmedBy} 确认。
                  {selected.confirmation.note}
                </p>
              )}
              <fieldset
                disabled={
                  busy ||
                  dirty ||
                  !selected ||
                  selected.stale ||
                  selected.check.blockingCount > 0 ||
                  selected.state === "final"
                }
              >
                <label>
                  核对与审改记录
                  <textarea
                    rows={3}
                    maxLength={1000}
                    value={confirmationNote}
                    onChange={(e) => setConfirmationNote(e.target.value)}
                    placeholder="说明已核对的引用、风险提示及表述适用范围"
                  />
                </label>
                <label className="cw-check">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                  />
                  我已逐段核对商品依据与风险提示，确认此稿可用于当前课程。
                </label>
                <button
                  type="button"
                  className="primary"
                  disabled={!acknowledged || !confirmationNote.trim()}
                  onClick={() => void confirm()}
                >
                  <Check size={13} />
                  确认定稿
                </button>
              </fieldset>
              <p className="cw-meta">
                单人演示可自确认；生产及团队空间必须走独立审核。
              </p>
            </div>
          )}
          <div className="cw-divider">
            <h3>用于真人直播</h3>
            <label>
              选择直播间
              <select
                disabled={busy}
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
              >
                {!rooms.length && <option value="">请先创建直播间</option>}
                {rooms.map((room) => (
                  <option key={room.id} value={room.id}>
                    {room.title}
                  </option>
                ))}
              </select>
            </label>
            <button
              type="button"
              className="secondary"
              disabled={
                busy ||
                dirty ||
                !selected ||
                selected.state !== "final" ||
                !["owner", "presenter"].includes(memberRole) ||
                (requiresReview &&
                  selected.confirmation?.role !== "independent_review") ||
                selected.stale ||
                !roomId
              }
              onClick={() => void bind()}
            >
              绑定当前定稿
            </button>
            {binding && (
              <div className="cw-bind-summary">
                <strong>
                  {binding.stale ? "已绑定内容需复核" : "已绑定讲稿"}
                </strong>
                <span>
                  {binding.productName} · V{binding.scriptVersion} ·{" "}
                  {date(binding.boundAt)}
                </span>
                {binding.courseId !== course.id && (
                  <span>
                    当前直播间绑定的是另一课时。点击上方按钮将改为本课。
                  </span>
                )}
              </div>
            )}
            <Feedback error={bindingError} />
            <p className="cw-meta">
              绑定讲稿不会自动开播。请由真人主播准备推流并确认现场安排。
            </p>
          </div>
        </div>
      </aside>
    </>
  );
}
