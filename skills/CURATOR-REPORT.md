# TAWD Skill Curator Report: Round 1 (September 23, 2026)

The three design skills ranked by the scout were downloaded, security-read, matched against `TAWD-PROFILE.md`, and trimmed into "TAWD editions". Each edition is locked to an exact version, keeps its original license, and has a `CHANGES.md` explaining every cut.

## Results at a glance

| Mockup | Skill | Before | After | Security | Conflicts found |
|---|---|---|---|---|---|
| #1 | UI UX Pro Max | 3.8 MB, ~340 files | 0.6 MB, 17 files | Passed | Its default look for trades is the cliche |
| #2 | Impeccable | 2.2 MB, 50+ files | 1.4 MB, 26 files | Passed with 3 conditions | None in the text |
| #3 | Taste Skill | 13 sub-skills, 380 KB | 1 skill + 3 references, 100 KB | Passed | 4 rules that invent data, all overridden |

## The three most important findings

**1. Taste Skill tells the AI to invent "realistic" data.** Its rules say to replace generic names with realistic-sounding ones and to use "organic, messy" numbers, even giving a made-up phone number as an example. It also says to generate photos and show "Trusted by" logo walls of real companies. On a plumber's website, that means fake reviews, fake crew photos, fake stats and implied endorsements, exactly what the house rules ban. All four rules are overridden in the TAWD edition. Without the Curator, this would have gone straight into client mockups.

**2. UI UX Pro Max's database gives plumbers the template look.** Tested with plumber, law firm, HVAC and med spa briefs, its default answer for trades is trust blue plus an orange button with Poppins and Open Sans, the cliche we want to avoid. Its structure and UX rules are strong, so the TAWD edition keeps those and re-chooses colors and fonts. After trimming, the engine gives output identical to the original on all four test briefs.

**3. Impeccable depends on a small program and one outside service.** Its main build step asks the author's server (impeccable.style) for a design direction. The source code shows it sends design settings, not client data, and gives up after about 4 seconds. It also has usage reporting switched on by default. Conditions for TAWD: install the program once at a pinned version, switch reporting off, and allow only that one outside address.

## What was removed across all three

Support for apps, dashboards, mobile and desktop platforms, 20+ tech stacks, dark mode, live-browser editing, image generation, design-system catalogs for big companies, and maintainer tooling. None of it is used to build a 10-page local service website.

## Still to do before these are locked

1. **Human sign-off:** you or a senior developer read the three `SKILL.md` files and the `CHANGES.md` files.
2. **Test-drive:** one sample client, three mockups (one per skill), compared side by side.
3. **On the TAWD server** (when you build it): install Impeccable's engine 0.1.5 once, set `IMPECCABLE_NO_TELEMETRY=1`, and restrict outside network access.

## Next quarterly scout

Compare each upstream repo's newest version against the pinned commit in `CHANGES.md`. Only bring over changes that pass the same security read and profile match.
