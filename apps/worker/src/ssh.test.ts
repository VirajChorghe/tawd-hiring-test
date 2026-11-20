import type { AddressInfo } from "node:net";
import { timingSafeEqual } from "node:crypto";
import { Server, utils, type Connection } from "ssh2";
import { afterEach, describe, expect, it } from "vitest";

import { Readable } from "node:stream";

import { makeSshKeyPair, sshFingerprint } from "@tawd/core/ssh-keys";

import { connectSsh, SshError } from "./ssh";

/*
  Build B, 4a: TAWD's own key signs in to a real SSH server (ssh2's, in
  this process), commands run and answer, the server's key is remembered,
  and a server answering with another key is refused.
*/

/*
  The server's own key comes from TAWD's makeSshKeyPair, not from ssh2's
  generateKeyPairSync (10 November 2026).

  ssh2's generator drops a leading zero byte from an ed25519 public key, so
  about one key in 256 is malformed - measured here at 1 in 400 - and
  parseKey then refuses it, failing this whole file at random. It had been
  doing that to roughly one full-suite run in 256 for weeks, and was found
  by chasing a "flaky" failure rather than re-running it.

  TAWD's own generator takes the key from the JWK, which keeps leading
  zeros: 2,000 pairs, none malformed. Using it here also tests something
  worth testing - that the private key format TAWD gives a real host is one
  a real SSH server accepts.
*/
const hostPair = makeSshKeyPair("host@canary");
const hostBlob = utils.parseKey(hostPair.privateKey);
if (hostBlob instanceof Error) throw hostBlob;
const hostFingerprint = sshFingerprint(hostBlob.getPublicSSH());

let server: Server | null = null;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
});

