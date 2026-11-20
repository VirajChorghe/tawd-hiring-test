# Taste Skill: TAWD edition change log

- **Upstream:** github.com/Leonxlnx/taste-skill
- **Pinned commit:** c184364c58658b2f131b4ae8bd3d206cabb3deee (2026-09-23)
- **License:** MIT. Original LICENSE file kept unchanged. Copyright (c) 2026 Leonxlnx.
- **Curated:** 2026-09-23 by the TAWD Skill Curator

## Size

The main skill file went from 87 KB to 59 KB, and 13 sub-skills (380 KB) became 1 skill plus 3 reference files (100 KB total).

## Security read: PASSED

- No scripts run. The only script in the repository (`skill.sh`) just prints file paths.
- No hidden instructions. Sponsor and affiliate links exist only in the repository README, which is not included.

## Conflict check: 4 conflicts with TAWD house rules, all overridden

| Original rule | Why it conflicts | TAWD override |
|---|---|---|
| 9.D: invent "realistic" names, phone numbers (for example `+1 (312) 847-1928`) and statistics | On a real business's site that is fabrication, and a made-up phone number could belong to a real person | Real data from the intake form only; otherwise a visible `[PLACEHOLDER]` |
| 4.8: generate images first; use picsum.photos; real company logo walls; invented brand marks | Fake photos of the client's crew, and implied endorsements from brands the client never worked with | Shutterstock comps or labeled placeholder frames only; credentials only when supplied |
| 6.C: dark mode is mandatory | Doubles the work for no benefit on local service sites | Light mode only, unless the brand requires dark |
| Redesign guide: "use realistic-sounding names" and "organic, messy data" | Same fabrication problem | Same override as 9.D |

## Replaced

- **Section 3 (React/Next.js, Tailwind, the Motion library, npm):** replaced with the TAWD stack (one self-contained HTML file, CSS-first motion, rebuildable as WordPress blocks).
- **Section 0.C (ask the user when the brief is ambiguous):** TAWD never asks mid-run; it uses the intake form or a placeholder.

## Cut, and why

| Removed | Why |
|---|---|
| Section 2 (official design systems: Fluent, Material, Carbon, Polaris and others) | Built for apps and enterprise products |
| Section 8 (dark mode protocol) | Light mode only |
| Section 10 (pattern vocabulary) and 12 (block library contract) | Reference lists for a component library TAWD does not use |
| Section 5.A-5.C (React/GSAP code skeletons) | React code; TAWD mockups are plain HTML |
| Appendices A-C (install commands, design-system sources, Apple Liquid Glass) | Not relevant |
| Sub-skills: brutalist, mobile image generation, web image generation, image-to-code, brand kit, Google Stitch, GPT variant, v1, output | Wrong style for trust-first local sites, image generation, other tools or superseded versions |

## Kept

Sections 0, 1, 4 to 7, 9, 11, 13 and 14 of the main skill (with the overrides above), plus two optional presets (`soft`, `minimalist`) and the redesign guide for clients who already have a website.

## TAWD dial settings

DESIGN_VARIANCE 5-7, MOTION_INTENSITY 1-3, VISUAL_DENSITY 3-4.

## 2026-11-08: the soft preset rewritten as "Premium for Trades" (B2, the design-skills diagnosis)

The sandboxed audit (8 November 2026) found the soft preset steering every Taste build toward
"spacious, muted, tasteful, flat and forgettable", with three direct conflicts against TAWD:
its eyebrow-pill mandate vs the skill's own eyebrow cap and TAWD's label rules; OLED-black
glassmorphism vocabulary vs TAWD's locked light client palettes; and scroll animation on every
element vs TAWD's near-still motion. `references/presets/soft.md` is rewritten around what
premium means for a local trades business — full-bleed photography, a stat strip of the
intake's real numbers, proof density, plain transparency, ONE bezel moment maximum, near-still
motion — keeping the original's performance guardrails and mobile-collapse rules. Serifs
explicitly welcome where the direction mandates them; equal offerings keep equal cells; small
labels defer to TAWD's page rules. No upstream re-pin: this is a TAWD-edition content change.
