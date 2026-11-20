import { promises as dns } from "node:dns";
import { speedForGate } from "@/lib/speed-check";
import { loadPageReview, pagesChecklistItem } from "@/lib/page-review";
import { loadStages, stagesChecklistItem } from "@/lib/site-builds";
import { and, desc, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { buildFeePayment, goLive, intakePrefill, netlifySite, project, projectTracking, siteBuild, siteDeploy, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { PREFILL_LABELS, goLiveFlags, type PrefillKey } from "@tawd/core/intake";
import { loadIntakeForBuilding, pendingSiteClaims } from "@tawd/core/intake/unconfirmed";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import { confirmedFactsFrom } from "@tawd/core/mockups";
import { keptWordsFor, suppliedHomeFile, suppliedHomeWords } from "@tawd/core/site-read";
import {
  runChecklist,
  checkGa4,
  formatPolicyDate,
  compareRecords,
  describeRecord,
  emailLookups,
  goLiveGate,
  DNSSEC_ON_MESSAGE,
  dnssecFromDoh,
  rdapDomainUrl,
  readRdap,
  type RegistryInfo,
  isDomain,
  keepRecord,
  netlifyRecords,
  twentyiRecords,
  normalizeDomain,
  recordKey,
  type ChecklistItem,
  type DnsRecord,
  type DnsRecordType,
  type GoLiveGate,
} from "@tawd/core/site";
import { healthChecklistItem, loadHealthFlags } from "@/lib/health-flags";
import { buildZip, ensureSite, netlify, NetlifyError } from "@/lib/netlify";
import { loadSeoGoLive } from "@/lib/seo-golive";
import { notifySlack } from "@/lib/slack-notify";
import { formsConfirmed } from "@/lib/forms-relay";
import { privacyLawFlags } from "@/lib/privacy-laws";
import type { ServiceContext } from "@/lib/users";

/*
  Phase 9, go-live (28 September 2026). The steps, in order, each logged
  and posted to Slack:

  1. The domain, confirmed as registered in the client's name.
  2. The client's email records, read from public DNS (free).
  3. The zone on VML's Cloudflare account, with those records and the
     Netlify ones (never proxied, so Netlify can issue the certificate).
  4. The records checked on Cloudflare and at its nameserver; then the PM
     confirms them with the client's email provider.
  5. The domain on the Netlify site.
  6. The nameserver switch at the registrar (the client's or the PM's job;
     TAWD checks it).
  7. HTTPS, confirmed.
  8. GA4: the client-owned property with VML as Editor, recorded by hand.
  9. Go live (founders and admins): the gate, then the live deploy.
  A one-click rollback restores the previous live deploy.

  CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are read by the web app
  (and, since 5 October 2026, by the worker for WordPress previews and the
  IP watch); sent to Cloudflare and nowhere else, never logged or shown to AI.
*/

type Db = Database;

export class GoLiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoLiveError";
  }
}

/* ---------- Cloudflare ---------- */

type Fetch = typeof fetch;
let cloudflareFetch: Fetch | null = null;
let httpsFetch: Fetch | null = null;

/** Tests pass stand-ins for Cloudflare and for loading the live site. */
export function setGoLiveFetchForTesting(cloudflare: Fetch | null, site: Fetch | null = null): void {
  cloudflareFetch = cloudflare;
  httpsFetch = site;
}

export function cloudflareSetup(): { configured: boolean; missing: string[] } {
  const missing = ["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"].filter((name) => !process.env[name]?.trim());
  return { configured: missing.length === 0, missing };
}

async function cloudflare<T>(method: string, path: string, body?: unknown): Promise<T> {
  const token = process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!token) throw new GoLiveError("Cloudflare isn't set up yet: an admin adds CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID to the web app in Coolify.");
  const response = await (cloudflareFetch ?? fetch)(`https://api.cloudflare.com/client/v4${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await response.json().catch(() => ({}))) as { success?: boolean; result?: T; errors?: { code: number; message: string }[] };
  if (response.status === 401 || response.status === 403) throw new GoLiveError("Cloudflare refused the token. Check CLOUDFLARE_API_TOKEN (it needs Zone Edit and DNS Edit on the VML account).");
  if (!response.ok || json.success === false) {
    throw new GoLiveError(`Cloudflare answered ${response.status}: ${json.errors?.map((e) => e.message).join("; ") || "no reason given"}.`);
  }
  return json.result as T;
}

interface CloudflareRecord {
  id: string;
  type: string;
  name: string;
  content: string;
  priority?: number;
  data?: { priority?: number; weight?: number; port?: number; target?: string };
}

function fromCloudflare(r: CloudflareRecord): DnsRecord {
  if (r.type === "SRV" && r.data) return { type: "SRV", name: r.name, content: `${r.data.weight ?? 0} ${r.data.port ?? 0} ${r.data.target ?? ""}`, priority: r.data.priority };
  return { type: r.type as DnsRecordType, name: r.name, content: r.content, ...(r.type === "MX" ? { priority: r.priority } : {}) };
}

function toCloudflare(r: DnsRecord): Record<string, unknown> {
  if (r.type === "SRV") {
    const [weight, port, target] = r.content.split(/\s+/);
    return { type: "SRV", name: r.name, ttl: 1, data: { priority: r.priority ?? 0, weight: Number(weight), port: Number(port), target } };
  }
  return { type: r.type, name: r.name, content: r.content, ttl: 1, proxied: false, ...(r.type === "MX" ? { priority: r.priority ?? 10 } : {}) };
}

/* ---------- DNS ---------- */

export interface DnsLookup {
  /** Records of a type at a name; empty when there are none. server: a nameserver's host name, to ask it directly. */
  lookup(type: DnsRecordType | "NS", name: string, server?: string): Promise<DnsRecord[]>;
}

const publicDns: DnsLookup = {
  async lookup(type, name, server) {
    const resolver = new dns.Resolver({ timeout: 5_000, tries: 2 });
    if (server) {
      const ips = await dns.resolve4(server).catch(() => [] as string[]);
      if (ips.length) resolver.setServers(ips);
    }
    try {
      switch (type) {
        case "MX":
          return (await resolver.resolveMx(name)).map((r) => ({ type: "MX", name, content: r.exchange, priority: r.priority }));
        case "TXT":
          return (await resolver.resolveTxt(name)).map((parts) => ({ type: "TXT", name, content: parts.join("") }));
        case "CNAME":
          return (await resolver.resolveCname(name)).map((content) => ({ type: "CNAME", name, content }));
        case "SRV":
          return (await resolver.resolveSrv(name)).map((r) => ({ type: "SRV", name, content: `${r.weight} ${r.port} ${r.name}`, priority: r.priority }));
        case "NS":
          return (await resolver.resolveNs(name)).map((content) => ({ type: "CNAME", name, content }));
        case "A":
          return (await resolver.resolve4(name)).map((content) => ({ type: "A", name, content }));
      }
    } catch {
      // No such record (or no answer): nothing to copy.
      return [];
    }
  },
};
let dnsLookup: DnsLookup = publicDns;

export function setDnsForTesting(stand: DnsLookup | null): void {
  dnsLookup = stand ?? publicDns;
}

/* ---------- the registrar and DNSSEC (28 September 2026) ---------- */

let registryFetch: Fetch | null = null;

/** Tests pass a stand-in for RDAP and DNS-over-HTTPS. */
export function setRegistryFetchForTesting(stand: Fetch | null): void {
  registryFetch = stand;
}

/* Whether DNSSEC is on (a DS record at the parent zone), from public DNS over HTTPS; null when neither resolver answers. */
async function dnssecOn(domain: string): Promise<boolean | null> {
  const name = encodeURIComponent(domain);
  for (const url of [`https://cloudflare-dns.com/dns-query?name=${name}&type=DS`, `https://dns.google/resolve?name=${name}&type=DS`]) {
    try {
      const response = await (registryFetch ?? fetch)(url, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(8_000) });
      if (!response.ok) continue;
      const signed = dnssecFromDoh(await response.json());
      if (signed !== null) return signed;
    } catch {
      // Try the other resolver.
    }
  }
  return null;
}

