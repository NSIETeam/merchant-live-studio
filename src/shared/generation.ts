import type { PromptVersion } from "./agent.js";
import type { ProductFactInput, ScriptParagraph } from "./content.js";
export interface GenerationInput {
  courseId: string;
  baseVersion: number;
  productId: string;
  productVersion: number;
  productName: string;
  category: string;
  title: string;
  objective: string;
  audience: string;
  facts: ProductFactInput[];
  targetCharacters: number;
  chapterCount: number;
  profileId: string;
  promptVersion: number;
  idempotencyKey: string;
}
export interface GenerationSnapshot extends GenerationInput {
  prompt: PromptVersion;
}
export interface GenerationOutline {
  chapters: { title: string; objective: string }[];
}
export interface GeneratedChapter {
  title: string;
  paragraphs: ScriptParagraph[];
}
export type GenerationStatus =
  | "waiting_configuration"
  | "queued"
  | "running"
  | "failed"
  | "cancelled"
  | "completed";
export interface GenerationJob {
  id: string;
  courseId: string;
  status: GenerationStatus;
  input: GenerationSnapshot;
  outline: GenerationOutline | null;
  chapters: GeneratedChapter[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  needsReview: true;
}

export interface GenerationSummary {
  id: string;
  courseId: string;
  status: GenerationStatus;
  error: string | null;
  completedChapters: number;
  chapterCount: number;
  createdAt: number;
  updatedAt: number;
}
