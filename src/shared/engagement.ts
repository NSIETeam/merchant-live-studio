export interface EngagementProgram {
  roomId: string;
  version: number;
  enabled: number;
  points: number;
  minWatchSeconds: number;
  dailyLimit: number;
}
export interface EngagementGift {
  id: string;
  title: string;
  description: string;
  points: number;
  stock: number;
  enabled: number;
  version: number;
}
export interface Redemption {
  id: string;
  giftId: string;
  title: string;
  points: number;
  code?: string;
  state: "reserved" | "fulfilled" | "cancelled";
  createdAt: number;
}
export interface EngagementState {
  program: EngagementProgram | null;
  day: string;
  checkin: { points: number; createdAt: number } | null;
  balance: number;
  gifts: EngagementGift[];
  ledger: {
    delta: number;
    reason: string;
    referenceId: string;
    createdAt: number;
  }[];
  redemptions: Redemption[];
}
export const redemptionNames = {
  reserved: "待领取",
  fulfilled: "已领取",
  cancelled: "已取消",
};
export const pointReasons = {
  checkin: "签到获得",
  redemption: "兑换扣除",
  redemption_refund: "取消返还",
};
