import type { ProjectType } from "@tawd/core/intake";

/*
  Content as one step (Jason, 7 October 2026; flow redesign Part C,
  0.100.0): the screen is one list of TAWD's steps in order, an accordion
  with one row open at a time (the next step to do open by default). Steps
  the project doesn't need stay in the list, greyed, with why. This file
  decides which step is needed and where each stands; the page fills in
  each row's line and body. No database: easy to test.
*/

export type StepKey = "read" | "quick" | "keywords" | "plan" | "words" | "client" | "suggestions" | "audit";
export type StepState = "done" | "working" | "todo" | "problem" | "waiting";
export type StepNeed = "yes" | "optional" | "no";

export interface ContentStep {
  key: StepKey;
  title: string;
  need: StepNeed;
  state: StepState;
  /** Why it isn't needed, or why it's optional; null for a needed step. */
  why: string | null;
  /** Behind "More": the extras, not part of preparing the words. */
  more: boolean;
  /*
    Said on the step's own line, open or closed, because it is the reason
    not to go on. A warning that only shows when a step is opened is not a
    warning: the design-menu one sat inside the Page plan step, which
    collapses as soon as the plan is made, so the screen that was built to
    say "this plan does not follow the design" said "Done" instead (the
    browser walk of #107, on live TAWD).
  */
  warn: string | null;
}

type Run = "none" | "working" | "done" | "failed";

export interface ContentStepsInput {
  type: ProjectType | null;
  hasSite: boolean;
  read: Run;
  quick: Run;
  research: Run;
  /** Why keyword research can't run now (DataForSEO not set up, no service yet, the cap): it becomes optional, with why. */
  researchBlocked?: string | null;
  planPages: number;
  /** The approved design's menu items the plan has no page for: the plan is made, but it is not the design's. */
  planMismatch?: string | null;
  words: { total: number; approved: number; ready: number; working: number; failed: number; notStarted: number };
  clientDecision: "approved" | "changes" | null;
  /** The only page is a supplied home page, kept as it is: no words to write, no copy for the client to approve. */
  nothingToApprove?: boolean;
  suggestions: number;
  audit: Run;
}

const fromRun = (run: Run): StepState => (run === "done" ? "done" : run === "working" ? "working" : run === "failed" ? "problem" : "todo");

export const WORDS_TITLES: Record<ProjectType, string> = {
  design_only: "The kept pages",
  design_content: "Improve and approve each page",
  everything_new: "Draft and approve each page",
  client_words: "The client's words, page by page",
};

export function contentSteps(input: ContentStepsInput): ContentStep[] {
  const type = input.type ?? "everything_new";
  const noSite = "No current website: nothing to read.";
  const fromSite = type === "design_only" || type === "design_content";
  const step = (key: StepKey, title: string, need: StepNeed, state: StepState, why: string | null = null, more = false, warn: string | null = null): ContentStep => ({ key, title, need, state, why, more, warn });
  const w = input.words;
  const wordsState: StepState =
    w.working > 0 ? "working" : w.failed > 0 ? "problem" : w.total > 0 && w.approved === w.total ? "done" : w.ready > 0 ? "todo" : input.planPages === 0 ? "waiting" : "todo";

  return [
    step("read", "The current site's pages", input.hasSite ? "yes" : "no", input.hasSite ? fromRun(input.read) : "done", input.hasSite ? null : noSite),
    step("quick", "SEO quick check of the current site", input.hasSite ? "optional" : "no", input.hasSite ? fromRun(input.quick) : "done", input.hasSite ? "Optional: what the current site ranks for, so the redirects keep it." : noSite),
    type === "design_only"
      ? step("keywords", "Keyword research", "no", "done", "Design only keeps the current site's words and addresses: no new keywords to work in.")
      : input.researchBlocked && input.research !== "done"
        ? step("keywords", "Keyword research", "optional", fromRun(input.research), `Can't run now: ${input.researchBlocked} The page plan can be made without it, from the intake's words.`)
        : step("keywords", "Keyword research", type === "design_content" ? "optional" : "yes", fromRun(input.research), type === "design_content" ? "Optional: gives the improved words real search keywords." : null),
    /*
      A plan that is made but does not follow the approved design needs a
      look, not a tick: "done" collapses the step and hides the one sentence
      that says so, and the next step after a tick is paid drafting.
    */
    step(
      "plan",
      "Page plan",
      "yes",
      input.planPages > 0 ? (input.planMismatch ? "problem" : "done") : fromSite ? (input.read === "failed" ? "problem" : "waiting") : "todo",
      null,
      false,
      input.planPages > 0 ? (input.planMismatch ?? null) : null,
    ),
    input.nothingToApprove
      ? step("words", WORDS_TITLES[type], "optional", "done", "The only page is the supplied home page, kept as it is: nothing to write or approve.")
      : type === "design_only"
      ? step("words", WORDS_TITLES[type], "optional", input.words.total > 0 ? "done" : "waiting", "Design only keeps the current site's words exactly: nothing to write or approve; the build checks them word for word. Open a page here to read it, or to add words to one the read couldn't give.")
      : step("words", WORDS_TITLES[type], "yes", wordsState),
    input.nothingToApprove
      ? step("client", "The client's approval of the copy", "no", "done", "The client approved the supplied homepage itself; there is no other copy.")
      : type === "design_only"
      ? step("client", "The client's approval of the copy", "no", "done", "The words are the client's own.")
      : step("client", "The client's approval of the copy", "yes", input.clientDecision === "approved" ? "done" : input.clientDecision === "changes" ? "problem" : w.total > 0 && w.approved === w.total ? "todo" : "waiting"),
    step("suggestions", "SEO suggestions for the current site", input.hasSite ? "optional" : "no", input.hasSite ? (input.read === "done" ? "done" : "waiting") : "done", input.hasSite ? `For the SEO team: ${input.suggestions} kind${input.suggestions === 1 ? "" : "s"} of fix found by code, suggestions only.` : noSite, true),
    step("audit", "Full SEO audit", input.hasSite ? "optional" : "no", input.hasSite ? fromRun(input.audit) : "done", input.hasSite ? "An add-on: a deeper look at the current site." : noSite, true),
  ];
}

/* The row open by default: the first needed step with something to do, else the first that's waiting. */
export function openStep(steps: ContentStep[]): StepKey | null {
  const main = steps.filter((s) => s.need === "yes" && !s.more);
  return (main.find((s) => s.state === "problem" || s.state === "todo" || s.state === "working") ?? main.find((s) => s.state === "waiting"))?.key ?? null;
}

export const STATE_LABELS: Record<StepState, string> = {
  done: "Done",
  working: "TAWD is on it",
  todo: "To do",
  problem: "Needs a look",
  waiting: "Waiting",
};
