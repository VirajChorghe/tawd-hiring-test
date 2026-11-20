import { PassThrough, type Readable } from "node:stream";
import { Client, type ClientChannel } from "ssh2";

import { sshFingerprint, type CommandOutput } from "@tawd/core/ssh-keys";

/*
  SSH for Build B (28 September 2026; 20i since 5 October 2026): the worker
  signs in to a WordPress site's hosting with TAWD's own key and runs fixed
  commands. The server's key is remembered the first time (per server name,
  app_setting "ssh_host_keys") and must match every time after, so nobody in
  between can pretend to be the server.

  Backups stream (20i, 5 October 2026): runStreamOut hands a command's output
  to the caller as a stream (piped on to R2, never held whole), and
  runStreamIn feeds a stream to a command (a restore). Both keep the SSH
  channel's flow control: a paused reader stops the server sending.
*/

export interface SshTarget {
  host: string;
  port: number;
  username: string;
  privateKey: string;
  /** The server key's fingerprint from before; null the first time. */
  expectedHostKey: string | null;
  /** How long to wait for the sign-in (20 seconds by default). */
  readyTimeoutMs?: number;
}

export interface SshSession {
  /** The fingerprint of the key the server answered with. */
  hostKey: string;
  run(command: string, timeoutMs?: number): Promise<CommandOutput>;
  /** B2: writes one file over SFTP, its folder made first (a path from the account's home). */
  upload(remotePath: string, data: Uint8Array): Promise<void>;
  /** Runs a command and gives its standard output to `sink` as a stream; output is what it wrote to stderr. */
  runStreamOut(command: string, sink: (stdout: Readable) => Promise<void>, timeoutMs?: number): Promise<CommandOutput>;
  /** Runs a command with `source` as its standard input; output is what it wrote. */
  runStreamIn(command: string, source: Readable, timeoutMs?: number): Promise<CommandOutput>;
  close(): void;
}

export class SshError extends Error {
  constructor(
    message: string,
    readonly kind: "host_key_changed" | "refused" | "unreachable" | "other",
  ) {
    super(message);
    this.name = "SshError";
  }
}

type Connect = (target: SshTarget) => Promise<SshSession>;
let stand: Connect | null = null;

/** Tests pass a stand-in server: commands recorded and answered. */
export function setSshForTesting(connect: Connect | null): void {
  stand = connect;
}

/** The most output kept from one command while it runs (more is cut). */
const MAX_OUTPUT = 200_000;

