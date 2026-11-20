import { appSetting } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { STEPS, STEP_MODELS_SETTING, defaultModelFor, modelForStep, modelsForStep } from "@tawd/core/mockups";
import { loadStepModels } from "@tawd/core/step-models";
import type { ServiceContext } from "@/lib/users";

/*
  The model each AI step runs on (Jason, 27 September 2026), chosen by an
  admin on the Spend page. Each change is logged with before and after and
  applies from the step's next call.
*/

type Db = ServiceContext["db"];

export class StepModelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepModelError";
  }
}

export interface StepModelRow {
  step: string;
  label: string;
  group: string;
  model: string;
  defaultModel: string;
  /** The models this step may run on (Fable 5.1 only on the concept build). */
  choices: string[];
}

export async function loadStepModelRows(db: Db): Promise<StepModelRow[]> {
  const saved = await loadStepModels(db);
  return STEPS.map((s) => ({ step: s.step, label: s.label, group: s.group, model: modelForStep(s.step, saved), defaultModel: defaultModelFor(s.step), choices: modelsForStep(s.step).map((m) => m.id) }));
}

export async function saveStepModel(ctx: ServiceContext, actor: Viewer, step: string, model: string): Promise<void> {
  assertCan(actor, "settings.manage");
  const info = STEPS.find((s) => s.step === step);
  if (!info) throw new StepModelError("That isn't one of TAWD's AI steps.");
  const allowed = modelsForStep(step);
  if (!allowed.some((m) => m.id === model)) throw new StepModelError(`Choose one of ${allowed.map((m) => m.label).join(", ")} for ${info.label}.`);
  const saved = await loadStepModels(ctx.db);
  const before = modelForStep(step, saved);
  if (before === model) return;
  const value = { ...saved, [step]: model };
  const now = new Date();
  await ctx.db
    .insert(appSetting)
    .values({ key: STEP_MODELS_SETTING, value, updatedByUserId: actor.id })
    .onConflictDoUpdate({ target: appSetting.key, set: { value, updatedByUserId: actor.id, updatedAt: now } });
  await recordActivity(ctx.db, {
    action: "settings.step_model_changed",
    entityType: "setting",
    entityId: `${STEP_MODELS_SETTING}:${step}`,
    ...actorFields(actor),
    valueBefore: { step: info.label, model: before },
    valueAfter: { step: info.label, model },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
