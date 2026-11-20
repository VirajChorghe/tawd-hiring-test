import { createHash, randomBytes } from "node:crypto";
import { claimScheduledRun } from "@tawd/core/scheduled-run";
import { eq } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { goLive, netlifySite, project, wpPreview } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { SYSTEM_ACTOR, assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import {
  PATH_LABELS,
  advisePath,
  changesFor,
  dnsHostFrom,
  emailProviderFrom,
  fetchDoh,
  guideFor,
  instructionsText,
  siteRecords,
  snapshotDomain,
  type Change,
  type ConnectPath,
  type DnsHost,
  type DohGet,
  type DomainSnapshot,
  type EmailProvider,
  type Hosting,
  type PathAdvice,
  type WantedRecord,
} from "@tawd/core/site";
import { notifySlack } from "@/lib/slack-notify";
import { GoLiveError } from "@/lib/golive";
/* What these steps use of a request: the database and who asked (no login needed for the client page or the timer). */
type ServiceContext = { db: Database; ipAddress: string | null; userAgent: string | null };

/*
  F3, Connect the domain (1 October 2026; Jason: "the most valuable and
  required setup"). TAWD looks the domain up itself (who runs its DNS and
  its email, what it points at, what's in the way), recommends the path,
  writes the client's steps for their own DNS provider, gives them a
  private no-login page, and checks the records on two public resolvers
  until they're right. Free, no AI. The nameserver flow (golive.ts) stays
  for domains VML manages.
*/

type Db = Database;

let doh: DohGet = fetchDoh;
/** Tests answer the DNS questions themselves. */
export function setConnectDnsForTesting(stand: DohGet | null): void {
  doh = stand ?? fetchDoh;
}

export interface ConnectFound {
  snapshot: DomainSnapshot;
  host: DnsHost | null;
  email: EmailProvider | null;
  advice: PathAdvice;
  at: string;
}

export interface ConnectCheck {
  ok: boolean;
  changes: Change[];
  resolvers: { id: string; ok: boolean }[];
  at: string;
  by: "pm" | "client" | "auto";
}

async function goLiveRow(db: Db, projectId: string) {
  const [row] = await db.select().from(goLive).where(eq(goLive.projectId, projectId)).limit(1);
  return row ?? null;
}

/* What the site's records point at: the Netlify site, or (WordPress on 20i) the package's current IPv4. */
async function siteFacts(db: Db, projectId: string): Promise<{ hosting: Hosting; netlifySiteName: string | null; wordpressIp: string | null; clientName: string }> {
  const [proj] = await db.select({ hosting: project.hosting, clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  const hosting: Hosting = proj?.hosting === "wordpress" ? "wordpress" : "netlify";
  const [site] = hosting === "netlify" ? await db.select({ name: netlifySite.name }).from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1) : [];
  const [wp] = hosting === "wordpress" ? await db.select({ ip: wpPreview.packageIpv4 }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1) : [];
  return { hosting, netlifySiteName: site?.name ?? null, wordpressIp: wp?.ip ?? null, clientName: proj?.clientName ?? "" };
}

const recordsFor = (facts: Awaited<ReturnType<typeof siteFacts>>, domain: string) => siteRecords(facts.hosting, domain, facts.netlifySiteName, facts.wordpressIp);

async function log(ctx: ServiceContext, actor: Viewer, projectId: string, action: Parameters<typeof recordActivity>[1]["action"], valueAfter: Record<string, unknown>, slack?: string) {
  await recordActivity(ctx.db, { action, entityType: "project", entityId: projectId, ...actorFields(actor), valueAfter, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
  if (slack) notifySlack(ctx.db, projectId, { kind: "golive_step", step: slack });
}

/* ---------- 1. what TAWD finds ---------- */

export async function detectDomain(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<ConnectFound> {
  assertCan(actor, "project.edit");
  const row = await goLiveRow(ctx.db, projectId);
  if (!row?.domain || !row.domainConfirmedAt) throw new GoLiveError("Confirm the domain first.");
  const views = await snapshotDomain(row.domain, doh);
  if (views.length === 0) throw new GoLiveError(`Public DNS didn't answer about ${row.domain}. Check the spelling, or try again in a minute.`);
  const snapshot = views[0]!.snapshot;
  const intake = await loadIntake(ctx.db, SYSTEM_ACTOR, projectId);
  // 20i (5 October 2026): a WordPress site works on any path, VML's Cloudflare included (its certificate doesn't need the host's nameservers).
  const advice = advisePath({ snapshot, vmlNameservers: (row.nameservers as string[] | null) ?? [], vmlBought: intake?.data.website.domainStatus === "vml_buys" });
  const found: ConnectFound = { snapshot, host: dnsHostFrom(snapshot.nameservers), email: emailProviderFrom(row.domain, snapshot.mx), advice, at: new Date().toISOString() };
  await ctx.db
    .update(goLive)
    .set({ connectFound: found, ...(row.connectPath ? {} : { connectPath: advice.path }), updatedAt: new Date() })
    .where(eq(goLive.projectId, projectId));
  await log(ctx, actor, projectId, "golive.domain_detected", { dns: found.host?.name ?? null, email: found.email?.name ?? null, advice: advice.path });
  return found;
}

/* ---------- 2. the path ---------- */

export async function choosePath(ctx: ServiceContext, actor: Viewer, projectId: string, path: ConnectPath): Promise<void> {
  assertCan(actor, "project.edit");
  if (!(path in PATH_LABELS)) throw new GoLiveError("Choose how the domain is connected.");
  const row = await goLiveRow(ctx.db, projectId);
  if (!row?.domainConfirmedAt) throw new GoLiveError("Confirm the domain first.");
  if (row.wentLiveAt) throw new GoLiveError("The site is live: the way the domain is connected can't change here.");
  if (row.connectPath === path) return;
  await ctx.db.update(goLive).set({ connectPath: path, recordsOkAt: null, connectCheck: null, updatedAt: new Date() }).where(eq(goLive.projectId, projectId));
  await log(ctx, actor, projectId, "golive.path_chosen", { from: row.connectPath, to: path });
}

/* ---------- 3. what to change, and the check ---------- */

export async function wantedRecords(db: Db, projectId: string, domain: string): Promise<WantedRecord[]> {
  return recordsFor(await siteFacts(db, projectId), domain);
}

/*
  Asks both resolvers; right when neither shows anything left to change.
  Run by the PM, by the client's "I've done it", and every 15 minutes by
  the worker while the client is on it.
*/
export async function checkRecords(ctx: ServiceContext, actor: Viewer, projectId: string, by: ConnectCheck["by"] = "pm"): Promise<ConnectCheck> {
  if (by === "pm") assertCan(actor, "project.edit");
  const row = await goLiveRow(ctx.db, projectId);
  if (!row?.domain || !row.domainConfirmedAt) throw new GoLiveError("Confirm the domain first.");
  const facts = await siteFacts(ctx.db, projectId);
  const wanted = recordsFor(facts, row.domain);
  const views = await snapshotDomain(row.domain, doh);
  if (views.length === 0) throw new GoLiveError(`Public DNS didn't answer about ${row.domain}. Try again in a minute.`);
  const per = views.map((v) => ({ id: v.resolver, changes: changesFor(v.snapshot, wanted, facts.hosting) }));
  const ok = per.every((p) => p.changes.length === 0);
  const check: ConnectCheck = { ok, changes: per.find((p) => p.changes.length)?.changes ?? [], resolvers: per.map((p) => ({ id: p.id, ok: p.changes.length === 0 })), at: new Date().toISOString(), by };
  const firstTime = ok && !row.recordsOkAt;
  await ctx.db
    .update(goLive)
    .set({ connectCheck: check, ...(firstTime ? { recordsOkAt: new Date() } : {}), ...(ok ? {} : { recordsOkAt: null }), updatedAt: new Date() })
    .where(eq(goLive.projectId, projectId));
  if (firstTime) {
    await log(ctx, actor, projectId, "golive.records_ok", { domain: row.domain, by }, `${row.domain} now points at the new site (checked on two public resolvers).`);
    // WordPress on 20i: TAWD's own certificate is free, so it's asked for at once (Fable's review, finding 1); the other ways wait for a person.
    if (facts.hosting === "wordpress") await autoCertificate(ctx, projectId);
  }
  return check;
}

/* The records first point at a WordPress site: its Let's Encrypt certificate is queued, once the domain is on the package. Never throws. */
async function autoCertificate(ctx: ServiceContext, projectId: string): Promise<void> {
  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the server log only; nothing is shown to a person
  try {
    const { certPathOf } = await import("@/lib/twentyi");
    if ((await certPathOf(ctx.db)) !== "letsencrypt") return;
    const [wp] = await ctx.db.select({ onHost: wpPreview.domainOnHostAt, certs: wpPreview.certs }).from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
    const live = (wp?.certs as { live?: { state?: string } } | null)?.live;
    if (!wp?.onHost || live?.state === "ok" || live?.state === "installing" || live?.state === "requested") return;
    const { requestWpCertificate } = await import("@/lib/wp-golive");
    await requestWpCertificate(ctx, SYSTEM_ACTOR, projectId, "auto");
  } catch (error) {
    console.error(`Certificate for ${projectId}: ${error instanceof Error ? error.message : "not queued"}`);
  }
}

/* ---------- 4. the client's private page ---------- */

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

/* A new link (the old one stops working). Shown once to the PM; only its hash is kept. */
export async function makeClientLink(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  const row = await goLiveRow(ctx.db, projectId);
  if (!row?.domainConfirmedAt || !row.connectFound) throw new GoLiveError("Confirm the domain and let TAWD look it up first.");
  if (row.connectPath === "vml_dns") throw new GoLiveError("VML runs this domain's DNS: there's nothing for the client to change.");
  const token = randomBytes(24).toString("base64url");
  await ctx.db.update(goLive).set({ clientLinkHash: hashToken(token), clientLinkAt: new Date(), clientLinkBy: actor.id, updatedAt: new Date() }).where(eq(goLive.projectId, projectId));
  await log(ctx, actor, projectId, "golive.client_link_made", { domain: row.domain });
  // TAWD's own address (BETTER_AUTH_URL, set in Coolify).
  return `${(process.env.BETTER_AUTH_URL?.trim() || "https://tawd.velocitymedialab.com").replace(/\/$/, "")}/connect/${token}`;
}

export interface ClientPage {
  projectId: string;
  clientName: string;
  domain: string;
  host: DnsHost | null;
  emailProvider: string | null;
  path: ConnectPath;
  wanted: WantedRecord[];
  check: ConnectCheck | null;
  changes: Change[];
  guide: ReturnType<typeof guideFor>;
  instructions: string;
  doneAt: Date | null;
  live: boolean;
}

/* What the client sees; null for a link that isn't (or is no longer) good. */
export async function loadClientPage(db: Db, token: string): Promise<ClientPage | null> {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
  const [row] = await db.select().from(goLive).where(eq(goLive.clientLinkHash, hashToken(token))).limit(1);
  if (!row?.domain || !row.connectFound) return null;
  // Thirty days after the site goes live the link has done its job.
  if (row.wentLiveAt && row.wentLiveAt.getTime() < Date.now() - 30 * 86_400_000) return null;
  const facts = await siteFacts(db, row.projectId);
  const found = row.connectFound as ConnectFound;
  const wanted = recordsFor(facts, row.domain);
  const check = (row.connectCheck as ConnectCheck | null) ?? null;
  const changes = check ? check.changes : changesFor(found.snapshot, wanted, facts.hosting);
  return {
    projectId: row.projectId,
    clientName: facts.clientName,
    domain: row.domain,
    host: found.host,
    emailProvider: found.email?.name ?? null,
    path: (row.connectPath as ConnectPath | null) ?? found.advice.path,
    wanted,
    check,
    changes: check?.ok ? [] : changes,
    guide: guideFor(found.host),
    instructions: instructionsText({ domain: row.domain, clientName: facts.clientName, host: found.host, changes, emailProvider: found.email?.name ?? null }),
    doneAt: row.clientDoneAt,
    live: Boolean(row.wentLiveAt),
  };
}

/* The client's "I've done it": checked at once (at most once a minute), and the PM hears about it. */
export async function clientSaysDone(ctx: ServiceContext, token: string): Promise<ConnectCheck | null> {
  const page = await loadClientPage(ctx.db, token);
  if (!page) return null;
  const row = (await goLiveRow(ctx.db, page.projectId))!;
  const recent = row.connectCheck && Date.now() - new Date((row.connectCheck as ConnectCheck).at).getTime() < 60_000;
  await ctx.db.update(goLive).set({ clientDoneAt: new Date(), updatedAt: new Date() }).where(eq(goLive.projectId, page.projectId));
  if (!row.clientDoneAt) {
    await recordActivity(ctx.db, { action: "golive.client_said_done", entityType: "project", entityId: page.projectId, ...actorFields(SYSTEM_ACTOR), valueAfter: { domain: page.domain }, ipAddress: ctx.ipAddress, userAgent: ctx.userAgent });
    notifySlack(ctx.db, page.projectId, { kind: "golive_step", step: `the client says the records for ${page.domain} are changed; TAWD is checking.` });
  }
  if (recent) return row.connectCheck as ConnectCheck;
  return checkRecords(ctx, SYSTEM_ACTOR, page.projectId, "client");
}

/* ---------- the view for the Go live card ---------- */

export interface ConnectView {
  domain: string | null;
  path: ConnectPath | null;
  found: ConnectFound | null;
  check: ConnectCheck | null;
  wanted: WantedRecord[];
  changes: Change[];
  recordsOkAt: Date | null;
  clientLinkAt: Date | null;
  clientDoneAt: Date | null;
  instructions: string | null;
  guide: ReturnType<typeof guideFor> | null;
}

export async function loadConnect(db: Db, projectId: string): Promise<ConnectView> {
  const row = await goLiveRow(db, projectId);
  const found = (row?.connectFound as ConnectFound | null) ?? null;
  const facts = await siteFacts(db, projectId);
  const wanted = row?.domain ? recordsFor(facts, row.domain) : [];
  const check = (row?.connectCheck as ConnectCheck | null) ?? null;
  const changes = check ? check.changes : found && row?.domain ? changesFor(found.snapshot, wanted, facts.hosting) : [];
  return {
    domain: row?.domain ?? null,
    path: (row?.connectPath as ConnectPath | null) ?? null,
    found,
    check,
    wanted,
    changes,
    recordsOkAt: row?.recordsOkAt ?? null,
    clientLinkAt: row?.clientLinkAt ?? null,
    clientDoneAt: row?.clientDoneAt ?? null,
    instructions: found && row?.domain ? instructionsText({ domain: row.domain, clientName: facts.clientName, host: found.host, changes, emailProvider: found.email?.name ?? null }) : null,
    guide: found ? guideFor(found.host) : null,
  };
}

/* The worker's sweep: every domain the client is working on, until its records are right (no more than a day after they said done). */
export async function pendingChecks(db: Db): Promise<string[]> {
  const rows = await db.select({ projectId: goLive.projectId, path: goLive.connectPath, ok: goLive.recordsOkAt, linkAt: goLive.clientLinkAt, doneAt: goLive.clientDoneAt, live: goLive.wentLiveAt }).from(goLive);
  const now = Date.now();
  return rows
    .filter((r) => (r.path === "records" || r.path === "access") && !r.ok && !r.live && r.linkAt && now - (r.doneAt ?? r.linkAt).getTime() < (r.doneAt ? 1 : 14) * 86_400_000)
    .map((r) => r.projectId);
}

/* Started with the web server (instrumentation.ts): every 15 minutes, the domains clients are working on. */
export const CONNECT_TICK_MS = 15 * 60_000;

export async function connectTick(db: Db): Promise<number> {
  const ids = await pendingChecks(db);
  for (const id of ids) {
    await checkRecords({ db, ipAddress: null, userAgent: null }, SYSTEM_ACTOR, id, "auto").catch((error: unknown) => console.error(`Connect check ${id}: ${error instanceof Error ? error.message : "unknown"}`));
  }
  return ids.length;
}

export function scheduleConnectChecks(db: Db): void {
  // D5: one run per interval across every web server and restart (scheduled-run.ts).
  const tick = async () => {
    if (await claimScheduledRun(db as never, "connect-checks", CONNECT_TICK_MS * 0.9)) await connectTick(db);
  };
  const timer = setInterval(() => void tick().catch(() => undefined), CONNECT_TICK_MS);
  timer.unref();
}
