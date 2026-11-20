# Impeccable: TAWD edition change log

- **Upstream:** github.com/pbakaus/impeccable (skill folder `plugin/skills/impeccable`)
- **Pinned commit:** e0881d2de397d5e9761d7b35ff5017d8f5ebf69b (2026-09-22), skill v4.3.1, engine 0.1.5
- **License:** Apache-2.0. Original LICENSE and NOTICE.md kept unchanged.
- **Curated:** 2026-09-23 by the TAWD Skill Curator
- **Modified file (Apache notice):** `SKILL.md` was rewritten for TAWD. All files in `reference/` and `scripts/` are unmodified copies.

## Size

2.2 MB and 50+ files, down to 1.4 MB and 26 files. Most of what remains is the engine's font index.

## Security read: PASSED WITH CONDITIONS

- **The launcher downloads a program.** `scripts/impeccable` fetches the engine from GitHub releases and refuses to run it unless its SHA-256 checksum matches. That is responsible, but TAWD should not download programs during a job. Condition: install the pinned engine once (built from source or checksum-verified) and put it on PATH.
- **One outside service.** The mandatory design-direction step (`concept-seed`) calls `impeccable.style/api`. The Curator read the Rust source: it sends design parameters, not client data, and times out after about 4 seconds. Condition: allow only that host.
- **Telemetry is on by default.** The engine reports the chosen direction back to impeccable.style. Condition: always set `IMPECCABLE_NO_TELEMETRY=1`.
- **Image generation fallback.** The engine can call OpenAI's image API. Not used in TAWD; block it.
- No hidden instructions found in the skill text.

## Kept (unchanged)

`new-work`, `craft-floor`, `shape`, `init` (used as the PRODUCT.md format), `critique`, `audit`, `polish`, `bolder`, `quieter`, `distill`, `layout`, `typeset`, `colorize`, `clarify`, `adapt`, `animate`, `optimize`, `document`, and the finish-reviewer and documenter roles. Plus the engine launcher, version file, command metadata and font index.

## Cut, and why

| Removed | Why |
|---|---|
| iOS, Android and native audit/adapt files | TAWD builds websites only |
| `live`, `live-setup`, `generate`, the live-browser bundle (550 KB) and screenshot script | Interactive browser mode for a human designer; TAWD runs unattended |
| `visualize` and asset producer | Image-generation comps; TAWD renders its own mockup images |
| `onboard`, `harden` | App first-run flows, error states, multi-language |
| `overdrive`, `delight` | Push-past-the-limits effects; wrong for trust-first local sites |
| `extract`, `hooks`, `doctor`, `routing`, `craft` | Design-system tooling, editor hooks, menus and a deprecated alias |
| Windows launcher (`impeccable.cmd`) | The TAWD server runs Linux |
| 20+ copies for other AI tools, the Rust source and tests | Repository extras (source stays available upstream for building the engine) |

## Known dangling links

Kept files still mention `live.md`, `visualize.md` and the native references. The TAWD `SKILL.md` tells the model to skip those paths. Kept unmodified so the files stay identical to upstream, which makes quarterly updates easy to compare.

## 2026-11-08: the direction contract restored (B1, the design-skills diagnosis)

The audit's finding on this bundle: TAWD kept the 20% that polices floors and removed the 80%
that generates ambition, so a model handed 14 refusals and no positive direction defaulted to
the flat, signatureless page the reviewer then scores down. Restored as text, no engine needed:
a "direction contract" section in SKILL.md — THESIS / FIRST VIEWPORT / SIGNATURE, one line each
before any HTML, the signature built from the one thing only this client has, named in a
tawd-signature comment. Matches the engine-side contract in the shared concept prompt (A3) and
tells the builder how the dealt structure and the contract fit together. No upstream re-pin.
