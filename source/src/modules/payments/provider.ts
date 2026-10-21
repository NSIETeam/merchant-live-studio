import {
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  randomBytes,
  sign as rsaSign,
  verify as rsaVerify,
} from "node:crypto";
import { z } from "zod";

/** Never accept an OpenID or payment status from an anonymous viewer. */
export interface TransferRequest {
  merchantId: string;
  outBillNo: string;
  amountCents: number;
  verifiedRecipientId: string;
}
export interface TransferReceipt {
  outBillNo: string;
  state: "pending" | "wait_user_confirm" | "paid" | "failed" | "cancelled";
  providerId?: string;
  confirmationPackage?: string;
}
export interface VerifiedTransferEvent {
  eventId: string;
  merchantId: string;
  amountCents: number;
  verifiedRecipientId: string;
  receipt: TransferReceipt;
}
export interface PaymentProvider {
  createTransfer(request: TransferRequest): Promise<TransferReceipt>;
  queryTransfer(
    merchantId: string,
    outBillNo: string,
  ): Promise<TransferReceipt>;
  verifyAndDecodeNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent>;
}

export interface WeChatTransferConfig {
  /** Internal tenant id. It is deliberately separate from the WeChat merchant id. */
  merchantId: string;
  appId: string;
  mchId: string;
  apiV3Key: string;
  merchantSerialNo: string;
  merchantPrivateKeyPem: string;
  wechatPaySerial: string;
  wechatPayPublicKeyPem: string;
  transferSceneId: string;
  notifyUrl: string;
  transferRemark: string;
  sceneReportInfos: Array<{ infoType: string; infoContent: string }>;
  userReceiveStyle?: "CONFIRM_PAGE" | "RED_PACKET";
}

const receiptSchema = z
  .object({
    out_bill_no: z.string().regex(/^[A-Za-z0-9]{1,32}$/),
    transfer_bill_no: z.string().min(1).max(64).optional(),
    state: z.enum([
      "ACCEPTED",
      "PROCESSING",
      "WAIT_USER_CONFIRM",
      "TRANSFERING",
      "SUCCESS",
      "FAIL",
      "CANCELING",
      "CANCELLED",
    ]),
    package_info: z.string().min(1).max(4096).optional(),
  })
  .passthrough();

const notificationSchema = z
  .object({
    id: z.string().min(1).max(64),
    resource_type: z.literal("encrypt-resource"),
    event_type: z.literal("MCHTRANSFER.BILL.FINISHED"),
    resource: z
      .object({
        original_type: z.literal("mch_payment"),
        algorithm: z.literal("AEAD_AES_256_GCM"),
        ciphertext: z.string().min(20).max(1_100_000),
        associated_data: z.string().max(32).optional().default(""),
        nonce: z.string().min(1).max(32),
      })
      .strict(),
  })
  .passthrough();

const notificationResourceSchema = z
  .object({
    out_bill_no: z.string().regex(/^[A-Za-z0-9]{1,32}$/),
    transfer_bill_no: z.string().min(1).max(64),
    state: z.enum(["SUCCESS", "FAIL", "CANCELLED"]),
    mch_id: z.string().min(1).max(32),
    transfer_amount: z.number().int().positive(),
    openid: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
  })
  .passthrough();

function charLength(value: string) {
  return Array.from(value).length;
}

function validateConfig(config: WeChatTransferConfig) {
  if (!/^[A-Za-z0-9_-]{1,50}$/.test(config.merchantId))
    throw new Error("Invalid internal merchant id");
  if (!/^wx[A-Za-z0-9]{16}$/.test(config.appId))
    throw new Error("Invalid WeChat AppID");
  if (!/^[0-9]{6,32}$/.test(config.mchId))
    throw new Error("Invalid WeChat merchant id");
  if (Buffer.byteLength(config.apiV3Key, "utf8") !== 32)
    throw new Error("WeChat APIv3 key must contain exactly 32 bytes");
  if (!/^[A-Fa-f0-9]{8,64}$/.test(config.merchantSerialNo))
    throw new Error("Invalid merchant certificate serial number");
  if (!/^(?:PUB_KEY_ID_[0-9]+|[A-Fa-f0-9]{8,64})$/.test(config.wechatPaySerial))
    throw new Error("Invalid WeChat Pay public key or certificate serial");
  if (!/^[A-Za-z0-9_-]{1,36}$/.test(config.transferSceneId))
    throw new Error("Invalid WeChat transfer scene id");
  const notify = new URL(config.notifyUrl);
  if (notify.protocol !== "https:" || notify.search || notify.hash)
    throw new Error(
      "WeChat notify URL must be HTTPS without query or fragment",
    );
  if (!config.transferRemark.trim() || charLength(config.transferRemark) > 32)
    throw new Error("Invalid WeChat transfer remark");
  if (!config.sceneReportInfos.length || config.sceneReportInfos.length > 8)
    throw new Error("WeChat transfer scene report information is required");
  for (const item of config.sceneReportInfos)
    if (
      !item.infoType.trim() ||
      charLength(item.infoType) > 15 ||
      !item.infoContent.trim() ||
      charLength(item.infoContent) > 32
    )
      throw new Error("Invalid WeChat transfer scene report information");
  // Parse keys at construction time so a bad deployment fails before any transfer request.
  if (
    createPrivateKey(config.merchantPrivateKeyPem).asymmetricKeyType !== "rsa"
  )
    throw new Error("WeChat merchant private key must be RSA");
  if (createPublicKey(config.wechatPayPublicKeyPem).asymmetricKeyType !== "rsa")
    throw new Error("WeChat Pay verification key must be RSA");
}

