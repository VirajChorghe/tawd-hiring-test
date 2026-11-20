# UI UX Pro Max: TAWD edition change log

- **Upstream:** github.com/nextlevelbuilder/ui-ux-pro-max-skill
- **Pinned commit:** dcc40ff5133ef78276117db0cc34e7b83cc8aeba (2026-09-21)
- **License:** MIT. Original LICENSE file kept unchanged. Copyright (c) 2024 Next Level Builder.
- **Curated:** 2026-09-23 by the TAWD Skill Curator

## Size

3.8 MB and ~340 files (skill folder), down to ~0.6 MB and 17 files.

## Security read: PASSED

- Python scripts only read local files. No network calls, no command execution, no package installs.
- No hidden instructions found in the skill text.

## Kept

- `scripts/search.py`, `core.py`, `design_system.py`, `reasoning_contract.py` (unchanged)
- Data: `styles`, `colors`, `landing`, `products`, `ux-guidelines`, `typography`, `icons`, `motion`, `ui-reasoning` (unchanged)
- Stack: `html-tailwind` only (closest match to a static mockup)
- `references/quick-reference.md` (unchanged)

## Cut, and why

| Removed | Why |
|---|---|
| 21 of 22 tech stacks (React, Vue, Flutter, SwiftUI, Three.js, WPF and others) | TAWD mockups are plain HTML; the build is WordPress |
| Chart, React-performance, app-interface and Google Fonts catalog data | Dashboards, apps and chart work are out of scope |
| Icon upstream catalog, font license and data-provenance files | Only used by the maintainer's data-validation script |
| `validate_data.py` and test fixtures | Maintainer tooling, not needed at run time |
| `references/pro-rules.md` | App-specific rules (safe areas, native touch) |
| Sibling skills: slides, banner design, brand, design, design-system, ui-styling | Not part of homepage mockups |
| CLI, gallery, demo projects, screenshots, docs | Repository extras |

## Verified after trimming

The design-system engine gives **identical output** to the original for four test briefs: plumber, law firm, HVAC and med spa.

## Changed

`SKILL.md` was rewritten for TAWD: category-to-query map, fixed dials, and a Curator warning. In testing, the database's default look for local trades is the category cliche (blue and orange, Poppins with Open Sans), so the palette and fonts are re-chosen while the database's structure and UX rules are kept.

## 2026-11-08: curated palette/typography tables replace the live colour and font searches (B3, the design-skills diagnosis)

The audit confirmed the Curator's own warning the hard way: the database's colour and
typography answers are the category cliche whatever the mood words, so every real design
decision bounced back to the model with no craft guidance. SKILL.md now carries two curated
tables — palette anchors per trade (each trade's real materials, extending the Curator's
documented method) and font pairings per direction family (rows taken from this bundle's own
data/typography.csv, Poppins + Open Sans explicitly excluded) — and the colour and typography
domains of the live database are no longer consulted. Also added: a design-system result
preaching "Flat Design, accent for CTA only" loses to the concept's measured colour rhythm
(it was steering builds into the exact flat page the Creative Director then scores down).
No upstream re-pin: TAWD-edition content change only.
