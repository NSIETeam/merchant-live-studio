import type { WeChatShareSignature } from "../../shared/channels.js";

export type WeChatSdk = {
  config(
    input: Omit<WeChatShareSignature, "jsApiList"> & {
      debug: false;
      jsApiList: string[];
    },
  ): void;
  ready(callback: () => void): void;
  error(callback: (error: unknown) => void): void;
  checkJsApi(input: {
    jsApiList: string[];
    success(result: { checkResult?: Record<string, boolean> }): void;
    fail?(): void;
  }): void;
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
    WeixinJSBridge?: {
      invoke(
        name: "requestMerchantTransfer",
        input: { mchId: string; appId: string; package: string },
        callback: (result: { err_msg?: string }) => void,
      ): void;
    };
  }
}

let sdkRequest: Promise<WeChatSdk> | undefined;

export function loadWeChatSdk() {
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
