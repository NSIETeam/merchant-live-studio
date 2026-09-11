import type { Hono } from "hono";
import { z } from "zod";
import type { WeChatJsSdkPort } from "../adapters/public.js";
import type { Config } from "../infrastructure/public.js";

type App = Hono<{ Variables: { merchantId: string; viewerId: string } }>;

export function attachWeChatSharing(
  app: App,
  config: Config,
  adapter: WeChatJsSdkPort,
) {
  app.get("/api/channels/wechat/share-signature", async (c) => {
    if (!adapter.configured)
      return c.json({ error: "微信签名分享尚未配置" }, 503);
    const query = z
      .object({
        roomId: z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/),
        url: z.url().max(2048),
      })
      .safeParse({ roomId: c.req.query("roomId"), url: c.req.query("url") });
    if (!query.success)
      return c.json({ error: "直播间或分享地址格式不正确" }, 400);
    const url = new URL(query.data.url);
    if (
      url.origin !== config.appOrigin ||
      url.username ||
      url.password ||
      url.hash ||
      url.pathname !== `${config.basePath}watch/${query.data.roomId}`
    )
      return c.json({ error: "只能签署当前直播间的观看地址" }, 400);
    try {
      const signature = await adapter.signUrl(url.href);
      c.header("Cache-Control", "no-store");
      return c.json(signature);
    } catch {
      return c.json({ error: "微信签名服务暂时不可用，请稍后重试" }, 502);
    }
  });
}
