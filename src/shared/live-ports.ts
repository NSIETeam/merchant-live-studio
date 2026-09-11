import type { Campaign, Room, StreamState } from "./types.js";
export interface RoomRow {
  id: string;
  merchant_id: string;
  title: string;
  product_name: string;
  status: Room["status"];
  stream_secret: string;
  created_at: number;
  live_started_at: number;
}
export interface VisitState {
  session_watch_millis: number;
  last_seen: number;
  active: number;
}
export interface ViewingStats {
  uniqueViewers: number;
  totalWatchSeconds: number;
  averageWatchSeconds: number;
  onlineViewers: number;
  timeline: { minute: string; viewers: number }[];
}
export interface LivePort {
  room(id: string): RoomRow;
  owned(id: string, merchant: string): RoomRow;
  roomDto(row: RoomRow): Room;
  signal(id: string): Promise<StreamState>;
  visit(room: string, viewer: string): VisitState | undefined;
  viewingStats(room: string): ViewingStats;
}
export interface CampaignRow {
  id: string;
  room_id: string;
  total_cents: number;
  count: number;
  remaining_cents: number;
  remaining_count: number;
  min_watch_seconds: number;
  opens_at: number;
  expires_at: number;
  status: string;
  payment_mode: "simulation" | "wechat";
}
export interface ClaimRow {
  id: string;
  campaign_id: string;
  viewer_id: string;
  amount_cents: number;
  status: "reserved" | "simulated";
  created_at: number;
}
export interface EngagementPort {
  paymentModeFor(merchantId: string): "simulation" | "wechat";
  active(room: string, now: number): Campaign[];
  nextCampaign(room: string, now: number): CampaignRow | undefined;
  campaignIds(room: string): string[];
  closeRoom(room: string, now: number): void;
  claimRecord(id: string): ClaimRow | undefined;
  markSimulated(id: string): void;
  summary(room: string): {
    claims: number;
    reservedCents: number;
    simulatedCents: number;
    questions: number;
  };
}
export interface PaymentPort {
  modeFor(merchantId: string): "simulation" | "wechat";
  budget(
    campaign: string,
    merchantId: string,
    amount: number,
    paymentMode: "simulation" | "wechat",
    now: number,
  ): void;
  reserve(
    input: {
      campaignId: string;
      claimId: string;
      viewerId: string;
      merchantId: string;
      amountCents: number;
      paymentMode: "simulation" | "wechat";
    },
    now: number,
  ): void;
  returnBudget(
    campaign: string,
    merchantId: string,
    amount: number,
    paymentMode: "simulation" | "wechat",
    now: number,
  ): void;
}
