/** Content belongs to the merchant content domain; no Agent service/database dependency. */
export interface ProductFactInput {
  id?: string;
  text: string;
  evidence: string;
  approved: boolean;
}
export interface ProductFact extends ProductFactInput {
  id: string;
}
export interface ProductInput {
  name: string;
  sku: string;
  category: string;
  facts: ProductFactInput[];
}
export interface ContentProduct {
  id: string;
  name: string;
  sku: string;
  category: string;
  latestVersion: number;
  createdAt: number;
  updatedAt: number;
}
export interface ProductVersion extends Omit<ProductInput, "facts"> {
  version: number;
  facts: ProductFact[];
  createdAt: number;
}
export interface ContentPlan {
  id: string;
  productId: string;
  name: string;
  audience: string;
  totalDays: number;
  createdAt: number;
}
export interface PlanInput {
  productId: string;
  name: string;
  audience: string;
  totalDays: number;
}
export interface PlanPatchInput extends Omit<PlanInput, "productId"> {
  base: Omit<PlanInput, "productId">;
}
export interface ContentCourse {
  id: string;
  planId: string;
  title: string;
  dayIndex: number;
  objective: string;
  durationMinutes: number;
  scheduleLabel: string;
  presenterName: string;
  latestScriptVersion: number;
  createdAt: number;
}
export interface CourseInput {
  title: string;
  dayIndex: number;
  objective: string;
  durationMinutes?: number;
  scheduleLabel?: string;
  presenterName?: string;
}
export interface CoursePatchInput extends CourseInput {
  base: CourseInput;
}
export interface ScriptParagraph {
  id: string;
  kind: "fact" | "transition";
  text: string;
  factIds: string[];
}
export interface ScriptInput {
  baseVersion: number;
  productVersion: number;
  paragraphs: ScriptParagraph[];
  changeNote: string;
}
export interface ScriptIssue {
  paragraphId: string;
  level: "block" | "review";
  code:
    | "claim"
    | "missing_evidence"
    | "invalid_evidence"
    | "unsupported_claim"
    | "emotion"
    | "instruction";
  message: string;
}
export interface ScriptCheck {
  checkedAt: number;
  ruleVersion: string;
  blockingCount: number;
  issues: ScriptIssue[];
  summary: string;
}
export interface ScriptConfirmation {
  confirmedAt: number;
  confirmedBy: string;
  note: string;
  role: "merchant_self_confirmation" | "independent_review";
}
export interface ScriptReviewRecord {
  authorId: string | null;
  submission: { submittedBy: string; submittedAt: number; note: string } | null;
  decision: {
    reviewerId: string;
    reviewedAt: number;
    decision: "approved" | "changes_requested";
    note: string;
  } | null;
}
export interface ScriptVersion {
  courseId: string;
  version: number;
  productId: string;
  productSnapshot: ProductVersion;
  paragraphs: ScriptParagraph[];
  changeNote: string;
  createdAt: number;
  check: ScriptCheck;
  confirmation?: ScriptConfirmation;
  stale: boolean;
  state:
    "draft" | "final" | "needs_review" | "pending_review" | "changes_requested";
}
export interface CourseDetail {
  course: ContentCourse;
  plan: ContentPlan;
  product: ContentProduct;
  versions: ScriptVersion[];
}
export interface ContentBinding {
  courseTitle: string;
  roomId: string;
  courseId: string;
  scriptVersion: number;
  boundAt: number;
  productId: string;
  productName: string;
  category: string;
  stale: boolean;
  script: ScriptVersion;
}
export interface ContentWorkspace {
  products: ContentProduct[];
  plans: ContentPlan[];
}
export const CONTENT_LIMITS = {
  scriptCharacters: 12000,
  paragraphs: 40,
  paragraphCharacters: 1500,
  facts: 40,
  requestBytes: 128 * 1024,
} as const;

export interface ReviewQueueItem {
  courseId: string;
  courseTitle: string;
  productName: string;
  version: number;
  submittedBy: string;
  submittedAt: number;
  note: string;
}
