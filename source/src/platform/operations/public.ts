import type { Hono } from "hono";
import {
  HttpWeChatJsSdkAdapter,
  type WeChatJsSdkPort,
} from "../../platform/adapters/public.js";
import { type Config } from "../../platform/infrastructure/public.js";
import { configuredChannelCapabilities } from "../../shared/channels.js";
import type { DB } from "../../shared/persistence.js";
import { findDatabase } from "./persistence/public-queries.js";
export { attachCapacityGuard } from "./capacity.js";
export type { CapacitySnapshot } from "./capacity.js";
import type { CapacitySnapshot } from "./capacity.js";
import { attachWeChatSharing } from "./wechat-sharing.js";
export { attachWeChatSharing } from "./wechat-sharing.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function attachOperations(
  app: App,
  db: DB,
  config: Config,
  media: { configured: boolean },
  capacity?: { snapshot: () => CapacitySnapshot },
  wechatSharing: WeChatJsSdkPort = new HttpWeChatJsSdkAdapter(config),
) {
  app.get("/api/health", (c) => {
    findDatabase(db);
    return c.json({
      status: "ok",
      revision: config.releaseRevision,
      demoMode: config.demoMode,
      payments: config.paymentProvider,
      copilot: "agent-service",
      agentIndependent: true,
      streamProvider: config.streamProvider,
      speechProvider: config.speechProvider,
      speechIngestion: config.speechProvider === "webhook",
      speechAgentProfile: Boolean(config.speechAgentProfileId),
      mediaControl: media.configured,
      requirePlayback: config.requirePlayback,
      platformCompliance: Boolean(config.platformCompliance),
      retentionPolicy: Boolean(config.retentionPolicy),
      capacity: capacity?.snapshot() ?? null,
    });
  });
  app.get("/api/channels", (c) =>
    c.json({
      channels: configuredChannelCapabilities(
        Boolean(config.wechatOAuth),
        wechatSharing.configured,
        config.paymentProvider === "wechat",
      ),
    }),
  );
  attachWeChatSharing(app, config, wechatSharing);
  app.get("/api/platform/compliance", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      configured: Boolean(config.platformCompliance),
      data: config.platformCompliance,
      dataPractices: [
        "普通观看会建立最长 12 小时的浏览器会话，用于区分本次观看与互动。",
        "提问、投诉、活动资格及领取记录会与该观看会话关联；请勿填写身份证、银行卡等敏感信息。",
        "商家工作台使用账号会话和角色权限；直播录像仅在服务器明确配置录像存储后生成。",
        config.paymentProvider === "wechat"
          ? "微信身份验证与收款授权分开记录；收款身份加密保存，撤回授权会阻止后续领取，已有付款义务仍按原单处理。"
          : "微信身份与签名分享按当前渠道能力单独配置；身份验证不等于付款授权，演示红包不会发生实际转账。",
      ],
      retention: {
        configured: Boolean(config.retentionPolicy),
        data: config.retentionPolicy,
        enforcement: [
          "业务版本、审核、纠错、投诉、账本和处置记录不会由应用按年龄自动删除。",
          "已登记直播录像不会自动删除；到期后仍须独立复核，存在有效引用、投诉争议或主动保留时禁止删除。",
          "获准删除的录像先进入隔离区，删除任务中断时可继续执行或恢复原文件，过程保留审计记录。",
          "网络与安全日志、备份保留由部署基础设施负责，当前应用无法验证实际执行期限。",
          "达到声明期限不自动触发删除；存在投诉、争议、监管调取、账务或有效引用时需要继续保留。",
        ],
        sourceLinks: [
          {
            label: "互联网直播服务管理规定",
            url: "https://www.cac.gov.cn/2016-11/04/c_1119847629.htm",
          },
          {
            label: "直播电商监督管理办法",
            url: "https://www.cac.gov.cn/2026-01/07/c_1769516655383334.htm",
          },
          {
            label: "中华人民共和国网络安全法",
            url: "https://www.cac.gov.cn/2025-12/29/c_1768735112911946.htm",
          },
        ],
      },
    });
  });
}