function mapReceipt(input: z.infer<typeof receiptSchema>): TransferReceipt {
  const state: TransferReceipt["state"] =
    input.state === "WAIT_USER_CONFIRM"
      ? "wait_user_confirm"
      : input.state === "SUCCESS"
        ? "paid"
        : input.state === "FAIL"
          ? "failed"
          : input.state === "CANCELLED"
            ? "cancelled"
            : "pending";
  return {
    outBillNo: input.out_bill_no,
    state,
    ...(input.transfer_bill_no ? { providerId: input.transfer_bill_no } : {}),
    ...(input.package_info ? { confirmationPackage: input.package_info } : {}),
  };
}

function header(headers: Record<string, string>, name: string) {
  const found = Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
  if (!found || found.length > 4096)
    throw new Error("Invalid WeChat signature headers");
  return found;
}

/**
 * WeChat Pay APIv3 transport adapter. It does not persist orders or authorize recipients;
 * callers must supply a server-verified OpenID and durably reconcile every receipt.
 */
export class WeChatPaymentProvider implements PaymentProvider {
  private readonly endpoint = "https://api.mch.weixin.qq.com";

  constructor(
    private readonly config?: WeChatTransferConfig,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly clock: () => number = Date.now,
    private readonly nonce: () => string = () =>
      randomBytes(16).toString("hex"),
  ) {
    if (config) validateConfig(config);
  }

  private requiredConfig() {
    if (!this.config)
      throw new Error("WeChat transfer integration is not configured");
    return this.config;
  }