/* The registrar and the nameservers from RDAP (the domain's own registry, from IANA's list: 0.122.1); null when it doesn't answer. */
async function rdapLookup(domain: string): Promise<RegistryInfo | null> {
  try {
    const get = (url: string) =>
      (registryFetch ?? fetch)(url, {
        headers: { accept: "application/rdap+json, application/json" },
        redirect: "follow",
        signal: AbortSignal.timeout(10_000),
      });
    const response = await get(await rdapDomainUrl(domain, get));
    if (!response.ok) return null;
    return readRdap(await response.json());
  } catch {
    return null;
  }
}

export interface RegistryView extends RegistryInfo {
  /** From public DNS: true when a DS record is published; null when it couldn't be asked. */
  dnssec: boolean | null;
  checkedAt: string;
}

/*
  Where the domain is registered, its nameservers now, and whether DNSSEC
  is on, before the switch. Free, read-only, logged.
*/
export async function checkRegistry(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<RegistryView> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.domain || !current.domainConfirmedAt) throw new GoLiveError("Confirm the domain first.");
  const [info, dnssec] = await Promise.all([rdapLookup(current.domain), dnssecOn(current.domain)]);
  if (!info && dnssec === null) throw new GoLiveError(`Neither the domain registry (RDAP) nor public DNS answered about ${current.domain}. Check the spelling, or try again in a minute.`);
  const value: RegistryView = { ...(info ?? { registrar: null, registrarUrl: null, nameservers: [], rdapSigned: null }), dnssec: dnssec ?? info?.rdapSigned ?? null, checkedAt: new Date().toISOString() };
  await update(ctx.db, projectId, { registry: value, lastError: null });
  await step(
    ctx,
    actor,
    projectId,
    "golive.registry_checked",
    { ...value },
    `${current.domain} is registered with ${value.registrar ?? "an unknown registrar"}; DNSSEC is ${value.dnssec === true ? "ON (turn it off before the switch)" : value.dnssec === false ? "off" : "unknown"}.`,
  );
  return value;
}

/* ---------- the row, the fee, the checklist ---------- */

async function row(db: Db, projectId: string) {
  const [existing] = await db.select().from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  if (existing) return existing;
  const [created] = await db.insert(goLive).values({ projectId }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(goLive).where(eq(goLive.projectId, projectId)).limit(1))[0]!;
}

async function update(db: Db, projectId: string, values: Partial<typeof goLive.$inferInsert>) {
  await db.update(goLive).set({ ...values, updatedAt: new Date() }).where(eq(goLive.projectId, projectId));
}

