import { normalizeRiskText } from "../../../shared/risk-text.js";
import type {
  AgentAlert,
  ClaimDecision,
  ClaimDecisionType,
} from "../../../shared/agent.js";

export const COMPLIANCE_POLICY_VERSION = "cn-live-claims-2026.1";
export type CompliancePolicyPack =
  "general" | "food-nutrition" | "regulated-health";

type Rule = {
  id: string;
  type: ClaimDecisionType;
  category: NonNullable<AgentAlert["category"]>;
  disposition: ClaimDecision["disposition"];
  pattern: RegExp;
  explanation: string;
  evidenceNeeded: string;
  suggestedAction: string;
};

const rules: Rule[] = [
  {
    id: "CN-INSTRUCTION-001",
    type: "instruction_override",
    category: "instruction",
    disposition: "block",
    pattern:
      /(?:忽略|绕过|覆盖|关闭).{0,16}(?:规则|指令|审核|证据|系统|安全)|ignore.{0,30}(?:previous|instructions?|safety|evidence)|(?:system|developer)\s*:|<\|(?:im_start|system)/giu,
    explanation:
      "输入正在要求改变固定证据或审核规则；业务资料和提示词不能取得这种权限。",
    evidenceNeeded: "不适用；任务数据不能授权修改系统约束。",
    suggestedAction: "忽略越权要求，只处理经过审核的事实和正常业务问题。",
  },
  {
    id: "CN-CLAIM-MEDICAL-001",
    type: "medical_efficacy",
    category: "claim",
    disposition: "block",
    pattern:
      /治疗|治愈|根治|药到病除|抗癌|降血糖|降血压|修复疾病|调理.{0,10}(?:疾病|糖尿病|高血压|肿瘤|失眠)/giu,
    explanation:
      "表达把商品与疾病治疗或明确医疗效果相联系，需要先核对商品类别、获准内容和完整语境。",
    evidenceNeeded:
      "商品法定类别、适用资质、获准广告或标签内容及对应原始材料。",
    suggestedAction:
      "暂停该功效主张；仅介绍已审核标签事实，不用保健或调理近义词代替治疗承诺。",
  },
  {
    id: "CN-CLAIM-GUARANTEE-001",
    type: "guarantee",
    category: "claim",
    disposition: "block",
    pattern:
      /保证.{0,14}(?:见效|有效|治好|成功|瘦|改善|满意)|包治|永久有效|终身保证|百分之百|100\s*%|零风险|绝对(?:有效|安全|不会|能)/giu,
    explanation: "表达作出确定效果、安全性或结果保证，不能只靠主播措辞成立。",
    evidenceNeeded:
      "主张对象、适用范围、条件、期限以及能够直接支持该结论的有效材料。",
    suggestedAction: "删除保证式结论，改为说明已审核的具体参数、条件和限制。",
  },
  {
    id: "CN-CLAIM-SUPERIORITY-001",
    type: "superiority",
    category: "claim",
    disposition: "block",
    pattern:
      /第一|无出其右|全网最低|最低价|最好|最强|顶级|绝无仅有|独一无二|国家级|最高级|最佳|天花板/giu,
    explanation:
      "表达包含绝对化、排他比较或近似优越性主张；同义替换不会改变主张本身。",
    evidenceNeeded:
      "明确比较对象、统计口径、时间地域、有效数据来源以及商品所处完整语境。",
    suggestedAction:
      "先移除排他结论；如确有依据，由审核人核对范围和时点后改用可验证的具体事实。",
  },
  {
    id: "CN-CLAIM-TESTIMONIAL-001",
    type: "testimonial",
    category: "emotion",
    disposition: "block",
    pattern:
      /专家(?:都)?推荐|医生(?:都)?推荐|权威(?:都)?推荐|我(?:亲自|亲身|从小|小时候|吃过|用过|用了|喝过|妈妈|母亲)|我记得|带我回到|(?:每个人|所有人).{0,10}(?:妈妈|童年|小时候|喜欢|爱吃|有效)/giu,
    explanation:
      "表达可能虚构推荐、个人经历或受众共同感受；风格样例不能证明这些事实。",
    evidenceNeeded:
      "真实主体、授权范围、原始记录及商品类别允许性；不得由模型补造。",
    suggestedAction:
      "删除代言或共同体验断言，保留主播真实且获授权的主观描述，并交人工复核。",
  },
  {
    id: "CN-CLAIM-EMOTION-001",
    type: "emotional_association",
    category: "emotion",
    disposition: "review",
    pattern: /妈妈的味道|母亲的味道|家的味道|童年的味道|童年回忆/giu,
    explanation:
      "这是情感或口味联想，是否真实取决于说话人和语境，不能扩展成普遍体验或商品功效。",
    evidenceNeeded:
      "主播本人真实表达意愿和品牌授权边界；商品事实仍需独立依据。",
    suggestedAction:
      "明确这是个人或主观联想，避免声称所有人都有同样感受，也不要连接未经证实的功效。",
  },
  {
    id: "CN-CLAIM-SCARCITY-001",
    type: "price_scarcity",
    category: "claim",
    disposition: "block",
    pattern:
      /仅剩\s*\d+\s*(?:件|份|单)|最后\s*\d+\s*(?:件|份|单)|马上涨价|今天不买.{0,10}(?:再也|永远|就).{0,8}(?:买不到|没有)|全网最低|亏本(?:卖|价)/giu,
    explanation:
      "表达可能形成价格、库存或期限的确定性稀缺主张，需要实时业务数据支持。",
    evidenceNeeded:
      "当前库存、有效价格、活动起止时间、适用门店和平台配置快照。",
    suggestedAction:
      "从实时活动配置读取并说明完整条件；无法核实时不要制造倒计时或稀缺感。",
  },
  {
    id: "CN-PLATFORM-INCENTIVE-001",
    type: "platform_incentive",
    category: "platform",
    disposition: "block",
    pattern: /(?:转发|分享|关注).{0,12}(?:领取|领红包|红包|返现|奖励)/giu,
    explanation:
      "活动把分享或关注与权益绑定，需要核对渠道规则、资格、金额和完整告知。",
    evidenceNeeded: "平台规则、活动配置、参与条件、资金或权益状态和适用期限。",
    suggestedAction: "暂停口头承诺，从已配置活动读取规则，并展示完整参与条件。",
  },
];

