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
interface SrsStream {
  app?: unknown;
  name?: unknown;
  clients?: unknown;
  publish?: { active?: unknown; cid?: unknown };
}

/** MediaMTX 1.21 or SRS 6 control API. Credentials never come from HTTP clients. */
export class MediaController {
  private cache = new Map<
    string,
    { at: number; promise: Promise<StreamState> }
  >();
  constructor(private config: Config) {}
  get configured() {
    return Boolean(this.config.mediaControlUrl);
  }
  private headers(): Record<string, string> {
    if (this.config.mediaControlUsername)
      return {
        Authorization: `Basic ${Buffer.from(`${this.config.mediaControlUsername}:${this.config.mediaControlPassword}`).toString("base64")}`,
      };
    return this.config.mediaControlToken
      ? { Authorization: `Bearer ${this.config.mediaControlToken}` }
      : {};
  }
  private async boundedText(response: Response) {
    const limit = 256 * 1024;
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > limit)
      throw new Error("Media control response is too large");
    if (!response.body) return "";
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit)
          throw new Error("Media control response is too large");
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      throw error;
    }
    return Buffer.concat(chunks, size).toString("utf8");
  }
  private async request(path: string, method = "GET") {
    const response = await fetch(
      this.config.mediaControlUrl.replace(/\/$/, "") + path,
      {
        method,
        headers: this.headers(),
        signal: AbortSignal.timeout(3000),
        redirect: "error",
      },
    );
    if (response.status === 404) return null;
    if (!response.ok) throw new Error("Media control request failed");
    const raw = await this.boundedText(response);
    const data = raw ? (JSON.parse(raw) as unknown) : {};
    if (
      this.config.streamProvider === "srs" &&
      (!data ||
        typeof data !== "object" ||
        !("code" in data) ||
        data.code !== 0)
    )
      throw new Error("SRS control response reported an error");
    return data;
  }
  async readyForAdmission(): Promise<boolean> {
    if (!this.configured) return false;
    try {
      if (this.config.streamProvider === "srs") {
        const info = await this.request("/api/v1/versions");
        const envelope = info as
          { version?: unknown; data?: { version?: unknown } } | undefined;
        const version = envelope?.version ?? envelope?.data?.version;
        return typeof version === "string" && /^v?\d+\.\d+/.test(version);
      }
      const info = (await this.request("/v3/info")) as {
        version?: unknown;
        started?: unknown;
      } | null;
      return Boolean(
        info &&
        typeof info.version === "string" &&
        /^v?\d+\.\d+/.test(info.version) &&
        typeof info.started === "string",
      );
    } catch {
      return false;
    }
  }
  private path(roomId: string): Promise<MediaPath | null> {
    return this.request(
      "/v3/paths/get/" + encodeURIComponent("live/" + roomId),
    ) as Promise<MediaPath | null>;
  }
  private async srsStream(roomId: string): Promise<SrsStream | null> {
    const response = await this.request("/api/v1/streams/?start=0&count=1000");
    const envelope = response as
      { streams?: unknown; data?: { streams?: unknown } } | undefined;
    const streams = envelope?.streams ?? envelope?.data?.streams;
    if (!Array.isArray(streams))
      throw new Error("SRS stream list is malformed");
    return (
      streams.find((item): item is SrsStream =>
        Boolean(
          item &&
          typeof item === "object" &&
          (item as SrsStream).app === "live" &&
          (item as SrsStream).name === roomId,
        ),
      ) || null
    );
  }
  private current(roomId: string) {
    return this.config.streamProvider === "srs"
      ? this.srsStream(roomId)
      : this.path(roomId);
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
    const promise = this.current(roomId)
      .then((p) => ({
        configured: true,
        connected:
          this.config.streamProvider === "srs"
            ? Boolean((p as SrsStream | null)?.publish?.active)
            : Boolean(
                p &&
                ((p as MediaPath).online ??
                  (p as MediaPath).ready ??
                  (p as MediaPath).available),
              ),
        viewers:
          this.config.streamProvider === "srs"
            ? typeof (p as SrsStream | null)?.clients === "number"
              ? Math.max(
                  0,
                  ((p as SrsStream).clients as number) -
                    ((p as SrsStream).publish?.active ? 1 : 0),
                )
              : 0
            : (p as MediaPath | null)?.readers?.length || 0,
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
      if (this.config.streamProvider === "srs") {
        const stream = await this.srsStream(roomId);
        if (!stream?.publish?.active) return { disconnected: true };
        const cid = stream.publish.cid;
        if (!(
          (typeof cid === "number" && Number.isSafeInteger(cid) && cid >= 0) ||
          (typeof cid === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(cid))
        ))
          return {
            disconnected: false,
            message: "SRS 未返回有效的发布连接，请手动停止推流",
          };
        await this.request(
          "/api/v1/clients/" + encodeURIComponent(String(cid)),
          "DELETE",
        );
        this.cache.delete(roomId);
        const after = await this.srsStream(roomId);
        if (after?.publish?.active)
          return {
            disconnected: false,
            message: "SRS 仍报告推流在线，请重试断流并停止 OBS",
          };
        return { disconnected: true };
      }
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
