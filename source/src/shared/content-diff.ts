import type { ScriptParagraph, ScriptVersion } from "./content.js";

export interface ParagraphChange {
  id: string;
  type: "added" | "removed" | "changed" | "unchanged";
  before?: ScriptParagraph;
  after?: ScriptParagraph;
  beforePosition?: number;
  afterPosition?: number;
  fields: ("text" | "kind" | "facts" | "position")[];
}
/** Paragraph IDs are stable editing identities, not a fuzzy claim of semantic equivalence. */
export function compareScripts(before: ScriptVersion, after: ScriptVersion) {
  const previous = new Map(before.paragraphs.map((p, i) => [p.id, { p, i }]));
  const next = new Map(after.paragraphs.map((p, i) => [p.id, { p, i }]));
  const changes: ParagraphChange[] = after.paragraphs.map((p, i) => {
    const old = previous.get(p.id);
    if (!old)
      return {
        id: p.id,
        type: "added",
        after: p,
        afterPosition: i + 1,
        fields: [],
      };
    const fields: ParagraphChange["fields"] = [];
    if (old.p.text !== p.text) fields.push("text");
    if (old.p.kind !== p.kind) fields.push("kind");
    if (
      JSON.stringify([...old.p.factIds].sort()) !==
      JSON.stringify([...p.factIds].sort())
    )
      fields.push("facts");
    if (old.i !== i) fields.push("position");
    return {
      id: p.id,
      type: fields.length ? "changed" : "unchanged",
      before: old.p,
      after: p,
      beforePosition: old.i + 1,
      afterPosition: i + 1,
      fields,
    };
  });
  for (const [id, old] of previous)
    if (!next.has(id))
      changes.push({
        id,
        type: "removed",
        before: old.p,
        beforePosition: old.i + 1,
        fields: [],
      });
  return {
    courseId: before.courseId,
    fromVersion: before.version,
    toVersion: after.version,
    evidenceChanged:
      before.productId !== after.productId ||
      before.productSnapshot.version !== after.productSnapshot.version,
    ruleChanged: before.check.ruleVersion !== after.check.ruleVersion,
    counts: {
      added: changes.filter((c) => c.type === "added").length,
      removed: changes.filter((c) => c.type === "removed").length,
      changed: changes.filter((c) => c.type === "changed").length,
      unchanged: changes.filter((c) => c.type === "unchanged").length,
    },
    changes,
  };
}

export interface BindingHistoryEntry {
  id: number;
  roomId: string;
  courseId: string;
  scriptVersion: number;
  boundAt: number;
  actorId: string | null;
  source: "binding" | "legacy_snapshot";
  roomTitle: string;
  courseTitle: string;
  productName: string;
}
