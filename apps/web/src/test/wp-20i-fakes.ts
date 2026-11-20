import { gzipSync } from "node:zlib";
import { Readable } from "node:stream";

import type { SshSession } from "../../../worker/src/ssh";
import type { AcmeIssuer, TlsProbe } from "../../../worker/src/wp-cert";

/*
  Build B on 20i (5 October 2026): the stand-ins the WordPress tests share.
  A package's SSH side (it remembers WordPress, the plugins, the config and
  every command; streams in and out for backups), a Let's Encrypt that
  writes and removes its check files like the real one, Check HTTPS by
  name, and public DNS by name. Nothing here reaches 20i, Let's Encrypt,
  Cloudflare or a resolver.
*/

export interface PackageServer {
  ran: string[];
  uploads: Map<string, Uint8Array>;
  wp: boolean;
  config: boolean;
  installed: boolean;
  adminPassword: string | null;
  plugins: Map<string, string>;
  /** Files restored from a backup (what came in on stdin). */
  restored: { command: string; bytes: number }[];
  /** The host key it answers with. */
  hostKey: string;
  /** Refuse TAWD's key (20i still setting it up). */
  refuseKey: boolean;
  webRoot: boolean;
  /** What the PHP check lists (8 October 2026): PHP builds and WP-CLI. */
  phpList: string;
  /** The database dump comes out empty though the command exits 0: gzip of nothing, about 20 bytes, as the real pipe gives. */
  emptyDump?: boolean;
  /** The WordPress login made at install, and the name pages show for it (13 October 2026). */
  adminUser?: string | null;
  publicName?: string | null;
  /** WordPress's home address (set at install, by option update, and by search-replace). */
  home?: string | null;
  /** Stored values that hold addresses (12 October 2026): search-replace rewrites them (never guid, nor a frozen one), db search finds them. */
  data?: { table: string; column: string; value: string; frozen?: boolean }[];
}

export function newServer(): PackageServer {
  return { ran: [], uploads: new Map(), wp: false, config: false, installed: false, adminPassword: null, plugins: new Map(), restored: [], hostKey: "SHA256:twentyigatewaykey0000000000000000000000000", refuseKey: false, webRoot: true, phpList: "php /usr/bin/php 8.3.12\nwp /usr/local/bin/wp #!/usr/bin/env php" };
}

