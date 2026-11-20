import type { Database } from "@tawd/core/db";
import { modelForStep } from "@tawd/core/mockups";
import { loadStepModels } from "@tawd/core/step-models";

import { noteStep } from "./replay";
import { checkStop } from "./stop";

/*
  The model a step runs on (27 September 2026), read before each call so
  a change on the Spend page applies from the next one.
*/
export async function stepModel(db: Database, step: string): Promise<string> {
  // The Stop button (28 September 2026): a stopped job ends here, before the call is paid for.
  await checkStop(db);
  // In a replay, the next saved answer comes from this step.
  noteStep(step);
  return modelForStep(step, await loadStepModels(db));
}
