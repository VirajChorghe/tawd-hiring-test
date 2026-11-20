import type { Database } from "@tawd/core/db";
import { loadIntake } from "@tawd/core/intake/service";
import type { Viewer } from "@tawd/core/permissions";
import { currentStep, loadJourneyFacts, stepLabel } from "./journey";
import { loadProjectNext, type NextStep } from "./next-step";
import { listProjectOverview } from "./project-overview";

/*
  My work (Jason, 29 September 2026): what is waiting on you across every
  project, from each project's Next step. Where anyone who isn't an admin
  lands after signing in.

  A step is yours when its job names you, or names your role while nobody
  in that role is assigned to the project, or waits on an admin or a
  founder and you are one.
*/

export interface MyWorkRow {
  projectId: string;
  name: string;
  tradeLabel: string;
  tierLabel: string;
  step: string;
  next: NextStep;
  lastActivity: { text: string; when: string; at: number } | null;
}

export interface MyWorkView {
  mine: MyWorkRow[];
  others: MyWorkRow[];
}

export function isMine(next: NextStep, viewer: Viewer, projectMembers: { id: string; roles: string[] }[]): boolean {
  const who = next.who;
  if (who.adminOrFounder) return viewer.isAdmin || viewer.roles.includes("founder");
  if (who.label !== "Whose job") return false;
  if (who.people.some((p) => p.id === viewer.id)) return true;
  // Nobody assigned in the role: anyone in the role may pick it up.
  return who.people.length === 0 && who.roles.some((r) => viewer.roles.includes(r)) && !projectMembers.some((m) => m.roles.some((r) => who.roles.includes(r as never)));
}

export async function loadMyWork(db: Database, viewer: Viewer, labels: { trade: (t: string) => string; tier: (t: string) => string }): Promise<MyWorkView> {
  const projects = await listProjectOverview(db, viewer);
  const mine: MyWorkRow[] = [];
  const others: MyWorkRow[] = [];
  for (const p of projects) {
    const member = p.members.some((m) => m.id === viewer.id);
    const facts = await loadJourneyFacts(db, p.id);
    if (!facts) continue;
    const at = currentStep(facts);
    const intake = at === "intake" ? await loadIntake(db, viewer, p.id) : null;
    const { next } = await loadProjectNext(db, {
      projectId: p.id,
      facts: { ...facts, intakeComplete: intake?.completeness.isComplete ?? false },
      laneOption: p.laneOption,
      members: p.members,
      missing: intake?.completeness.missing.map((m) => m.label) ?? [],
    });
    // A live site with nothing to do for it isn't work: only open updates and quotes waiting on an answer are.
    if (at === "updates" && next.title.startsWith("Updates:")) continue;
    const row: MyWorkRow = {
      projectId: p.id,
      name: p.clientName,
      tradeLabel: labels.trade(p.trade),
      tierLabel: labels.tier(p.tier),
      step: at === "paused" ? "Paused" : stepLabel(at, facts.lane),
      next,
      lastActivity: p.lastActivity ? { text: p.lastActivity.text, when: p.lastActivity.when, at: p.lastActivity.at.getTime() } : null,
    };
    if (isMine(next, viewer, p.members)) mine.push(row);
    else if (member) others.push(row);
  }
  // Oldest activity first: what has waited longest.
  const age = (r: MyWorkRow) => r.lastActivity?.at ?? 0;
  mine.sort((a, b) => age(a) - age(b));
  others.sort((a, b) => age(a) - age(b));
  return { mine, others };
}
