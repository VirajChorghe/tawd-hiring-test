/*
  Data inside a prompt block can't close it (F-009, audit batch C).

  Prompts put untrusted or derived text (scraped site words, a client's typed
  request, AI-written HTML) inside XML-like blocks such as <current_page>.
  A "</current_page>" in that text would end the block early and what followed
  would read as TAWD's own instructions. fenceSafe turns the "<" of any
  opening or closing tag of a prompt block into "&lt;" and leaves every other
  tag alone, so page HTML (<div>, <section>) survives untouched.

  Every block name used by a prompt must be listed here: the prompt-fences
  test fails when a closing tag appears in the source that is neither an HTML
  element nor in this list.
*/
export const PROMPT_BLOCKS = [
  "approved_copy",
  "approved_mockup_words",
  "approved_section",
  "client_copy",
  "client_design_md",
  "client_likes",
  "client_request",
  "comments",
  "crawl_export",
  "creative_director",
  "current_page",
  "current_site",
  "design_plan",
  "current_site_features",
  "current_site_sections",
  "design_text",
  "designer_notes",
  "example_sections",
  "feedback",
  "footer_part",
  "header_part",
  "home_words",
  "impeccable_critique",
  "impeccable_polish",
  "intake",
  "last_improved_version",
  "outline",
  "page",
  "page_html",
  "previous_draft",
  "problems",
  "site_css",
  "skill",
  "style_kit",
  "styles",
  "tawd-changes",
  "tawd-part",
  "tawd-section",
  "tawd_profile",
] as const;

// Whole names only: the lookahead keeps "<pagination>" and "<page-x>" out.
// Built from a string, so each backslash is doubled: a single one is lost in a template literal (the test caught that).
const FENCES = new RegExp(`<\\s*(\\/?)\\s*(${PROMPT_BLOCKS.join("|")})(?![\\w-])`, "gi");

export function fenceSafe(text: string): string {
  return text.replace(FENCES, (_m, slash: string, name: string) => `&lt;${slash}${name}`);
}
