import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EditsCard } from "@/components/build/edits-card";
import { NextStepBar } from "@/components/project/next-step-bar";
import { ProjectHeading } from "@/components/project/heading";
import { InvoiceCard } from "@/components/updates/invoice-card";
import { QuotesCard } from "@/components/updates/quotes-card";
import { getDb } from "@tawd/core/db";
import { formatCost } from "@tawd/core/mockups";
import { can } from "@tawd/core/permissions";
import { UPDATE_CATEGORIES, categoryLabel, formatMinutes, hoursFrom } from "@tawd/core/site";
import { loadEdits } from "@/lib/edits";
import { loadJourneyFacts } from "@/lib/journey";
import { projectChips } from "@/lib/labels";
import { loadNextStepFor } from "@/lib/next-step";
import { getProject } from "@/lib/projects";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";
import { pacificToday } from "@/lib/spend-report";
import { ANSWER_CHANNELS, builtPages, draftInvoiceLines, invoiceMonths, loadInvoice, loadQuotes, monthPlan } from "@/lib/updates";

export const metadata: Metadata = { title: "Updates - TAWD" };
export const dynamic = "force-dynamic";

const STATUS: Record<string, string> = {
  open: "To make",
  queued: "Starting",
  editing: "Editing",
  edited: "Ready to check",
  failed: "Failed",
  rebuilt: "In a new build",
  done: "Done",
  quoted: "Quote: waiting on the client",
  declined: "Declined",
};

/* Updates, the step after Go live (1 October 2026, DESIGN.md "Updates"): requests, quotes and the month's invoice. */
export default async function UpdatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id } = await params;
  const asked = ((await searchParams) ?? {}).month;
  const current = await requireUser();
  const db = getDb();
  const project = await getProject(db, current, id);
  if (!project) notFound();
  const journey = (await loadJourneyFacts(db, id))!;
  const heading = (
    <ProjectHeading
      projectId={id}
      clientName={project.clientName}
      crumb="Updates"
      chips={projectChips(project)}
      members={project.members}
      canEditTeam={can(current, "project.assign_members")}
      journey={journey}
      viewing="updates"
      slackWarning={await slackWarningFor(db, id)}
    />
  );

  // Before go-live there is nothing to update: say why, and where the work is.
  if (project.status !== "live") {
    return (
      <>
        {heading}
        <div className="page">
          <div className="card stage-lock" role="status">
            <h2 className="card-title">Not yet: this stage is locked</h2>
            <p>Updates opens when the site goes live.</p>
            <p className="hint">The client&rsquo;s changes after launch are logged here, against the hours their plan includes.</p>
            <Link className="btn btn-primary btn-small" href={`/projects/${id}/build?part=golive`}>
              Go to Go live
            </Link>
          </div>
        </div>
      </>
    );
  }

  const edits = await loadEdits(db, id);
  const plan = await monthPlan(db, id);
  const pages = await builtPages(db, id);
  const quotes = await loadQuotes(db, id);
  const isAdmin = can(current, "money.manage");
  const months = isAdmin ? await invoiceMonths(db, id) : [];
  const month = typeof asked === "string" && months.includes(asked) ? asked : (months[0] ?? pacificToday().slice(0, 7));
  const invoice = isAdmin ? await loadInvoice(db, id, month) : null;
  const draft = isAdmin && !invoice ? await draftInvoiceLines(db, id, month) : [];
  const estimates = await Promise.all(edits.requests.map((r) => edits.estimate(Math.max(r.pageIds.length, 1))));
  const pageName = (r: (typeof edits.requests)[number]) =>
    r.pagePaths.length ? r.pagePaths.map((path) => pages.find((p) => p.path === path)?.name ?? path) : r.pageIds.map((pid) => pages.find((p) => p.pageId === pid)?.name ?? "a removed page");

  return (
    <>
      {heading}
      <div className="page">
        <div className="updates-grid">
          <div className="stack">
            <div id="edits" />
            <EditsCard
              projectId={id}
              canEdit={can(current, "project.edit")}
              hoursLine={edits.hours.line}
              over={edits.hours.over > 0}
              hasBuild={pages.length > 0}
              pages={pages.map((p) => ({ id: p.pageId, name: p.name }))}
              today={pacificToday()}
              month={{ line: plan.line, usedMinutes: plan.usedMinutes, plannedMinutes: plan.plannedMinutes, included: plan.included }}
              categories={UPDATE_CATEGORIES.map((c) => ({ key: c.key, label: c.label }))}
              canMakeAi={project.lane !== "lane_2"}
              requests={edits.requests.map((r, i) => ({
                id: r.id,
                kind: r.kind as "edit" | "quote",
                status: r.status,
                statusLabel: STATUS[r.status] ?? r.status,
                requestedOn: r.requestedOn,
                clientWords: r.clientWords,
                teamNote: r.teamNote,
                pageNames: pageName(r),
                categoryLabel: categoryLabel(r.category),
                estimate: r.estimateMinutes ? `${hoursFrom(r.estimateMinutes)}h` : "none",
                time: r.minutes ? formatMinutes(r.minutes) : "none yet",
                aiCost: r.aiCost ? formatCost(r.aiCost) : "none",
                estimateLine: estimates[i]!.label,
                failure: r.status === "failed" ? r.failureReason : null,
                changes: r.pages.map((p) => ({ name: p.name, removed: p.changes.removed, added: p.changes.added, changed: p.changed })),
              }))}
            />
            {isAdmin ? (
              <InvoiceCard
                projectId={id}
                clientName={project.clientName}
                month={month}
                months={months}
                saved={invoice ? { lines: invoice.lines, updatedAt: invoice.updatedAt.toISOString() } : null}
                draft={draft}
              />
            ) : null}
          </div>
          <div id="quotes">
            <QuotesCard projectId={id} canAnswer={can(current, "project.edit")} channels={[...ANSWER_CHANNELS]} quotes={quotes.map((q) => ({ ...q, createdAt: q.createdAt.toISOString() }))} />
          </div>
        </div>
      </div>
      <NextStepBar next={await loadNextStepFor(db, current, id)} here={`/projects/${id}/updates`} />
    </>
  );
}
