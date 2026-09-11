import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// Parameters are fixed in code; stored data cannot request unbounded KDF work.
const FORMAT = /^scrypt-v1\$([a-f0-9]{32})\$([a-f0-9]{64})$/;
const validSecret = (secret: string) =>
  typeof secret === "string" && Buffer.byteLength(secret, "utf8") >= 24 && Buffer.byteLength(secret, "utf8") <= 256;
function derive(secret: string, salt: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(secret, salt, 32, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}
/** 256 bits of randomness; returned only for initial issuance or explicit reset. */
export function createAccessSecret(): string {
  return randomBytes(32).toString("base64url");
}
export async function hashAccessSecret(secret: string): Promise<string> {
  if (!validSecret(secret)) throw new Error("访问密钥长度无效");
  const salt = randomBytes(16);
  const key = await derive(secret, salt);
  return `scrypt-v1$${salt.toString("hex")}$${key.toString("hex")}`;
}
export async function verifyAccessSecret(secret: string, encoded: string): Promise<boolean> {
  if (!validSecret(secret) || typeof encoded !== "string" || encoded.length > 128) return false;
  const match = encoded.match(FORMAT);
  if (!match || match[0] !== encoded) return false;
  const key = await derive(secret, Buffer.from(match[1], "hex"));
  return timingSafeEqual(key, Buffer.from(match[2], "hex"));
}