export function answer(server: PackageServer, command: string): { code: number; output: string } {
  if (command.startsWith("for b in php")) return { code: 0, output: server.phpList };
  if (command.includes("test -d")) return { code: 0, output: server.webRoot ? "yes" : "no" };
  if (command.startsWith("mkdir -p")) return (server.webRoot = true), { code: 0, output: "yes" };
  if (command.startsWith("ls -1A")) return { code: 0, output: server.webRoot ? "logs\npublic_html" : "logs\nprivate" };
  if (command.includes("wp-load.php")) return { code: 0, output: server.wp ? "yes" : "no" };
  if (command.includes("core download")) return (server.wp = true), { code: 0, output: "Success: WordPress downloaded." };
  if (command.includes("wp-config.php && echo")) return { code: 0, output: server.config ? "yes" : "no" };
  if (command.includes("config create")) return (server.config = true), { code: 0, output: "Success: Generated 'wp-config.php' file." };
  if (command.includes("config set") || command.includes("config delete")) return { code: 0, output: "Success" };
  if (command.includes("core is-installed")) return { code: 0, output: server.installed ? "yes" : "Error: not installed\nno" };
  if (command.includes("core install")) {
    server.installed = true;
    server.adminPassword = /--admin_password='([^']+)'/.exec(command)?.[1] ?? null;
    server.adminUser = /--admin_user='([^']+)'/.exec(command)?.[1] ?? null;
    server.home = /--url='([^']+)'/.exec(command)?.[1] ?? null;
    return { code: 0, output: "Success: WordPress installed successfully." };
  }
  if (command.includes("user update") && command.includes("--display_name=")) return (server.publicName = /--display_name='([^']+)'/.exec(command)?.[1] ?? null), { code: 0, output: "Success" };
  if (command.includes("user update")) {
    if (/user update '([^']+)'/.exec(command)?.[1] !== server.adminUser) return { code: 1, output: "Error: Invalid user ID, email or login" };
    return (server.adminPassword = /--user_pass='([^']+)'/.exec(command)?.[1] ?? null), { code: 0, output: "Success" };
  }
  if (command.includes("plugin get")) {
    const slug = /plugin get '([^']+)'/.exec(command)?.[1] ?? "";
    return server.plugins.has(slug) ? { code: 0, output: server.plugins.get(slug)! } : { code: 1, output: "Error: The plugin could not be found." };
  }
  if (command.includes("plugin install")) {
    server.plugins.set(/plugin install '([^']+)'/.exec(command)![1]!, /--version='([^']+)'/.exec(command)![1]!);
    return { code: 0, output: "Success: Installed 1 of 1 plugins." };
  }
  if (command.includes("plugin activate") || command.includes("plugin deactivate")) return { code: 0, output: "Success" };
  if (command.includes(" gf install --key=")) return (server.plugins.set("gravityforms", "2.9.20"), { code: 0, output: "Success: Gravity Forms installed and activated." });
  if (command.includes("ZipArchive")) return { code: 0, output: "" };
  if (command.includes("eval-file install.php")) return { code: 0, output: "Files: 1\nTheme: tawd-harbor-pest\nForms: 1\nPage: /\nPage: /contact/\nRedirects: 0\nDone: 2 pages" };
  if (command.includes("option get home")) return { code: 0, output: server.home ?? "" };
  if (command.includes("option update home")) return (server.home = /option update home '([^']+)'/.exec(command)?.[1] ?? null), { code: 0, output: "Success: Updated 'home' option." };
  if (command.includes("search-replace")) {
    const [, from = "", to = ""] = /search-replace '([^']+)' '([^']+)'/.exec(command) ?? [];
    if (server.home) server.home = server.home.split(from).join(to);
    for (const d of server.data ?? []) if (d.column !== "guid" && !d.frozen) d.value = d.value.split(from).join(to);
    return { code: 0, output: "Success: Made 3 replacements." };
  }
  if (command.includes("db search")) {
    const text = /db search '([^']+)'/.exec(command)?.[1] ?? "";
    const lines: string[] = [];
    for (const d of server.data ?? []) {
      if (!d.value.includes(text)) continue;
      lines.push(`${d.table}:${d.column}`, `1:${text}`);
    }
    return { code: 0, output: lines.join("\n") };
  }
  if (command.includes("option update")) return { code: 0, output: "Success" };
  if (command.includes("post list --post_type=wpcf7_contact_form")) return { code: 0, output: "12" };
  if (command.includes("rm -rf") || command.includes("rm -f")) return { code: 0, output: "" };
  return { code: 127, output: "command not found" };
}

/* The SSH side of a 20i package, as setSshForTesting wants it. */
export function sshStandIn(server: PackageServer, targets: { host: string; username: string; expectedHostKey: string | null }[]) {
  return async (target: { host: string; username: string; expectedHostKey: string | null }): Promise<SshSession> => {
    targets.push({ host: target.host, username: target.username, expectedHostKey: target.expectedHostKey });
    if (target.expectedHostKey && target.expectedHostKey !== server.hostKey) {
      const { SshError } = await import("../../../worker/src/ssh");
      throw new SshError(`The server ${target.host} answered with a different key than before.`, "host_key_changed");
    }
    if (server.refuseKey) {
      const { SshError } = await import("../../../worker/src/ssh");
      throw new SshError(`${target.host} refused TAWD's key for ${target.username}.`, "refused");
    }
    return {
      hostKey: server.hostKey,
      close() {},
      upload: async (path, data) => void server.uploads.set(path, data),
      run: async (command) => {
        server.ran.push(command);
        return answer(server, command);
      },
      runStreamOut: async (command, sink) => {
        server.ran.push(command);
        // A database dump or a tarball, in a few chunks; the command exits 0 either way.
        const dump = command.includes("db export");
        try {
          await sink(Readable.from(dump && server.emptyDump ? [gzipSync(Buffer.alloc(0))] : [Buffer.from(`${dump ? "SQL" : "TAR"}:`), Buffer.alloc(100_000, 7)]));
        } catch (error) {
          // As the real exec (ssh.ts): the receiving side failing is never a success.
          return { code: 1, output: `
${error instanceof Error ? error.message : "The stream stopped."}` };
        }
        return { code: 0, output: "" };
      },
      runStreamIn: async (command, source) => {
        server.ran.push(command);
        let bytes = 0;
        for await (const chunk of source) bytes += (chunk as Buffer).length;
        server.restored.push({ command, bytes });
        return { code: 0, output: "" };
      },
    };
  };
}

