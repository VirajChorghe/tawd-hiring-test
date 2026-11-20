import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/*
  Encryption at rest for secrets TAWD must keep but never show again: a
  project's Slack webhook now, client server credentials later.

  AES-256-GCM with a random nonce per value. The key is 32 random bytes,
  base64, in TAWD_ENCRYPTION_KEY - set in Coolify for both the web app and
  the worker, never in the repo. Stored values look like
  "v1.<nonce>.<tag>.<ciphertext>", so a later key rotation can tell old
  values from new ones.
*/

const VERSION = "v1";

export class SecretsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretsError";
  }
}

let testKey: Buffer | null = null;

/** Tests run with a fixed key rather than reading the environment. */
export function setEncryptionKeyForTesting(key: Buffer | null): void {
  testKey = key;
}

function readKey(): Buffer | null {
  if (testKey) return testKey;
  const raw = process.env.TAWD_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) {
    throw new SecretsError(
      "TAWD_ENCRYPTION_KEY must be 32 random bytes in base64 (44 characters).",
    );
  }
  return key;
}

/**
 * What is wrong with the server's key, in words (never the key itself), or
 * null when it is set and valid. The same reading the encrypting code uses,
 * so the worker can refuse to start on a key that would fail later
 * (CodeRabbit #81).
 */
export function encryptionKeyProblem(): string | null {
  try {
    return readKey() ? null : "TAWD_ENCRYPTION_KEY is not set (or is only spaces).";
  } catch (error) {
    return error instanceof SecretsError ? error.message : "TAWD_ENCRYPTION_KEY could not be read.";
  }
}

/** Whether the server has a key, so a setting can say so before failing. */
export function hasEncryptionKey(): boolean {
  try {
    return readKey() !== null;
  } catch {
    return false;
  }
}

function requireKey(): Buffer {
  const key = readKey();
  if (!key) {
    throw new SecretsError("TAWD_ENCRYPTION_KEY is not set on the server.");
  }
  return key;
}

export function encryptSecret(plain: string): string {
  const key = requireKey();
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, nonce.toString("base64"), tag.toString("base64"), body.toString("base64")].join(".");
}

export function decryptSecret(stored: string): string {
  const [version, nonce, tag, body] = stored.split(".");
  if (version !== VERSION || !nonce || !tag || !body) {
    throw new SecretsError("A stored secret is not in a format TAWD can read.");
  }
  // The full 16-byte tag only: a shortened tag would make forging a value easier.
  const tagBytes = Buffer.from(tag, "base64");
  if (tagBytes.length !== 16) throw new SecretsError("A stored secret is not in a format TAWD can read.");
  const decipher = createDecipheriv("aes-256-gcm", requireKey(), Buffer.from(nonce, "base64"), { authTagLength: 16 });
  decipher.setAuthTag(tagBytes);
  try {
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch {
    // A wrong key or a tampered value; never say more than that.
    throw new SecretsError("A stored secret could not be decrypted with this server's key.");
  }
}
