export type RoomStatus = "draft" | "live" | "ended";
export interface Room {
  id: string;
  title: string;
  merchantId: string;
  status: RoomStatus;
  createdAt: number;
  playbackUrl: string;
  productName: string;
  signal?: StreamState;
}
export interface StreamState {
  configured: boolean;
  connected: boolean | null;
  checkedAt: number;
  viewers?: number;
  message?: string;
}
export interface StreamConfig {
  provider: "srs" | "mediamtx";
  server: string;
  streamKey: string;
  playbackUrl: string;
  authEnabled: boolean;
}
export interface Fact {
  id: string;
  roomId: string;
  text: string;
  evidence: string;
  approved: boolean;
}
export interface Campaign {
  id: string;
  roomId: string;
  totalCents: number;
  count: number;
  remainingCents: number;
  remainingCount: number;
  minWatchSeconds: number;
  opensAt: number;
  expiresAt: number;
  status: string;
  mode: "simulation" | "wechat";
}
export interface Claim {
  id: string;
  campaignId: string;
  amountCents: number;
  status: "reserved" | "simulated";
  createdAt: number;
}
export interface LedgerEntry {
  id: string;
  campaignId: string;
  claimId: string | null;
  debit: string;
  credit: string;
  amountCents: number;
  createdAt: number;
}
export interface Question {
  id: string;
  text: string;
  count: number;
}
export interface Analytics {
  uniqueViewers: number;
  onlineViewers: number;
  averageWatchSeconds: number;
  totalWatchSeconds: number;
  claims: number;
  reservedCents: number;
  simulatedCents: number;
  questions: number;
  timeline: { minute: string; viewers: number }[];
}
export interface CopilotResult {
  provider: "grounded-rules";
  suggestion: string;
  factIds: string[];
  evidence: string[];
  alerts: import("./agent.js").AgentAlert[];
  nextCue: string;
  needsReview: boolean;
  policyVersion?: string;
  policyPack?: import("./agent.js").AgentResult["policyPack"];
  claimDecisions?: import("./agent.js").ClaimDecision[];
}