export function connectSsh(target: SshTarget): Promise<SshSession> {
  if (stand) return stand(target);
  return new Promise((resolve, reject) => {
    const client = new Client();
    let seen = "";
    let settled = false;
    const fail = (error: SshError) => {
      if (settled) return;
      settled = true;
      client.end();
      reject(error);
    };

    /* One command: its stderr always collected; wire decides what happens to stdout and stdin. */
    const exec = (command: string, timeoutMs: number, wire: (stream: ClientChannel, add: (chunk: Buffer) => void) => Promise<void> | void) =>
      new Promise<CommandOutput>((done) => {
        client.exec(command, (error, stream) => {
          if (error) return done({ code: null, output: `The server refused to run it: ${error.message}` });
          let output = "";
          let code: number | null = null;
          let finished = false;
          // The caller's side failed (an R2 upload refused, a sink that threw): never a success, even when the command itself exited 0 (Fable's code review, finding 1).
          let wireFailed = false;
          const add = (chunk: Buffer) => {
            if (output.length < MAX_OUTPUT) output += chunk.toString("utf8");
          };
          const timer = setTimeout(() => {
            finished = true;
            stream.close();
            done({ code: null, output: `${output}\nIt didn't finish within ${Math.round(timeoutMs / 1000)} seconds.` });
          }, timeoutMs);
          stream.stderr.on("data", add);
          stream.on("exit", (exitCode: number | null) => {
            code = exitCode ?? null;
          });
          const wired = Promise.resolve()
            .then(() => wire(stream, add))
            .catch((wireError: unknown) => {
              add(Buffer.from(`\n${wireError instanceof Error ? wireError.message : "The stream stopped."}`));
              wireFailed = true;
              stream.close();
            });
          stream.on("close", (closeCode: number | null) => {
            void wired.then(() => {
              if (finished) return;
              finished = true;
              clearTimeout(timer);
              const exited = code ?? closeCode ?? null;
              done({ code: wireFailed ? (exited === 0 || exited === null ? 1 : exited) : exited, output });
            });
          });
        });
      });

    client.on("ready", () => {
      settled = true;
      resolve({
        hostKey: seen,
        close: () => client.end(),
        upload: (remotePath, data) =>
          new Promise<void>((done, failed) => {
            client.sftp((error, sftp) => {
              if (error) return failed(new SshError(`The server refused a file upload (SFTP): ${error.message}`, "other"));
              const parts = remotePath.split("/").slice(0, -1);
              // Each folder on the way, made if it isn't there (an error for one that exists is fine).
              const makeDirs = (i: number, next: () => void): void => {
                if (i > parts.length) return next();
                const dir = parts.slice(0, i).join("/");
                if (!dir) return makeDirs(i + 1, next);
                sftp.mkdir(dir, () => makeDirs(i + 1, next));
              };
              makeDirs(1, () =>
                sftp.writeFile(remotePath, Buffer.from(data), (writeError) => {
                  sftp.end();
                  if (writeError) return failed(new SshError(`The file didn't upload: ${writeError.message}`, "other"));
                  done();
                }),
              );
            });
          }),
        run: (command, timeoutMs = 60_000) =>
          exec(command, timeoutMs, (stream, add) => {
            stream.on("data", add);
          }),
        runStreamOut: (command, sink, timeoutMs = 600_000) =>
          exec(command, timeoutMs, (stream) => {
            // The caller reads a pass-through (piped, so its pace holds the channel back), never the channel itself.
            const out = new PassThrough();
            stream.pipe(out);
            return sink(out);
          }),
        runStreamIn: (command, source, timeoutMs = 900_000) =>
          exec(command, timeoutMs, (stream, add) => {
            stream.on("data", add);
            source.on("error", (sourceError: Error) => {
              add(Buffer.from(`\nThe backup couldn't be read: ${sourceError.message}`));
              stream.close();
            });
            source.pipe(stream);
          }),
      });
    });

    client.on("error", (error: Error & { level?: string; code?: string }) => {
      if (target.expectedHostKey && seen && seen !== target.expectedHostKey) {
        return fail(
          new SshError(
            `The server ${target.host} answered with a different key than before (was ${target.expectedHostKey}, now ${seen}). That can mean the host moved it to new hardware, or that something is in the way. Check with 20i first; if the server really changed, an admin clicks "Forget this server's key" on System and tries again.`,
            "host_key_changed",
          ),
        );
      }
      if (error.level === "client-authentication") {
        return fail(new SshError(`${target.host} refused TAWD's key for ${target.username}.`, "refused"));
      }
      if (error.code === "ENOTFOUND" || error.code === "ECONNREFUSED" || error.code === "ETIMEDOUT" || error.code === "EHOSTUNREACH" || /handshake|timed out/i.test(error.message)) {
        return fail(new SshError(`TAWD couldn't reach ${target.host} on port ${target.port} (${error.code ?? error.message}).`, "unreachable"));
      }
      fail(new SshError(`The SSH connection failed: ${error.message}`, "other"));
    });

    client.connect({
      host: target.host,
      port: target.port,
      username: target.username,
      privateKey: target.privateKey,
      readyTimeout: target.readyTimeoutMs ?? 20_000,
      // Only the key: never a password, never an agent.
      tryKeyboard: false,
      hostVerifier: (key: Buffer) => {
        seen = sshFingerprint(key);
        return !target.expectedHostKey || seen === target.expectedHostKey;
      },
    });
  });
}
