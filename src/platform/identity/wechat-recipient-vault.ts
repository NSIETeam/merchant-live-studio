import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type { DB } from "../../shared/persistence.js";
import {
  currentRecipientAuthorization,
  insertRecipientAuthorization,
} from "./persistence/wechat-recipient-queries.js";

type Current = {
  state: "authorized" | "revoked";
  recipientCiphertext: string;
  recipientDigest: string;
  createdAt: number;
};

const idPattern = /^[A-Za-z0-9_-]{1,100}$/;
const openIdPattern = /^[A-Za-z0-9_-]{10,64}$/;

/**
 * Keeps an OAuth OpenID in memory until the viewer explicitly authorizes
 * transfer use, then stores only authenticated ciphertext and a keyed digest.
 */
export function createWeChatRecipientVault(
  db: DB,
  encryptionKeyHex: string,
  clock: () => number = Date.now,
  random: (size: number) => Buffer = randomBytes,
) {
  if (!/^[a-fA-F0-9]{64}$/.test(encryptionKeyHex))
    throw new Error(
      "WeChat recipient encryption key must be 64 hexadecimal characters",
    );
  const key = Buffer.from(encryptionKeyHex, "hex");
  const staged = new Map<
    string,
    { merchantId: string; subject: string; expiresAt: number }
  >();
  const current = (viewerId: string, merchantId: string) =>
    currentRecipientAuthorization(db, viewerId, merchantId) as
      Current | undefined;
  const validateIds = (viewerId: string, merchantId: string) => {
    if (!idPattern.test(viewerId) || !idPattern.test(merchantId))
      throw new Error("Invalid recipient ownership");
  };
  const aad = (viewerId: string, merchantId: string) =>
    Buffer.from(`wechat-recipient:${viewerId}:${merchantId}`);
  const stageKey = (viewerId: string, merchantId: string) =>
    `${viewerId}:${merchantId}`;
  const digest = (merchantId: string, subject: string) =>
    createHmac("sha256", key)
      .update(`wechat-recipient-digest:${merchantId}:${subject}`)
      .digest("hex");
  const encrypt = (viewerId: string, merchantId: string, subject: string) => {
    const nonce = random(12);
    if (nonce.length !== 12)
      throw new Error("Invalid recipient encryption nonce");
    const cipher = createCipheriv("aes-256-gcm", key, nonce);
    cipher.setAAD(aad(viewerId, merchantId));
    const ciphertext = Buffer.concat([
      cipher.update(subject, "utf8"),
      cipher.final(),
    ]);
    return Buffer.concat([nonce, ciphertext, cipher.getAuthTag()]).toString(
      "base64url",
    );
  };
  const decrypt = (
    viewerId: string,
    merchantId: string,
    ciphertext: string,
  ) => {
    const bytes = Buffer.from(ciphertext, "base64url");
    if (bytes.length < 29)
      throw new Error("Stored recipient authorization is invalid");
    try {
      const decipher = createDecipheriv(
        "aes-256-gcm",
        key,
        bytes.subarray(0, 12),
      );
      decipher.setAAD(aad(viewerId, merchantId));
      decipher.setAuthTag(bytes.subarray(-16));
      return Buffer.concat([
        decipher.update(bytes.subarray(12, -16)),
        decipher.final(),
      ]).toString("utf8");
    } catch {
      throw new Error("Stored recipient authorization cannot be decrypted");
    }
  };
  const clean = () => {
    const now = clock();
    for (const [id, entry] of staged)
      if (entry.expiresAt <= now) staged.delete(id);
  };

  return {
    stage(viewerId: string, merchantId: string, subject: string) {
      validateIds(viewerId, merchantId);
      if (!openIdPattern.test(subject))
        throw new Error("Invalid WeChat recipient identity");
      clean();
      if (staged.size >= 10_000)
        throw new Error("Too many pending recipient authorizations");
      staged.set(stageKey(viewerId, merchantId), {
        merchantId,
        subject,
        expiresAt: clock() + 15 * 60 * 1000,
      });
    },
    status(viewerId: string, merchantId: string) {
      validateIds(viewerId, merchantId);
      const row = current(viewerId, merchantId);
      return {
        authorized: row?.state === "authorized",
        authorizedAt: row?.state === "authorized" ? row.createdAt : null,
        staged: staged.has(stageKey(viewerId, merchantId)),
      };
    },
    authorize(viewerId: string, merchantId: string) {
      validateIds(viewerId, merchantId);
      clean();
      const pendingKey = stageKey(viewerId, merchantId);
      const pending = staged.get(pendingKey);
      if (!pending || pending.merchantId !== merchantId)
        throw new Error(
          "WeChat recipient verification must be completed again",
        );
      const recipientDigest = digest(merchantId, pending.subject);
      const previous = current(viewerId, merchantId);
      if (
        previous?.state === "authorized" &&
        previous.recipientDigest === recipientDigest
      ) {
        staged.delete(pendingKey);
        return { authorized: true, recipientDigest, replayed: true };
      }
      insertRecipientAuthorization(
        db,
        viewerId,
        merchantId,
        "authorized",
        encrypt(viewerId, merchantId, pending.subject),
        recipientDigest,
        clock(),
      );
      staged.delete(pendingKey);
      return { authorized: true, recipientDigest, replayed: false };
    },
    resolve(viewerId: string, merchantId: string) {
      validateIds(viewerId, merchantId);
      const row = current(viewerId, merchantId);
      if (!row || row.state !== "authorized") return null;
      const subject = decrypt(viewerId, merchantId, row.recipientCiphertext);
      if (
        !openIdPattern.test(subject) ||
        digest(merchantId, subject) !== row.recipientDigest
      )
        throw new Error(
          "Stored recipient authorization does not match its digest",
        );
      return { subject, recipientDigest: row.recipientDigest };
    },
    revoke(viewerId: string, merchantId: string) {
      validateIds(viewerId, merchantId);
      staged.delete(stageKey(viewerId, merchantId));
      const previous = current(viewerId, merchantId);
      if (!previous || previous.state === "revoked") return { revoked: true };
      insertRecipientAuthorization(
        db,
        viewerId,
        merchantId,
        "revoked",
        "",
        previous.recipientDigest,
        clock(),
      );
      return { revoked: true };
    },
  };
}