  private validateRequest(request: TransferRequest) {
    const config = this.requiredConfig();
    if (request.merchantId !== config.merchantId)
      throw new Error("Transfer tenant does not match configured merchant");
    if (!/^[A-Za-z0-9]{1,32}$/.test(request.outBillNo))
      throw new Error("Invalid transfer bill number");
    if (!Number.isSafeInteger(request.amountCents) || request.amountCents <= 0)
      throw new Error("Invalid transfer amount");
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(request.verifiedRecipientId))
      throw new Error("Invalid verified WeChat recipient");
    return config;
  }

  private requestAuthorization(method: string, path: string, body: string) {
    const config = this.requiredConfig();
    const timestamp = String(Math.floor(this.clock() / 1000));
    const nonce = this.nonce();
    if (!/^[A-Za-z0-9]{8,64}$/.test(nonce))
      throw new Error("Invalid payment nonce");
    const message = `${method}\n${path}\n${timestamp}\n${nonce}\n${body}\n`;
    const signature = rsaSign(
      "RSA-SHA256",
      Buffer.from(message),
      config.merchantPrivateKeyPem,
    ).toString("base64");
    return `WECHATPAY2-SHA256-RSA2048 mchid="${config.mchId}",nonce_str="${nonce}",timestamp="${timestamp}",serial_no="${config.merchantSerialNo}",signature="${signature}"`;
  }

  private verifyWechatSignature(
    headers: Headers | Record<string, string>,
    body: string,
  ) {
    const config = this.requiredConfig();
    const entries =
      headers instanceof Headers
        ? Object.fromEntries(headers.entries())
        : headers;
    const serial = header(entries, "Wechatpay-Serial");
    const signature = header(entries, "Wechatpay-Signature");
    const timestamp = header(entries, "Wechatpay-Timestamp");
    const nonce = header(entries, "Wechatpay-Nonce");
    if (
      serial !== config.wechatPaySerial ||
      !/^[0-9]{10,13}$/.test(timestamp) ||
      Math.abs(Math.floor(this.clock() / 1000) - Number(timestamp)) > 300 ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(nonce) ||
      signature.startsWith("WECHATPAY/SIGNTEST/")
    )
      throw new Error("Invalid WeChat response signature");
    const valid = rsaVerify(
      "RSA-SHA256",
      Buffer.from(`${timestamp}\n${nonce}\n${body}\n`),
      config.wechatPayPublicKeyPem,
      Buffer.from(signature, "base64"),
    );
    if (!valid) throw new Error("Invalid WeChat response signature");
  }

  private async call(method: "GET" | "POST", path: string, body = "") {
    const response = await this.fetchImpl(this.endpoint + path, {
      method,
      headers: {
        Accept: "application/json",
        ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        Authorization: this.requestAuthorization(method, path, body),
      },
      ...(body ? { body } : {}),
      signal: AbortSignal.timeout(8000),
    });
    const declared = Number(response.headers.get("content-length") || 0);
    if (Number.isFinite(declared) && declared > 65_536)
      throw new Error("WeChat response is too large");
    const raw = await response.text();
    if (Buffer.byteLength(raw, "utf8") > 65_536)
      throw new Error("WeChat response is too large");
    this.verifyWechatSignature(response.headers, raw);
    if (!response.ok)
      throw new Error(
        "WeChat transfer request failed; query the original bill before retrying",
      );
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error("Invalid WeChat transfer response");
    }
    const receipt = receiptSchema.safeParse(parsed);
    if (!receipt.success) throw new Error("Invalid WeChat transfer response");
    return mapReceipt(receipt.data);
  }

  async createTransfer(request: TransferRequest): Promise<TransferReceipt> {
    const config = this.validateRequest(request);
    const body = JSON.stringify({
      appid: config.appId,
      out_bill_no: request.outBillNo,
      transfer_scene_id: config.transferSceneId,
      openid: request.verifiedRecipientId,
      transfer_amount: request.amountCents,
      transfer_remark: config.transferRemark,
      notify_url: config.notifyUrl,
      transfer_scene_report_infos: config.sceneReportInfos.map((item) => ({
        info_type: item.infoType,
        info_content: item.infoContent,
      })),
      ...(config.userReceiveStyle
        ? { user_recv_style: { type: config.userReceiveStyle } }
        : {}),
    });
    const receipt = await this.call(
      "POST",
      "/v3/fund-app/mch-transfer/transfer-bills",
      body,
    );
    if (receipt.outBillNo !== request.outBillNo)
      throw new Error(
        "WeChat transfer response does not match the requested bill",
      );
    return receipt;
  }

  async queryTransfer(
    merchantId: string,
    outBillNo: string,
  ): Promise<TransferReceipt> {
    const config = this.validateRequest({
      merchantId,
      outBillNo,
      amountCents: 1,
      verifiedRecipientId: "validated-at-order-creation",
    });
    const path = `/v3/fund-app/mch-transfer/transfer-bills/out-bill-no/${outBillNo}`;
    const receipt = await this.call("GET", path);
    if (receipt.outBillNo !== outBillNo || merchantId !== config.merchantId)
      throw new Error(
        "WeChat transfer query does not match the requested bill",
      );
    return receipt;
  }

  async verifyAndDecodeNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent> {
    const config = this.requiredConfig();
    if (rawBody.byteLength > 1_100_000)
      throw new Error("WeChat notification is too large");
    const body = Buffer.from(rawBody).toString("utf8");
    this.verifyWechatSignature(headers, body);
    let input: unknown;
    try {
      input = JSON.parse(body);
    } catch {
      throw new Error("Invalid WeChat notification");
    }
    const notification = notificationSchema.safeParse(input);
    if (!notification.success) throw new Error("Invalid WeChat notification");
    const encrypted = Buffer.from(
      notification.data.resource.ciphertext,
      "base64",
    );
    if (encrypted.length <= 16) throw new Error("Invalid WeChat notification");
    const ciphertext = encrypted.subarray(0, -16);
    const authTag = encrypted.subarray(-16);
    let plaintext: Buffer;
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(config.apiV3Key, "utf8"),
        Buffer.from(notification.data.resource.nonce, "utf8"),
      );
      decipher.setAuthTag(authTag);
      decipher.setAAD(
        Buffer.from(notification.data.resource.associated_data, "utf8"),
      );
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
    } catch {
      throw new Error("Invalid WeChat notification ciphertext");
    }
    let resourceInput: unknown;
    try {
      resourceInput = JSON.parse(plaintext.toString("utf8"));
    } catch {
      throw new Error("Invalid WeChat notification resource");
    }
    const resource = notificationResourceSchema.safeParse(resourceInput);
    if (!resource.success || resource.data.mch_id !== config.mchId)
      throw new Error("WeChat notification does not match configured merchant");
    return {
      eventId: notification.data.id,
      merchantId: config.merchantId,
      amountCents: resource.data.transfer_amount,
      verifiedRecipientId: resource.data.openid,
      receipt: mapReceipt(resource.data),
    };
  }
}