async function step(ctx: ServiceContext, actor: Viewer, projectId: string, action: Parameters<typeof recordActivity>[1]["action"], valueAfter: Record<string, unknown>, slack: string) {
  await recordActivity(ctx.db, { action, entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  notifySlack(ctx.db, projectId, { kind: "golive_step", step: slack });
}

async function fail(ctx: ServiceContext, actor: Viewer, projectId: string, what: string, error: unknown): Promise<never> {
  const message = error instanceof GoLiveError || error instanceof NetlifyError ? error.message : "It stopped unexpectedly. Try again.";
  await update(ctx.db, projectId, { lastError: `${what}: ${message}` });
  await recordActivity(ctx.db, { action: "golive.failed", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { step: what, reason: message }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  throw error instanceof GoLiveError || error instanceof NetlifyError ? error : new GoLiveError(message);
}

export const PAYMENT_METHODS = ["card", "bank transfer", "check", "cash", "other"] as const;

export async function recordBuildFeePaid(ctx: ServiceContext, actor: Viewer, projectId: string, input: { paidOn: string; method: string; note?: string }): Promise<void> {
  assertCan(actor, "golive.fee");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn)) throw new GoLiveError("Give the date it was paid.");
  if (!(PAYMENT_METHODS as readonly string[]).includes(input.method)) throw new GoLiveError("Choose how it was paid.");
  await ctx.db.update(buildFeePayment).set({ removedAt: new Date() }).where(and(eq(buildFeePayment.projectId, projectId), isNull(buildFeePayment.removedAt)));
  await ctx.db.insert(buildFeePayment).values({ projectId, paidOn: input.paidOn, method: input.method, note: input.note?.trim().slice(0, 1000) || null, recordedByUserId: actor.id });
  await recordActivity(ctx.db, { action: "golive.fee_paid", entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter: { paidOn: input.paidOn, method: input.method, note: input.note?.trim() || null }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

export async function undoBuildFeePaid(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "golive.fee");
  const removed = await ctx.db.update(buildFeePayment).set({ removedAt: new Date() }).where(and(eq(buildFeePayment.projectId, projectId), isNull(buildFeePayment.removedAt))).returning();
  if (removed.length === 0) throw new GoLiveError("There is no payment recorded to take back.");
  await recordActivity(ctx.db, { action: "golive.fee_unpaid", entityType: "project", entityId: projectId, ...actorFields(actor), valueBefore: { paidOn: removed[0]!.paidOn, method: removed[0]!.method }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
}

/*
  B1 review (M1): "Facts match the intake" and the claims item, read again
  against the built pages as stored and the intake as it is now. The
  checklist is otherwise a snapshot taken at build time, so when the
  checklist told a person to add a missing fact to the intake, doing it
  changed nothing until a paid rebuild: a block with no free way forward.
  Code only, no AI. If the pages can't be read, the stored items stand.
*/
async function liveFactItems(db: Db, projectId: string, version: number): Promise<Map<string, ChecklistItem>> {
  const out = new Map<string, ChecklistItem>();
  try {
    const intake = await loadIntakeForBuilding(db as never, SYSTEM_ACTOR, projectId);
    if (!intake) return out;
    const confirmed = confirmedFactsFrom(intake.data, {
      unconfirmed: intake.unconfirmed.map((c) => ({ key: c.key, value: c.value })),
      keptWords: await keptWordsFor(db as never, projectId),
    });
    const storage = getStorage();
    const prefix = `${projectStoragePrefix(projectId)}site/v${version}/`;
    const files = new Map<string, string>();
    for (const key of await storage.list(prefix)) {
      const file = key.slice(prefix.length);
      if (!file.endsWith(".html") || file.startsWith("_source/")) continue;
      const body = await storage.get(key);
      if (body) files.set(file, body.toString("utf8"));
    }
    if (files.size === 0) return out;
    for (const item of runChecklist({ files, pagePaths: [], domain: null, mobileOverflow: null, gbpUrl: "", claims: confirmed.claims, facts: confirmed, suppliedHomeFile: await suppliedHomeFile(db as never, projectId), suppliedWords: await suppliedHomeWords(db as never, projectId) })) {
      if (item.key === "facts" || item.key === "claims") out.set(item.key, item);
    }
  } catch (error) {
    console.warn(`[go-live] the facts couldn't be read again for ${projectId}:`, error instanceof Error ? error.message : error);
  }
  return out;
}

/*
  The latest finished build's checklist as the Build page shows it: health
  flags with their confirmations, and the SEO team's sign-off of this version.
*/
export async function goLiveChecklist(db: Db, projectId: string): Promise<{ version: number | null; items: ChecklistItem[] }> {
  const [done] = await db
    .select()
    .from(siteBuild)
    .where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.status, "done")))
    .orderBy(desc(siteBuild.version))
    .limit(1);
  if (!done?.checks) return { version: null, items: [] };
  const health = await loadHealthFlags(db, projectId, new Map());
  const seo = await loadSeoGoLive(db, projectId);
  // Every page reviewed and approved by the team (step 3a, 3 October 2026).
  const pagesItem = pagesChecklistItem(await loadPageReview(db, projectId, new Map()));
  // Staged builds (6 October 2026): go-live waits until every planned page is built.
  const builtItem = stagesChecklistItem(await loadStages(db, projectId));
  /*
    B3 (audit F-016): a warranty, offer or financing read from the old site
    and never confirmed. It is kept off the pages (loadIntakeForBuilding), so
    this does not block go-live; it is listed so the client's real offer is
    confirmed rather than quietly dropped.
  */
  const pendingClaims = pendingSiteClaims(
    await db
      .select({ fieldKey: intakePrefill.fieldKey, status: intakePrefill.status, origin: intakePrefill.origin, value: intakePrefill.value })
      .from(intakePrefill)
      .where(and(eq(intakePrefill.projectId, projectId), eq(intakePrefill.status, "pending"))),
  );
  const claimsItem: ChecklistItem = {
    key: "site-claims",
    label: "Claims from the current website confirmed",
    ok: pendingClaims.length === 0,
    detail: pendingClaims.length
      ? `Not on the site until confirmed on the intake: ${pendingClaims.map((m) => `${PREFILL_LABELS[m.fieldKey as PrefillKey]} ("${m.value === true ? "financing is offered" : String(m.value)}")`).join("; ")}`
      : "None waiting",
    blocksGoLive: false,
  };
  // The facts and claims items, read again now (B1 review, M1): a fact a person added to the intake since the build clears them without a paid rebuild.
  const live = await liveFactItems(db, projectId, done.version);
  return {
    version: done.version,
    items: [
      ...(done.checks as ChecklistItem[]).map((c) => live.get(c.key) ?? (c.key === "health" && health ? healthChecklistItem(c, health.flags) : c)),
      {
        key: "seo-signoff",
        label: "SEO team sign-off",
        ok: seo.signedOff,
        detail: seo.signedOff ? "Signed off for this version" : "Run the SEO check below, then the SEO team signs off",
        blocksGoLive: true,
      },
      ...(builtItem ? [builtItem] : []),
      ...(pagesItem ? [pagesItem] : []),
      claimsItem,
    ],
  };
}

export interface GoLiveView {
  cloudflare: { configured: boolean; missing: string[] };
  row: typeof goLive.$inferSelect;
  domainFromIntake: string | null;
  fee: { paidOn: string; method: string; note: string | null } | null;
  checklistVersion: number | null;
  gate: GoLiveGate;
  netlifySiteName: string | null;
  liveDeploys: { id: string; version: number; kind: string; url: string | null; readyAt: Date | null; state: string }[];
  canRollBack: boolean;
}

export async function loadGoLive(db: Db, projectId: string): Promise<GoLiveView> {
  // A go-live the web app was interrupted in is settled first, so this screen tells the truth (D4). Never stops the screen loading.
  await settleInterruptedGoLive(db, projectId).catch((error) => console.warn(`[go-live] couldn't settle an interrupted go-live for ${projectId}:`, error instanceof Error ? error.message : error));
  const current = await row(db, projectId);
  const intake = await loadIntake(db, SYSTEM_ACTOR, projectId);
  const [fee] = await db.select().from(buildFeePayment).where(and(eq(buildFeePayment.projectId, projectId), isNull(buildFeePayment.removedAt))).orderBy(desc(buildFeePayment.createdAt)).limit(1);
  const checklist = await goLiveChecklist(db, projectId);
  const [site] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  const [proj] = await db.select().from(project).where(eq(project.id, projectId)).limit(1);
  const liveDeploys = await db
    .select()
    .from(siteDeploy)
    .where(and(eq(siteDeploy.projectId, projectId), inArray(siteDeploy.kind, ["live", "rollback"])))
    .orderBy(desc(siteDeploy.createdAt));
  // For the founders, never a block (Jason, 28 September 2026).
  const founderFlags = intake
    ? [
        ...goLiveFlags({ intake: intake.data, projectTrade: proj?.trade ?? null, files: intake.files } as never).map((f) => `${f.label}: ${f.line}`),
        // A state whose privacy rules haven't been checked for three months (28 September 2026).
        ...(await privacyLawFlags(db, intake.data)),
      ]
    : [];
  const gate = goLiveGate({
    buildFeePaid: Boolean(fee),
    checklist: checklist.items,
    hasBuild: checklist.version !== null,
    wordpress: proj?.hosting === "wordpress",
    wordpressSteps: proj?.hosting === "wordpress" ? await wordpressSteps(db, projectId) : undefined,
    dnssecOn: (current.registry as RegistryView | null)?.dnssec === true && !current.nameserversSwitchedAt ? { domain: current.domain!, registrar: (current.registry as RegistryView).registrar } : undefined,
    founderFlags,
    path: (current.connectPath as "records" | "access" | "vml_dns" | null) ?? null,
    formsConfirmed: await formsConfirmed(db, projectId),
    speed: await speedForGate(db, projectId),
    steps: {
      domainConfirmed: Boolean(current.domainConfirmedAt),
      emailVerified: Boolean(current.emailVerifiedAt),
      emailConfirmed: Boolean(current.emailConfirmedAt),
      netlifyDomain: Boolean(current.netlifyDomainAt),
      nameserversSwitched: Boolean(current.nameserversSwitchedAt),
      httpsConfirmed: Boolean(current.httpsConfirmedAt),
      ga4Recorded: Boolean(current.ga4RecordedAt),
      recordsOk: Boolean(current.recordsOkAt),
    },
  });
  return {
    cloudflare: cloudflareSetup(),
    row: current,
    domainFromIntake: intake?.data.website.domainName ? normalizeDomain(intake.data.website.domainName) : null,
    fee: fee ? { paidOn: fee.paidOn, method: fee.method, note: fee.note } : null,
    checklistVersion: checklist.version,
    gate,
    netlifySiteName: site?.name ?? null,
    liveDeploys: liveDeploys.map((d) => ({ id: d.id, version: d.version, kind: d.kind, url: d.url, readyAt: d.readyAt, state: d.state })),
    canRollBack: Boolean(current.wentLiveAt) && rollbackTarget(liveDeploys) !== null,
  };
}

/* B3: the WordPress side of the gate (the preview on the latest build, the domain on the site's 20i package). */
async function wordpressSteps(db: Db, projectId: string) {
  const { loadWpLive } = await import("@/lib/wp-golive");
  const wp = await loadWpLive(db, projectId);
  return { previewCurrent: wp?.previewCurrent ?? false, latestBuild: wp?.latestBuild ?? null, onHost: wp?.onHost ?? false };
}

/* ---------- 1. the domain ---------- */

export async function confirmDomain(ctx: ServiceContext, actor: Viewer, projectId: string, input: { domain: string; registrar: string; registrant: string; inClientsName: boolean }): Promise<void> {
  assertCan(actor, "project.edit");
  const domain = normalizeDomain(input.domain);
  if (!isDomain(domain)) throw new GoLiveError("That isn't a domain name (for example finleypest.com).");
  if (!input.registrar.trim()) throw new GoLiveError("Name the registrar the domain is with (GoDaddy, Namecheap, Squarespace...).");
  if (!input.registrant.trim()) throw new GoLiveError("Give the registrant: the client's name or business as the registrar shows it.");
  if (!input.inClientsName) throw new GoLiveError("The domain must be registered in the client's name. Tick the box once you've checked it.");
  const current = await row(ctx.db, projectId);
  if (current.wentLiveAt && current.domain && current.domain !== domain) throw new GoLiveError("The site is already live on another domain.");
  await update(ctx.db, projectId, {
    domain,
    registrar: input.registrar.trim().slice(0, 120),
    registrant: input.registrant.trim().slice(0, 200),
    domainConfirmedBy: actor.id,
    domainConfirmedAt: new Date(),
    // A different domain starts the DNS steps again.
    ...(current.domain && current.domain !== domain
      ? { emailRecords: null, emailReadAt: null, cloudflareZoneId: null, nameservers: null, cloudflareReadyAt: null, emailCheck: null, emailVerifiedAt: null, emailConfirmedAt: null, emailConfirmedBy: null, netlifyDomainAt: null, nameserversSwitchedAt: null, httpsConfirmedAt: null, connectPath: null, connectFound: null, connectCheck: null, recordsOkAt: null, clientLinkHash: null, clientLinkAt: null, clientDoneAt: null }
      : {}),
    lastError: null,
  });
  await step(ctx, actor, projectId, "golive.domain_confirmed", { domain, registrar: input.registrar.trim(), registrant: input.registrant.trim() }, `${domain} confirmed as registered in the client's name.`);
}

/* ---------- 2. the email records ---------- */

export async function readEmailRecords(ctx: ServiceContext, actor: Viewer, projectId: string, selectors: string[] = []): Promise<DnsRecord[]> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.domain || !current.domainConfirmedAt) throw new GoLiveError("Confirm the domain first.");
  const found: DnsRecord[] = [];
  for (const q of emailLookups(current.domain, selectors)) {
    for (const r of await dnsLookup.lookup(q.type, q.name)) {
      const record = { ...r, name: q.name };
      if (keepRecord(record) && !found.some((f) => recordKey(f) === recordKey(record))) found.push(record);
    }
  }
  await update(ctx.db, projectId, { emailRecords: found, emailReadAt: new Date(), dkimSelectors: selectors, emailCheck: null, emailVerifiedAt: null, emailConfirmedAt: null, emailConfirmedBy: null, lastError: null });
  const mx = found.filter((r) => r.type === "MX").length;
  await step(ctx, actor, projectId, "golive.email_read", { records: found.length, mx }, `the email records were read: ${found.length} (${mx} MX).`);
  return found;
}

/* ---------- 3. Cloudflare ---------- */

export async function setUpCloudflare(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string[]> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.domain || !current.emailReadAt) throw new GoLiveError("Read the email records first, so they are copied before anything changes.");
  // A WordPress site on 20i (5 October 2026): both names at its package's IPv4; otherwise the Netlify site.
  const [proj] = await ctx.db.select({ hosting: project.hosting }).from(project).where(eq(project.id, projectId)).limit(1);
  let siteRecords: DnsRecord[];
  if (proj?.hosting === "wordpress") {
    const [wp] = await ctx.db.select({ ip: wpPreview.packageIpv4 }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
    if (!wp?.ip) throw new GoLiveError("Deploy the WordPress preview first: the domain points at its 20i package's IP.");
    siteRecords = twentyiRecords(current.domain, wp.ip);
  } else {
    const [site] = await ctx.db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
    if (!site) throw new GoLiveError("Deploy a preview first: the domain points at the project's Netlify site.");
    siteRecords = netlifyRecords(current.domain, site.name);
  }
  const account = process.env.CLOUDFLARE_ACCOUNT_ID?.trim();
  try {
    let zones = await cloudflare<{ id: string; name_servers: string[] }[]>("GET", `/zones?name=${encodeURIComponent(current.domain)}${account ? `&account.id=${account}` : ""}`);
    if (zones.length === 0) {
      const created = await cloudflare<{ id: string; name_servers: string[] }>("POST", "/zones", { name: current.domain, account: { id: account }, type: "full", jump_start: false });
      zones = [created];
    }
    const zone = zones[0]!;
    const existing = (await cloudflare<CloudflareRecord[]>("GET", `/zones/${zone.id}/dns_records?per_page=500`)).map(fromCloudflare);
    const wanted = [...((current.emailRecords as DnsRecord[] | null) ?? []), ...siteRecords];
    const have = new Set(existing.map(recordKey));
    for (const record of wanted) {
      if (have.has(recordKey(record))) continue;
      await cloudflare("POST", `/zones/${zone.id}/dns_records`, toCloudflare(record));
    }
    await update(ctx.db, projectId, { cloudflareZoneId: zone.id, nameservers: zone.name_servers, cloudflareReadyAt: new Date(), emailVerifiedAt: null, lastError: null });
    await step(ctx, actor, projectId, "golive.cloudflare_ready", { zone: current.domain, nameservers: zone.name_servers, records: wanted.length }, `the Cloudflare zone for ${current.domain} is ready with ${wanted.length} records.`);
    return zone.name_servers;
  } catch (error) {
    return fail(ctx, actor, projectId, "Setting up Cloudflare", error);
  }
}

/* ---------- 4. checking the email records, then the PM's confirmation ---------- */

export async function checkEmailRecords(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ record: string; ok: boolean }[]> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.cloudflareZoneId || !current.domain) throw new GoLiveError("Set up Cloudflare first.");
  const wanted = (current.emailRecords as DnsRecord[] | null) ?? [];
  try {
    const onCloudflare = (await cloudflare<CloudflareRecord[]>("GET", `/zones/${current.cloudflareZoneId}/dns_records?per_page=500`)).map(fromCloudflare);
    // Asked of Cloudflare's own nameserver too: what the world will see once the switch is made.
    const server = ((current.nameservers as string[] | null) ?? [])[0];
    const answered: DnsRecord[] = [];
    if (server) {
      for (const q of new Map(wanted.map((r) => [`${r.type} ${r.name}`, r])).values()) {
        for (const r of await dnsLookup.lookup(q.type, q.name, server)) answered.push({ ...r, name: q.name });
      }
    }
    const inApi = compareRecords(wanted, onCloudflare);
    const atServer = server ? compareRecords(wanted, answered) : inApi;
    const check = inApi.map((c, i) => ({ record: describeRecord(c.record), ok: c.ok && atServer[i]!.ok }));
    const allOk = check.every((c) => c.ok);
    await update(ctx.db, projectId, { emailCheck: check, emailVerifiedAt: allOk ? new Date() : null, lastError: allOk ? null : "Some email records don't match yet." });
    if (allOk) await step(ctx, actor, projectId, "golive.email_verified", { records: check.length }, `all ${check.length} email records match on Cloudflare.`);
    return check;
  } catch (error) {
    return fail(ctx, actor, projectId, "Checking the email records", error);
  }
}

