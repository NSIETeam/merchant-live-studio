import type { Config } from "../config.js";
import type { StreamConfig } from "../../shared/types.js";
export interface StreamAdapter {
  playbackUrl(roomId: string): string;
  configuration(roomId: string, secret: string): StreamConfig;
}
export function createStreamAdapter(config: Config): StreamAdapter {
  const playbackUrl = (id: string) =>
    `${config.streamHlsBase.replace(/\/$/, "")}/${encodeURIComponent(id)}${config.streamProvider === "srs" ? ".m3u8" : "/index.m3u8"}`;
  return {
    playbackUrl,
    configuration: (id, secret) => ({
      provider: config.streamProvider,
      server: config.streamRtmpBase,
      streamKey: `${id}?token=${secret}`,
      playbackUrl: playbackUrl(id),
      authEnabled: Boolean(config.streamAuthSecret),
    }),
  };
}
