import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getDb, type Database } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { PACKAGE_LIMIT, TWENTYI_PLAN } from "@tawd/core/wp-preview";
import { CertPathCard, ServerKeysCard, TwentyiCheckCard, TwentyiKeyCard } from "@/components/admin/twentyi-cards";
import { E2eCheckCard } from "@/components/admin/e2e-check-card";
import { TeamSlackCard } from "@/components/admin/team-slack-card";
import { loadTeamSlack } from "@/lib/team-slack";
import { loadDelivery } from "@/lib/delivery-checks";
import { DeliveryCard } from "@/components/admin/delivery-card";
import { loadTwentyi } from "@/lib/twentyi";
import { loadE2eCheck } from "@/lib/e2e-check";
import { formatWhen } from "@/lib/labels";
import { requireUser } from "@/lib/session";
import { listPeopleNames } from "@/lib/users";

export const metadata: Metadata = { title: "System - TAWD" };
export const dynamic = "force-dynamic";

/*
  System (29 September 2026): the checks and connections TAWD runs on, in
  one admin page instead of two top-bar links. The Site check (29
  September 2026: build, preview and share link on this server, for $0)
  and the hosting connections (Build B on 20i since 5 October 2026: TAWD's
  20i key, the account check, the package type, HTTPS, server keys and the
  daily work).
*/
export default async function SystemPage() {
  const current = await requireUser();
  if (!can(current, "settings.manage")) redirect("/projects");
  const db = getDb();
  return (
    <div className="page">
      <div className="page-head spend-head">
        <div>
          <h1 className="page-title">System</h1>
          <p className="page-lede">The checks and connections TAWD runs on. Nobody needs these day to day. Admins only.</p>
        </div>
      </div>
      <div className="stack">
        {await SiteCheckSection({ db })}
        {await HostingSection({ db })}
        {await DeliverySection({ db })}
      </div>
    </div>
  );
}

async function SiteCheckSection({ db }: { db: Database }) {
  const check = await loadE2eCheck(db);
  const people = await listPeopleNames(db);
  // No person: TAWD started it after a deploy.
  const who = check?.startedByUserId ? ` by ${people.get(check.startedByUserId) ?? "a team member"}` : check ? " by TAWD after a deploy" : "";
  const doneLine = check?.finishedAt ? `Run ${formatWhen(check.createdAt)}${who}, finished ${formatWhen(check.finishedAt)}.` : null;
  const slack = await loadTeamSlack(db);
  return (
    <section id="site-check" className="system-section">
      <h2 className="section-title">Site check</h2>
      <p className="hint">
        Checks the whole path from a design to a shared preview link on this server, with no AI and no spend: a test project, a small build, a Netlify
        preview, and every page and stage link opened as a visitor. The test project stays until the next check.
      </p>
      <p className="hint">
        <strong>It runs by itself after each deploy</strong>, once the worker is on the new version. Only a failure is announced: a red strip for
        admins, an email to each admin, and a post to the team Slack channel below. Switched off with <code>TAWD_AUTO_SITE_CHECK=off</code> on the web
        service in Coolify.
      </p>
      <E2eCheckCard status={check?.status ?? null} steps={check?.steps ?? []} previewUrl={check?.previewUrl ?? null} projectId={check?.projectId ?? null} doneLine={doneLine} />
      <TeamSlackCard {...slack} />
    </section>
  );
}

/* F4 (1 October 2026): proving form messages keep arriving. */
async function DeliverySection({ db }: { db: Database }) {
  const d = await loadDelivery(db);
  const when = (at: Date | null) => (at ? formatWhen(at) : null);
  return (
    <section id="delivery" className="system-section">
      <h2 className="section-title">Email delivery</h2>
      <p className="hint">Whether the clients&rsquo; form messages reach their inboxes: a monthly test at each common email provider, and a weekly test of each live site&rsquo;s form.</p>
      {d.configured ? null : <p className="hint-amber">Postmark isn&rsquo;t set up yet (POSTMARK_SERVER_TOKEN and FORMS_FROM_EMAIL on the web app).</p>}
      <DeliveryCard
        configured={d.configured}
        inboxesText={d.inboxes.map((i) => `${i.address}, ${i.provider}`).join("\n")}
        inboxes={d.inboxes.map((i) => ({ address: i.address, provider: i.provider, status: i.status, line: i.detail ?? (i.at ? when(i.at) : null) }))}
        lastRunLine={d.lastRun ? `Last sent ${formatWhen(d.lastRun)}.` : null}
        sites={d.sites.map((s) => ({ projectId: s.projectId, clientName: s.clientName, domain: s.domain, status: s.status, line: s.detail ?? (s.at ? `Checked ${formatWhen(s.at)}` : null) }))}
      />
    </section>
  );
}

