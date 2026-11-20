import type { CheckIssue } from "./checks";
import { bandKinds } from "./pictures";
import { bandLabels, dropHollowReviews, unifyCallButtons, unifyFormButtons } from "../site/page-rules";

/*
  Checks for Jason's comments on Sample Plumbing Co.' concept
  (8 October 2026), on TAWD's own concepts and (since 0.103.5) on every
  built site page: a button to the form not saying "Request a quote" and a
  call button not saying "Call (number)" (both fixed by code), a reviews
  band that only asks for reviews (taken out by code), a phrase repeated on
  the first screen, more than one small label in a band, a drawn map. The
  heading over one column only is checked on the render.
*/

const plainText = (html: string) =>
  html
    .replace(/<(script|style|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const count = (text: string, phrase: string) => {
  if (!phrase.trim()) return 0;
  const trimmed = phrase.trim();
  const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  /* A number is not part of a longer one: "1970" is not in "19701", "$1970", "555-1970", "(1970)" or "1970.50". */
  const before = /^\d/.test(trimmed) ? "(?<![\\d$\\-.,(])" : "";
  const after = /\d$/.test(trimmed) ? "(?![\\d\\-)]|[.,]\\d)" : "";
  return (text.match(new RegExp(`${before}${escaped}${after}`, "gi")) ?? []).length;
};

export function checkPageRules(
  html: string,
  facts: {
    businessName: string;
    cities: string[];
    phones?: string[];
    keepReviewsToConfirm?: boolean;
    /* For the page-wide credential budget (11 November 2026): both are exact, so both can be counted. */
    yearFounded?: number | null;
    licenseNumbers?: string[];
    /*
      A supplied home page, kept as the client approved it: no rule changes
      its words, so a finding about it must not say TAWD changes it. The
      finding is still made (the team should see it), worded as what it is.
    */
    kept?: boolean;
  },
): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const keptLeft = "the supplied page is kept as written, so TAWD left it as it is.";

  if (unifyFormButtons(html).changed > 0) {
    issues.push({ id: "copy.formButton", severity: "fail", message: facts.kept ? `A button that leads to the form isn't worded "Request a quote"; ${keptLeft}` : 'A button that leads to the form isn\'t worded "Request a quote"; TAWD rewords it.' });
  }
  if (unifyCallButtons(html, facts.phones ?? []).changed > 0) {
    issues.push({ id: "copy.callButton", severity: "fail", message: facts.kept ? `A button that calls isn't worded "Call" and the number; ${keptLeft}` : 'A button that calls isn\'t worded "Call" and the number; TAWD rewords it.' });
  }
  if (dropHollowReviews(html, { keepToConfirm: facts.keepReviewsToConfirm }).dropped > 0) {
    issues.push({ id: "copy.hollowReviews", severity: "fail", message: facts.kept ? `A reviews band only asks for reviews (a placeholder, no customer's words); ${keptLeft}` : "A reviews band only asks for reviews (a placeholder, no customer's words); TAWD takes it out." });
  }

  // The first screen: the header and the hero.
  const bands = bandKinds(html);
  const first = bands.filter((b) => b.kind === "header" || b.kind === "hero").map((b) => b.section.html).join(" ");
  if (first) {
    const text = plainText(first);
    const repeated = [
      ["24/7", count(text, "24/7")],
      [facts.businessName, count(text, facts.businessName)],
      ...facts.cities.slice(0, 3).map((c) => [c, count(text, c)] as [string, number]),
    ].filter(([, n]) => (n as number) > 2) as [string, number][];
    if (repeated.length) {
      issues.push({
        id: "copy.repeats",
        severity: "fail",
        message: `On the first screen ${repeated.map(([p, n]) => `"${p}" appears ${n} times`).join(", ")}: at most twice each. Remove the small labels and lines that repeat it.`,
      });
    }
  }

  /*
    The credential budget on the WHOLE page (A2, the design-skills diagnosis,
    8 November 2026): "24/7" is the one credential a machine can count exactly
    (the licence and years take too many forms), so it is checked page-wide —
    at most twice, like the written rule says. The header and footer are
    chrome on every screen, so they are left out of the count.
  */
  const whole = plainText(bands.filter((b) => b.kind !== "header" && b.kind !== "footer").map((b) => b.section.html).join(" "));
  const always = count(whole, "24/7");
  if (always > 2) {
    issues.push({
      id: "copy.repeats",
      severity: "fail",
      message: `"24/7" appears ${always} times on the page: the credential budget is at most twice, in different forms. Keep the two strongest tellings and remove the rest.`,
    });
  }

  /*
    The founding year and the licence number, on the same budget (Jason's
    run, 10 November 2026).

    The Creative Director marked Concept A down three times for one fault:
    the hero's "Since 1970 / License #660410" line repeating the stat bar
    directly below it, a six-item list repeating band 8's spec list word
    for word, and the timeline "repeating a year already shown four
    times". Its verdict on the whole page was that the repeated trust
    facts "keep it short of a finished, sellable feel".

    These two are exact - TAWD has the year and the licence from the
    intake - so they can be counted as precisely as "24/7" was, which is
    why the credential budget could only cover that one until now.

    The CITIES are deliberately NOT on this budget: a primary city belongs
    in the H1, in the service-area band and in the copy, and local SEO
    wants it there. The first-screen rule above already stops the crowding
    that matters.
  */
  const credentials: [string, number][] = [
    ...(facts.yearFounded ? ([[String(facts.yearFounded), count(whole, String(facts.yearFounded))]] as [string, number][]) : []),
    ...(facts.licenseNumbers ?? [])
      .map((licence) => licence.trim())
      .filter((licence) => licence.length >= 4)
      .map((licence) => [licence, count(whole, licence)] as [string, number]),
  ];
  const overBudget = credentials.filter(([, times]) => times > 2);
  if (overBudget.length) {
    issues.push({
      id: "copy.repeats",
      severity: "fail",
      message: `${overBudget.map(([what, times]) => `"${what}" appears ${times} times`).join(", ")} on the page: the credential budget is at most twice each, in different forms. Keep the two strongest tellings and take the rest out.`,
    });
  }

  // At most one small label above a heading in a band, and never the name, "24/7" or the city as that label.
  const banned = [facts.businessName, "24/7", ...facts.cities.slice(0, 3)].map((p) => p.trim().toLowerCase()).filter((p) => p.length > 1);
  const crowded = bandLabels(html).filter((b) => b.labels.length > 1 || b.labels.some((l) => banned.includes(l.trim().toLowerCase())));
  if (crowded.length) {
    issues.push({
      id: "copy.labels",
      severity: "fail",
      message: `Too many small labels: ${crowded.map((b) => `band ${b.band} has ${b.labels.map((l) => `"${l}"`).join(", ")}`).join("; ")}. Keep at most one small label above a heading in a band, and never the business's name, "24/7" or the city as one.`,
      where: crowded.map((b) => b.band).join(","),
    });
  }

  // A drawn map: a big outline drawing in a service-area band.
  for (const { section, kind } of bands) {
    if (kind !== "area") continue;
    const drawn = (section.html.match(/<svg\b[\s\S]*?<\/svg>/gi) ?? []).some((svg) => {
      const pathData = [...svg.matchAll(/\sd\s*=\s*["']([^"']*)["']/gi)].reduce((n, m) => n + m[1]!.length, 0);
      return pathData > 400 || /\b(map|state|outline|region)\b/i.test(/<svg\b[^>]*>/i.exec(svg)?.[0] ?? "");
    });
    if (drawn) {
      issues.push({ id: "images.drawnMap", severity: "fail", message: `Band ${section.index} draws a map. Use a photo of the business or the area instead.`, where: String(section.index) });
    }
  }

  return issues;
}
