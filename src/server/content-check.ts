import type {
  ProductVersion,
  ScriptParagraph,
  ScriptCheck,
  ScriptIssue,
} from "../shared/content.js";

export const CONTENT_RULE_VERSION = "kaopu-content-rules-1";

/** A bounded editorial precheck. It cannot establish truth, efficacy, or legal permission. */
export function checkScript(
  paragraphs: ScriptParagraph[],
  product: ProductVersion,
  now: number,
): ScriptCheck {
  const issues: ScriptIssue[] = [];
  const approved = new Map(
    product.facts
      .filter((fact) => fact.approved && fact.evidence.trim())
      .map((fact) => [fact.id, fact]),
  );
  const add = (
    paragraphId: string,
    level: ScriptIssue["level"],
    code: ScriptIssue["code"],
    message: string,
  ) => issues.push({ paragraphId, level, code, message });
  for (const paragraph of paragraphs) {
    // Course ordinals and an explicit non-substitution disclaimer are not superiority or treatment claims.
    const text = paragraph.text.normalize("NFKC");
    const claims = text
      .replace(
        /第[一二三四五六七八九十百零\d]+(?:课|讲|章|节|步|次|天|周|轮|段|批|阶段)/g,
        "课程顺序",
      )
      .replace(
        /(?:本(?:品|产品)|此产品)?(?:不能|不可|并不能|不可以)(?:代替|替代)(?:药品|药物|医疗)?治疗(?:疾病)?/g,
        "非替代声明",
      );
    if (
      /无出其右|独一无二|天下第一|第一名|(?:全网|全国|行业|同类|销量|销售额|排名|口碑|品质|质量|效果|功效|本款|本品|本产品|这款(?:产品)?|我们)[^。！？\n]{0,12}(?:第[一1]|NO\.?\s*1)|(?:最(?:佳|好|强|高|优|顶级))/.test(
        claims,
      )
    )
      add(
        paragraph.id,
        "block",
        "claim",
        "检测到排名、极限或同义优越性宣传；需核实适用范围并修改主张，不能只换成隐晦同义词。",
      );
    if (
      /治疗|治愈|根治|治好|药到病除|(?:保证|保障|确保|一定|必定)[^。！？\n]{0,12}(?:有效|见效|治好|治愈|改善|康复|降[血压糖脂]|安全|无副作用)|(?:百分百|100\s*%)[^。！？\n]{0,6}(?:有效|见效)|(?:一个月|三天|七天|一周)[^。！？\n]{0,4}(?:见效|康复)/.test(
        claims,
      )
    )
      add(
        paragraph.id,
        "block",
        "claim",
        `检测到治疗或保证效果的主张。商品类别为“${product.category}”；本轮规则不具备核验药品/医疗广告资质的能力，不能据此定稿。`,
      );
    if (
      /(?:忽略|绕过|跳过|无视)[^。！？\n]{0,12}(?:规则|审核|审查|证据)|(?:规避|躲避)[^。！？\n]{0,8}(?:审查|审核|监管)/.test(
        text,
      )
    )
      add(
        paragraph.id,
        "block",
        "instruction",
        "发现要求绕过证据或审查的指令；这类要求不能作为可定稿话术。",
      );
    if (
      /妈妈的味道|童年的味道|家乡的味道|小时候|我(?:妈|母亲|小时候|亲身)/.test(
        text,
      )
    ) {
      add(
        paragraph.id,
        "review",
        "emotion",
        "情感联想需要符合主播真实经历，并保留个人感受边界；不能虚构亲历或暗示产品功效。",
      );
      if (
        /(?:所有人|每个人|人人|大家都)[^。！？\n]{0,16}(?:想起|感受|感到|记得|喜欢)/.test(
          text,
        )
      )
        add(
          paragraph.id,
          "block",
          "emotion",
          "不能把个人情感联想承诺为每个人都会产生的感受。",
        );
    }
    if (paragraph.kind === "fact" && !paragraph.factIds.length)
      add(
        paragraph.id,
        "block",
        "missing_evidence",
        "事实段落尚未关联已审核商品依据；请补充引用或重新判断该段是否仅为过渡。",
      );
    const invalid = paragraph.factIds.filter((id) => !approved.has(id));
    if (invalid.length)
      add(
        paragraph.id,
        "block",
        "invalid_evidence",
        "引用包含不存在、未审核或没有出处的事实；请使用当前商品证据版本重新核对。",
      );
    if (
      paragraph.kind === "transition" &&
      !paragraph.factIds.length &&
      /\d|百分之|(?:容量|成分|配料|产地|蛋白|含量|功效|效果|适合|不含|富含|改善|降低|增强|预防)/.test(
        claims,
      )
    )
      add(
        paragraph.id,
        "block",
        "missing_evidence",
        "这段过渡文字包含商品参数、效果或适用性信息；请改为事实段并关联依据。",
      );
    if (paragraph.factIds.length && !invalid.length) {
      const citedText = paragraph.factIds
        .map((id) => approved.get(id)!.text.normalize("NFKC"))
        .join("\n");
      const numbers = (
        text
          .replace(/第\d+(?:课|讲|章|节|步|次|天|周|轮|段)/g, "")
          .match(
            /\d+(?:\.\d+)?\s*(?:%|毫升|ml|mL|克|g|mg|毫克|公斤|kg|岁|个月|年|元|度|℃)/g,
          ) || []
      ).map((value) => value.replace(/\s+/g, ""));
      if (
        numbers.some(
          (number) => !citedText.replace(/\s+/g, "").includes(number),
        )
      )
        add(
          paragraph.id,
          "block",
          "unsupported_claim",
          "段落中的部分数值或单位未出现在所引用事实中；请逐项核对，不能靠关联任意证据支持新参数。",
        );
      add(
        paragraph.id,
        "review",
        "unsupported_claim",
        "引用已关联，但规则不能证明整段语义均获证据支持；人工定稿前须核对真实性、适用范围和完整语境。",
      );
    }
  }
  const blockingCount = issues.filter(
    (issue) => issue.level === "block",
  ).length;
  return {
    checkedAt: now,
    ruleVersion: CONTENT_RULE_VERSION,
    blockingCount,
    issues,
    summary: blockingCount
      ? `发现 ${blockingCount} 项阻断问题，需要修改后保存新版本再检查。有限规则不等于完整语义或法律审查。`
      : "未命中本轮有限规则的阻断项；仍须人工核对事实、表达与适用范围。该结果不代表法律审查或独立审稿人批准。",
  };
}
