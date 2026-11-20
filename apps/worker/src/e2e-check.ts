import type Anthropic from "@anthropic-ai/sdk";
import { eq } from "drizzle-orm";
import type { Browser } from "playwright-core";

import { getDb } from "@tawd/core/db";
import type { SiteBuildJobData } from "@tawd/core/queue";
import { e2eCheck, project } from "@tawd/core/schema";
import { E2E_CHECK_CLIENT, e2eStandInTurns } from "@tawd/core/site";

import type { RawTurn } from "./claude";
import type { WorkerConfig } from "./config";
import { runWithReplay } from "./replay";
import { runSiteBuildJob } from "./site-build";

/*
  The end-to-end check's build (29 September 2026): the real site build,
  its "AI" answered from the stand-ins as a replay is, so nothing is sent to
  Anthropic and nothing goes in the ledger. Only ever for the check's own
  project: a client's build never runs on stand-ins.
*/
export async function standInTurnsFor(projectId: string): Promise<Map<string, RawTurn[]>> {
  const [row] = await getDb().select({ clientName: project.clientName }).from(project).where(eq(project.id, projectId)).limit(1);
  // Its name and a check that made it: a real project that shares the name never gets stand-in answers (13 October 2026, the whole-code review).
  const [made] = await getDb().select({ id: e2eCheck.id }).from(e2eCheck).where(eq(e2eCheck.projectId, projectId)).limit(1);
  if (row?.clientName !== E2E_CHECK_CLIENT || !made) throw new Error("Stand-in answers are only for the end-to-end check's own project.");
  return e2eStandInTurns() as unknown as Map<string, RawTurn[]>;
}

export async function runStandInSiteBuild(data: SiteBuildJobData, config: WorkerConfig, client: Anthropic, browser: Browser): Promise<void> {
  const turns = await standInTurnsFor(data.projectId);
  await runWithReplay(turns, () => runSiteBuildJob(data, config, client, browser));
}
