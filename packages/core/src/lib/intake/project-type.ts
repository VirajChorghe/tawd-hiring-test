/*
  The project type (Jason, 6 October 2026, locked names; built in 0.100.0,
  docs/plans/project-type.md and flow-redesign.md Part B). When the client
  has a current website, the team picks one:

  - Design only ("keep"): the current site's pages and words, kept exactly,
    in a new design. No wireframe, no Content step: the kept pages are the
    client's own words, checked word for word after the build.
  - Design + content ("improve"): the same pages, the words improved by TAWD
    from the current site's (Home page first), the concepts designed from
    the current words.
  - Everything new ("auto"): TAWD writes every page from the intake.
  - The client is sending their own words ("manual").

  Without a current website the choice is Everything new or the client's
  words, as before; a blank choice there means Everything new. Lane 2 takes
  its words from the design and has no type.

  Stored in the intake's content.mode, so older projects keep their meaning.
*/

export type ContentMode = "auto" | "manual" | "keep" | "improve";
export type ProjectType = "design_only" | "design_content" | "everything_new" | "client_words";

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  design_only: "Design only",
  design_content: "Design + content",
  everything_new: "Everything new",
  client_words: "Client's words",
};

export const PROJECT_TYPE_MODES: Record<ProjectType, ContentMode> = {
  design_only: "keep",
  design_content: "improve",
  everything_new: "auto",
  client_words: "manual",
};

/* The modes that start from the current site's pages and words. */
export const SITE_WORDS_MODES: readonly string[] = ["keep", "improve"];

export interface ProjectTypeInput {
  lane: string | null | undefined;
  mode: string | null | undefined;
  hasCurrentWebsite: boolean;
}

/* The project's type, or null: Lane 2, or a current website with no type chosen yet. */
export function projectTypeOf(input: ProjectTypeInput): ProjectType | null {
  if (input.lane === "lane_2") return null;
  switch (input.mode) {
    // Without a current website (taken off the intake after choosing), they mean Everything new: nothing to keep.
    case "keep":
      return input.hasCurrentWebsite ? "design_only" : "everything_new";
    case "improve":
      return input.hasCurrentWebsite ? "design_content" : "everything_new";
    case "manual":
      return "client_words";
    case "auto":
      return "everything_new";
    default:
      return input.hasCurrentWebsite ? null : "everything_new";
  }
}

/* Whether a current website is answered with an address (not "No current website"). */
export function hasCurrentWebsite(website: { currentWebsiteUrl: string; noCurrentWebsite?: boolean | null }): boolean {
  return website.noCurrentWebsite !== true && website.currentWebsiteUrl.trim().length > 0;
}

/* Design only has no Content step: its pages are the client's own words, kept exactly. */
export function skipsContentStep(type: ProjectType | null): boolean {
  return type === "design_only";
}
