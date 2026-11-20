---
name: high-end-visual-design
description: Teaches the AI what premium looks like for a local trades business - full-bleed photography, a stat strip, proof density and restrained hardware details - and blocks the defaults that read as a template. TAWD edition, rewritten 8 November 2026 from the design-skills diagnosis.
---

> **TAWD edition note:** modified for TAWD. `../../../TAWD-PROFILE.md` and the TAWD stack (Section 3 of this skill's SKILL.md: one self-contained HTML file, no React, Tailwind or npm) override anything below. The client's brand palette and fonts are locked by the concept brief; this preset shapes HOW they are used, never WHICH they are.

# Agent Skill: Premium for Trades

## 1. Core Directive

"Premium" for a patio-cover builder, a plumber or a roofer is not what premium means for a SaaS startup. It is what the best independent trade sites do: lead with the real work photographed well, put the numbers that matter where they are seen, show prices and process plainly, and spend restraint where templates spend decoration. The visitor should leave trusting the company more, not admiring the website.

## 2. WHAT PREMIUM LOOKS LIKE HERE (POSITIVE SPEC)

Build toward these, in this order of importance:

1. **Full-bleed photography.** The client's real work carries the page. The hero and at least one more band run a photograph to the viewport edges, with the content inside holding the page's measure. A photo in a small rounded box floating in whitespace reads as a stock template. No usable photo for a band? Follow the profile's image rules — a labeled stock frame where stock is allowed, else a labeled placeholder band — never an invented or misattributed image.
2. **A stat strip.** The client's real numbers (years, jobs, rating, service-area count — only as the intake gives them) set in one quiet horizontal strip, usually directly under the hero. Large figures, small labels, no icons needed.
3. **Proof density.** Real reviews with names as given, real project photos, the licence number, the guarantee as written in the intake — placed throughout the page, not corralled into one "testimonials" corner. Every claim adjacent to its proof.
4. **Plain transparency.** The process in numbered plain steps; prices or "from" figures ONLY where the intake provides them (an invented price is a house-rule violation); service areas named concretely.
5. **One bezel moment, maximum.** The nested double-bezel card treatment is a seasoning, not a system: at most ONE band's centerpiece earns it (the quote form, or the signature band). Everywhere else, flat surfaces with hairline borders and soft, diffused shadows.
6. **Near-still motion.** TAWD pages stay calm: hover states and one gentle reveal at most. No scroll-triggered entrances on every element, no staggered mask reveals, no magnetic buttons. A visitor researching a contractor is not here to be entertained.

Serifs are welcome wherever the concept's direction calls for them (Premium Upscale, Heritage, Editorial): there is nothing inherently un-premium about a serif. The brief's locked fonts always win.

## 3. ANTI-PATTERNS (THE FLOOR — THESE STILL FAIL THE DESIGN)

- Generic 1px solid mid-gray borders everywhere; harsh dark drop shadows (`rgba(0,0,0,0.3)` and heavier).
- An edge-to-edge navbar glued flat to the top with no relationship to the hero below it.
- Decoration doing proof's job: badges, ribbons or icons asserting quality where a real number or photo could.
- **No eyebrow mandate.** Small labels above headings follow TAWD's page rules (at most one per band, never the business name, "24/7" or the city). This preset never requires one.
- A grid of equal offerings (six patio styles, four services) stays uniform — equal things get equal cells. Asymmetric bento sizing needs a content reason, never decoration.

## 4. HARDWARE DETAILS (USED SPARINGLY)

Where a surface earns emphasis (the single bezel moment, the primary button):

- **The bezel:** an outer shell with a subtle background, hairline border and generous radius; the inner core with its own background and a concentric smaller radius. Once per page.
- **Buttons:** fully rounded or softly rounded, generous padding, pressed state slightly scaled down. The two CTA wordings are fixed by TAWD's page rules.
- **Whitespace:** sections breathe (generous vertical padding), but density is not the enemy — a proof-dense band set tight reads more credible than one floating fact in a sea of space.

## 5. PERFORMANCE GUARDRAILS (UNCHANGED)

- Animate exclusively via `transform` and `opacity`; never `top`, `left`, `width`, `height`.
- `backdrop-blur` only on fixed or sticky elements, never on scrolling content.
- Any noise/grain texture only on a fixed, `pointer-events-none` layer.
- Asymmetric layouts collapse below 768px to a single column, full width; use `min-h-[100dvh]`, never `h-screen`.

## 6. PRE-OUTPUT CHECKLIST

- [ ] The hero (or another band) runs a real photograph to the viewport edges
- [ ] The client's real numbers appear as a stat strip near the top
- [ ] Proof sits next to the claims it backs, through the whole page
- [ ] No price, review or figure appears that the intake did not supply
- [ ] At most ONE double-bezel moment on the page
- [ ] Motion is near-still: no scroll entrances on every element
- [ ] Equal offerings sit in equal cells
- [ ] The locked brand palette and fonts are used as given; small labels follow TAWD's page rules
- [ ] The overall impression reads as "the best contractor in town", not "a template with nice fonts"
