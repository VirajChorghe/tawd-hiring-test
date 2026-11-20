/*
  Which model TAWD uses, and what a run costs.

  Two deliberate choices here.

  The model is an environment variable, not a constant. Model names change,
  and a wrong one is a 400 on every call - being able to fix that without a
  deploy is worth the indirection.

  And money is never stored. What gets written to the database is token
  counts, which are facts. Dollars and cents are worked out from the rates
  below whenever they are displayed, so if a rate turns out to be wrong,
  correcting it fixes every historical figure at once instead of leaving
  wrong numbers baked into old rows.
*/

// Confirmed to exist on 24 September 2026: "Claude Opus 5.5".
export const DEFAULT_MODEL = "claude-opus-5-5";

/*
  Per million tokens, in US dollars.

  Claude Opus 5.5's rates, confirmed against the Models API on 24 September
  2026. If the configured model prices differently, set the two environment
  variables and every figure in the app - including ones already recorded -
  follows, because what is stored is tokens rather than money.
*/
export const DEFAULT_INPUT_PRICE_PER_MTOK = 4;
export const DEFAULT_OUTPUT_PRICE_PER_MTOK = 20;

/* A cache read is a tenth of the input rate; a cache write is 1.25 times. */
const CACHE_READ_MULTIPLIER = 0.1;
/*
  Except where a model reads cheaper: Opus 5.5 reads at a twentieth ($0.20
  a million). Found 8 October 2026 by checking Spend against Anthropic's
  own cost export for 1-7 October (TAWD $12.48, Anthropic $12.41).
*/
// Fable 5.1 reads its cache at $0.25 a million, a fortieth of its $10 input price (Claude API reference, 5 November 2026).
const CACHE_READ_MULTIPLIERS: Record<string, number> = { "claude-opus-5-5": 0.05, "claude-fable-5-1": 0.025 };

export function cacheReadMultiplierFor(model: string): number {
  return CACHE_READ_MULTIPLIERS[model] ?? CACHE_READ_MULTIPLIER;
}
const CACHE_WRITE_MULTIPLIER = 1.25;
// Writing to the one-hour cache costs twice the input price (26 September 2026).
const CACHE_WRITE_1H_MULTIPLIER = 2;

