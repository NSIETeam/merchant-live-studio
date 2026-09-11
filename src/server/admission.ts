import { disclosureInDate } from "../shared/disclosure.js";
import { activeModerationHold } from "./moderation.js";
import type { DB } from "./db.js";
import type { Config } from "./config.js";
import { getRoomContentBinding } from "./content.js";
import type { AdmissionCheck } from "../shared/admission.js";
export function admissionCheck(
  db: DB,
  config: Config,
  roomId: string,
  merchantId: string,
  controlReachable: boolean,
  now = Date.now(),
): AdmissionCheck {
  const disclosure = db
    .prepare(
      "SELECT version,action FROM disclosure_events WHERE merchant_id=? ORDER BY id DESC LIMIT 1",
    )
    .get(merchantId);
  const publishedData =
    disclosure?.action === "publish"
      ? db
          .prepare(
            "SELECT data_json FROM disclosure_versions WHERE merchant_id=? AND version=?",
          )
          .get(merchantId, disclosure.version)
      : undefined;
  const disclosureValid =
    !!publishedData &&
    disclosureInDate(JSON.parse(String(publishedData.data_json)), now);
  const binding = getRoomContentBinding(db, roomId, merchantId, true);
  const configured =
    config.streamProvider === "mediamtx" &&
    Boolean(config.mediaControlUrl) &&
    Boolean(config.streamAuthSecret);
  const hold = activeModerationHold(db, roomId);
  const checks = [
    {
      code: "disclosure",
      label: "经营者公示",
      passed: disclosure?.action === "publish" && disclosureValid,
      detail:
        disclosure?.action === "publish"
          ? disclosureValid
            ? "已有独立复核且在复核期限内的公示资料"
            : "公示资料已过期或缺少复核截止日期，请重新提交复核"
          : "请先填写企业资料并由另一账号复核公示",
    },
    {
      code: "script",
      label: "独立审核定稿",
      passed: Boolean(binding && !binding.stale),
      detail: !binding
        ? "请先绑定另一账号审核通过的讲稿"
        : binding.stale
          ? "当前讲稿或依据已失效，或尚未完成独立审核"
          : "已绑定有效的独立审核版本",
    },
    {
      code: "media",
      label: "推流鉴权与断流控制",
      passed: configured && controlReachable,
      detail: !configured
        ? "服务器尚未接通推流鉴权和强制断流控制，请联系管理员"
        : !controlReachable
          ? "流媒体控制服务暂时不可达，请恢复后重试"
          : "控制服务可达；实际断流效果仍需现场验证",
    },
    {
      code: "moderation",
      label: "现场处置状态",
      passed: !hold,
      detail: hold
        ? "直播间已暂停，需另一审核账号复核解除"
        : "没有尚未解除的暂停记录",
    },
  ];
  return {
    enforced: config.requireReviewedLive,
    ready: checks.every((check) => check.passed),
    checks,
    basis: {
      disclosureVersion:
        disclosure?.action === "publish" ? Number(disclosure.version) : null,
      courseId: binding?.courseId || null,
      scriptVersion: binding?.scriptVersion || null,
    },
  };
}
