import { useState } from "react";
import type { ScriptVersion, ScriptParagraph } from "../../shared/content.js";
import { compareScripts } from "../../shared/content-diff.js";
import "../review/review-history.css";

function ParagraphSnapshot({
  paragraph,
  version,
  position,
}: {
  paragraph?: ScriptParagraph;
  version: ScriptVersion;
  position?: number;
}) {
  if (!paragraph) return <div className="comparison-empty">此版本无此段</div>;
  return (
    <div className="comparison-snapshot">
      <small>
        第 {position} 段 ·{" "}
        {paragraph.kind === "fact" ? "商品事实" : "过渡与互动"}
      </small>
      <p>{paragraph.text}</p>
      {paragraph.factIds.length > 0 && (
        <ul aria-label="本版本引用依据">
          {paragraph.factIds.map((id) => {
            const fact = version.productSnapshot.facts.find((f) => f.id === id);
            return (
              <li key={id}>
                {fact ? (
                  <>
                    {fact.text}
                    <br />
                    <small>{fact.evidence}</small>
                  </>
                ) : (
                  `未找到引用：${id}`
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ScriptComparison({
  versions,
  selected,
  dirty,
}: {
  versions: ScriptVersion[];
  selected: ScriptVersion;
  dirty: boolean;
}) {
  const [from, setFrom] = useState(0);
  const [showUnchanged, setShowUnchanged] = useState(false);
  const [open, setOpen] = useState(false);
  const previous =
    versions.find((v) => v.version === from) ??
    versions
      .filter((v) => v.version < selected.version)
      .sort((a, b) => b.version - a.version)[0] ??
    selected;
  const result = open ? compareScripts(previous, selected) : null;
  const names = {
    added: "新增",
    removed: "删除",
    changed: "修改",
    unchanged: "未变",
  };
  const fieldNames = {
    text: "正文",
    kind: "段落类型",
    facts: "引用依据",
    position: "位置",
  };
  return (
    <details
      className="script-comparison"
      onToggle={(e) => setOpen(e.currentTarget.open)}
    >
      <summary>原稿与修改稿对照 · 当前 V{selected.version}</summary>
      {open && result && (
        <div className="comparison-body">
          <label>
            对照原稿版本
            <select
              value={previous.version}
              onChange={(e) => setFrom(Number(e.target.value))}
            >
              {versions.map((v) => (
                <option key={v.version} value={v.version}>
                  V{v.version}
                </option>
              ))}
            </select>
          </label>
          <p>
            比较已保存的 V{previous.version} 与 V{selected.version}。
            {dirty && "当前未保存修改未计入本次对照。"}
          </p>
          <p>
            新增 {result.counts.added} · 删除 {result.counts.removed} · 修改{" "}
            {result.counts.changed} · 未变 {result.counts.unchanged}
          </p>
          <p className="comparison-note">
            修改说明：{selected.changeNote || "未填写"}
          </p>
          {result.evidenceChanged && (
            <p role="status">
              商品依据从 V{previous.productSnapshot.version} 变为 V
              {selected.productSnapshot.version}，即使正文未变也需核对。
            </p>
          )}
          {result.ruleChanged && (
            <p role="status">
              两版使用的检查规则不同，请分别查看原版本的检查结果。
            </p>
          )}
          <label className="comparison-toggle">
            <input
              type="checkbox"
              checked={showUnchanged}
              onChange={(e) => setShowUnchanged(e.target.checked)}
            />
            显示未改变的段落
          </label>
          {result.changes
            .filter((c) => showUnchanged || c.type !== "unchanged")
            .map((change) => (
              <article
                key={change.id}
                className={`comparison-change comparison-${change.type}`}
              >
                <h4>
                  {names[change.type]}
                  {change.fields.length
                    ? ` · ${change.fields.map((f) => fieldNames[f]).join("、")}`
                    : ""}
                </h4>
                <div className="comparison-columns">
                  <section aria-label={`原稿 V${previous.version}`}>
                    <strong>原稿 V{previous.version}</strong>
                    <ParagraphSnapshot
                      paragraph={change.before}
                      version={previous}
                      position={change.beforePosition}
                    />
                  </section>
                  <section aria-label={`修改稿 V${selected.version}`}>
                    <strong>修改稿 V{selected.version}</strong>
                    <ParagraphSnapshot
                      paragraph={change.after}
                      version={selected}
                      position={change.afterPosition}
                    />
                  </section>
                </div>
              </article>
            ))}
          {!showUnchanged &&
            !result.counts.added &&
            !result.counts.removed &&
            !result.counts.changed && (
              <p>段落正文、类型、引用编号及顺序没有改变。</p>
            )}
          <small>
            按段落标识对照。重新导入并生成新标识的段落显示为新增和删除，不推断它们语义相同。本页不改变正文或定稿状态。
          </small>
        </div>
      )}
    </details>
  );
}
