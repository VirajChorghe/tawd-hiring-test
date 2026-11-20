import { after } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { zipSync } from "fflate";

import type { Database } from "@tawd/core/db";
import { netlifySite, previewDecision, project, siteBuild, siteDeploy, wpPreview } from "@tawd/core/schema";
import { formDefinition, headersFile, robotsTxt, setEffectiveDate } from "@tawd/core/site";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import type { ServiceContext } from "@/lib/users";
import { loadHosting } from "@/lib/hosting";
import { channelSecret, postmarkSetup, relayUrls } from "@/lib/forms-relay";

/*
  Build A, 8b (26 September 2026): preview deploys on Netlify.

  One VML team account holds every client's site (Jason, 26 September
  2026); TAWD creates the site on the first deploy, switches on form
  detection, and has Netlify email every form submission to the client
  with a copy to VML. Each deploy uploads one build's files as a zip;
  Netlify keeps every deploy, so an earlier one can be restored from its
  dashboard. Before go-live every deploy is a preview: the build's
  robots.txt and _headers keep it out of search engines.

  NETLIFY_AUTH_TOKEN lives only in Coolify: sent to Netlify and nowhere
  else, never logged, never shown to an AI. Netlify's free plan; no AI.
*/

type Db = Database;

export class NetlifyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NetlifyError";
  }
}

const API = "https://api.netlify.com/api/v1";

export function netlifySetup(): { configured: boolean; missing: string[]; copyEmail: string | null } {
  const missing = ["NETLIFY_AUTH_TOKEN", "NETLIFY_FORM_COPY_EMAIL"].filter((name) => !process.env[name]?.trim());
  return { configured: !missing.includes("NETLIFY_AUTH_TOKEN"), missing, copyEmail: process.env.NETLIFY_FORM_COPY_EMAIL?.trim() || null };
}

type Fetch = typeof fetch;
let fetchOverride: Fetch | null = null;
let waitOverride: ((ms: number) => Promise<void>) | null = null;

/** Tests pass a stand-in for Netlify; nothing in the tests reaches it. */
export function setNetlifyFetchForTesting(stand: Fetch | null, wait: ((ms: number) => Promise<void>) | null = null): void {
  fetchOverride = stand;
  waitOverride = wait;
}

/** Go-live (Phase 9) uses the same client: the domain, HTTPS, the live deploy and restores. */
export async function netlify<T>(method: string, path: string, body?: unknown, contentType = "application/json"): Promise<T> {
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!token) throw new NetlifyError("Netlify isn't set up yet: an admin adds NETLIFY_AUTH_TOKEN in Coolify.");
  const response = await (fetchOverride ?? fetch)(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": contentType },
    body: body === undefined ? undefined : contentType === "application/json" ? JSON.stringify(body) : (body as BodyInit),
    signal: AbortSignal.timeout(120_000),
  });
  if (response.status === 401 || response.status === 403) {
    // Netlify says why: a bad token, or (1 October 2026) a team out of credits, which pauses every deploy.
    const said = await response
      .clone()
      .json()
      .then((j: { message?: string; error?: string }) => (j.message ?? j.error ?? "").toString())
      .catch(() => "");
    if (/credit|billing|plan|upgrade|usage|limit|paused/i.test(said)) throw new NetlifyError(`Netlify paused deploys for the VML team: ${said.slice(0, 300)} An admin upgrades the Netlify plan, or deploys resume at the next billing cycle.`);
    throw new NetlifyError(response.status === 401 ? "Netlify refused the token. Check NETLIFY_AUTH_TOKEN in Coolify." : `Netlify refused it${said ? `: ${said.slice(0, 300)}` : ""}. If the token is fine, check the VML team's plan and credits in Netlify.`);
  }
  if (response.status === 422 && path.endsWith("/sites")) throw new NetlifyError("Netlify wouldn't create the site (the name may be taken). Try again.");
  if (!response.ok) throw new NetlifyError(`Netlify answered ${response.status}.`);
  // A delete answers 204, with nothing to read.
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

function siteName(clientName: string): string {
  const base = clientName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "client";
  return `tawd-${base}-${crypto.randomUUID().slice(0, 6)}`;
}