export async function confirmEmailRecords(ctx: ServiceContext, actor: Viewer, projectId: string, input: { confirmedWithProvider: boolean; note: string }): Promise<void> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.emailVerifiedAt) throw new GoLiveError("Check the email records on Cloudflare first; every one must match.");
  if (!input.confirmedWithProvider) throw new GoLiveError('Tick "Confirmed with the client\'s email provider" once you have.');
  const note = input.note.trim();
  if (note.length < 3) throw new GoLiveError("Say who confirmed it and how (for example: Google Workspace admin, by phone).");
  await update(ctx.db, projectId, { emailConfirmedBy: actor.id, emailConfirmedAt: new Date(), emailConfirmNote: note.slice(0, 1000) });
  await step(ctx, actor, projectId, "golive.email_confirmed", { note }, "the email records were confirmed with the client's email provider.");
}

/* ---------- 5. the domain on the Netlify site ---------- */

export async function attachNetlifyDomain(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<void> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  const recordsPath = current.connectPath === "records" || current.connectPath === "access";
  if (!current.domain || (!current.cloudflareReadyAt && !(recordsPath && current.connectFound))) throw new GoLiveError(recordsPath ? "Let TAWD look the domain up first." : "Set up Cloudflare first.");
  try {
    const site = await ensureSite(ctx.db, actor, projectId);
    await netlify("PATCH", `/sites/${site.siteId}`, { custom_domain: current.domain, domain_aliases: [`www.${current.domain}`] });
    await update(ctx.db, projectId, { netlifyDomainAt: new Date(), lastError: null });
    await step(ctx, actor, projectId, "golive.netlify_domain", { domain: current.domain }, `${current.domain} and www are on the Netlify site.`);
  } catch (error) {
    return fail(ctx, actor, projectId, "Putting the domain on Netlify", error);
  }
}

