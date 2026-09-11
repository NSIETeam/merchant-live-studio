import { activeModerationHold } from "./moderation.js";
import type { DB } from "../../shared/persistence.js";
import type { Config } from "../../platform/infrastructure/public.js";
import type { ContentBinding } from "../../shared/content.js";
import type { AdmissionCheck } from "../../shared/admission.js";
export function createAdmissionChecker(
  db: DB,
  config: Config,
  ports: {
    disclosure: (
      tenant: string,
      now: number,
    ) => { published: boolean; version: number | null; valid: boolean };
    binding: (
      room: string,
      tenant: string,
      independent: boolean,
    ) => ContentBinding | null;
  },
) {
  return function admissionCheck(
    roomId: string,
    merchantId: string,
    controlReachable: boolean,
    now = Date.now(),
  ): AdmissionCheck {
    const disclosure = ports.disclosure(merchantId, now);
    const disclosureValid = disclosure.valid;
    const binding = ports.binding(roomId, merchantId, true);
    const configured =
      config.streamProvider === "mediamtx" &&
      Boolean(config.mediaControlUrl) &&
      Boolean(config.streamAuthSecret);
    const hold = activeModerationHold(db, roomId);
    const checks = [
      {
        code: "platform",
        label: "平台主体与政策",
        passed: Boolean(config.platformCompliance),
        detail: config.platformCompliance
          ? "平台运营主体、投诉渠道及政策入口已配置"
          : "请由服务器管理员配置并核验平台运营主体、投诉渠道、隐私政策和服务协议",
      },
      {
        code: "retention",
        label: "记录留存政策",
        passed: Boolean(config.retentionPolicy),
        detail: config.retentionPolicy
          ? "直播内容、业务记录及安全日志保存期限已达到配置下限"
          : "请由服务器管理员配置并核验记录保存期限和删除复核渠道",
      },
      {
        code: "disclosure",
        label: "经营者公示",
        passed: disclosure.published && disclosureValid,
        detail: disclosure.published
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
        platformPolicyEffectiveDate:
          config.platformCompliance?.effectiveDate ?? null,
        retentionPolicyEffectiveDate:
          config.retentionPolicy?.effectiveDate ?? null,
        disclosureVersion: disclosure.published
          ? Number(disclosure.version)
          : null,
        courseId: binding?.courseId || null,
        scriptVersion: binding?.scriptVersion || null,
      },
    };
  };
}
