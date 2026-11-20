/*
  The note under the project type when it's changed on a project with work
  (0.100.0, docs/plans/project-type.md section 5): changing the type never
  changes work by itself. Browser-safe: no database.
*/

export interface TypeChangeWork {
  pages: number;
  approved: number;
  concepts: number;
}

export function typeChangeLine(work: TypeChangeWork, mode: string | null): string {
  const n = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
  const has = [
    work.pages ? `${n(work.pages, "planned page", "planned pages")}${work.approved ? ` (${work.approved} approved)` : ""}` : null,
    work.concepts ? n(work.concepts, "concept", "concepts") : null,
  ].filter(Boolean);
  const exists = has.length ? `This project has ${has.join(" and ")}. ` : "";
  const next =
    mode === "keep" || mode === "improve"
      ? "Once saved, the page plan follows the current site's pages: an empty plan or one TAWD made from the read changes by itself; a plan with the team's work waits for one decision on Content, which says what it would delete."
      : mode === "manual"
        ? "Once saved, the words come from the client's documents or pasted copy; the current plan stays until Make the page plan on Content replaces it (it says what it deletes first)."
        : "Once saved, TAWD writes new words; the current plan and its words stay until Make the page plan on Content replaces them (it says what it deletes first).";
  return `${exists}Changing the type deletes nothing by itself. ${next} Concepts already made stay as they are.`;
}
