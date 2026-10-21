import { z } from "zod";
import type { ChannelIdentity } from "../../shared/channels.js";
import type { Config } from "../infrastructure/public.js";

export interface WeChatOAuthPort {
  readonly configured: boolean;
  createAuthorizationUrl(state: string): string;
  verifyCallback(input: {
    code: string;
    state: string;
  }): Promise<ChannelIdentity>;
}

export class HttpWeChatOAuthAdapter implements WeChatOAuthPort {
  readonly configured: boolean;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    this.configured = Boolean(config.wechatOAuth);
  }

  createAuthorizationUrl(state: string) {
    const config = this.config.wechatOAuth;
    if (!config) throw new Error("WeChat OAuth is not configured");
    const query = new URLSearchParams({
      appid: config.appId,
      redirect_uri: config.redirectUri,
      response_type: "code",
      scope: "snsapi_base",
      state,
    });
    return `https://open.weixin.qq.com/connect/oauth2/authorize?${query.toString()}#wechat_redirect`;
  }

  async verifyCallback(input: { code: string; state: string }) {
    const config = this.config.wechatOAuth;
    if (!config) throw new Error("WeChat OAuth is not configured");
    const endpoint = new URL(
      "https://api.weixin.qq.com/sns/oauth2/access_token",
    );
    endpoint.search = new URLSearchParams({
      appid: config.appId,
      secret: config.appSecret,
      code: input.code,
      grant_type: "authorization_code",
    }).toString();
    const response = await this.fetchImpl(endpoint, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (!response.ok || declaredSize > 8192)
      throw new Error("WeChat OAuth exchange failed");
    const raw = await response.text();
    if (raw.length > 8192)
      throw new Error("WeChat OAuth response is too large");
    const parsed = z
      .object({
        openid: z.string().regex(/^[a-zA-Z0-9_-]{10,128}$/),
        errcode: z.number().optional(),
      })
      .passthrough()
      .safeParse(JSON.parse(raw));
    if (!parsed.success || parsed.data.errcode !== undefined)
      throw new Error("WeChat OAuth exchange failed");
    return {
      channel: "wechat" as const,
      subject: parsed.data.openid,
      verified: true,
    };
  }
}
