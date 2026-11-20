import { ButtonLink } from "@/components/ui/button";
import type { NextStep } from "@/lib/next-step";

/*
  The next-step bar (30 September 2026, DESIGN.md "The next-step bar"):
  fixed to the bottom of every stage page. The status on the left, the
  one next action on the right.

  The page may hand in its own buttons (`actions`) when the next action is
  a plain one on that page (Continue to Design, Record client decision,
  Move to Build & preview). Otherwise the bar links to where the work is:
  a card further down this page, or another page. It never starts a paid
  step itself.

  No hooks, so server pages and client components can both render it.
*/

const PAGES: [RegExp, string][] = [
  [/\/intake$/, "Intake"],
  [/\/mockups$/, "Design"],
  [/\/content$/, "Content"],
  [/\/build$/, "Build"],
];

/** "Content", from "/projects/x/content#drafts"; the project page otherwise. */
export function pageName(href: string): string {
  const path = href.split(/[?#]/)[0]!;
  return PAGES.find(([re]) => re.test(path))?.[1] ?? "the project page";
}

const CARD_WORDS: Record<string, string> = {
  "#setup": "Go to the set up",
  "#site": "Go to the site",
  "#drafts": "Go to the drafts",
  "#review": "Go to the review",
};

export interface BarPlan {
  badge: "Now" | "Waiting" | "Next step";
  /** Where the work is, when it isn't on this page. */
  elsewhere: string | null;
  link: { label: string; href: string } | null;
}

/* What the bar shows, from the Next step and the page it is on. Pure, for the tests. */
export function planBar(next: NextStep, here: string, hasActions: boolean): BarPlan {
  const waiting = next.who.label === "Waiting on";
  const badge = waiting ? "Waiting" : "Now";
  // The page's own buttons are the next action.
  if (hasActions) return { badge, elsewhere: null, link: null };
  const action = next.action;
  if (!action) return { badge, elsewhere: null, link: null };
  const [withQuery] = action.href.split("#") as [string];
  const path = withQuery.split("?")[0]!;
  if (path !== here.split("?")[0]) {
    return { badge: waiting ? "Waiting" : "Next step", elsewhere: pageName(action.href), link: { label: `${action.label} →`, href: action.href } };
  }
  // On this page. While TAWD works there is nothing to press.
  if (waiting && next.who.text === "TAWD") return { badge, elsewhere: null, link: null };
  // Another part of this page (the intake's Design section, another part of Build).
  if (withQuery !== here) return { badge, elsewhere: null, link: { label: action.label, href: action.href } };
  const hash = action.href.includes("#") ? action.href.slice(action.href.indexOf("#")) : "";
  // "Open Build" reads oddly on Build itself: name the card instead.
  const label = action.label === `Open ${pageName(here)}` ? (CARD_WORDS[hash] ?? "Show me") : action.label;
  return { badge, elsewhere: null, link: hash ? { label: `${label} ↓`, href: hash } : null };
}

export function NextStepBar({
  next,
  here,
  actions,
}: {
  next: NextStep | null;
  /** This page's path, "/projects/<id>/content", with its part on Build ("?part=check"). */
  here: string;
  /** The page's own next action, when it is a plain button on this page. */
  actions?: React.ReactNode;
}) {
  if (!next) return null;
  const plan = planBar(next, here, Boolean(actions));
  const who = [...next.who.people.map((p) => p.name), next.who.text].filter(Boolean).join(", ");
  return (
    <aside className="next-bar" aria-label="Next step">
      <div className="next-bar-inner">
        <div className="next-bar-status">
          <span className={`badge next-bar-badge is-${plan.badge === "Now" ? "now" : plan.badge === "Waiting" ? "waiting" : "next"}`}>{plan.badge}</span>
          <div>
            <p className="next-bar-title">{next.title}</p>
            <p className="next-bar-who">
              {next.who.label}: {who || "the team"}
              {plan.elsewhere ? ` · on ${plan.elsewhere}` : null}
            </p>
          </div>
        </div>
        {actions || plan.link ? (
          <div className="next-bar-actions">
            {actions ?? (
              <ButtonLink href={plan.link!.href} variant="primary">
                {plan.link!.label}
              </ButtonLink>
            )}
          </div>
        ) : null}
      </div>
    </aside>
  );
}
