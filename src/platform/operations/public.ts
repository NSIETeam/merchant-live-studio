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
      mediaControl: media.configured,
      requirePlayback: config.requirePlayback,
      platformCompliance: Boolean(config.platformCompliance),
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
    });
  });
}
