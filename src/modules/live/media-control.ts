import type { Config } from "../../platform/infrastructure/public.js";
import type { StreamState } from "../../shared/types.js";

interface MediaPath {
  name: string;
  online?: boolean;
  available?: boolean;
  ready?: boolean;
  readers?: unknown[];
  source?: { type: string; id: string } | null;
}
/** MediaMTX 1.21 control API. Control URL and credentials never come from HTTP clients. */
export class MediaController {
  private cache = new Map<
    string,
    { at: number; promise: Promise<StreamState> }
  >();
  constructor(private config: Config) {}
  get configured() {
    return (
      Boolean(this.config.mediaControlUrl) &&
      this.config.streamProvider === "mediamtx"
    );
  }
  private async request(path: string, method = "GET") {
    const response = await fetch(
      this.config.mediaControlUrl.replace(/\/$/, "") + path,
      {
        method,
        headers: this.config.mediaControlToken
          ? { Authorization: `Bearer ${this.config.mediaControlToken}` }
          : {},
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Media control request failed");
    return method === "GET" ? await response.json() : {};
  }
  private path(roomId: string): Promise<MediaPath | null> {
    return this.request(
      "/v3/paths/get/" + encodeURIComponent("live/" + roomId),
    );
  }
  async status(roomId: string): Promise<StreamState> {
    if (!this.configured)
      return {
        configured: false,
        connected: null,
        checkedAt: Date.now(),
        message: "未配置流状态服务",
      };
    const cached = this.cache.get(roomId);
    if (cached && Date.now() - cached.at < 2500) return cached.promise;
    if (this.cache.size > 1000)
      for (const [key, item] of this.cache)
        if (Date.now() - item.at > 5000) this.cache.delete(key);
    const promise = this.path(roomId)
      .then((p) => ({
        configured: true,
        connected: Boolean(p && (p.online ?? p.ready ?? p.available)),
        viewers: p?.readers?.length || 0,
        checkedAt: Date.now(),
      }))
      .catch(() => ({
        configured: true,
        connected: null,
        checkedAt: Date.now(),
        message: "暂时无法读取流状态",
      }));
    this.cache.set(roomId, { at: Date.now(), promise });
    return promise;
  }
  async disconnect(
    roomId: string,
  ): Promise<{ disconnected: boolean; message?: string }> {
    this.cache.delete(roomId);
    if (!this.configured)
      return { disconnected: false, message: "未配置引擎控制，请手动停止 OBS" };
    try {
      const path = await this.path(roomId);
      if (!path?.source) return { disconnected: true };
      const endpoints: Record<string, string> = {
        rtmpConn: "/v3/rtmp/conns/kick/",
        rtmpsConn: "/v3/rtmps/conns/kick/",
      };
      const endpoint = endpoints[path.source.type];
      if (!endpoint)
        return {
          disconnected: false,
          message: "当前推流协议暂不支持强制断开，请手动停止推流",
        };
      await this.request(endpoint + encodeURIComponent(path.source.id), "POST");
      this.cache.delete(roomId);
      const after = await this.path(roomId);
      if (after?.source && (after.online ?? after.ready ?? false))
        return {
          disconnected: false,
          message: "引擎仍报告推流在线，请重试断流并停止 OBS",
        };
      return { disconnected: true };
    } catch {
      return {
        disconnected: false,
        message: "断流请求失败，请手动停止 OBS 后重试",
      };
    }
  }
}
