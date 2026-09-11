import { useEffect, useState } from "react";
import type { WeChatShareSignature } from "../../shared/channels.js";
import { api } from "../shared/api.js";

type WeChatSdk = {
  config(input: WeChatShareSignature & { debug: false }): void;
  ready(callback: () => void): void;
  error(callback: (error: unknown) => void): void;
  updateAppMessageShareData(input: {
    title: string;
    desc: string;
    link: string;
  }): void;
  updateTimelineShareData(input: { title: string; link: string }): void;
};

declare global {
  interface Window {
    wx?: WeChatSdk;
  }
}

let sdkRequest: Promise<WeChatSdk> | undefined;
function loadSdk() {
  if (window.wx) return Promise.resolve(window.wx);
  if (!sdkRequest) {
    sdkRequest = new Promise<WeChatSdk>((resolve, reject) => {
      const previous = document.querySelector<HTMLScriptElement>(
        'script[data-wechat-js-sdk="true"]',
      );
      const script = previous || document.createElement("script");
      const finish = () =>
        window.wx
          ? resolve(window.wx)
          : reject(new Error("微信 JS-SDK 未就绪"));
      script.addEventListener("load", finish, { once: true });
      script.addEventListener(
        "error",
        () => reject(new Error("微信 JS-SDK 加载失败")),
        { once: true },
      );
      if (!previous) {
        script.src = "https://res.wx.qq.com/open/js/jweixin-1.6.0.js";
        script.async = true;
        script.dataset.wechatJsSdk = "true";
        document.head.append(script);
      }
    }).catch((error) => {
      sdkRequest = undefined;
      throw error;
    });
  }
  return sdkRequest;
}

export function WeChatShareStatus({
  roomId,
  title,
  configured,
}: {
  roomId: string;
  title: string;
  configured: boolean;
}) {
  const [status, setStatus] = useState<
    "unconfigured" | "outside" | "loading" | "ready" | "failed"
  >("unconfigured");

  useEffect(() => {
    if (!configured) {
      setStatus("unconfigured");
      return;
    }
    if (!/MicroMessenger/i.test(navigator.userAgent)) {
      setStatus("outside");
      return;
    }
    let active = true;
    setStatus("loading");
    const signedUrl = window.location.href.split("#", 1)[0];
    Promise.all([
      api<WeChatShareSignature>(
        `/channels/wechat/share-signature?roomId=${encodeURIComponent(roomId)}&url=${encodeURIComponent(signedUrl)}`,
      ),
      loadSdk(),
    ])
      .then(([signature, wx]) => {
        if (!active) return;
        const timeout = window.setTimeout(() => {
          if (active) setStatus("failed");
        }, 8000);
        wx.error(() => {
          window.clearTimeout(timeout);
          if (active) setStatus("failed");
        });
        wx.ready(() => {
          window.clearTimeout(timeout);
          if (!active) return;
          const link = signedUrl;
          const desc = `在靠谱观看「${title}」直播间`;
          wx.updateAppMessageShareData({ title, desc, link });
          wx.updateTimelineShareData({ title, link });
          setStatus("ready");
        });
        wx.config({ debug: false, ...signature });
      })
      .catch(() => {
        if (active) setStatus("failed");
      });
    return () => {
      active = false;
    };
  }, [configured, roomId, title]);

  const message = {
    unconfigured: "微信签名分享尚未配置，可使用浏览器分享或复制链接。",
    outside: "微信签名分享已配置；请在微信内打开本页后使用右上角分享。",
    loading: "正在准备微信分享信息…",
    ready: "微信分享信息已就绪，可使用右上角发送给朋友或分享到朋友圈。",
    failed: "微信分享暂不可用，可继续观看并复制当前链接。",
  }[status];
  return (
    <p className="audience-help" role="status" data-share-state={status}>
      {message}
    </p>
  );
}
