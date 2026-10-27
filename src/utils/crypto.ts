/**
 * AES-256-GCM encryption helpers for sensitive PII fields stored in MongoDB.
 *
 * Required env var: FIELD_ENCRYPTION_KEY — a 64-character hex string (32 bytes).
 * Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 *
 * If the key is absent, encryptField() throws in production (fail closed) and stores
 * plaintext only in non-production. encrypt()/decrypt() of encrypted values always require it.
 */

import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  type CipherGCMTypes,
} from "node:crypto";

const ALGORITHM: CipherGCMTypes = "aes-256-gcm";
const ENCRYPTED_PREFIX = "enc:";
const AUTH_TAG_BYTES = 16;

function getKey(): Buffer {
  const hex = process.env.FIELD_ENCRYPTION_KEY;
  if (!hex) {
    throw new Error(
      "FIELD_ENCRYPTION_KEY is not set. Add a 64-character hex string to .env.local",
    );
  }
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      "FIELD_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).",
    );
  }
  return key;
}

/** Returns true if the stored string was produced by encrypt(). */
export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTED_PREFIX);
}

/** Encrypts plaintext and returns a prefixed base64url string. */
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return (
    ENCRYPTED_PREFIX +
    `${iv.toString("base64url")}.${tag.toString("base64url")}.${ciphertext.toString("base64url")}`
  );
}

/** Decrypts a string produced by encrypt(). Returns plaintext as-is if not encrypted. */
export function decrypt(stored: string): string {
  if (!isEncrypted(stored)) return stored;
  const key = getKey();
  const parts = stored.slice(ENCRYPTED_PREFIX.length).split(".");
  if (parts.length !== 3) throw new Error("Invalid encrypted field format.");
  const [ivB64, tagB64, ctB64] = parts;
  const iv = Buffer.from(ivB64, "base64url");
  const tag = Buffer.from(tagB64, "base64url");
  const ciphertext = Buffer.from(ctB64, "base64url");
  // Pin the GCM tag length; otherwise Node accepts truncated (4-15 byte) tags and weakens integrity.
  if (iv.length !== 12 || tag.length !== AUTH_TAG_BYTES) throw new Error("Invalid encrypted field format.");
  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(tag);
  return decipher.update(ciphertext).toString("utf8") + decipher.final("utf8");
}

/** Encrypts binary data as IV + authentication tag + ciphertext. */
export function encryptBuffer(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

/** Decrypts binary data produced by encryptBuffer(). */
export function decryptBuffer(stored: Buffer): Buffer {
  if (stored.length < 29) throw new Error("Invalid encrypted document format.");
  const iv = stored.subarray(0, 12);
  const tag = stored.subarray(12, 28);
  const ciphertext = stored.subarray(28);
  const decipher = createDecipheriv(ALGORITHM, getKey(), iv, { authTagLength: AUTH_TAG_BYTES });
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

/** User PII fields encrypted at rest by User.ts's pre-save hook. */
export const ENCRYPTED_USER_FIELDS = [
  "aadharNumber",
  "panNumber",
  "bankAccountNumber",
  "bankName",
  "bankIfsc",
  "bankBranch",
] as const;

/** Decrypts any ENCRYPTED_USER_FIELDS present on a plain user object (e.g. from .lean()). */
export function decryptUserFields<T extends Record<string, unknown>>(user: T): T {
  for (const field of ENCRYPTED_USER_FIELDS) {
    const value = user[field];
    if (typeof value === "string") (user as Record<string, unknown>)[field] = decrypt(value);
  }
  return user;
}


/**
 * Encrypt a field value if FIELD_ENCRYPTION_KEY is configured.
 * Skips already-encrypted values (idempotent).
 * In production, fails closed when the key is absent to avoid plaintext PII.
 * In non-production, falls back to plaintext with a warning for local workflows.
 */
export function encryptField(value: string | undefined): string | undefined {
  if (!value) return value;
  if (isEncrypted(value)) return value;
  if (!process.env.FIELD_ENCRYPTION_KEY) {
    if (process.env.NODE_ENV !== "production") return value;
    throw new Error(
      "[SECURITY] FIELD_ENCRYPTION_KEY is required to avoid plaintext PII storage. " +
        "Generate one with: node -e \"console.log(require('crypto').randomBytes(32).toString('hex'))\"",
    );
  }
  return encrypt(value);
}
