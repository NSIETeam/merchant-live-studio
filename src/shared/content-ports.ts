import type {
  ContentCourse,
  ContentPlan,
  ContentProduct,
  ProductVersion,
  ScriptCheck,
  ScriptParagraph,
  ScriptReviewRecord,
  ScriptVersion,
} from "./content.js";

export interface ProductRow {
  id: string;
  merchant_id: string;
  name: string;
  sku: string;
  category: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
}
export interface PlanRow {
  id: string;
  product_id: string;
  name: string;
  audience: string;
  total_days: number;
  created_at: number;
}
export interface CourseRow {
  id: string;
  plan_id: string;
  title: string;
  day_index: number;
  objective: string;
  duration_minutes: number;
  schedule_label: string;
  presenter_name: string;
  latest_script_version: number;
  created_at: number;
}
export interface ScriptRow {
  course_id: string;
  version: number;
  product_id: string;
  product_version: number;
  product_snapshot_json: string;
  paragraphs_json: string;
  change_note: string;
  check_json: string;
  created_at: number;
}
export interface ConfirmationRow {
  confirmed_at: number;
  confirmed_by: string;
  note: string;
}

export interface KnowledgePort {
  productOwned(id: string, merchant: string): ProductRow;
  productVersion(id: string, version: number): ProductVersion;
  productDto(row: ProductRow): ContentProduct;
  productIds(merchant: string): string[];
}
export interface MarketingPort {
  planOwned(id: string, merchant: string): PlanRow;
  planDto(row: PlanRow): ContentPlan;
  planIds(merchant: string): string[];
}
export interface ContentPort {
  generationSources(tenant: string, course?: string, version?: number): { version: number; profile: string }[];
  courseOwned(id: string, merchant: string): CourseRow;
  courseDto(row: CourseRow): ContentCourse;
  scriptVersion(id: string, version: number, merchant: string): ScriptVersion;
  saveScript(
    id: string,
    merchant: string,
    actor: string,
    value: unknown,
  ): number;
  listCourses(plan: string): ContentCourse[];
  maxDay(plan: string): number;
  author(id: string, version: number): string | null;
  latest(id: string): number;
  reviewCandidates(
    merchant: string,
  ): {
    courseId: string;
    courseTitle: string;
    productName: string;
    version: number;
  }[];
}
export interface ReviewPort {
  authorizationIssue(tenant: string, course: string, version: number, now?: number): string | undefined;
  readScriptReview(id: string, version: number): ScriptReviewRecord;
  readConfirmation(id: string, version: number): ConfirmationRow | undefined;
  checkScript(
    paragraphs: ScriptParagraph[],
    product: ProductVersion,
    now: number,
  ): ScriptCheck;
  ruleVersion: string;
}