/* F1: who Netlify emails a form message to: the Website forms addresses (else the business email), then VML's copy. */
export async function formRecipients(db: Db, viewer: Viewer, projectId: string): Promise<string[]> {
  const intake = await loadIntake(db, viewer, projectId);
  const def = intake ? formDefinition(intake.data) : null;
  const copy = netlifySetup().copyEmail;
  return [...new Set([...(def?.recipients ?? []), ...(copy && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(copy) ? [copy] : [])])];
}

/*
  F1: the recipients changed in the intake (Website forms, or the business
  email): Netlify's email hooks follow at once, so the next message goes to
  the new list. Nothing to do before the first deploy (it sets them).
*/
export async function syncFormRecipients(db: Db, viewer: Viewer, projectId: string): Promise<{ changed: boolean; emails: string[] }> {
  const [site] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  if (!site || !netlifySetup().configured) return { changed: false, emails: [] };
  /*
    F2: once Postmark is set up, Netlify sends each message to TAWD (signed
    with the project's key) and TAWD emails the client; Netlify's own email
    goes to VML's copy only, as a safety net if TAWD were ever down.
  */
  const relay = postmarkSetup().configured;
  const copy = netlifySetup().copyEmail;
  const wanted = relay ? (copy ? [copy] : []) : await formRecipients(db, viewer, projectId);
  /*
    The site's notifications as Netlify has them. If Netlify won't list them
    (it refused this on the Site check after 0.75.0), TAWD goes by what it
    saved last time instead of stopping: nothing is removed, and only what
    isn't known to be there is added.
  */
  let listedOk = true;
  const listed = await netlify<unknown>("GET", `/hooks?site_id=${encodeURIComponent(site.siteId)}`).catch((error: unknown) => {
    console.error(`Netlify hooks for ${site.siteId} couldn't be listed: ${error instanceof Error ? error.message : "unknown"}`);
    listedOk = false;
    return null;
  });
  const saved = (site.formEmails as string[] | null) ?? [];
  const hooks = (
    Array.isArray(listed)
      ? listed
      : listedOk
        ? []
        : // The relay's hook is only added on the first setting-up when TAWD can't see what's there.
          [...saved.map((email, i) => ({ id: `saved-${i}`, type: "email", event: "submission_created", data: { email } })), ...(saved.length ? [{ id: "saved-relay", type: "url", event: "submission_created", data: { url: `${relayUrls().netlify}?site=${encodeURIComponent(site.siteId)}` } }] : [])]
  ) as { id: string; type: string; event: string; data?: { email?: string; url?: string } }[];
  const relayUrl = `${relayUrls().netlify}?site=${encodeURIComponent(site.siteId)}`;
  const urlHooks = hooks.filter((hk) => hk.type === "url" && hk.event === "submission_created" && (hk.data?.url ?? "").startsWith(relayUrls().netlify));
  let relayChanged = false;
  if (relay && !urlHooks.some((hk) => hk.data?.url === relayUrl)) {
    await netlify("POST", "/hooks", { site_id: site.siteId, type: "url", event: "submission_created", data: { url: relayUrl, signature_secret: await channelSecret(db, projectId) } });
    relayChanged = true;
  }
  if (!relay && listedOk) {
    for (const hk of urlHooks) {
      await netlify("DELETE", `/hooks/${encodeURIComponent(hk.id)}`);
      relayChanged = true;
    }
  }
  const emailHooks = hooks.filter((hk) => hk.type === "email" && hk.event === "submission_created");
  const have = new Set(emailHooks.map((hk) => hk.data?.email ?? ""));
  let changed = relayChanged;
  for (const hk of emailHooks) {
    if (!wanted.includes(hk.data?.email ?? "") && listedOk) {
      await netlify("DELETE", `/hooks/${encodeURIComponent(hk.id)}`);
      changed = true;
    }
  }
  for (const email of wanted) {
    if (!have.has(email)) {
      await netlify("POST", "/hooks", { site_id: site.siteId, type: "email", event: "submission_created", data: { email } });
      changed = true;
    }
  }
  if (changed || JSON.stringify(site.formEmails) !== JSON.stringify(wanted)) await db.update(netlifySite).set({ formEmails: wanted }).where(eq(netlifySite.projectId, projectId));
  return { changed, emails: wanted };
}

