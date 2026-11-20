import { buildTokensPerConcept, costOf, getModelConfig, type ModelConfig, type TokenUsage } from "./pricing";

/*
  A model per AI step (Jason, 27 September 2026: design reading was too
  expensive on Opus). Reading and checking steps (the uploaded design,
  the text on photos, the look at the faithful copy, reference sites) run
  on a cheaper model by default; building, the Creative Director and
  critique and polish stay on Opus. An admin can change any step on the
  Spend page; the choice is kept in app_setting "step_models" and logged.

  Prices are per million tokens (Claude API, checked 27 September 2026).
  What is stored for each call is its tokens and its model, so a price
  fixed here fixes every figure shown, old ones included.
*/

export interface ModelInfo {
  id: string;
  label: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
  /** Haiku 4.5 takes no effort setting and no adaptive thinking. */
  effort: boolean;
  /**
   * Only these steps may run on it (Fable 5.1, Jason 4 November 2026: the
   * concept build only). Left out: every step.
   */
  steps?: readonly string[];
  /** A word on Spend next to its price, when it needs one. */
  note?: string;
}

export const MODELS: ModelInfo[] = [
  { id: "claude-opus-5-5", label: "Opus 5.5", inputPricePerMTok: 4, outputPricePerMTok: 20, effort: true },
  { id: "claude-sonnet-5", label: "Sonnet 5", inputPricePerMTok: 2, outputPricePerMTok: 10, effort: true },
  { id: "claude-haiku-4-5", label: "Haiku 4.5", inputPricePerMTok: 1, outputPricePerMTok: 5, effort: false },
  /*
    Fable 5.1 (Jason, 4 November 2026): a choice for the concept build only,
    at 2.5 times Opus 5.5's price. It runs only for an API account with
    Anthropic's 30-day data retention; without it the call is refused at
    once, before any work, so nothing is charged (FABLE_RETENTION_HINT).
  */
  {
    id: "claude-fable-5-1",
    label: "Fable 5.1",
    inputPricePerMTok: 10,
    outputPricePerMTok: 50,
    effort: true,
    steps: ["build"],
    note: "concept build only; needs 30-day data retention on VML's Anthropic account",
  },
];

export const FABLE_MODEL = "claude-fable-5-1";

/* Said when Anthropic refuses a Fable call before it starts (HTTP 400): the likeliest reason. */
export const FABLE_RETENTION_HINT =
  "Fable 5.1 only runs for an Anthropic account with 30-day data retention switched on. Nothing was charged for the refused call. Switch it on in Anthropic's console, or set the concept build back to Opus 5.5 on Spend.";

/* The models a step may run on: every model, less those kept to other steps. */
export function modelsForStep(step: string): ModelInfo[] {
  return MODELS.filter((m) => !m.steps || m.steps.includes(step));
}

export function modelAllowedForStep(model: string, step: string): boolean {
  return modelsForStep(step).some((m) => m.id === model);
}

export const CHEAP_MODEL = "claude-sonnet-5";

export function modelInfo(id: string): ModelInfo | null {
  return MODELS.find((m) => m.id === id) ?? null;
}

export function modelLabel(id: string): string {
  return modelInfo(id)?.label ?? id;
}

/*
  The prices for a model. The configured main model keeps its environment
  overrides (ANTHROPIC_INPUT_PRICE_PER_MTOK and ..._OUTPUT_...); a model
  TAWD doesn't know is priced as the main model, so it is never shown as
  free.
*/
export function priceConfigFor(model: string, base: ModelConfig = getModelConfig()): ModelConfig {
  if (model === base.model) return base;
  const known = modelInfo(model);
  return known ? { model, inputPricePerMTok: known.inputPricePerMTok, outputPricePerMTok: known.outputPricePerMTok } : { ...base, model };
}

/*
  What building the concepts on buildModel adds to an estimate priced on the
  main model (negative when it is cheaper): the build call's tokens at both
  prices. Fable 5.1 adds about $1 a concept over Opus 5.5.
*/
export function buildModelPremium(conceptCount: number, buildModel: string, base: ModelConfig = getModelConfig()): number {
  if (buildModel === base.model) return 0;
  const t = buildTokensPerConcept();
  const usage = { inputTokens: t.input, outputTokens: t.output, cacheWriteTokens: t.cacheWrite };
  return Math.max(0, conceptCount) * (costOf(usage, priceConfigFor(buildModel, base)) - costOf(usage, base));
}

/* What a call actually cost: its tokens at its own model's prices. */
export function callCost(call: TokenUsage & { model?: string | null }, base: ModelConfig = getModelConfig()): number {
  return costOf(call, call.model ? priceConfigFor(call.model, base) : base);
}

export interface StepInfo {
  step: string;
  label: string;
  group: string;
  /** The model it runs on unless an admin changes it: the main model, or the cheaper one for reading and checking. */
  cheapByDefault: boolean;
}