async function HostingSection({ db }: { db: Database }) {
  const people = await listPeopleNames(db);
  const t = await loadTwentyi(db);
  const who = (id: string | null) => (id ? ` by ${people.get(id) ?? "a team member"}` : "");
  const results = t.check?.results ?? null;
  const doneLine =
    t.check?.status === "done" && results && t.check.finishedAt
      ? `Checked ${formatWhen(t.check.finishedAt)}${who(t.check.startedBy)}. ${results.keyWorks ? `20i answers; ${results.packages ?? "?"} of ${PACKAGE_LIMIT} packages used.` : "20i didn't accept TAWD's key: see below."}`
      : null;
  const daily = t.daily;
  const dailyLine = daily.finishedAt
    ? `IP watch and renewals last ran ${formatWhen(new Date(daily.finishedAt))}: ${daily.summary?.sites ?? 0} site(s)${daily.summary?.ipChanged?.length ? `, ${daily.summary.ipChanged.length} IP change(s)` : ""}${daily.summary?.renewed?.length ? `, ${daily.summary.renewed.length} certificate(s) renewed` : ""}${daily.summary?.problems?.length ? `, problems: ${daily.summary.problems.join("; ")}` : ""}.`
    : "IP watch and renewals haven't run yet (the web server queues them once an hour when due).";

  return (
    <section id="hosting" className="system-section">
      <h2 className="section-title">Hosting connections</h2>
      <h3 className="card-title">20i (WordPress, Build B)</h3>
      <p className="hint">
        Each WordPress site gets its own 20i hosting package on VML&rsquo;s reseller account ({TWENTYI_PLAN.name}: up to {PACKAGE_LIMIT} sites), made by TAWD through 20i&rsquo;s API. TAWD signs in over SSH with its own key. Set up once; only needed again if something changes.
      </p>

      <TwentyiKeyCard publicKey={t.key?.publicKey ?? null} fingerprint={t.key?.fingerprint ?? null} madeLine={t.key ? `Made ${formatWhen(t.key.createdAt)}${who(t.key.createdBy)}.` : null} />

      <div className="card content-card">
        <h2 className="card-title">Worker settings</h2>
        <p className="hint">Set in Coolify on the worker (tawd-worker-new), then redeploy the worker. The worker reports which are set every five minutes; values are never shown. TWENTYI_API_KEY is on the worker only: the web app never holds it.</p>
        {t.workerSettings ? (
          <ul className="host-settings">
            {[
              { name: "TWENTYI_API_KEY", set: !t.workerSettings.missing.includes("TWENTYI_API_KEY"), need: true, what: "20i's General API key (My20i, Reseller API)" },
              { name: "WP_PREVIEW_DOMAIN", set: t.workerSettings.previewDomain, need: Boolean(t.previewDomain), what: "the VML preview domain (also on tawd-web-new); blank: 20i's staging address" },
              { name: "CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID", set: t.workerSettings.cloudflare, need: Boolean(t.previewDomain), what: "the client-zones account, for preview records and the IP watch's fix" },
            ].map((s) => (
              <li key={s.name}>
                <span className={s.set ? "badge badge-done" : s.need ? "badge badge-warning" : "badge badge-info"}>{s.set ? "Set" : s.need ? "Missing" : "Blank"}</span>
                <span>
                  <code>{s.name}</code> <span className="hint">{s.what}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="hint-amber">The worker hasn&rsquo;t reported yet.</p>
        )}
      </div>

      <TwentyiCheckCard
        keySet={t.workerSettings ? !t.workerSettings.missing.includes("TWENTYI_API_KEY") : null}
        state={t.check?.status ?? null}
        doneLine={doneLine}
        failure={t.check?.failureReason ?? null}
        items={results?.items ?? []}
        types={results?.types ?? []}
        chosen={t.packageType ? { id: t.packageType.id, label: t.packageType.label } : null}
        chosenLine={t.packageType ? `TAWD makes sites with "${t.packageType.label}"${t.packageType.chosenAt ? `, chosen ${formatWhen(new Date(t.packageType.chosenAt))}` : ""}.` : "No package type chosen yet: deploys wait for it."}
      />

      <CertPathCard path={t.certPath} paths={t.certPaths} previewDomain={t.previewDomain} acmeStaging={Boolean(t.workerSettings?.acmeStaging)} />

      <ServerKeysCard keys={t.serverKeys.map((k) => ({ ...k, line: `${k.host}: ${k.fingerprint}, remembered ${k.firstSeenAt ? formatWhen(new Date(k.firstSeenAt)) : "at the first sign-in"}. Every later sign-in must match it.` }))} />

      <div className="card content-card">
        <h2 className="card-title">IP watch and certificate renewals</h2>
        <p className={daily.late ? "hint-amber" : "hint"}>{dailyLine}{daily.unfinished ? ` The last run, started ${formatWhen(new Date(daily.startedAt!))}, didn't finish: check the worker is running (the next one starts within an hour).` : daily.late && daily.finishedAt ? " That's more than two days ago: check the worker is running." : ""}</p>
        <p className="hint">Once a day the worker compares each live site&rsquo;s domain with 20i&rsquo;s current IP (fixing it where VML runs the DNS, telling the PM otherwise), renews TAWD&rsquo;s own certificates with a third of their life left, and warns 14 and 7 days before any certificate runs out.</p>
      </div>
    </section>
  );
}
