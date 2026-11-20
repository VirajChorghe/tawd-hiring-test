---
name: ui-ux-pro-max-tawd
description: TAWD edition of UI UX Pro Max (pinned upstream commit dcc40ff, MIT). Builds TAWD mockup #1, a single-file HTML homepage mockup for a local service business, using a searchable local database of styles, palettes, font pairings, landing-page patterns and UX rules. Use only inside the TAWD pipeline together with TAWD-PROFILE.md.
---

# UI UX Pro Max: TAWD edition (mockup #1)

**Read `../TAWD-PROFILE.md` first. If anything below conflicts with it, the profile wins.**

This skill contributes design intelligence: a local database the search tool queries for a matching landing-page pattern, style, palette, font pairing and UX rules. It does not decide the final look on its own. Treat every result as a candidate, then apply the profile's conversion floor and house rules.

## Curator warning: avoid the database's default look

Tested by the Curator (and confirmed by the 8 November 2026 design-skills audit): for local trades, the database's live answer for colour and typography is the category cliche (trust blue plus an orange button, Poppins with Open Sans, flat design), whatever the mood words. **The colour and typography domains of the database are therefore not consulted at all.** The design-system search is still run for its pattern, sections, CTA placement, colour roles and UX rules — that is where this database is strong — with `--variance` between 5 and 7.

When the intake form **locks** colors and fonts, use them exactly. When it does **not**, use the curated tables below (from this bundle's own data and each trade's real materials), and say in the summary which rows you took.

### Palette anchors by trade (reason from these materials; keep the database's roles — primary, accent for calls to action, background, text — and its contrast checks)

| Trade | Material anchors |
|---|---|
| Plumbing | copper pipe, brass fittings, deep water blue |
| HVAC | refrigerant blue, brushed steel, a warm amber for heat |
| Roofing | slate grey, terracotta, cedar shake |
| Electrical | copper wire, graphite, safety yellow only as the accent |
| Garage doors | powder-coated steel, walnut wood tones |
| Well and pump | granite, spring-water blue, cast iron |
| Glass and windows | sky-reflection blue, aluminium frame, clear white |
| Legal | oak, ink navy, parchment |
| Med spa | porcelain, eucalyptus, warm sand |
| Pest control | leaf green, earth brown, clean white |
| Home services / other | brick, lawn green, daylight white |
| Creative trades | neutral gallery white and charcoal: the client's own work carries the colour |

### Font pairings by direction (rows from this bundle's `data/typography.csv`; pick the one that fits the mood words — never row 2, "Modern Professional", Poppins + Open Sans)

| Direction family | Pairings (heading + body) |
|---|---|
| Classic Trust, Brand-Led | Corporate Trust (Lexend + Source Sans 3) · Financial Trust (IBM Plex Sans) |
| Bold Emergency | Bold Statement (Bebas Neue + Source Sans 3) · Sports/Fitness (Barlow Condensed + Barlow) |
| Modern Clean, Technical Precision | Geometric Modern (Outfit + Work Sans) · Premium Sans (DM Sans) |
| Warm Local, Bright and Friendly | Soft Rounded (Varela Round + Nunito Sans) · Friendly SaaS (Plus Jakarta Sans) |
| Premium Upscale | Classic Elegant (Playfair Display + Inter) · Luxury Serif (Cormorant + Montserrat) |
| Rugged Craftsman | Sports/Fitness (Barlow Condensed + Barlow) · Bold Statement (Bebas Neue + Source Sans 3) |
| Editorial Authority | News Editorial (Newsreader + Roboto) · Magazine Style (Libre Bodoni + Public Sans) |
| Heritage Established | Editorial Classic (Cormorant Garamond + Libre Baskerville) · Legal Professional (EB Garamond + Lato) |
| Clinical Calm | Wellness Calm (Lora + Raleway) · Accessibility First (Atkinson Hyperlegible) |

### Flat design never overrides the colour rhythm

A design-system result preaching "Flat Design, accent for CTA only" loses to the concept's colour-rhythm rule every time: the rhythm's full brand-colour (or photo-led) bands are required, and TAWD measures them on the rendered page. Take such a result's structure and UX rules; leave its colour philosophy.

## Running the search tool

The script lives in this skill's own folder. Always call it by full path. Python 3, no dependencies, no network.

```bash
python3 "<this-skill-dir>/scripts/search.py" "<query>" --design-system -p "<Business Name>" -f markdown --variance 6 --motion 2 --density 3
```

Dials for TAWD: `--density 3` (spacious marketing page), `--motion 2` (near-still; use 1 for emergency-mode trades), `--variance 5-7` (never above 7).

## Workflow

### Step 1: Turn the intake category into a query

| Intake category | Query terms |
|---|---|
| Plumbing, electrical, garage doors, well and pump, home services | `"home services <trade> local emergency"` |
| HVAC | `"home services hvac heating cooling local"` |
| Legal | `"legal services law firm trust"` |
| Glass and windows, roofing | `"home services <trade> local contractor"` |
| Med spa | `"beauty spa wellness service"` |
| Dental | `"dental practice"` |

Add one mood word from the intake form (for example "premium", "friendly", "family-owned").

### Step 2: Generate the design system (required)

Run the command above. Record the pattern, sections, CTA placement and anti-patterns.

### Step 3: Targeted searches (only as needed)

| Need | Domain |
|---|---|
| Landing page structure | `landing` |
| Font pairings | never searched: the curated table above |
| More style options | `style` |
| Product-type patterns | `product` |
| UX rules (forms, contrast, touch) | `ux` |
| Icons | `icons` |
| Motion rules | `motion` |

Keep each query to one intent and 2-5 words. If a search returns nothing, retry once with narrower words, then fall back to the profile and say so. Never present an empty search as a result.

### Step 4: Build

Build one self-contained HTML file following the profile: conversion floor, house rules, image rules and accessibility floor. For implementation notes, the only stack available is `--stack html-tailwind`; it is guidance only, so write plain CSS rather than adding Tailwind.

### Step 5: Check before delivering

Use `references/quick-reference.md` sections 1-8 (accessibility, touch, performance, style, layout, typography and color, animation, forms). Skip its navigation-app and chart sections. Then confirm:

- [ ] Phone number tappable and visible without scrolling; sticky call button on mobile
- [ ] Every credential, review and number is real or marked `[PLACEHOLDER: ...]` on the page
- [ ] Palette and fonts: locked brand values, or re-chosen and explained
- [ ] Text contrast 4.5:1 or better; visible focus states; reduced motion respected
- [ ] Looks right at 375px, 768px and 1440px

## Output

The HTML file, a 3-line summary (palette, fonts, signature element, noting which came from the database), and the list of placeholders.