/* The client's site on the VML account: made on the first deploy, with forms on and their emails set. */
export async function ensureSite(db: Db, viewer: Viewer, projectId: string) {
  const [existing] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  if (existing) return existing;
  const [row] = await db.select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new NetlifyError("That project no longer exists.");
  const account = process.env.NETLIFY_ACCOUNT_SLUG?.trim();
  const created = await netlify<{ id: string; name: string; ssl_url?: string; url?: string; admin_url?: string }>("POST", account ? `/${account}/sites` : "/sites", {
    name: siteName(row.clientName),
  });
  // Netlify only reads forms from the HTML when form detection is on.
  await netlify("PATCH", `/sites/${created.id}`, { processing_settings: { ignore_html_forms: false } });
  await db
    .insert(netlifySite)
    .values({ projectId, siteId: created.id, name: created.name, url: created.ssl_url ?? created.url ?? `https://${created.name}.netlify.app`, adminUrl: created.admin_url ?? null, formEmails: [] })
    .returning();
  // Who gets the messages (or TAWD, once Postmark is set up), as for a later change.
  await syncFormRecipients(db, viewer, projectId);
  const [saved] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  return saved!;
}

/*
  A build's files as Netlify will serve them: TAWD's own pictures and
  sources stay behind. For the live site (Phase 9) the same files, with the
  live robots.txt and _headers: search engines may index it. No rebuild.
*/
export async function buildZip(projectId: string, version: number, live: { domain: string; effectiveDate?: string } | null = null): Promise<{ zip: Uint8Array; files: number }> {
  const storage = getStorage();
  const prefix = `${projectStoragePrefix(projectId)}site/v${version}/`;
  const keys = (await storage.list(prefix)).filter((key) => !/\/(_shots|_source)\//.test(key.slice(prefix.length - 1)));
  if (keys.length === 0) throw new NetlifyError("That build's files are missing.");
  const entries: Record<string, Uint8Array> = {};
  for (const key of keys) {
    const body = await storage.get(key);
    if (body) entries[key.slice(prefix.length)] = new Uint8Array(body);
  }
  if (live) {
    entries["robots.txt"] = new TextEncoder().encode(robotsTxt("live", live.domain));
    entries["_headers"] = new TextEncoder().encode(headersFile("live"));
    // The policies take effect the day the site first goes live.
    if (live.effectiveDate) {
      for (const file of ["privacy/index.html", "cookies/index.html"]) {
        if (entries[file]) entries[file] = new TextEncoder().encode(setEffectiveDate(new TextDecoder().decode(entries[file]), live.effectiveDate));
      }
    }
  }
  return { zip: zipSync(entries, { level: 6 }), files: Object.keys(entries).length };
}

const pending = new Set<Promise<unknown>>();

/** For tests: wait for deploys started outside a request. */
export async function settleDeploys(): Promise<void> {
  await Promise.all([...pending]);
}

/* Deploys the latest finished build as a preview. Free (Netlify's free plan); no AI. */
export async function deployPreview(ctx: ServiceContext, actor: Viewer, projectId: string): Promise<string> {
  assertCan(actor, "project.edit");
  if (!netlifySetup().configured) throw new NetlifyError("Netlify isn't set up yet: an admin adds NETLIFY_AUTH_TOKEN in Coolify.");
  const [build] = await ctx.db.select().from(siteBuild).where(eq(siteBuild.projectId, projectId)).orderBy(desc(siteBuild.version)).limit(1);
  if (!build || build.status !== "done") throw new NetlifyError("Build the site first: a preview deploys the latest finished build.");
  const [running] = await ctx.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, projectId)).orderBy(desc(siteDeploy.createdAt)).limit(1);
  if (running?.state === "uploading" && Date.now() - running.createdAt.getTime() < 10 * 60_000) throw new NetlifyError("A preview is already being deployed.");
  const [row] = await ctx.db.insert(siteDeploy).values({ projectId, buildId: build.id, version: build.version, state: "uploading", startedByUserId: actor.id }).returning();
  await recordActivity(ctx.db, {
    action: "site.preview_started",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version: build.version },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  const task = () => runDeploy(ctx.db, actor, row!.id).catch((error: unknown) => console.error(`Preview deploy failed: ${error instanceof Error ? error.message : "unknown"}`));
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
  return row!.id;
}

