# TAWD hiring test: Bug #1

TAWD turns a client brief into a website. This is a trimmed copy of the real
codebase, for you to work in. **It is safe to run:** no real AI, database,
storage, hosting or email is used. The Claude API is replaced by a canned
stand-in, so there are zero API calls and zero cost. There are no secrets in
this repo; `.env.example` holds dummy values only.

## Run it (about 5 minutes, no Docker needed)

You need Node 24 or newer and pnpm 12.

```
pnpm install
pnpm repro:bug1
```

The script prints a line like `Open http://127.0.0.1:54321/ in your browser`.
Open that address. (To only write the page and not start a server, add
`--no-serve`; the file is `out/bug1/dist/index.html`.)

The data it loads (the "seed") is in `fixtures/hiring-test/`: one fictional
client, **Sample Plumbing Co.**, and the homepage the client supplied
(`supplied-home.html`). There is nothing to import.

## The page to open

The one page the script builds and serves: `/` (the home page of Sample
Plumbing Co.).

## What you should see: Bug #1

The same phone number appears in two different formats on one page:

| Where on the page | How it reads | Who wrote it |
|---|---|---|
| The big orange **Call** button, and the sentence under it (inside the page body) | `530-227-2479` | The client's supplied homepage, kept exactly as supplied |
| The **header** (top bar) call link and the **footer** (bottom bar) | `(530) 227-2479` | TAWD's shared header and footer, reformatted by TAWD's phone rule |

The terminal also prints TAWD's own notice that the header and footer differ.
Right-click the page and View Source to see all four spots.

## The task

Decide what the right behaviour is and fix it, so a supplied homepage's phone
number reads the same everywhere on the page. Two reasonable options:

- (a) the shared header and footer follow the supplied page's phone format when
  the home page is kept, or
- (b) keep TAWD's standard format everywhere and accept the difference.

Pick one, say why, and make the change. Keep it small, and update or add a test.

## Where to look

- `apps/worker/src/hiring-test/repro-bug1.ts` is the script, in the same order
  as a real build.
- `apps/worker/src/site-build.ts`: `formatSitePhones` (the phone rule that
  skips a kept page's `<main>` but rewrites the header and footer) and
  `sharedPartsNotes`.
- `packages/core/src/lib/phone.ts` (`formatPhonesInHtml`) and
  `packages/core/src/lib/site/kept-page.ts` (`passOverPage`, `sharedPartsNote`).
- `apps/web/src/test/kept-page.test.ts` and `phone-format.test.ts`: existing
  tests around this behaviour.
- `apps/worker/src/stub-claude.ts`: the canned AI stand-in (it writes the
  header and footer as `530.227.2479`; the phone rule turns that into
  `(530) 227-2479`).

Run tests with `pnpm --filter @tawd/web exec vitest run src/test/kept-page.test.ts`.

## Rules

Please don't paste real API keys anywhere, and don't try to contact any
real service. This copy is not connected to any.