/* ---------- 6. the nameserver switch (done at the registrar; TAWD checks it) ---------- */

export async function checkNameservers(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ switched: boolean; found: string[] }> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.domain || !current.nameservers) throw new GoLiveError("Set up Cloudflare first.");
  if (!current.emailConfirmedAt) throw new GoLiveError("Confirm the email records first: switching before they're in place stops the client's email.");
  // DNSSEC still on at the registrar breaks the domain once the nameservers change (28 September 2026).
  if (!current.nameserversSwitchedAt) {
    const signed = await dnssecOn(current.domain);
    const registry = (current.registry as RegistryView | null) ?? null;
    if (signed !== null && registry && registry.dnssec !== signed) await update(ctx.db, projectId, { registry: { ...registry, dnssec: signed, checkedAt: new Date().toISOString() } });
    if (signed === true) throw new GoLiveError(DNSSEC_ON_MESSAGE(current.domain, registry?.registrar ?? null));
  }
  const wanted = new Set(((current.nameservers as string[]) ?? []).map((n) => n.toLowerCase().replace(/\.$/, "")));
  const found = (await dnsLookup.lookup("NS", current.domain)).map((r) => r.content.toLowerCase().replace(/\.$/, ""));
  const switched = found.length > 0 && found.every((n) => wanted.has(n));
  if (switched && !current.nameserversSwitchedAt) {
    await update(ctx.db, projectId, { nameserversSwitchedAt: new Date(), lastError: null });
    await step(ctx, actor, projectId, "golive.nameservers_switched", { nameservers: found }, `${current.domain} now uses Cloudflare's nameservers.`);
  }
  return { switched, found };
}

