import type { Metadata } from "next";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { tierLabels, tradeLabels } from "@/lib/labels";
import { currentStep, journeySteps, loadJourneyFacts, stepLabel } from "@/lib/journey";
import { loadProjectNext } from "@/lib/next-step";
import { listProjectOverview } from "@/lib/project-overview";
import { requireUser } from "@/lib/session";
import { ProjectsBoard } from "./board";

export const metadata: Metadata = { title: "Projects - TAWD" };
export const dynamic = "force-dynamic";

/* Every website in progress, and where each one stands. */
export default async function ProjectsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const current = await requireUser();
  const params = (await searchParams) ?? {};
  const pick = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const db = getDb();
  const projects = await listProjectOverview(db, current);
  // Each project's steps, for its stage bar (lane-aware, 29 September 2026).
  const journeys = new Map(
    await Promise.all(
      projects.map(async (p) => {
        const facts = (await loadJourneyFacts(db, p.id))!;
        const at = currentStep(facts);
        const name = at === "paused" ? "Paused" : stepLabel(at, facts.lane);
        // Needs attention: a specific problem the overview found, or else the project's next step (every stage).
        const next = p.attention.tone === "warn" || at === "paused" ? null : (await loadProjectNext(db, { projectId: p.id, facts, laneOption: p.laneOption, members: p.members, missing: [] })).next;
        const attention = next ? { tone: at === "updates" && next.title.startsWith("Updates:") ? ("none" as const) : ("go" as const), text: next.who.label === "Waiting on" ? `${next.title} (waiting on ${next.who.text})` : next.title } : p.attention;
        return [p.id, { steps: journeySteps(p.id, facts).map((s) => s.state), name, attention }] as const;
      }),
    ),
  );

  /*
    "Project deleted" (Jason, 10 November 2026): deleting a project sent the
    team back to this list with nothing to say it had worked, and the wait
    beforehand had already made the screen look frozen. The name comes back
    in the address the delete sends them to.
  */
  const deleted = pick(params.deleted);

  return (
    <div className="page">
      {deleted ? (
        <p className="info-note" role="status">
          Deleted. The project&rsquo;s files were deleted with it. The activity log keeps who did it, when and why.
        </p>
      ) : null}
      <ProjectsBoard
        currentUserId={current.id}
        canCreate={can(current, "project.create")}
        // A filtered view can be linked to: /projects?stage=mockups&q=pat
        initial={{
          stage: pick(params.stage),
          q: pick(params.q),
          trade: pick(params.trade),
          mine: pick(params.mine) === "1",
        }}
        projects={projects.map((p) => ({
          id: p.id,
          name: p.clientName,
          trade: p.trade,
          tradeLabel: tradeLabels[p.trade],
          tierLabel: tierLabels[p.tier].split(" (")[0]!,
          status: p.status,
          steps: journeys.get(p.id)!.steps,
          stepName: journeys.get(p.id)!.name,
          members: p.members,
          attention: journeys.get(p.id)!.attention,
          lastActivity: p.lastActivity
            ? { text: p.lastActivity.text, when: p.lastActivity.when }
            : null,
          // Newest activity, or the last edit if nothing is logged yet.
          lastActivityAt: (p.lastActivity?.at ?? p.updatedAt).getTime(),
        }))}
      />
    </div>
  );
}
