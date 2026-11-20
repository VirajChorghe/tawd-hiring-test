import { describe, expect, it } from "vitest";

import { makeSshKeyPair, publicKeyFingerprint, readPinnedHostKeys } from "@tawd/core/ssh-keys";

/* TAWD's own SSH keys, shared by every host (moved from bluehost.ts for 20i, 5 October 2026). */
describe("ssh-keys", () => {
  it("makes an ed25519 pair whose fingerprint matches its public line", () => {
    const pair = makeSshKeyPair("tawd-test");
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAA[A-Za-z0-9+/=]+ tawd-test$/);
    expect(pair.privateKey).toContain("-----BEGIN OPENSSH PRIVATE KEY-----");
    expect(publicKeyFingerprint(pair.publicKey)).toBe(pair.fingerprint);
    expect(pair.fingerprint).toMatch(/^SHA256:/);
  });

  it("reads the pinned server keys and leaves out anything that isn't one", () => {
    const fp = makeSshKeyPair().fingerprint;
    const pinned = readPinnedHostKeys({ "ssh.us.stackcp.com": { fingerprint: fp, firstSeenAt: "2026-10-05T10:00:00Z" }, bad: { fingerprint: "nope" }, worse: null });
    expect(Object.keys(pinned)).toEqual(["ssh.us.stackcp.com"]);
    expect(pinned["ssh.us.stackcp.com"]!.fingerprint).toBe(fp);
    expect(readPinnedHostKeys(null)).toEqual({});
  });
});