/* A server that lets in only the given public key and answers "echo" style commands. */
async function startServer(allowedPublicKey: string): Promise<number> {
  const allowed = utils.parseKey(allowedPublicKey);
  if (allowed instanceof Error) throw allowed;
  server = new Server({ hostKeys: [hostPair.privateKey] }, (client: Connection) => {
    client.on("authentication", (ctx) => {
      if (ctx.method !== "publickey" || ctx.key.algo !== allowed.type || !timingSafeEqual(ctx.key.data, allowed.getPublicSSH())) return ctx.reject(["publickey"]);
      if (ctx.signature && ctx.blob && !allowed.verify(ctx.blob, ctx.signature, ctx.hashAlgo)) return ctx.reject(["publickey"]);
      ctx.accept();
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().once("exec", (acceptExec, _reject, info) => {
          const stream = acceptExec();
          if (info.command === "big-out") {
            // A note on stderr, then 3 MB in 64 KB writes, honouring the channel's flow control.
            stream.stderr.write("done\n");
            const chunk = Buffer.alloc(65_536, 97);
            let left = 48;
            const pump = () => {
              while (left > 0) {
                left -= 1;
                if (!stream.write(chunk)) return void stream.once("drain", pump);
              }
              stream.exit(0);
              stream.end();
            };
            pump();
            return;
          }
          if (info.command === "small-out") {
            // 1000 bytes, then a clean exit: the command itself worked.
            stream.write(Buffer.alloc(1000, 98), () => {
              stream.exit(0);
              stream.end();
            });
            return;
          }
          if (info.command === "count-in") {
            let bytes = 0;
            stream.on("data", (d: Buffer) => (bytes += d.length));
            stream.on("end", () => {
              stream.write(`got ${bytes}\n`, () => {
                stream.exit(0);
                stream.end();
              });
            });
            return;
          }
          if (info.command === "php -v 2>&1") {
            stream.write("PHP 8.2.28 (cli) (built: Mar 12 2026)\n");
            stream.exit(0);
          } else {
            stream.stderr.write(`bash: ${info.command.split(" ")[0]}: command not found\n`);
            stream.exit(127);
          }
          stream.end();
        });
      });
    });
    client.on("error", () => {});
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

describe("TAWD's SSH key", () => {
  it("is a valid OpenSSH ed25519 key pair whose halves match", () => {
    const pair = makeSshKeyPair();
    expect(pair.publicKey).toMatch(/^ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI[A-Za-z0-9+/=]+ tawd@velocitymedialab\.com$/);
    expect(pair.privateKey).toMatch(/^-----BEGIN OPENSSH PRIVATE KEY-----\n/);
    const priv = utils.parseKey(pair.privateKey);
    const pub = utils.parseKey(pair.publicKey);
    if (priv instanceof Error || pub instanceof Error) throw new Error("ssh2 couldn't read the key");
    expect(priv.type).toBe("ssh-ed25519");
    expect(priv.getPublicSSH().equals(pub.getPublicSSH())).toBe(true);
    const signed = priv.sign(Buffer.from("tawd"));
    expect(pub.verify(Buffer.from("tawd"), signed as Buffer)).toBe(true);
    expect(pair.fingerprint).toBe(sshFingerprint(pub.getPublicSSH()));
  });
});

describe("connectSsh", () => {
  it("signs in with the key, runs commands and reports the server's key", async () => {
    const pair = makeSshKeyPair();
    const port = await startServer(pair.publicKey);
    const session = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: pair.privateKey, expectedHostKey: null });
    expect(session.hostKey).toBe(hostFingerprint);
    expect(await session.run("php -v 2>&1")).toEqual({ code: 0, output: "PHP 8.2.28 (cli) (built: Mar 12 2026)\n" });
    const missing = await session.run("wp --info 2>&1");
    expect(missing.code).toBe(127);
    expect(missing.output).toContain("command not found");
    session.close();
  });

  it("accepts the remembered server key and refuses a different one", async () => {
    const pair = makeSshKeyPair();
    const port = await startServer(pair.publicKey);
    const again = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: pair.privateKey, expectedHostKey: hostFingerprint });
    again.close();
    const error = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: pair.privateKey, expectedHostKey: "SHA256:someoneelse" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SshError);
    expect((error as SshError).kind).toBe("host_key_changed");
    expect((error as SshError).message).toContain("Forget this server's key");
  });

  it("says in plain words when the key isn't authorized", async () => {
    const port = await startServer(makeSshKeyPair().publicKey);
    const error = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: makeSshKeyPair().privateKey, expectedHostKey: null }).catch((e: unknown) => e);
    expect((error as SshError).kind).toBe("refused");
    expect((error as SshError).message).toContain("refused TAWD's key for allpest");
  });

  it("streams a command's output to the caller (backups to R2) and a stream into a command (restores)", async () => {
    const pair = makeSshKeyPair();
    const port = await startServer(pair.publicKey);
    const session = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: pair.privateKey, expectedHostKey: null });
    let received = 0;
    const out = await session.runStreamOut("big-out", async (stdout) => {
      for await (const chunk of stdout) {
        received += (chunk as Buffer).length;
        // A slow reader now and then: the server waits rather than the worker holding it all.
        if (received % 10 === 0) await new Promise((r) => setTimeout(r, 1));
      }
    });
    expect(out.code).toBe(0);
    expect(out.output).toBe("done\n");
    expect(received).toBe(48 * 65_536);
    const sent = await session.runStreamIn("count-in", Readable.from([Buffer.alloc(100_000, 1), Buffer.alloc(23, 2)]));
    expect(sent).toEqual({ code: 0, output: "got 100023\n" });
    session.close();
  });

  it("never reports success when the receiving side fails after the command exited 0 (an R2 upload refused mid-backup)", async () => {
    const pair = makeSshKeyPair();
    const port = await startServer(pair.publicKey);
    const session = await connectSsh({ host: "127.0.0.1", port, username: "allpest", privateKey: pair.privateKey, expectedHostKey: null });
    let read = 0;
    const out = await session.runStreamOut("small-out", async (stdout) => {
      for await (const chunk of stdout) read += (chunk as Buffer).length;
      // Everything read, the command long finished with 0: then the upload is refused.
      throw new Error("R2 refused the upload");
    });
    expect(read).toBe(1000);
    expect(out.code).not.toBe(0);
    expect(out.code).toBe(1);
    expect(out.output).toContain("R2 refused the upload");
    // The same session still works after it.
    expect((await session.runStreamOut("small-out", async (stdout) => void (await stdout.toArray()))).code).toBe(0);
    session.close();
  });
});
