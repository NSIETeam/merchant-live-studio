import type { Hono } from "hono";
import { type Config } from "../../platform/infrastructure/public.js";
import { channelCapabilities } from "../../shared/channels.js";
import type { DB } from "../../shared/persistence.js";
import { findDatabase } from "./persistence/public-queries.js";
type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;
export function attachOperations(
  app: App,
  db: DB,
  config: Config,
  media: { configured: boolean },
) {
  app.get("/api/health", (c) => {
    findDatabase(db);
    return c.json({
      status: "ok",
      demoMode: config.demoMode,
      payments: "simulation",
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
    });
  });
  app.get("/api/channels", (c) => c.json({ channels: channelCapabilities }));
  app.get("/api/platform/compliance", (c) => {
    c.header("Cache-Control", "no-store");
    return c.json({
      configured: Boolean(config.platformCompliance),
      data: config.platformCompliance,
      dataPractices: [
        "普通观看会建立最长 12 小时的浏览器会话，用于区分本次观看与互动。",
        "提问、投诉、活动资格及领取记录会与该观看会话关联；请勿填写身份证、银行卡等敏感信息。",
        "商家工作台使用账号会话和角色权限；直播录像仅在服务器明确配置录像存储后生成。",
        "真实模型、微信身份与微信支付当前未配置；演示红包不会发生实际转账。",
      ],
      retention: {
        configured: Boolean(config.retentionPolicy),
        data: config.retentionPolicy,
        enforcement: [
          "业务版本、审核、纠错、投诉、账本和处置记录不会由应用按年龄自动删除。",
          "已登记直播录像当前没有自动删除；安全删除审批、引用检查和争议冻结流程尚未实现。",
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