const structuralOrdinal = /^第一(?:步|页|章|节|阶段|轮|次|点|部分|个问题)/u;
const disavowal =
  /(?:不要说|不能说|别说|避免说|不可说|能不能说|是否可以说|有人说|原话是).{0,10}$/u;

export function policyPackFor(category?: string): CompliancePolicyPack {
  const value = normalizeRiskText(category || "").toLowerCase();
  if (/药品|医疗器械|医疗|医美|诊疗|处方|非处方/.test(value))
    return "regulated-health";
  if (/食品|饮料|营养|保健|膳食|奶粉|酒|茶|咖啡/.test(value))
    return "food-nutrition";
  return "general";
}

function sentenceAt(text: string, index: number, length: number) {
  const before = text.slice(0, index);
  const after = text.slice(index + length);
  const start = Math.max(
    before.lastIndexOf("。"),
    before.lastIndexOf("！"),
    before.lastIndexOf("？"),
    before.lastIndexOf("\n"),
  );
  const ends = ["。", "！", "？", "\n"]
    .map((mark) => after.indexOf(mark))
    .filter((at) => at >= 0);
  const end = ends.length ? Math.min(...ends) : after.length;
  return text
    .slice(start + 1, index + length + end)
    .trim()
    .slice(0, 240);
}

function withContext(rule: Rule, text: string, phrase: string, index: number) {
  if (rule.type === "superiority" && phrase === "第一") {
    const tail = text.slice(index, index + 24);
    if (structuralOrdinal.test(tail))
      return {
        ...rule,
        id: "CN-CONTEXT-ORDINAL-001",
        type: "contextual_ordinal" as const,
        disposition: "context" as const,
        explanation:
          "这里更像步骤、章节或顺序序号，但仍需结合整句话确认它没有转指商品排名。",
        evidenceNeeded:
          "完整前后句；若实际指向销量或质量排名，仍需比较范围和数据依据。",
        suggestedAction:
          "保留完整上下文供人工查看，不因单个“第一”字样自动拦截。",
      };
  }
  const prefix = text.slice(Math.max(0, index - 24), index);
  if (
    disavowal.test(prefix) &&
    !/(?:改成|换成|就说|但(?:能|可以)?说|可以说)/u.test(prefix)
  )
    return {
      ...rule,
      disposition: "review" as const,
      explanation: `${rule.explanation} 当前语句可能在讨论或否定该说法，需查看后续是否换词继续表达同一主张。`,
      suggestedAction: `保留完整上下文核对；若只是明确禁止该说法可记录为已纠正，若后文继续同义表达则按原级别拦截。`,
    };
  return rule;
}

export function inspectCompliance(
  input: string,
  category?: string,
): {
  policyVersion: string;
  policyPack: CompliancePolicyPack;
  decisions: ClaimDecision[];
  alerts: AgentAlert[];
} {
  const text = normalizeRiskText(input);
  const pack = policyPackFor(category);
  const decisions: ClaimDecision[] = [];
  const seen = new Set<string>();
  for (const base of rules) {
    for (const match of text.matchAll(base.pattern)) {
      const index = match.index ?? 0;
      const applied = withContext(base, text, match[0], index);
      const key = `${applied.id}:${index}:${match[0]}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const packNote =
        applied.type === "medical_efficacy" && pack === "food-nutrition"
          ? " 当前商品类别涉及食品或营养，先确认它是否属于普通食品、保健食品或其他类别。"
          : applied.type === "medical_efficacy" && pack === "regulated-health"
            ? " 当前商品类别属于医疗健康敏感范围，需按其实际资质和获准内容复核。"
            : "";
      decisions.push({
        ruleId: applied.id,
        type: applied.type,
        disposition: applied.disposition,
        category: applied.category,
        phrase: match[0].slice(0, 100),
        statement: sentenceAt(text, index, match[0].length),
        explanation: `${applied.explanation}${packNote}`,
        evidenceNeeded: applied.evidenceNeeded,
        suggestedAction: applied.suggestedAction,
      });
      if (decisions.length >= 40) break;
    }
    if (decisions.length >= 40) break;
  }
  const alerts = decisions.map((decision) => ({
    level:
      decision.disposition === "block"
        ? ("high" as const)
        : ("review" as const),
    category: decision.category,
    phrase: decision.phrase,
    reason: `${decision.explanation} 处理方向：${decision.suggestedAction}`,
  }));
  return {
    policyVersion: COMPLIANCE_POLICY_VERSION,
    policyPack: pack,
    decisions,
    alerts,
  };
}
