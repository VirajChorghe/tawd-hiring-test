# TAWD - Total Agentic Web Developer

Velocity Media Lab's internal web app that turns a client brief into a live
WordPress website for local service businesses. Only the VML team logs in;
clients never do.

- Live: https://tawd.velocitymedialab.com
- Deploys: Coolify on the shared `velocity-reports` droplet, triggered by a
  push to `main`

The rulebook for how we work on this repo is in [CLAUDE.md](CLAUDE.md). The
build history is in [memory.md](memory.md). [DESIGN.md](DESIGN.md) is the
approved interface system that every TAWD screen follows, with the reference
designs in [`docs/design/`](docs/design/). The product rules that govern what
TAWD designs and builds for *clients* live in [`skills/`](skills/) and are
authoritative.

## Layout

```
apps/web/
  drizzle/       database migrations, applied on every deploy
  scripts/       migration runner and the one-time create-admin command
  src/app/       pages and server actions
  src/db/        schema and connection
  src/lib/       auth, permissions, activity log, validation
  src/lib/intake/  the intake form, its gate, the tier check and file storage
  src/components/ui/  the DESIGN.md parts: buttons, fields, badges, top bar
  src/test/      tests, run against a real PostgreSQL in the test process
skills/          product rules and pinned design skills - do not edit casually
Dockerfile       production image, built by Coolify
```

`apps/worker` and `packages/*` arrive in later phases.

## Requirements

- Node.js 24 (current LTS)
- pnpm 12.5.1 - the exact version is pinned in `package.json` under
  `packageManager` and in the `Dockerfile`. Install it with
  `npm install -g pnpm`.
- PostgreSQL, for running the app locally. The tests do **not** need it: they
  bring their own PostgreSQL along.

## Running the tests

No setup at all, and nothing to install beyond the dependencies:

```
pnpm install
pnpm test
```

The tests run against a real PostgreSQL compiled to WebAssembly, in process.
That is how the activity log's append-only guarantee can be proved rather than
assumed: the tests genuinely try to edit and delete log entries and check the
database refuses.

## Running the app locally

The app needs a database, two auth settings and the Cloudflare file storage
details. Copy `.env.example` to `apps/web/.env.local` and fill it in, then:

```
pnpm install
pnpm dev
```

Then open http://localhost:3000.

You will need a PostgreSQL to point `DATABASE_URL` at. Two reasonable
options: install PostgreSQL for Windows from postgresql.org, or use a free
hosted database for development. **Never point local development at the
production database.**

The first time you run against an empty database, apply the migrations:

```
pnpm --filter @tawd/web db:migrate
```

Then create the first admin account, as described below.

Useful commands, all from the repo root:

| Command | What it does |
| --- | --- |
| `pnpm dev` | Start the development server on port 3000 |
| `pnpm test` | Run the test suite |
| `pnpm lint` | Run ESLint |
| `pnpm typecheck` | Check TypeScript types without building |
| `pnpm build` | Produce the production build |

## The first admin account

There is no sign-up page anywhere in TAWD. Every account exists because an
admin created it. The very first admin is created by a command on the server.

In Coolify, open the TAWD application, go to the **Terminal** tab, and run:

```
node apps/web/scripts/create-admin.js --email you@velocitymedialab.com --name "Your Name"
```

It prints a temporary password once. Sign in with it and TAWD immediately
asks you to choose a real one. The command refuses to run a second time once
any admin exists, so every later account goes through the Team page where the
activity log records who created it.

## How accounts work

- Email and password only, and only `@velocitymedialab.com` addresses.
- Passwords are hashed with scrypt and sessions are rows in the database, so
  they can be revoked.
- Five failed attempts on one email address inside fifteen minutes locks that
  address for fifteen minutes.
- Disabling somebody blocks them immediately and ends their current sessions,
  while keeping everything they did in the log.
- **Team roles** (Founder, PM, Web Designer, SEO, Content) describe what
  somebody does, and a person can hold several. The separate **Admin** switch
  decides who can manage accounts. They are independent: a Founder is not
  automatically an admin.

