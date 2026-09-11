import type { CopilotResult, Fact } from "../../shared/types.js";
export interface CopilotProvider {
  suggest(input: {
    transcript: string;
    question?: string;
    productName: string;
    facts: Fact[];
    campaignCue?: string;
  }): Promise<CopilotResult>;
}
const rules = [
  {
    pattern:
      /治疗|治愈|根治|药到病除|抗癌|降血糖|调理.{0,8}(疾病|糖尿病|高血压)/g,
    reason:
      "涉及疾病治疗或医疗功效，需核实商品类别与允许的宣称；换同义词不能消除风险。",
  },
  {
    pattern:
      /全网最低|最低价|第一|最好|最强|百分之百|100%|绝对|保证.{0,10}(见效|有效|治好)/g,
    reason: "绝对化、价格比较或效果保证需要具体适用条件与证据。",
  },
  {
    pattern: /转发.{0,12}(领|红包)|分享.{0,12}(领|红包)|关注.{0,12}(领|红包)/g,
    reason: "激励分享或关注涉及平台规则，活动条件需人工审查。",
  },
];
export class GroundedCopilot implements CopilotProvider {
  async suggest(
    input: Parameters<CopilotProvider["suggest"]>[0],
  ): Promise<CopilotResult> {
    const alerts: CopilotResult["alerts"] = [];
    for (const rule of rules)
      for (const match of input.transcript.matchAll(rule.pattern))
        alerts.push({ level: "high", phrase: match[0], reason: rule.reason });
    const facts = input.facts.filter((f) => f.approved && f.evidence.trim());
    if (input.transcript.trim())
      alerts.push({
        level: "review",
        phrase: "完整语义与商品资质",
        reason:
          "当前使用本地规则，未自动核验所有主张。未命中规则不代表合规，批准的事实也需由商家审核真实性。",
      });
    let chosen = facts;
    if (input.question) {
      const terms =
        input.question.match(/[a-zA-Z0-9]+|[\u4e00-\u9fff]{2}/g) || [];
      chosen = facts.filter((f) => terms.some((t) => f.text.includes(t)));
    }
    chosen = chosen.slice(0, 3);
    return {
      provider: "grounded-rules",
      suggestion: chosen.length
        ? `${input.question ? "关于这个问题，我们先看已经核实的信息。" : "我们来看这款产品的具体信息。"}${chosen.map((f) => f.text).join("。")}。其他使用条件请以产品标签为准。`
        : "这个问题目前还缺少经过审核的资料，先为大家核实后再答复。",
      factIds: chosen.map((f) => f.id),
      evidence: chosen.map((f) => f.evidence),
      alerts,
      needsReview: true,
      nextCue:
        input.campaignCue || "介绍适用人群 → 回答观众问题 → 说明活动规则",
    };
  }
}