/* ---------- 7. HTTPS ---------- */

export async function checkHttps(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<boolean> {
  assertCan(actor, "project.edit");
  const current = await row(ctx.db, projectId);
  if (!current.domain || !(current.nameserversSwitchedAt || current.recordsOkAt) || !current.netlifyDomainAt) throw new GoLiveError("The domain has to be on Netlify, and pointing at it (its records, or the switch to Cloudflare), first.");
  try {
    const site = await ensureSite(ctx.db, actor, projectId);
    // Ask Netlify for the certificate (it does nothing if one is already issued).
    await netlify("POST", `/sites/${site.siteId}/ssl`).catch(() => undefined);
    const ssl = await netlify<{ state?: string; domains?: string[] }>("GET", `/sites/${site.siteId}/ssl`).catch(() => ({}) as { state?: string; domains?: string[] });
    const response = await (httpsFetch ?? fetch)(`https://${current.domain}/`, { method: "GET", redirect: "follow", signal: AbortSignal.timeout(20_000) }).catch(() => null);
    const ok = ssl.state === "issued" && Boolean(response?.ok);
    if (ok && !current.httpsConfirmedAt) {
      await update(ctx.db, projectId, { httpsConfirmedAt: new Date(), lastError: null });
      await step(ctx, actor, projectId, "golive.https_confirmed", { domain: current.domain }, `HTTPS works on https://${current.domain}.`);
    } else if (!ok) {
      await update(ctx.db, projectId, { lastError: `HTTPS isn't ready yet (the certificate is ${ssl.state ?? "not issued"}${response ? `, the site answered ${response.status}` : ", the site didn't answer"}). Netlify usually needs a few minutes after the switch; check again.` });
    }
    return ok;
  } catch (error) {
    return fail(ctx, actor, projectId, "Checking HTTPS", error);
  }
}

/* ---------- 8. GA4, recorded by hand ---------- */

export async function recordGa4(ctx: ServiceContext, actor: Viewer, projectId: string, input: { propertyId: string; measurementId: string; vmlIsEditor: boolean }): Promise<void> {
  assertCan(actor, "project.edit");
  const problem = checkGa4(input);
  if (problem) throw new GoLiveError(problem);
  if (!input.vmlIsEditor) throw new GoLiveError('Tick "VML has Editor access" once the client has added VML to their GA4 property.');
  const measurementId = input.measurementId.trim().toUpperCase();
  const [tracking] = await ctx.db.select().from(projectTracking).where(eq(projectTracking.projectId, projectId)).limit(1);
  if (tracking?.ga4 && tracking.ga4.toUpperCase() !== measurementId) throw new GoLiveError(`The Tracking card has ${tracking.ga4}; the site loads that one. Use the same measurement ID in both.`);
  if (!tracking?.ga4) throw new GoLiveError("Add the measurement ID on the Tracking card too, so the site loads it, then rebuild.");
  await row(ctx.db, projectId);
  await update(ctx.db, projectId, { ga4PropertyId: input.propertyId.trim(), ga4MeasurementId: measurementId, ga4EditorConfirmedBy: actor.id, ga4RecordedAt: new Date() });
  await step(ctx, actor, projectId, "golive.ga4_recorded", { propertyId: input.propertyId.trim(), measurementId }, `GA4 recorded (property ${input.propertyId.trim()}, VML as Editor).`);
}

/* ---------- 9. go live, and roll back ---------- */

let waitFor: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export function setGoLiveWaitForTesting(wait: ((ms: number) => Promise<void>) | null): void {
  waitFor = wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

async function waitForDeploy(deployId: string): Promise<string | null> {
  for (let i = 0; i < 60; i += 1) {
    const status = await netlify<{ state: string; ssl_url?: string; error_message?: string }>("GET", `/deploys/${deployId}`);
    if (status.state === "ready") return status.ssl_url ?? null;
    if (status.state === "error") throw new GoLiveError(`Netlify couldn't publish it: ${status.error_message ?? "no reason given"}.`);
    await waitFor(3000);
  }
  throw new GoLiveError("Netlify took too long to publish the live site. Check it in Netlify, then press Go live again.");
}

export async function goLiveNow(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ url: string; version: number }> {
  assertCan(actor, "site.golive");
  const view = await loadGoLive(ctx.db, projectId);
  if (!view.gate.ready) throw new GoLiveError(`Not ready to go live: ${view.gate.blockers.join(" ")}`);
  const domain = view.row.domain!;
  const version = view.checklistVersion!;
  const [build] = await ctx.db.select().from(siteBuild).where(and(eq(siteBuild.projectId, projectId), eq(siteBuild.version, version))).limit(1);
  /*
    D4 (audit F-032): one press, one run. Two presses used to start two
    uploads. The claim is taken under a lock on this project's go-live, so a
    second press while one is publishing is told so; an upload stuck longer
    than LIVE_CLAIM_MS (a web restart mid-way) no longer holds it.
  */
  const deployRow = await claimLiveDeploy(ctx.db, projectId, build!.id, version, actor.id);
  if (!deployRow) throw new GoLiveError("Going live is already running for this site. Wait for it to finish, then look again.");
  try {
    const site = await ensureSite(ctx.db, actor, projectId);
    // The policies' effective date: the day the site first went live (kept on later deploys).
    const { zip } = await buildZip(projectId, version, { domain, effectiveDate: formatPolicyDate(view.row.wentLiveAt ?? new Date()) });
    const deploy = await netlify<{ id: string }>("POST", `/sites/${site.siteId}/deploys`, zip, "application/zip");
    await ctx.db.update(siteDeploy).set({ netlifyDeployId: deploy.id }).where(eq(siteDeploy.id, deployRow!.id));
    await waitForDeploy(deploy.id);
    const url = `https://${domain}/`;
    const recorded = await recordLive(ctx.db, projectId, deployRow.id, version, url, view.row.wentLiveAt);
    // Already recorded by the go-live screen's recovery, which logged it: nothing more to log.
    if (!recorded) return { url, version };
    const before = recorded.before;
    // The measurement ID should now be on the live home page.
    const home = await (httpsFetch ?? fetch)(url, { signal: AbortSignal.timeout(20_000) }).then((r) => r.text()).catch(() => "");
    const ga4OnPage = view.row.ga4MeasurementId ? home.includes(view.row.ga4MeasurementId) : null;
    await recordActivity(ctx.db, {
      action: "golive.went_live",
      entityType: "project",
      entityId: projectId,
      ...actorFields(actor),
      valueAfter: { url, version, ga4OnPage },
      ipAddress: ctx.ipAddress,
      userAgent: ctx.userAgent,
    });
    if (before?.status !== "live") {
      await recordActivity(ctx.db, { action: "project.status_changed", entityType: "project", entityId: projectId, ...actorFields(actor), valueBefore: { status: before?.status ?? null }, valueAfter: { status: "live", reason: `Went live at ${url}` }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    }
    notifySlack(ctx.db, projectId, { kind: "went_live", url, version });
    return { url, version };
  } catch (error) {
    await ctx.db.update(siteDeploy).set({ state: "failed", error: error instanceof Error ? error.message : "failed" }).where(eq(siteDeploy.id, deployRow.id));
    return fail(ctx, actor, projectId, "Going live", error);
  }
}

/* How long a live upload holds the go-live claim: longer than Netlify's own wait (60 checks, 3 s apart) plus the upload. */
export const LIVE_CLAIM_MS = 15 * 60_000;

/* The go-live claim (D4): the new live deploy's row, or null when another is still uploading for this project. */
export async function claimLiveDeploy(db: Db, projectId: string, buildId: string, version: number, userId: string | null): Promise<typeof siteDeploy.$inferSelect | null> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`golive:${projectId}`}))`);
    const [busy] = await tx
      .select({ id: siteDeploy.id })
      .from(siteDeploy)
      .where(and(eq(siteDeploy.projectId, projectId), eq(siteDeploy.kind, "live"), eq(siteDeploy.state, "uploading"), gt(siteDeploy.createdAt, new Date(Date.now() - LIVE_CLAIM_MS))))
      .limit(1);
    if (busy) return null;
    const [row] = await tx.insert(siteDeploy).values({ projectId, buildId, version, kind: "live", state: "uploading", startedByUserId: userId }).returning();
    return row!;
  });
}

/*
  D4 (audit F-032): the record that the site is live, all or nothing. These
  were separate writes after Netlify had published, so a web restart between
  them left the site live and TAWD saying it wasn't. Returns the project's
  status before, for the activity log; null when the deploy was already
  recorded (the go-live itself and the screen's recovery can't both record
  it, so the log says "went live" once: the batch D review).
*/
async function recordLive(
  db: Db,
  projectId: string,
  deployId: string,
  version: number,
  url: string,
  wentLiveAt: Date | null,
  readyAt: Date = new Date(),
): Promise<{ before: { status: string | null; liveAt: Date | null } | undefined } | null> {
  return db.transaction(async (txn) => {
    const tx = txn as unknown as Db;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`golive:${projectId}`}))`);
    const claimed = await tx
      .update(siteDeploy)
      .set({ state: "ready", url, readyAt })
      .where(and(eq(siteDeploy.id, deployId), eq(siteDeploy.state, "uploading")))
      .returning({ id: siteDeploy.id });
    if (claimed.length === 0) return null;
    const [before] = await tx.select({ status: project.status, liveAt: project.liveAt }).from(project).where(eq(project.id, projectId)).limit(1);
    await tx.update(project).set({ status: "live", updatedAt: new Date(), ...(before?.liveAt ? {} : { liveAt: new Date() }) }).where(eq(project.id, projectId));
    await update(tx, projectId, { liveVersion: version, liveUrl: url, wentLiveAt: wentLiveAt ?? new Date(), lastError: null });
    return { before };
  });
}