## The activity log

Every meaningful action is recorded with who did it, what changed from and to,
when, and from which address.

It is append-only, enforced by the database rather than by the application: a
trigger rejects any attempt to update, delete or truncate the table, so no
code path in TAWD can rewrite history. Each entry also carries a fingerprint
chaining it to the previous one, so tampering by someone with direct database
access is detectable even though it cannot be prevented. The activity page
verifies that chain every time it loads.

## The client intake

Each project has an Intake section where the team collects the client's
details: business facts, services, service areas, brand, photos, content and
process. A bar at the top shows how much is answered and lists what is still
needed.

One section is on screen at a time, with a left rail showing where every
section stands and what is still required. Each section has its own Save
button in a bar pinned to the bottom of the card, and each save writes one
activity log entry naming exactly which answers changed and what they changed
from and to. Leaving a section with unsaved changes asks first: save, discard
or stay.

Uploads are the exception: they save the moment they finish and say so.
Captions are typed answers, so they save with the section.

**The gate.** A project cannot leave Intake until every required answer is
there: business name, phone, trade, at least one service, at least one service
area, licence number, year founded, Google Business Profile link, logo, and an
address unless it is a service-area business. The check covers any forward
move, not only Intake to Mockups, so a project cannot skip around it. Pausing
is always allowed.

An admin, and only an admin, can override the gate by typing a reason. The log
records the reason together with the exact list of what was missing at that
moment.

**The tier check.** More than five services, or a separate page per city,
means the project needs at least the Growth tier. TAWD shows a warning saying
which rule was triggered and never changes the tier by itself: that is a
conversation with the client and a PM's decision.

**Nothing is prefilled.** An empty field means nobody has asked yet, which is
different from the client saying no, and different again from an invented
answer. That distinction survives to the mockup, where anything missing shows
up as a visible placeholder.

## Uploaded files

Files live in a private Cloudflare R2 bucket, never on the droplet's disk.

The browser uploads straight to Cloudflare using a short-lived permission slip
signed by TAWD; the file never passes through the container. That matters
because the container has a 1 GB memory limit on a droplet shared with a
client-facing app. Viewing works the same way: a link that lasts five minutes,
issued only to a signed-in user.

| Kind | Types | Limit |
| --- | --- | --- |
| Logo | PNG, JPEG, WebP, SVG | 5 MB, one per project |
| Brand guide | PDF | 25 MB |
| Photos | PNG, JPEG, WebP | 15 MB each |
| Content documents | PDF, DOCX, TXT, MD | 15 MB each |

A permission slip cannot cap a file's size on its own, so after each upload
TAWD asks Cloudflare how big the file actually is and deletes anything over
the limit. See `.env.example` for the one-time Cloudflare setup.

## Database changes

Migrations are generated from the schema, reviewed by hand, and committed:

```
pnpm --filter @tawd/web db:generate
```

They run automatically at container start, before the web server accepts
anything. If a migration fails the container does not start, Coolify marks the
deploy failed, and the previous version keeps running.

**Migrations must be backward-compatible.** During a deploy Coolify keeps the
old container running while the new one starts, so for a moment the old code
is talking to the new schema. Never rename or remove a column in the same
deploy that stops using it: add the new one, deploy, move the code across,
then remove the old one in a later deploy.

## Health check

`GET /api/health` returns `{ "status": "ok" }`. Since 26 September 2026 it shows
the version only to a signed-in team member (open it in the browser while
signed in to TAWD: `{ "status": "ok", "version": "0.31.0" }`), so the outside
world can't tell which version is running.

Coolify uses this to decide whether a deploy came up cleanly. It deliberately
does not test the database: a brief database hiccup should not make Coolify
restart a perfectly healthy container.

## Deploying

Pushing to `main` triggers a production deploy through Coolify. Do not push
without Jason's explicit go, and finish every Coolify setting first - the push
is what triggers the deploy, so anything unsaved only takes effect on the next
one.
