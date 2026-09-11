export interface ModerationResult {
  id: number;
  disconnected: number;
  message: string;
  actorId: string;
  createdAt: number;
}
export interface ModerationState {
  hold: {
    id: number;
    actorId: string;
    note: string;
    result: ModerationResult | null;
    processing: boolean;
  } | null;
  items: {
    id: number;
    kind: "note" | "stop" | "release";
    note: string;
    evidenceReference: string;
    actorId: string;
    createdAt: number;
    holdId: number | null;
    result: ModerationResult | null;
  }[];
  nextBefore: number | null;
}
export const moderationLabels = {
  note: "现场记录",
  stop: "暂停直播",
  release: "复核解除暂停",
};
