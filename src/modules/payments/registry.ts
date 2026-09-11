import { readFileSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import type { PaymentProvider, VerifiedTransferEvent } from "./provider.js";
import { WeChatPaymentProvider } from "./provider.js";

export interface PaymentProviderRegistry {
  readonly enabled: boolean;
  providerFor(merchantId: string): PaymentProvider | null;
  clientConfigFor(merchantId: string): { appId: string; mchId: string } | null;
  verifyNotification(
    headers: Record<string, string>,
    rawBody: Uint8Array,
  ): Promise<VerifiedTransferEvent>;
}

export interface RegisteredPaymentProvider {
  merchantId: string;
  wechatPaySerial: string;
  provider: PaymentProvider;
  clientConfig: { appId: string; mchId: string };
}

const merchantSchema = z
  .object({
    merchantId: z.string().regex(/^[A-Za-z0-9_-]{1,50}$/),
    appId: z.string().regex(/^wx[A-Za-z0-9]{16}$/),
    mchId: z.string().regex(/^[0-9]{6,32}$/),
    apiV3Key: z.string().refine((value) => Buffer.byteLength(value) === 32),
    merchantSerialNo: z.string().regex(/^[A-Fa-f0-9]{8,64}$/),
    merchantPrivateKeyPath: z.string().min(1).max(1000),
    wechatPaySerial: z
      .string()
      .regex(/^(?:PUB_KEY_ID_[0-9]+|[A-Fa-f0-9]{8,64})$/),
    wechatPayPublicKeyPath: z.string().min(1).max(1000),
    transferSceneId: z.string().regex(/^[A-Za-z0-9_-]{1,36}$/),
    notifyUrl: z.url().max(1000),
    transferRemark: z.string().trim().min(1).max(32),
    sceneReportInfos: z
      .array(
        z
          .object({
            infoType: z.string().trim().min(1).max(15),
            infoContent: z.string().trim().min(1).max(32),
          })
          .strict(),
      )
      .min(1)
      .max(8),
    userReceiveStyle: z.enum(["CONFIRM_PAGE", "RED_PACKET"]).optional(),
  })
  .strict();

const fileSchema = z
  .object({ merchants: z.array(merchantSchema).min(1).max(100) })
  .strict();

function header(headers: Record<string, string>, name: string) {
  return Object.entries(headers).find(
    ([key]) => key.toLowerCase() === name.toLowerCase(),
  )?.[1];
}

export function createPaymentProviderRegistry(
  registrations: RegisteredPaymentProvider[],
): PaymentProviderRegistry {
  const byMerchant = new Map<string, PaymentProvider>();
  const clientConfig = new Map<string, { appId: string; mchId: string }>();
  const bySerial = new Map<string, PaymentProvider>();
  for (const registration of registrations) {
    if (
      byMerchant.has(registration.merchantId) ||
      bySerial.has(registration.wechatPaySerial)
    )
      throw new Error("Duplicate WeChat transfer merchant or platform serial");
    byMerchant.set(registration.merchantId, registration.provider);
    clientConfig.set(registration.merchantId, registration.clientConfig);
    bySerial.set(registration.wechatPaySerial, registration.provider);
  }
  return {
    enabled: registrations.length > 0,
    providerFor: (merchantId) => byMerchant.get(merchantId) || null,
    clientConfigFor: (merchantId) => clientConfig.get(merchantId) || null,
    async verifyNotification(headers, rawBody) {
      const serial = header(headers, "Wechatpay-Serial");
      const provider = serial ? bySerial.get(serial) : undefined;
      if (!provider) throw new Error("Unknown WeChat Pay notification serial");
      return provider.verifyAndDecodeNotification(headers, rawBody);
    },
  };
}

export function disabledPaymentProviderRegistry(): PaymentProviderRegistry {
  return createPaymentProviderRegistry([]);
}

function privateFile(path: string, production: boolean, limit: number) {
  if (!isAbsolute(path))
    throw new Error("Payment secret paths must be absolute");
  const stat = statSync(path);
  if (!stat.isFile() || stat.size < 1 || stat.size > limit)
    throw new Error("Invalid payment secret file");
  if (production && (stat.mode & 0o077) !== 0)
    throw new Error("Payment secret files must not be group or world readable");
  return readFileSync(path, "utf8").trim();
}

export function loadPaymentProviderRegistry(
  configPath: string,
  production: boolean,
  expectedAppId: string,
): PaymentProviderRegistry {
  const raw = privateFile(configPath, production, 128 * 1024);
  let input: unknown;
  try {
    input = JSON.parse(raw);
  } catch {
    throw new Error("WeChat transfer configuration must be valid JSON");
  }
  const parsed = fileSchema.parse(input);
  return createPaymentProviderRegistry(
    parsed.merchants.map((merchant) => {
      if (merchant.appId !== expectedAppId)
        throw new Error(
          "WeChat transfer AppID must match the configured OAuth AppID",
        );
      const provider = new WeChatPaymentProvider({
        merchantId: merchant.merchantId,
        appId: merchant.appId,
        mchId: merchant.mchId,
        apiV3Key: merchant.apiV3Key,
        merchantSerialNo: merchant.merchantSerialNo,
        merchantPrivateKeyPem: privateFile(
          merchant.merchantPrivateKeyPath,
          production,
          32 * 1024,
        ),
        wechatPaySerial: merchant.wechatPaySerial,
        wechatPayPublicKeyPem: privateFile(
          merchant.wechatPayPublicKeyPath,
          production,
          32 * 1024,
        ),
        transferSceneId: merchant.transferSceneId,
        notifyUrl: merchant.notifyUrl,
        transferRemark: merchant.transferRemark,
        sceneReportInfos: merchant.sceneReportInfos,
        userReceiveStyle: merchant.userReceiveStyle,
      });
      return {
        merchantId: merchant.merchantId,
        wechatPaySerial: merchant.wechatPaySerial,
        provider,
        clientConfig: { appId: merchant.appId, mchId: merchant.mchId },
      };
    }),
  );
}
