import { useState } from "react";
import type { WeChatShareSignature } from "../../shared/channels.js";
import { api } from "../shared/api.js";
import { loadWeChatSdk } from "../shared/wechat-sdk.js";

export type WeChatTransferConfirmationData = {
  appId: string;
  mchId: string;
  package: string;
};

export function WeChatTransferConfirmation({
  roomId,
  confirmation,
}: {
  roomId: string;
  confirmation: WeChatTransferConfirmationData;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");

  async function confirm() {
    if (busy) return;
    setBusy(true);
    setMessage("");
    try {
      if (!/MicroMessenger/i.test(navigator.userAgent))
        throw new Error("请在微信内打开直播间完成收款确认");
      const signedUrl = window.location.href.split("#", 1)[0];
      const [signature, wx] = await Promise.all([
        api<WeChatShareSignature>(
          `/channels/wechat/share-signature?roomId=${encodeURIComponent(roomId)}&url=${encodeURIComponent(signedUrl)}`,
        ),
        loadWeChatSdk(),
      ]);
      if (signature.appId !== confirmation.appId)
        throw new Error("微信收款配置与当前公众号不一致");
      await new Promise<void>((resolve, reject) => {
        const timeout = window.setTimeout(
          () => reject(new Error("微信收款组件响应超时，请重试")),
          8000,
        );
        wx.error(() => {
          window.clearTimeout(timeout);
          reject(new Error("微信收款组件配置失败"));
        });
        wx.ready(() => {
          wx.checkJsApi({
            jsApiList: ["requestMerchantTransfer"],
            success(result) {
              window.clearTimeout(timeout);
              if (!result.checkResult?.requestMerchantTransfer)
                reject(new Error("当前微信版本不支持收款确认，请升级微信"));
              else resolve();
            },
            fail() {
              window.clearTimeout(timeout);
              reject(new Error("无法检查微信收款能力"));
            },
          });
        });
        wx.config({
          debug: false,
          ...signature,
          jsApiList: ["requestMerchantTransfer"],
        });
      });
      const bridge = window.WeixinJSBridge;
      if (!bridge) throw new Error("微信收款组件尚未就绪，请重试");
      await new Promise<void>((resolve, reject) =>
        bridge.invoke(
          "requestMerchantTransfer",
          {
            mchId: confirmation.mchId,
            appId: confirmation.appId,
            package: confirmation.package,
          },
          (result) => {
            if (result.err_msg === "requestMerchantTransfer:ok") resolve();
            else if (result.err_msg === "requestMerchantTransfer:cancel")
              reject(new Error("你已取消收款确认"));
            else reject(new Error("微信收款确认页未能打开，请重试"));
          },
        ),
      );
      setMessage("收款确认页已展示；最终到账状态仍以微信支付回调为准。");
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        className="audience-action audience-claim"
        type="button"
        disabled={busy}
        onClick={() => void confirm()}
      >
        {busy ? "正在打开微信收款…" : "确认微信收款"}
      </button>
      {message && (
        <small className="audience-transfer-message" role="status">
          {message}
        </small>
      )}
    </div>
  );
}