/* Every AI step, as the Spend page lists them. */
export const STEPS: StepInfo[] = [
  { step: "reference_study", label: "Reference site briefs", group: "Mockup inputs", cheapByDefault: true },
  { step: "photo_text", label: "Photo text check", group: "Mockup inputs", cheapByDefault: true },
  { step: "home_words", label: "Home page words (new site)", group: "Mockup inputs", cheapByDefault: true },
  { step: "build", label: "Concept build", group: "Build", cheapByDefault: false },
  { step: "fix", label: "Automatic fix rounds", group: "Build", cheapByDefault: false },
  { step: "review", label: "Creative Director review", group: "Creative Director", cheapByDefault: false },
  { step: "improve", label: "Creative Director improvement", group: "Creative Director", cheapByDefault: false },
  { step: "rebuild", label: "Rebuild after review", group: "Creative Director", cheapByDefault: false },
  { step: "polish_critique", label: "Critique", group: "Critique and polish", cheapByDefault: false },
  { step: "polish", label: "Polish", group: "Critique and polish", cheapByDefault: false },
  { step: "changes", label: "Requested changes", group: "Changes", cheapByDefault: false },
  { step: "design_read", label: "Reading an uploaded design", group: "Designer's design", cheapByDefault: true },
  // Sonnet 5 fits a read, a build and four rounds inside $10 with room to spare (spec 15 section 13).
  { step: "design_page", label: "Building a page from the design", group: "Designer's design", cheapByDefault: true },
  // Sonnet 5 first (Jason, 29 September 2026: Opus only if its suggestions disappoint).
  { step: "design_review", label: "Design review", group: "Designer's design", cheapByDefault: true },
  // The faithful copy (Option B) and the exact copies (Option A) are the same step (27 September 2026).
  { step: "faithful_copy", label: "Exact and faithful copies, first build", group: "Designer's design", cheapByDefault: true },
  { step: "faithful_copy_retry", label: "Copy sections rebuilt after a low score", group: "Designer's design", cheapByDefault: false },
  { step: "faithful_check", label: "Faithful copy look check", group: "Designer's design", cheapByDefault: true },
  { step: "design_improve", label: "Design improvement", group: "Designer's design", cheapByDefault: false },
  { step: "design_rescore", label: "Design re-score", group: "Designer's design", cheapByDefault: false },
  { step: "design_decisions", label: "Designer's decisions", group: "Designer's design", cheapByDefault: false },
  { step: "design_mobile", label: "Phone version", group: "Designer's design", cheapByDefault: false },
  { step: "logo_design", label: "Logo design", group: "Add-ons", cheapByDefault: false },
  { step: "content_draft", label: "Page drafts", group: "Content", cheapByDefault: false },
  // Design + content (0.100.0): Sonnet 5 first, as the plan says (Opus 5.5 if the words aren't good enough).
  { step: "content_improve", label: "Improve a page's words (Design + content)", group: "Content", cheapByDefault: true },
  { step: "seo_audit_report", label: "SEO audit report", group: "SEO", cheapByDefault: false },
  { step: "seo_golive_check", label: "SEO check before go-live", group: "SEO", cheapByDefault: false },
  { step: "site_parts", label: "Site header and footer", group: "Site build", cheapByDefault: false },
  { step: "site_page", label: "Site pages", group: "Site build", cheapByDefault: false },
  { step: "site_edit", label: "Monthly edits", group: "Site build", cheapByDefault: false },
  // The page review's Fix these (Jason, 3 October 2026: Sonnet 5 first, Opus if it isn't good enough).
  { step: "site_page_fix", label: "Page review: Fix these", group: "Site build", cheapByDefault: true },
  // Lane 2's site from the design (Jason, 29 September 2026: Sonnet 5).
  { step: "design_site_parts", label: "Site from the design: header and footer", group: "Site build", cheapByDefault: true },
  { step: "design_site_page", label: "Site from the design: pages", group: "Site build", cheapByDefault: true },
  { step: "design_site_rework", label: "Site from the design: feedback", group: "Site build", cheapByDefault: true },
];

export const STEP_MODELS_SETTING = "step_models";

export function defaultModelFor(step: string, base: ModelConfig = getModelConfig()): string {
  return STEPS.find((s) => s.step === step)?.cheapByDefault ? CHEAP_MODEL : base.model;
}

/* The model a step runs on: the admin's choice if it is a known model, else the default. */
export function modelForStep(step: string, saved: unknown, base: ModelConfig = getModelConfig()): string {
  const choice = saved && typeof saved === "object" ? (saved as Record<string, unknown>)[step] : undefined;
  return typeof choice === "string" && (modelAllowedForStep(choice, step) || choice === base.model) ? choice : defaultModelFor(step, base);
}

/*
  The request settings a model accepts: Haiku 4.5 takes neither an effort
  level nor adaptive thinking, so both are left out for it (a structured
  output format still goes).
*/
export function requestSettings(
  model: string,
  wanted: { effort?: "low" | "medium" | "high" | "xhigh" | "max"; format?: Record<string, unknown>; adaptiveThinking?: boolean },
): { output_config?: Record<string, unknown>; thinking?: { type: "adaptive" } } {
  const effort = modelInfo(model)?.effort ?? true;
  const output = { ...(effort && wanted.effort ? { effort: wanted.effort } : {}), ...(wanted.format ? { format: wanted.format } : {}) };
  return {
    ...(Object.keys(output).length ? { output_config: output } : {}),
    ...(effort && wanted.adaptiveThinking ? { thinking: { type: "adaptive" as const } } : {}),
  };
}