export async function runDeploy(db: Db, viewer: Viewer, deployRowId: string): Promise<void> {
  const [row] = await db.select().from(siteDeploy).where(eq(siteDeploy.id, deployRowId)).limit(1);
  if (!row || row.state !== "uploading") return;
  try {
    const site = await ensureSite(db, viewer, row.projectId);
    const { zip } = await buildZip(row.projectId, row.version);
    /*
      A preview is always a draft, with its own link (13 October 2026, the
      whole-code review): before go-live too, since the client's domain is
      on this Netlify site before Go live is pressed, and a production
      deploy would show the unfinished site there. Only Go live publishes.
    */
    const deploy = await netlify<{ id: string; state: string; deploy_ssl_url?: string; ssl_url?: string }>("POST", `/sites/${site.siteId}/deploys?draft=true`, zip, "application/zip");
    await db.update(siteDeploy).set({ netlifyDeployId: deploy.id }).where(eq(siteDeploy.id, row.id));
    let state = deploy.state;
    // The draft's own address only: ssl_url is the site's main address, which shows nothing before go-live.
    let url = deploy.deploy_ssl_url ?? null;
    const wait = waitOverride ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (let i = 0; i < 60 && state !== "ready" && state !== "error"; i += 1) {
      await wait(3000);
      const status = await netlify<{ state: string; deploy_ssl_url?: string; error_message?: string }>("GET", `/deploys/${deploy.id}`);
      state = status.state;
      url = status.deploy_ssl_url ?? url;
      if (state === "error") throw new NetlifyError(`Netlify couldn't publish it: ${status.error_message ?? "no reason given"}.`);
    }
    if (state !== "ready") throw new NetlifyError("Netlify took too long to publish the preview. Check it in Netlify, or deploy again.");
    if (!url) throw new NetlifyError("Netlify published the preview but didn't give its own address. Deploy again.");
    const accessWarning = await previewAccessWarning(url);
    await db.update(siteDeploy).set({ state: "ready", url, readyAt: new Date(), accessWarning }).where(eq(siteDeploy.id, row.id));
    await recordActivity(db, {
      action: "site.preview_deployed",
      entityType: "project",
      entityId: row.projectId,
      ...actorFields(viewer),
      valueAfter: { version: row.version, url, site: site.url },
    });
  } catch (error) {
    const reason = error instanceof NetlifyError ? error.message : "The deploy stopped unexpectedly. Try again.";
    if (!(error instanceof NetlifyError)) console.error("Preview deploy:", error instanceof Error ? error.message : error);
    await db.update(siteDeploy).set({ state: "failed", error: reason }).where(eq(siteDeploy.id, row.id));
  }
}

/*
  Netlify can keep a site private (team login only) whatever TAWD asks: its
  "project visibility" has no API (29 September 2026). So each preview is
  opened as a signed-out visitor once it is ready; if Netlify refuses, the
  preview says so and names the setting to change. Can't tell (no answer):
  no warning.
*/
export const PRIVATE_PREVIEW_WARNING =
  "Netlify is keeping this preview private: anyone not signed in to VML's Netlify team is refused. In Netlify, open this site's Project configuration > General > Visitor access > Project visibility and set production and previews to Public (and keep Team settings > General > Visitor access > Default project visibility on Public for new projects), then deploy again. Previews stay out of search engines either way.";

let probeOverride: Fetch | null = null;

export function setPreviewProbeForTesting(stand: Fetch | null): void {
  probeOverride = stand;
}

export async function previewAccessWarning(url: string | null): Promise<string | null> {
  if (!url) return null;
  // With Netlify stood in (tests), only a stand-in visitor opens the link: nothing goes out.
  if (fetchOverride && !probeOverride) return null;
  try {
    const response = await (probeOverride ?? fetch)(url, { redirect: "manual", signal: AbortSignal.timeout(15_000) });
    return response.status === 401 || response.status === 403 ? PRIVATE_PREVIEW_WARNING : null;
  } catch {
    return null;
  }
}

export const PREVIEW_CHANNELS = ["phone call", "email", "meeting"] as const;

