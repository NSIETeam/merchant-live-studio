export interface PresenterProfile {
  displayName: string;
  roleDescription: string;
  speakingStyle: string;
  pace: "slow" | "balanced" | "brisk";
  authorizationReference: string;
  authorizationConfirmed: boolean;
}
/** Only delivery characteristics cross the model boundary. Authorization is retained for human audit. */
export function presenterForModel(presenter?: PresenterProfile) {
  if (!presenter) return undefined;
  return { speakingStyle: presenter.speakingStyle, pace: presenter.pace };
}
export interface AgentFact {
  id: string;
  text: string;
  evidence: string;
  approved: boolean;
}
export interface StyleExample {
  situation: string;
  response: string;
}
export interface PromptContent {
  presenter?: PresenterProfile;
  systemPrompt: string;
  styleGuide: string;
  audience: string;
  examples: StyleExample[];
}
export interface PromptVersion extends PromptContent {
  version: number;
  createdAt: number;
}
export interface AgentProfile {
  revocation?: { reason: string; actorId: string; createdAt: number };
  id: string;
  name: string;
  kind: "standard" | "brand";
  publishedVersion: number | null;
  latestVersion: number;
  createdAt: number;
}
export interface AgentContext {
  roomId: string;
  productName: string;
  category?: string;
  transcript: string;
  question?: string;
  facts: AgentFact[];
  campaignCue?: string;
}
export interface AgentExecutionInput {
  context: AgentContext;
  profile: AgentProfile;
  prompt: PromptVersion;
}
export interface AgentAlert {
  level: "high" | "review";
  phrase: string;
  reason: string;
  category?: "claim" | "evidence" | "emotion" | "platform" | "instruction";
}
export type ClaimDecisionType =
  | "superiority"
  | "contextual_ordinal"
  | "medical_efficacy"
  | "guarantee"
  | "testimonial"
  | "emotional_association"
  | "price_scarcity"
  | "platform_incentive"
  | "instruction_override";
export interface ClaimDecision {
  ruleId: string;
  type: ClaimDecisionType;
  disposition: "block" | "review" | "context";
  category: NonNullable<AgentAlert["category"]>;
  phrase: string;
  statement: string;
  explanation: string;
  evidenceNeeded: string;
  suggestedAction: string;
}
export interface AgentResult {
  provider: "grounded-rules" | "remote-model";
  modelConfigured: boolean;
  suggestion: string;
  factIds: string[];
  evidence: string[];
  alerts: AgentAlert[];
  nextCue: string;
  needsReview: boolean;
  abstained: boolean;
  profileId: string;
  promptVersion: number;
  stages: {
    name: string;
    status: "passed" | "review" | "blocked";
    summary: string;
  }[];
  decisionSummary: string[];
  /** Added in policy v1. Older persisted run results may not contain these fields. */
  policyVersion?: string;
  policyPack?: "general" | "food-nutrition" | "regulated-health";
  claimDecisions?: ClaimDecision[];
}
export interface AgentRun {
  id: string;
  roomId: string;
  profileId: string;
  promptVersion: number;
  mode: "rehearsal" | "live";
  status: "queued" | "running" | "completed" | "failed";
  createdAt: number;
  completedAt?: number;
  result?: AgentResult;
  error?: string;
  contextDigest: string;
  stale?: boolean;
  staleReason?: string;
  feedback?: { rating: "useful" | "needs_work"; note: string };
}
export interface AgentServiceStatus {
  available: boolean;
  modelConfigured: boolean;
  provider: "grounded-rules" | "remote-model";
  queued: number;
  running: number;
  maxConcurrency: number;
  message?: string;
}
