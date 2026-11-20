import { createHash, generateKeyPairSync, randomBytes } from "node:crypto";

/*
  TAWD's own SSH keys (28 September 2026, moved here from bluehost.ts on
  5 October 2026 for 20i): an ed25519 pair made with Node's own crypto and
  written in OpenSSH's formats (the public line a host takes, the private
  key the worker signs in with, stored encrypted and never shown), and
  OpenSSH's fingerprints. Nothing here is specific to a host.
*/

/** What one command over SSH said: its exit code (null when it didn't finish) and its output. */
export interface CommandOutput {
  code: number | null;
  output: string;
}

/* ---------- The key pair ---------- */

function sshString(value: Buffer | string): Buffer {
  const body = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const length = Buffer.alloc(4);
  length.writeUInt32BE(body.length);
  return Buffer.concat([length, body]);
}

function uint32(n: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n >>> 0);
  return b;
}

export interface SshKeyPair {
  /** "ssh-ed25519 AAAA... <comment>": what goes into cPanel. */
  publicKey: string;
  /** The OpenSSH private key (PEM-style armour). Encrypt before storing. */
  privateKey: string;
  /** "SHA256:...", as cPanel and ssh-keygen show it. */
  fingerprint: string;
}

/** The public key's wire form: string "ssh-ed25519", string key. */
function ed25519Blob(publicRaw: Buffer): Buffer {
  return Buffer.concat([sshString("ssh-ed25519"), sshString(publicRaw)]);
}

/** OpenSSH's fingerprint of a key blob: SHA-256, base64 without padding. */
export function sshFingerprint(blob: Buffer): string {
  return `SHA256:${createHash("sha256").update(blob).digest("base64").replace(/=+$/, "")}`;
}

/** The fingerprint of a public key line ("ssh-ed25519 AAAA... comment"). */
export function publicKeyFingerprint(line: string): string {
  const [, body] = line.trim().split(/\s+/);
  if (!body) throw new Error("That isn't an SSH public key.");
  return sshFingerprint(Buffer.from(body, "base64"));
}

export function makeSshKeyPair(comment = "tawd@velocitymedialab.com"): SshKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const blob = ed25519Blob(pub);

  // openssh-key-v1, unencrypted (it is encrypted by TAWD before it is stored).
  const check = randomBytes(4);
  let secret = Buffer.concat([check, check, sshString("ssh-ed25519"), sshString(pub), sshString(Buffer.concat([seed, pub])), sshString(comment)]);
  const padding: number[] = [];
  for (let i = 1; (secret.length + padding.length) % 8 !== 0; i += 1) padding.push(i);
  secret = Buffer.concat([secret, Buffer.from(padding)]);
  const body = Buffer.concat([
    Buffer.from("openssh-key-v1\0", "latin1"),
    sshString("none"),
    sshString("none"),
    sshString(""),
    uint32(1),
    sshString(blob),
    sshString(secret),
  ]).toString("base64");
  const lines = body.match(/.{1,70}/g) ?? [];

  return {
    publicKey: `ssh-ed25519 ${blob.toString("base64")} ${comment}`,
    privateKey: ["-----BEGIN OPENSSH PRIVATE KEY-----", ...lines, "-----END OPENSSH PRIVATE KEY-----", ""].join("\n"),
    fingerprint: sshFingerprint(blob),
  };
}

/*
  The servers TAWD signs in to (20i, 5 October 2026): every package in a
  data centre is reached through the same SSH gateway, so the server's own
  key is remembered once per host name (app_setting "ssh_host_keys") and
  required on every later connection to it.
*/
export const SSH_HOST_KEYS_SETTING = "ssh_host_keys";

export interface PinnedHostKey {
  fingerprint: string;
  firstSeenAt: string;
}

export type PinnedHostKeys = Record<string, PinnedHostKey>;

/** The pinned keys, from the app_setting value (anything unreadable is left out). */
export function readPinnedHostKeys(value: unknown): PinnedHostKeys {
  if (!value || typeof value !== "object") return {};
  const out: PinnedHostKeys = {};
  for (const [host, entry] of Object.entries(value as Record<string, unknown>)) {
    const e = entry as Partial<PinnedHostKey> | null;
    if (e && typeof e.fingerprint === "string" && /^SHA256:[A-Za-z0-9+/]{20,}$/.test(e.fingerprint)) out[host] = { fingerprint: e.fingerprint, firstSeenAt: String(e.firstSeenAt ?? "") };
  }
  return out;
}