/* The client's decision on a preview link, recorded like the mockup decision. */
export async function recordPreviewDecision(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  input: { outcome: "approved" | "changes_requested"; channel: string; clientSaid: string },
): Promise<void> {
  assertCan(actor, "project.edit");
  if (!(PREVIEW_CHANNELS as readonly string[]).includes(input.channel)) throw new NetlifyError("Choose how the client's answer came in.");
  const said = input.clientSaid.trim();
  if (said.length < 3) throw new NetlifyError("Write down what the client said.");
  // On WordPress the client decides on the WordPress preview (8 October 2026); otherwise on the Netlify one.
  const hosting = await loadHosting(ctx.db, projectId);
  let seen: { deployId: string | null; wpVersion: number | null; version: number | null; url: string | null };
  if (hosting?.hosting === "wordpress") {
    const [wp] = await ctx.db.select().from(wpPreview).where(eq(wpPreview.projectId, projectId)).limit(1);
    if (!wp || wp.state !== "ready" || wp.deployedVersion == null) throw new NetlifyError("Deploy the WordPress preview first: the client decides on what they can open.");
    seen = { deployId: null, wpVersion: wp.deployedVersion, version: wp.deployedVersion, url: wp.host ? `https://${wp.host}` : null };
  } else {
    const [deploy] = await ctx.db.select().from(siteDeploy).where(eq(siteDeploy.projectId, projectId)).orderBy(desc(siteDeploy.createdAt)).limit(1);
    if (!deploy || deploy.state !== "ready") throw new NetlifyError("There is no preview link to decide on yet.");
    seen = { deployId: deploy.id, wpVersion: null, version: deploy.version, url: deploy.url };
  }
  await ctx.db.insert(previewDecision).values({ projectId, deployId: seen.deployId, wpVersion: seen.wpVersion, outcome: input.outcome, channel: input.channel, clientSaid: said.slice(0, 4000), recordedByUserId: actor.id });
  await recordActivity(ctx.db, {
    action: "site.preview_decision",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { outcome: input.outcome, channel: input.channel, clientSaid: said.slice(0, 1000), version: seen.version, url: seen.url, ...(seen.wpVersion != null ? { wordpress: true } : {}) },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  /*
    Lane 2 builds from the design on Mockups, so the client approving the
    preview is its sign-off: the project moves on to Build (Jason, 29
    September 2026), logged like any change of status.
  */
  if (input.outcome === "approved") {
    const [row] = await ctx.db.select({ lane: project.lane, status: project.status }).from(project).where(eq(project.id, projectId)).limit(1);
    if (row?.lane === "lane_2" && (row.status === "mockups" || row.status === "content")) {
      await ctx.db.update(project).set({ status: "build", updatedAt: new Date() }).where(eq(project.id, projectId));
      await recordActivity(ctx.db, {
        action: "project.status_changed",
        entityType: "project",
        entityId: projectId,
        ...actorFields(actor),
        valueBefore: { status: row.status },
        valueAfter: { status: "build", reason: "The client approved the preview" },
        ipAddress: ctx.ipAddress,
        userAgent: ctx.userAgent,
      });
    }
  }
}

export async function loadPreviews(db: Db, projectId: string) {
  const [site] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  // Previews only: live deploys and rollbacks show on the Go live card.
  const deploys = await db.select().from(siteDeploy).where(and(eq(siteDeploy.projectId, projectId), eq(siteDeploy.kind, "preview"))).orderBy(desc(siteDeploy.createdAt));
  const [decision] = await db.select().from(previewDecision).where(eq(previewDecision.projectId, projectId)).orderBy(desc(previewDecision.createdAt)).limit(1);
  return { setup: netlifySetup(), site: site ?? null, deploys, decision: decision ?? null };
}

/*
  Deleting a project deletes its Netlify site too (Jason, 26 September
  2026); live projects can't be deleted at all. Already gone at Netlify
  counts as done. Returns the site's address, for the log, or null.
*/
export async function deleteNetlifySite(db: Db, projectId: string): Promise<string | null> {
  const [site] = await db.select().from(netlifySite).where(eq(netlifySite.projectId, projectId)).limit(1);
  if (!site) return null;
  const token = process.env.NETLIFY_AUTH_TOKEN?.trim();
  if (!token) throw new NetlifyError(`This project has a Netlify site (${site.url}). Add NETLIFY_AUTH_TOKEN in Coolify so TAWD can delete it too, then delete the project.`);
  const response = await (fetchOverride ?? fetch)(`${API}/sites/${site.siteId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok && response.status !== 404) {
    throw new NetlifyError(
      response.status === 401 || response.status === 403
        ? "Netlify refused the token, so the site couldn't be deleted. Check NETLIFY_AUTH_TOKEN in Coolify."
        : `Netlify couldn't delete the site (it answered ${response.status}). Nothing was deleted; try again.`,
    );
  }
  return site.url;
}