/*
  D4 (audit F-032): a go-live the web app was interrupted in. When Netlify
  had the upload (its deploy id is recorded) but TAWD never recorded the
  result, the go-live screen asks Netlify: published means the record is
  completed now; failed means the upload is marked failed. Code and one
  Netlify read, no AI.
*/
export async function settleInterruptedGoLive(db: Db, projectId: string, now = new Date()): Promise<"recovered" | "failed" | null> {
  // Only an upload older than a real go-live can take (the claim window), so a go-live still running is never taken for an interrupted one.
  const [stuck] = await db
    .select()
    .from(siteDeploy)
    .where(and(eq(siteDeploy.projectId, projectId), eq(siteDeploy.kind, "live"), eq(siteDeploy.state, "uploading"), lt(siteDeploy.createdAt, new Date(now.getTime() - LIVE_CLAIM_MS))))
    .orderBy(desc(siteDeploy.createdAt))
    .limit(1);
  if (!stuck) return null;
  const failed = async (error: string) => {
    await db.update(siteDeploy).set({ state: "failed", error }).where(and(eq(siteDeploy.id, stuck.id), eq(siteDeploy.state, "uploading")));
    return "failed" as const;
  };
  if (!stuck.netlifyDeployId) return failed("Stopped before TAWD recorded Netlify's answer (the app restarted). Press Go live again.");
  const [site] = await db.select({ siteId: netlifySite.siteId }).from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  let deploy: { state: string; error_message?: string; published_at?: string | null };
  let published: string | null = null;
  try {
    deploy = await netlify<{ state: string; error_message?: string; published_at?: string | null }>("GET", `/deploys/${stuck.netlifyDeployId}`);
    // What Netlify is actually serving: a deploy stays "ready" after another is published or restored.
    if (site?.siteId) published = (await netlify<{ published_deploy?: { id?: string } | null }>("GET", `/sites/${site.siteId}`)).published_deploy?.id ?? null;
  } catch (error) {
    // The deploy or the site is gone at Netlify (deleted): it will never finish.
    if (error instanceof NetlifyError && /404|not found/i.test(error.message)) return failed("Netlify no longer has this upload. Press Go live again.");
    throw error;
  }
  if (deploy.state === "error") return failed(`Netlify couldn't publish it: ${deploy.error_message ?? "no reason given"}.`);
  if (deploy.state !== "ready") return failed(`Netlify never finished it (it says "${deploy.state}"). Press Go live again.`);
  if (published !== stuck.netlifyDeployId) return failed("Netlify published it, but a later deploy or a roll back is what the site serves now, so this one isn't recorded as live.");
  const [row] = await db.select({ domain: goLive.domain, wentLiveAt: goLive.wentLiveAt }).from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  if (!row?.domain) return null;
  const url = `https://${row.domain}/`;
  const recorded = await recordLive(db, projectId, stuck.id, stuck.version, url, row.wentLiveAt, deploy.published_at ? new Date(deploy.published_at) : new Date());
  // Recorded meanwhile by the go-live itself: it has logged it.
  if (!recorded) return null;
  const before = recorded.before;
  await recordActivity(db, {
    action: "golive.went_live",
    entityType: "project",
    entityId: projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: { url, version: stuck.version, recovered: "the app restarted after Netlify published; recorded when the go-live screen was next opened" },
    ipAddress: null,
    userAgent: null,
  });
  if (before?.status !== "live") {
    await recordActivity(db, { action: "project.status_changed", entityType: "project", entityId: projectId, ...actorFields(SYSTEM_ACTOR), valueBefore: { status: before?.status ?? null }, valueAfter: { status: "live", reason: `Went live at ${url}` }, ipAddress: null, userAgent: null });
  }
  return "recovered";
}

