export type MemberRole =
  "owner" | "editor" | "reviewer" | "presenter" | "analyst";
export interface Membership {
  merchantId: string;
  role: Exclude<MemberRole, "owner">;
}
export interface MerchantIdentity {
  merchantId: string;
  actorId: string;
  memberRole: MemberRole;
  requiresIndependentReview: boolean;
}
export const memberRoleNames: Record<MemberRole, string> = {
  owner: "管理员",
  editor: "编辑",
  reviewer: "审核",
  presenter: "主播",
  analyst: "数据复盘",
};
