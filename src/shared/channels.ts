// Channel adapters are independent from Live Core and Agent prompt/model logic.
// No WeChat identity or signed sharing capability is simulated by these contracts.
export interface ChannelIdentity {
  channel: "web" | "wechat" | "partner";
  subject: string;
  verified: boolean;
}
export interface ChannelCapabilities {
  channel: ChannelIdentity["channel"];
  viewerEntry: "available" | "not-configured";
  verifiedIdentity: boolean;
  signedSharing: boolean;
  realPayment: boolean;
}
export interface ChannelIdentityAdapter {
  readonly channel: ChannelIdentity["channel"];
  verifyCallback(input: {
    code: string;
    state: string;
    redirectUri: string;
  }): Promise<ChannelIdentity>;
}
export interface ShareEntryAdapter {
  createEntry(input: {
    roomId: string;
    publicWatchUrl: string;
  }): Promise<{ url: string; expiresAt?: number }>;
}
export const channelCapabilities: ChannelCapabilities[] = [
  {
    channel: "web",
    viewerEntry: "available",
    verifiedIdentity: false,
    signedSharing: false,
    realPayment: false,
  },
  {
    channel: "wechat",
    viewerEntry: "not-configured",
    verifiedIdentity: false,
    signedSharing: false,
    realPayment: false,
  },
  {
    channel: "partner",
    viewerEntry: "not-configured",
    verifiedIdentity: false,
    signedSharing: false,
    realPayment: false,
  },
];
export function configuredChannelCapabilities(wechatIdentity: boolean) {
  return channelCapabilities.map((capability) =>
    capability.channel === "wechat" && wechatIdentity
      ? {
          ...capability,
          viewerEntry: "available" as const,
          verifiedIdentity: true,
        }
      : capability,
  );
}