export const FAKE_PRIVATE_KEY = "-----BEGIN PRIVATE KEY-----\nsite-private-key-material-do-not-store\n-----END PRIVATE KEY-----";

/* Let's Encrypt, as acme-client's auto() drives it: a check file per name, written then removed. */
export function fakeAcme(log: { names: string[]; staging: boolean; tokens: string[] }[], fail: { message: string | null } = { message: null }): AcmeIssuer {
  return {
    async createAccountKey() {
      return "-----BEGIN PRIVATE KEY-----\nacme-account\n-----END PRIVATE KEY-----";
    },
    async issue(input) {
      const tokens: string[] = [];
      for (const name of input.names) {
        const token = `tok${name.replace(/[^a-z0-9]/g, "")}${"x".repeat(20)}`.slice(0, 40);
        tokens.push(token);
        await input.setChallenge(token, `${token}.keyauth`);
      }
      for (const token of tokens) await input.clearChallenge(token);
      log.push({ names: input.names, staging: input.staging, tokens });
      if (fail.message) throw new Error(fail.message);
      const issuedAt = new Date("2026-10-05T00:00:00Z");
      return {
        certificate: "-----BEGIN CERTIFICATE-----\nleaf\n-----END CERTIFICATE-----",
        caBundle: "-----BEGIN CERTIFICATE-----\nR11\n-----END CERTIFICATE-----",
        privateKey: FAKE_PRIVATE_KEY,
        accountKeyPem: input.accountKeyPem ?? "-----BEGIN PRIVATE KEY-----\nacme-account\n-----END PRIVATE KEY-----",
        issuer: "R11",
        issuedAt,
        expiresAt: new Date(issuedAt.getTime() + 90 * 86_400_000),
      };
    },
  };
}

/* Check HTTPS by name: a site answers with a trusted certificate once it's in the set. */
export function tlsStandIn(serving: Map<string, { issuer: string; validTo: string }>) {
  return async (host: string): Promise<TlsProbe> => {
    const cert = serving.get(host);
    return cert ? { ok: true, issuer: cert.issuer, validFrom: new Date("2026-10-05T00:00:00Z"), validTo: new Date(cert.validTo), reason: null } : { ok: false, issuer: null, validFrom: null, validTo: null, reason: "unable to verify the first certificate" };
  };
}

/* Public DNS by name and type ("harborpest.com A"), the same from both resolvers. */
export type Zone = Record<string, { type: number; data: string; name?: string }[]>;

export function dohStandIn(zone: () => Zone) {
  return async (url: string) => {
    const u = new URL(url);
    const name = u.searchParams.get("name")!;
    const type = u.searchParams.get("type")!;
    const answers = zone()[`${name} ${type}`] ?? [];
    return { Status: 0, Answer: answers.map((a) => ({ name: a.name ?? `${name}.`, type: a.type, data: a.data })) };
  };
}

/* harborpest.com pointing at a package's IP (A @, CNAME www), at GoDaddy. */
export function pointedZone(ip: string): Zone {
  return {
    "harborpest.com NS": [{ type: 2, data: "ns51.domaincontrol.com." }],
    "harborpest.com A": [{ type: 1, data: ip }],
    "www.harborpest.com CNAME": [{ type: 5, data: "harborpest.com." }],
  };
}
