export const complaintCategories = {
  content: "内容与宣传",
  product: "商品与服务",
  conduct: "直播行为",
  other: "其他问题",
} as const;
export const complaintStates = {
  received: "待受理",
  reviewing: "处理中",
  resolved: "已答复",
} as const;
export const complaintAppealStates = {
  submitted: "待独立复核",
  reviewing: "复核中",
  resolved: "复核完成",
} as const;
export interface Complaint {
  id: string;
  roomId: string;
  category: keyof typeof complaintCategories;
  body: string;
  createdAt: number;
  responseDueAt: number;
  overdue: boolean;
  events: {
    version: number;
    state: keyof typeof complaintStates;
    reply: string;
    createdAt: number;
  }[];
  appeal: null | {
    id: string;
    reason: string;
    createdAt: number;
    reviewDueAt: number;
    overdue: boolean;
    events: {
      version: number;
      state: keyof typeof complaintAppealStates;
      reply: string;
      createdAt: number;
    }[];
  };
}
export interface ComplaintPage {
  items: Complaint[];
  nextAfter: string | null;
}