type PublishedDeploy = typeof siteDeploy.$inferSelect;

/*
  What a roll back goes to: the live deploy before the one being served.
  After a roll back the one being served is that roll back's deploy, so a
  second roll back steps further back, never forward again (13 October
  2026, the whole-code review). Null when there is nothing earlier.
*/
export function rollbackTarget(deploys: PublishedDeploy[]): { current: PublishedDeploy; previous: PublishedDeploy } | null {
  const published = deploys
    .filter((d) => d.state === "ready" && d.readyAt && (d.kind === "live" || d.kind === "rollback"))
    .sort((a, b) => b.readyAt!.getTime() - a.readyAt!.getTime());
  const current = published[0];
  if (!current?.netlifyDeployId) return null;
  const lives = published.filter((d) => d.kind === "live" && d.netlifyDeployId);
  // The live deploy being served: the current one itself, or the one a roll back restored.
  const served = current.kind === "live" ? current : lives.find((d) => d.netlifyDeployId === current.netlifyDeployId);
  if (!served) return null;
  const previous = lives.find((d) => d.netlifyDeployId !== served.netlifyDeployId && d.readyAt! < served.readyAt!);
  return previous ? { current, previous } : null;
}

/* One click: the live deploy before the current one is published again (Netlify keeps every deploy). */
export async function rollBack(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<{ version: number }> {
  assertCan(actor, "site.golive");
  const view = await loadGoLive(ctx.db, projectId);
  if (!view.canRollBack) throw new GoLiveError("There is no earlier live deploy to go back to.");
  const published = await ctx.db
    .select()
    .from(siteDeploy)
    .where(and(eq(siteDeploy.projectId, projectId), inArray(siteDeploy.kind, ["live", "rollback"]), eq(siteDeploy.state, "ready")));
  const target = rollbackTarget(published);
  if (!target?.previous.netlifyDeployId) throw new GoLiveError("There is no earlier live deploy to go back to.");
  const { current, previous } = target;
  try {
    const site = await ensureSite(ctx.db, actor, projectId);
    await netlify("POST", `/sites/${site.siteId}/deploys/${previous.netlifyDeployId}/restore`);
    const url = view.row.liveUrl ?? previous.url ?? "";
    await ctx.db.insert(siteDeploy).values({ projectId, buildId: previous.buildId, version: previous.version, kind: "rollback", netlifyDeployId: previous.netlifyDeployId, url, state: "ready", readyAt: new Date(), startedByUserId: actor.id });
    await update(ctx.db, projectId, { liveVersion: previous.version, lastError: null });
    await recordActivity(ctx.db, { action: "golive.rolled_back", entityType: "project", entityId: projectId, ...actorFields(actor), valueBefore: { version: current.version }, valueAfter: { version: previous.version, url }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    notifySlack(ctx.db, projectId, { kind: "rolled_back", url, version: previous.version });
    return { version: previous.version };
  } catch (error) {
    return fail(ctx, actor, projectId, "Rolling back", error);
  }
}
