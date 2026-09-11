import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { WeChatShareSignature } from "../../shared/channels.js";
import type { Config } from "../infrastructure/public.js";

const responseLimit = 8192;
type CachedCredential = { value: string; expiresAt: number };

export interface WeChatJsSdkPort {
  readonly configured: boolean;
  signUrl(url: string): Promise<WeChatShareSignature>;
}

export class HttpWeChatJsSdkAdapter implements WeChatJsSdkPort {
  readonly configured: boolean;
  private accessToken?: CachedCredential;
  private ticket?: CachedCredential;
  private accessRequest?: Promise<CachedCredential>;
  private ticketRequest?: Promise<CachedCredential>;

  constructor(
    private readonly config: Config,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
  ) {
    this.configured = Boolean(config.wechatOAuth && config.wechatJsSdkEnabled);
  }

  private async boundedJson(url: URL) {
    const response = await this.fetchImpl(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(8000),
    });
    const declaredSize = Number(response.headers.get("content-length") || 0);
    if (
      !response.ok ||
      (Number.isFinite(declaredSize) && declaredSize > responseLimit)
    )
      throw new Error("WeChat JS-SDK request failed");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > responseLimit)
      throw new Error("WeChat JS-SDK response is too large");
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error("WeChat JS-SDK response is invalid");
    }
  }

  private cache(value: string, expiresIn: number): CachedCredential {
    return {
      value,
      expiresAt: this.clock() + Math.max(30, expiresIn - 300) * 1000,
    };
  }

  private async getAccessToken() {
    if (this.accessToken && this.accessToken.expiresAt > this.clock())
      return this.accessToken.value;
    if (!this.accessRequest) {
      this.accessRequest = (async () => {
        const config = this.config.wechatOAuth;
        if (!config || !this.config.wechatJsSdkEnabled)
          throw new Error("WeChat JS-SDK is not configured");
        const endpoint = new URL("https://api.weixin.qq.com/cgi-bin/token");
        endpoint.search = new URLSearchParams({
          grant_type: "client_credential",
          appid: config.appId,
          secret: config.appSecret,
        }).toString();
        const parsed = z
          .object({
            access_token: z.string().min(10).max(2048),
            expires_in: z.number().int().min(60).max(86400),
          })
          .passthrough()
          .safeParse(await this.boundedJson(endpoint));
        if (!parsed.success)
          throw new Error("WeChat JS-SDK access token failed");
        return this.cache(parsed.data.access_token, parsed.data.expires_in);
      })().finally(() => {
        this.accessRequest = undefined;
      });
    }
    this.accessToken = await this.accessRequest;
    return this.accessToken.value;
  }

  private async getTicket() {
    if (this.ticket && this.ticket.expiresAt > this.clock())
      return this.ticket.value;
    if (!this.ticketRequest) {
      this.ticketRequest = (async () => {
        const endpoint = new URL(
          "https://api.weixin.qq.com/cgi-bin/ticket/getticket",
        );
        endpoint.search = new URLSearchParams({
          access_token: await this.getAccessToken(),
          type: "jsapi",
        }).toString();
        const parsed = z
          .object({
            errcode: z.literal(0),
            ticket: z.string().min(10).max(2048),
            expires_in: z.number().int().min(60).max(86400),
          })
          .passthrough()
          .safeParse(await this.boundedJson(endpoint));
        if (!parsed.success) throw new Error("WeChat JS-SDK ticket failed");
        return this.cache(parsed.data.ticket, parsed.data.expires_in);
      })().finally(() => {
        this.ticketRequest = undefined;
      });
    }
    this.ticket = await this.ticketRequest;
    return this.ticket.value;
  }

  async signUrl(url: string): Promise<WeChatShareSignature> {
    const config = this.config.wechatOAuth;
    if (!config || !this.config.wechatJsSdkEnabled)
      throw new Error("WeChat JS-SDK is not configured");
    const ticket = await this.getTicket();
    const timestamp = Math.floor(this.clock() / 1000);
    const nonceStr = randomBytes(16).toString("hex");
    const signature = createHash("sha1")
      .update(
        `jsapi_ticket=${ticket}&noncestr=${nonceStr}&timestamp=${timestamp}&url=${url}`,
      )
      .digest("hex");
    return {
      appId: config.appId,
      timestamp,
      nonceStr,
      signature,
      jsApiList: ["updateAppMessageShareData", "updateTimelineShareData"],
    };
  }
}
