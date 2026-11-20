import { eq } from "drizzle-orm";

import type { Database } from "../db";
import { appSetting } from "../db/schema";
import { STEP_MODELS_SETTING, modelForStep, priceConfigFor } from "./mockups/models";
import { getModelConfig, type ModelConfig } from "./mockups/pricing";

/*
  The model each AI step runs on, as saved on the Spend page (27 September
  2026). Read by the worker before every call and by the web app for its
  estimates, so a change applies from the next call.
*/

export async function loadStepModels(db: Database): Promise<Record<string, string>> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, STEP_MODELS_SETTING)).limit(1);
  const value = row?.value;
  return value && typeof value === "object" ? (value as Record<string, string>) : {};
}

/* The step's model and its prices. */
export async function stepModelConfig(db: Database, step: string, base: ModelConfig = getModelConfig()): Promise<ModelConfig> {
  const model = modelForStep(step, await loadStepModels(db), base);
  return priceConfigFor(model, base);
}
