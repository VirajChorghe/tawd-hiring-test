---
name: impeccable-tawd
description: TAWD edition of Impeccable (pinned upstream commit e0881d2, skill v4.3.1, engine 0.1.5, Apache-2.0). Builds TAWD mockup #2, a single-file HTML homepage mockup for a local service business, and runs the refine and review commands used during client feedback rounds. Use only inside the TAWD pipeline together with TAWD-PROFILE.md.
license: Apache 2.0 (see LICENSE and NOTICE.md). This file was modified for TAWD; see CHANGES.md.
---

# Impeccable: TAWD edition (mockup #2, plus feedback rounds)

**Read `../TAWD-PROFILE.md` first. If anything below or in `reference/` conflicts with it, the profile wins.**

Impeccable brings design discipline: a quality floor, a banned-patterns list, deterministic detector checks, and named refine commands (bolder, quieter, distill and others) that map neatly onto client feedback.

## TAWD run settings

- **Mode is always Persuade.** A local service homepage is a landing page: the visitor decides and calls. Ignore the Operate, Read and Experience modes.
- **Build path is always code-led.** TAWD renders the finished HTML to a PNG/JPEG itself. Skip every comp-led and image-generation step in `reference/new-work.md` (the comp round and `visualize.md`, which are not included).
- **Never ask the user.** Where the references say to ask a question, take the answer from `PRODUCT.md`. TAWD writes `PRODUCT.md` from the intake form in the format described in `reference/init.md`. Anything missing becomes a visible `[PLACEHOLDER: ...]`.
- **Live browser mode is not available.** Skip every instruction that mentions `live`, `live-server`, `live.md`, hooks or pinning. For a parameter contract that points to `live.md`, give one plain recommendation instead.
- **Native platforms are out of scope.** Ignore the iOS, Android and `.native` references.

## Engine policy (security)

Impeccable ships a small program (the "engine") used for context loading, the design-direction roll, and its detector checks. TAWD runs it under these rules:

1. **Pinned version:** engine `0.1.5` (see `scripts/VERSION`). Install it once on the TAWD server, either by building it from the open-source Rust code at the pinned commit or by downloading the release and verifying its SHA-256 checksum. Put it on the server's PATH so the launcher never auto-downloads.
2. **Telemetry off:** always set `IMPECCABLE_NO_TELEMETRY=1`.
3. **One outside call:** the `concept-seed` step asks `impeccable.style/api` for a design-direction roll. The Curator read the source: it sends design parameters (scope, mode, platform), not client data, and gives up after about 4 seconds. Allow only that host on the network. Block everything else, including the image-generation fallback.
4. If the engine is unavailable, follow the skill's own "Launcher unavailable" path: read `PRODUCT.md` and `DESIGN.md` directly, and do not invent missing context.

Launcher: `"<this-skill-dir>/scripts/impeccable" <command>` (for example `context`, `detect --json <file>`).

## Setup (each job)

1. Run `"<this-skill-dir>/scripts/impeccable" context` once, with the working folder set to the job folder that holds `PRODUCT.md`.
2. For a new homepage mockup, load `reference/new-work.md`.
3. Read `reference/craft-floor.md` immediately before any edit. It carries the quality floor and the absolute bans.

## How to design (kept from the original)

- **The brief wins.** Honor locked brand colors, fonts and materials from the intake form, even when they conflict with a pattern warning.
- **Refinement preserves; redesign replaces.** In feedback rounds, keep everything the client did not ask to change. Never replace factual copy or add claims.
- **Prove, don't claim.** Show the business doing its job with real specifics, not superlatives.

## The direction contract (restored, 8 November 2026)

The craft floor polices mistakes; this contract generates ambition. The refusals say what not to do — a model given only refusals defaults to safe and minimal, which is the flat, signatureless page the reviewer then scores down. So before writing any HTML, commit in one line each:

- **THESIS** — the page's one idea, in this client's terms.
- **FIRST VIEWPORT** — what a visitor sees without scrolling, and why it makes them stay.
- **SIGNATURE** — the page's one memorable band, built from the client's most distinctive VERIFIED detail (a specialty, a material, a number, a guarantee as written in their answers), carrying proof or usefulness, never decoration. If no detail stands out, make it the most useful band (the process, the service area, the quote form) and never claim it is unique: nothing may be stated or implied to be exclusive, the only or the first unless the client's answers say so.

TAWD's concept brief deals the structure (the hero archetype, the section order, the brand-colour deployment): the contract is how you make that dealt shape THIS client's page rather than anyone's. The three lines go in your reply before the HTML, and the signature's name goes in a `<!-- tawd-signature: ... -->` comment just inside `<body>`. A contract you could paste onto a competitor's page is a failed contract — rewrite it from this client's real answers until it fits them, without inventing anything to get there.

## Commands available in TAWD

| Command | TAWD use | Reference |
|---|---|---|
| (default new work) | Build mockup #2 | `reference/new-work.md` |
| `shape` | Plan the page before building | `reference/shape.md` |
| `critique` | Design review before the mockup is sent | `reference/critique.md` |
| `audit` | Accessibility, speed and mobile checks | `reference/audit.md` |
| `polish` | Final pass before sending | `reference/polish.md` |
| `bolder` | Client feedback: "make it pop" | `reference/bolder.md` |
| `quieter` | Client feedback: "too busy" | `reference/quieter.md` |
| `distill` | Client feedback: "too much going on" | `reference/distill.md` |
| `layout` | Spacing and hierarchy fixes | `reference/layout.md` |
| `typeset` | Font and heading fixes | `reference/typeset.md` |
| `colorize` | Client feedback: "needs more color" | `reference/colorize.md` |
| `clarify` | Button labels, form and error text | `reference/clarify.md` |
| `adapt` | Mobile and tablet fixes | `reference/adapt.md` |
| `animate` | Only when the brief asks for motion (one moment maximum) | `reference/animate.md` |
| `optimize` | Speed fixes | `reference/optimize.md` |
| `document` | After approval: record the design (colors, type, spacing) for the WordPress build | `reference/document.md` |

Removed for TAWD: onboard, harden, overdrive, delight, live, generate, extract, hooks, doctor, pin, visualize and all native-platform variants. See `CHANGES.md`.

## Output

The HTML file, a 3-line summary (palette, fonts, signature element), the list of placeholders, and the detector result from `impeccable detect --json`.