export interface ModelConfig {
  model: string;
  inputPricePerMTok: number;
  outputPricePerMTok: number;
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function getModelConfig(): ModelConfig {
  return {
    model: process.env.ANTHROPIC_MODEL?.trim() || DEFAULT_MODEL,
    inputPricePerMTok: numberFromEnv(
      "ANTHROPIC_INPUT_PRICE_PER_MTOK",
      DEFAULT_INPUT_PRICE_PER_MTOK,
    ),
    outputPricePerMTok: numberFromEnv(
      "ANTHROPIC_OUTPUT_PRICE_PER_MTOK",
      DEFAULT_OUTPUT_PRICE_PER_MTOK,
    ),
  };
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Written to the one-hour cache; not counted in cacheWriteTokens. */
  cacheWrite1hTokens?: number;
}

export function costOf(usage: TokenUsage, config: ModelConfig): number {
  const input =
    (usage.inputTokens / 1_000_000) * config.inputPricePerMTok +
    ((usage.cacheReadTokens ?? 0) / 1_000_000) *
      config.inputPricePerMTok *
      cacheReadMultiplierFor(config.model) +
    ((usage.cacheWriteTokens ?? 0) / 1_000_000) *
      config.inputPricePerMTok *
      CACHE_WRITE_MULTIPLIER +
    ((usage.cacheWrite1hTokens ?? 0) / 1_000_000) *
      config.inputPricePerMTok *
      CACHE_WRITE_1H_MULTIPLIER;

  const output = (usage.outputTokens / 1_000_000) * config.outputPricePerMTok;

  return input + output;
}

/*
  What a concept has spent, from its version rows.

  Each version row records the concept's running total at the moment it was
  stored: version 1 holds the build, version 2 the build plus the fix round.
  So the spend is the newest version's figures, never the sum - summing
  counted the build twice for every concept that needed a fix, which is part
  of why the first real concept appeared to cost $1.73.

  Reading it this way corrects the rows already stored as well, with no
  migration.
*/
export interface VersionUsage extends TokenUsage {
  version: number;
}

export function conceptSpend(versions: VersionUsage[]): Required<TokenUsage> {
  let latest: VersionUsage | undefined;
  for (const v of versions) {
    if (!latest || v.version > latest.version) latest = v;
  }
  return {
    inputTokens: latest?.inputTokens ?? 0,
    outputTokens: latest?.outputTokens ?? 0,
    cacheReadTokens: latest?.cacheReadTokens ?? 0,
    cacheWriteTokens: latest?.cacheWriteTokens ?? 0,
    cacheWrite1hTokens: latest?.cacheWrite1hTokens ?? 0,
  };
}

export function formatCost(dollars: number): string {
  if (dollars === 0) return "$0";
  if (dollars < 0.01) return "under $0.01";
  if (dollars < 10) return `$${dollars.toFixed(2)}`;
  return `$${Math.round(dollars)}`;
}

/*
  What a run will cost, before it runs.

  The figures below are measured where they can be and reasoned where they
  cannot. The prompt sizes are real: TAWD-PROFILE is about 2,300 tokens and
  the three skill files are 1,300, 1,500 and 15,900, so the system prompt is
  between four and eighteen thousand tokens depending on which skill builds
  the concept. An earlier version of this file guessed seventy thousand,
  which was wrong by a factor of four to twenty and made every estimate
  roughly three times too high.

  The output sizes are still estimates - a homepage is as long as it needs
  to be - which is why the answer is a range rather than a number. The real
  token counts are recorded against every concept version, so once a few
  runs exist these constants should be replaced with what actually happened
  rather than what was expected.

  Note what is NOT in here for 3a: the Creative Director's review, and the
  improvement round that follows it. In 3a the improvement round only runs
  when a mechanical check failed. Pass includesReview when 3b lands and the
  estimate rises accordingly.
*/
export interface RunEstimate {
  low: number;
  high: number;
  inputTokens: number;
  outputTokens: number;
  label: string;
}

export interface PipelineShape {
  /** The Creative Director review and its improvement round. 3b onwards. */
  includesReview: boolean;
  /**
   * The expected number of fix rounds per concept when there is no review.
   *
   * A round only runs if a mechanical check failed, and there are at most
   * two. Most first builds need one; some need the second. It is the least
   * certain number here.
   */
  improveLikelihood: number;
}

export const PIPELINE_3A: PipelineShape = {
  includesReview: false,
  improveLikelihood: 0.9,
};

/*
  From 3b: the Creative Director scores every concept twice (before and
  after), one improvement round applies the notes, and a concept still
  under 3 is rebuilt once. The rebuild is the rarer path; a fifth of
  concepts is the guess until real runs say otherwise.
*/
export const PIPELINE_3B: PipelineShape = {
  includesReview: true,
  improveLikelihood: 0.9,
};

const REVIEW_PASSES = 2;
// No rebuild since 8 October 2026: a concept under 4.5 after one rewrite is held, not rebuilt.
const REBUILD_LIKELIHOOD = 0;

const PER_CONCEPT = {
  /*
    The system prompt: the profile plus one skill file. Written to the cache
    once per skill, then read back on the same concept's later turns.
    Averaged across the three skills, two of which are small.
  */
  systemTokens: 9_000,
  /* The user prompt - mostly the intake - plus a tool read or two. */
  buildInputTokens: 6_000,
  /*
    A complete homepage, including the thinking tokens, which are billed as
    output and at effort "high" are a large share of it. The first real run
    showed this was the number most badly underestimated.
  */
  buildOutputTokens: 30_000,
  /* The fix or improvement turn resends the page it is changing. */
  improveInputTokens: 30_000,
  improveOutputTokens: 30_000,
  /*
    The review, per concept per pass: its screenshots (about 12,000 tokens
    of images) and its HTML, then the scores and notes plus thinking.
  */
  reviewInputTokens: 27_000,
  reviewOutputTokens: 5_000,
};

/*
  The concept build call's own share of a concept (its system prompt, its
  brief and the page it writes), so the estimate can price that one call on
  the model Spend sets for it (Fable 5.1 on the concept build, 5 November
  2026). The fix rounds and the review stay on their own steps' models.
*/
export function buildTokensPerConcept(): { cacheWrite: number; input: number; output: number } {
  return { cacheWrite: PER_CONCEPT.systemTokens, input: PER_CONCEPT.buildInputTokens, output: PER_CONCEPT.buildOutputTokens };
}

/*
  What one concept has actually cost, measured.

  The first real run came in at $1.73 against an estimate of $0.44 to $1.00,
  so the constants above were still too low even after being corrected once.
  Guessing a third time would be the wrong move: the worker records the
  token counts for every concept, so once anything has been built the
  estimate uses that instead and says so.
*/
export interface ObservedPerConcept {
  concepts: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export function estimateFromObserved(
  conceptCount: number,
  config: ModelConfig,
  observed: ObservedPerConcept,
  options: { addGuessedReview?: boolean } = {},
): RunEstimate {
  const count = Math.max(1, Math.min(3, conceptCount));

  const perConcept =
    costOf(
      {
        inputTokens: observed.inputTokens,
        outputTokens: observed.outputTokens,
        cacheReadTokens: observed.cacheReadTokens,
        cacheWriteTokens: observed.cacheWriteTokens,
      },
      config,
    ) + (options.addGuessedReview ? reviewCostPerConcept(config) : 0);

  const middle = perConcept * count;

  /*
    Narrower than the guessed range, but not narrow. One or two concepts is
    a thin basis, and a client with more to say still costs more.
  */
  const spread = observed.concepts >= 5 ? 0.35 : 0.5;

  return {
    low: middle * (1 - spread),
    high: middle * (1 + spread),
    inputTokens: observed.inputTokens * count,
    outputTokens: observed.outputTokens * count,
    label: `Around ${formatCost(middle * (1 - spread))} to ${formatCost(
      middle * (1 + spread),
    )} in AI costs, plus review time (based on ${observed.concepts} concept${
      observed.concepts === 1 ? "" : "s"
    } built so far)`,
  };
}

/*
  The Creative Director's guessed share per concept: two scoring passes,
  one improvement round, and a rebuild for a fifth of concepts.
*/
function reviewTokensPerConcept() {
  return {
    input:
      REVIEW_PASSES * PER_CONCEPT.reviewInputTokens +
      PER_CONCEPT.improveInputTokens +
      REBUILD_LIKELIHOOD * PER_CONCEPT.buildInputTokens,
    output:
      REVIEW_PASSES * PER_CONCEPT.reviewOutputTokens +
      PER_CONCEPT.improveOutputTokens +
      REBUILD_LIKELIHOOD * PER_CONCEPT.buildOutputTokens,
  };
}

/* One Creative Director scoring pass on one concept (after Request changes, for example). */
export function scoringPassCost(config: ModelConfig): number {
  return costOf({ inputTokens: PER_CONCEPT.reviewInputTokens, outputTokens: PER_CONCEPT.reviewOutputTokens }, config);
}

export function reviewCostPerConcept(config: ModelConfig): number {
  const review = reviewTokensPerConcept();
  return costOf({ inputTokens: review.input, outputTokens: review.output }, config);
}

export function estimateRun(
  conceptCount: number,
  config: ModelConfig,
  shape: PipelineShape = PIPELINE_3B,
): RunEstimate {
  const count = Math.max(1, Math.min(3, conceptCount));

  const review = shape.includesReview ? reviewTokensPerConcept() : { input: 0, output: 0 };

  const perConcept = {
    cacheWrite: PER_CONCEPT.systemTokens,
    input:
      PER_CONCEPT.buildInputTokens +
      shape.improveLikelihood * PER_CONCEPT.improveInputTokens +
      review.input,
    output:
      PER_CONCEPT.buildOutputTokens +
      shape.improveLikelihood * PER_CONCEPT.improveOutputTokens +
      review.output,
  };

  const inputTokens = perConcept.input * count;
  const outputTokens = perConcept.output * count;
  const cacheWriteTokens = perConcept.cacheWrite * count;

  const middle = costOf(
    { inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens: 0 },
    config,
  );

  /*
    Wide on purpose. A client who filled the intake in properly produces a
    longer page than one who gave three services and a phone number, and
    that difference is most of the cost. A range that is honestly wide is
    more use than a precise-looking number that is wrong.
  */
  return {
    low: middle * 0.7,
    high: middle * 1.6,
    inputTokens,
    outputTokens,
    label: `Around ${formatCost(middle * 0.7)} to ${formatCost(
      middle * 1.6,
    )} in AI costs, plus review time (a first estimate, as nothing has been built yet)`,
  };
}

/*
  Where a step's money went, from its saved calls (26 September 2026): how
  many calls (a second round is a retry), and what the tokens in, the cache
  writes and reads, and the answer (thinking included: it is billed as
  output) each cost. So "estimated $0.34, cost $0.67" can be read off the
  screen instead of guessed.
*/
export function describeCallCosts(
  calls: (TokenUsage & { round?: number | null })[],
  config: ModelConfig,
): string {
  if (calls.length === 0) return "";
  const sum = (pick: (c: TokenUsage) => number) => calls.reduce((n, c) => n + pick(c), 0);
  const input = sum((c) => c.inputTokens);
  const output = sum((c) => c.outputTokens);
  const read = sum((c) => c.cacheReadTokens ?? 0);
  const write = sum((c) => (c.cacheWriteTokens ?? 0) + (c.cacheWrite1hTokens ?? 0));
  const price = (usage: TokenUsage) => `$${costOf(usage, config).toFixed(2)}`;
  const n = (value: number) => value.toLocaleString("en-US");
  const retries = calls.filter((c) => (c.round ?? 1) > 1).length;
  const parts = [
    `${calls.length} call${calls.length === 1 ? "" : "s"}${retries ? ` (${retries} a retry)` : ""}`,
    `${n(input)} tokens in (${price({ inputTokens: input, outputTokens: 0 })})`,
    ...(write ? [`${n(write)} written to the cache (${price({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: sum((c) => c.cacheWriteTokens ?? 0), cacheWrite1hTokens: sum((c) => c.cacheWrite1hTokens ?? 0) })})`] : []),
    ...(read ? [`${n(read)} read from the cache (${price({ inputTokens: 0, outputTokens: 0, cacheReadTokens: read })})`] : []),
    `${n(output)} out, thinking included (${price({ inputTokens: 0, outputTokens: output })})`,
  ];
  return parts.join("; ");
}
