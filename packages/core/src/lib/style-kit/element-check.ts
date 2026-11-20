import type { PageInventory, SectionInventory } from "./elements";
import type { StyleKit } from "./kit";

/*
  The element check (Jason, 28 September 2026): every item of a section's
  inventory must be in the copy, styled from the kit, in the kit's fonts,
  and not clipped or overlapping. Any miss fails the section, and the
  misses are shown by name. The plan is made here; the worker's browser
  looks at the rendered copy and returns what it found.
*/

export interface CheckItem {
  /** Inventory ids this item covers (several ribbons of one class are one item with a count). */
  ids: string[];
  label: string;
  /** A CSS selector for the item inside the section. */
  selector: string;
  count: number;
}

export interface CheckText {
  id: string;
  text: string;
  /** The kit family it should be drawn in. */
  family: string | null;
  label: string;
}

export interface SectionPlan {
  number: number;
  name: string;
  items: CheckItem[];
  texts: CheckText[];
}

export type Problem = "missing" | "wrong font" | "font not loaded" | "clipped" | "overlapping";

export interface Miss {
  section: number;
  label: string;
  problem: Problem;
  detail?: string;
}

export interface CheckResult {
  sections: { number: number; name: string; passed: boolean; misses: Miss[]; checked: number }[];
  passed: boolean;
}

const KIND_WORDS: Record<string, string> = {
  panel: "the coloured panel",
  card: "the card",
  box: "the bordered box",
  button: "the button",
  ribbon: "the ribbon",
  divider: "the dividing line",
};

function quote(text: string, max = 40): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? `${t.slice(0, max - 1)}…` : t}"`;
}

export function planSection(kit: StyleKit, section: SectionInventory): SectionPlan {
  const byRef = new Map<string, CheckItem>();
  for (const e of section.elements) {
    if (e.kind === "text" || e.kind === "picture") continue;
    const ref = kit.map[e.id];
    if (!ref) continue;
    const isIcon = ref.startsWith("kit-icon-");
    const selector = isIcon ? `[data-kit-icon="${ref}"]` : `.${ref}`;
    const existing = byRef.get(selector);
    if (existing) {
      existing.ids.push(e.id);
      existing.count += 1;
      continue;
    }
    const icon = isIcon ? kit.icons.find((i) => i.ref === ref) : undefined;
    const label = isIcon
      ? `the ${icon?.label === "icon from the design" ? "icon" : `${icon?.label} icon`} (${ref})`
      : e.kind === "button" || e.kind === "ribbon"
        ? `${KIND_WORDS[e.kind]} ${quote(e.text)} (${ref})`
        : `${KIND_WORDS[e.kind] ?? e.kind} (${ref})`;
    byRef.set(selector, { ids: [e.id], label, selector, count: 1 });
  }
  const families = new Map(kit.fonts.map((f) => [f.role, f.family]));
  const texts: CheckText[] = section.elements
    .filter((e): e is Extract<typeof e, { kind: "text" }> => e.kind === "text" && e.text.trim().length > 1)
    .map((e) => ({ id: e.id, text: e.text, family: families.get(e.role) ?? null, label: `the text ${quote(e.text)}` }));
  return { number: section.number, name: section.name, items: [...byRef.values()], texts };
}

export function planPage(kit: StyleKit, page: PageInventory): SectionPlan[] {
  return page.sections.map((s) => planSection(kit, s));
}

/* What the browser reports for one section, turned into the result. */
export interface SectionFindings {
  number: number;
  found: Record<string, number>;
  texts: { id: string; present: boolean; family: string | null; loaded: boolean }[];
  clipped: string[];
  overlaps: [string, string][];
}

export function checkResult(plans: SectionPlan[], findings: SectionFindings[]): CheckResult {
  const sections = plans.map((plan) => {
    const f = findings.find((x) => x.number === plan.number);
    const misses: Miss[] = [];
    if (!f) {
      misses.push({ section: plan.number, label: `section ${plan.number} (${plan.name})`, problem: "missing" });
    } else {
      for (const item of plan.items) {
        const have = f.found[item.selector] ?? 0;
        if (have < item.count) misses.push({ section: plan.number, label: item.label, problem: "missing", detail: item.count > 1 ? `${have} of ${item.count}` : undefined });
      }
      for (const t of plan.texts) {
        const got = f.texts.find((x) => x.id === t.id);
        if (!got || !got.present) misses.push({ section: plan.number, label: t.label, problem: "missing" });
        else if (t.family && got.family && got.family.toLowerCase() !== t.family.toLowerCase()) misses.push({ section: plan.number, label: t.label, problem: "wrong font", detail: `${got.family} instead of ${t.family}` });
        else if (t.family && !got.loaded) misses.push({ section: plan.number, label: t.label, problem: "font not loaded", detail: `${t.family} didn't load, so the browser used another` });
      }
      for (const c of f.clipped) misses.push({ section: plan.number, label: c, problem: "clipped" });
      for (const [a, b] of f.overlaps) misses.push({ section: plan.number, label: a, problem: "overlapping", detail: b });
    }
    return { number: plan.number, name: plan.name, passed: misses.length === 0, misses, checked: plan.items.reduce((n, i) => n + i.count, 0) + plan.texts.length };
  });
  return { sections, passed: sections.every((s) => s.passed) };
}

/* One line per miss, for the team: "Meet the pack: the ribbon "Mia" (kit-ribbon-1) is missing (4 of 5)." */
export function describeMisses(result: CheckResult): string[] {
  return result.sections.flatMap((s) =>
    s.misses.map((m) => {
      const what = m.problem === "missing" ? "is missing" : m.problem === "wrong font" ? "is in the wrong font" : m.problem === "font not loaded" ? "is in a stand-in font" : m.problem === "clipped" ? "is cut off" : "overlaps";
      return `${s.name}: ${m.label} ${what}${m.detail ? ` (${m.detail})` : ""}.`;
    }),
  );
}
