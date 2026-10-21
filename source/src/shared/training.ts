import type {
  AgentFact,
  AgentRun,
  AgentAlert,
  PromptVersion,
} from "./agent.js";

export interface MaterialInput {
  sourceName: string;
  format: "csv" | "json";
  content: string;
}
export interface MaterialPreview {
  sourceName: string;
  format: "csv" | "json";
  contentHash: string;
  rows: { row: number; text: string; evidence: string; duplicate: boolean }[];
  duplicateCount: number;
  warnings: string[];
}
export interface MaterialBatch {
  id: string;
  sourceName: string;
  format: "csv" | "json";
  contentHash: string;
  createdAt: number;
  importedCount: number;
  skippedCount: number;
  factIds: string[];
}
export interface ExampleImportInput {
  sourceName: string;
  authorization: "owned" | "licensed";
  examples: { situation: string; response: string }[];
  baseVersion: number;
  idempotencyKey: string;
}
export interface ExampleImportReceipt {
  id: string;
  sourceName: string;
  authorization: "owned" | "licensed";
  importedCount: number;
  createdAt: number;
  version: number;
}
export interface ExampleImportResult {
  receipt: ExampleImportReceipt;
  version: PromptVersion;
}
export interface EvaluationCase {
  id: string;
  title: string;
  transcript: string;
  question?: string;
  expect: {
    mustCiteEvidence: boolean;
    abstained?: boolean;
    alertCategories: NonNullable<AgentAlert["category"]>[];
    forbiddenPhrases: string[];
  };
}
export interface EvaluationSuite {
  id: string;
  roomId: string;
  name: string;
  revision: number;
  cases: EvaluationCase[];
  createdAt: number;
}
export interface EvaluationVariant {
  profileId: string;
  version: number;
}
export interface EvaluationCheck {
  name: string;
  passed: boolean;
  detail: string;
}
export interface EvaluationReview {
  style: number;
  naturalness: number;
  decision: "acceptable" | "revise";
  note: string;
}
export interface EvaluationItem {
  id: string;
  caseId: string;
  variantIndex: number;
  run: AgentRun;
  checks: EvaluationCheck[];
  outcome: "pending" | "passed" | "failed";
  review?: EvaluationReview;
}
export interface EvaluationReport {
  id: string;
  roomId: string;
  suite: EvaluationSuite;
  variants: (EvaluationVariant & { name: string })[];
  status: "queued" | "running" | "completed";
  createdAt: number;
  productName: string;
  category?: string;
  factSnapshot: AgentFact[];
  items: EvaluationItem[];
  stale?: boolean;
  staleReason?: string;
}
