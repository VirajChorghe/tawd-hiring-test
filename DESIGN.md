# DESIGN.md: TAWD interface system (v1, approved September 2026)

Every TAWD screen follows this file.

**To look at the approved screens, open `docs/design/reference/`.** Every screen is there twice: as a standalone `.html` page that opens directly in any browser, and as a full-page desktop screenshot in `screenshots/`. `docs/design/reference/README.md` indexes them all.

The `.dc.html` files in `docs/design/` are the design-tool sources. They do **not** render on their own, and their markup is a tool format, so never copy it. Build with the app's own components in `src/components/`.

## Brand

**TAWD, Total Agentic Web Developer.** Always "TAWD" in running text and the short name; the full name appears in page titles and metadata. The logo (v2, approved by Kevin, 5 October 2026: "both Vs") is the agent's face: the glasses on its bar are Todd's spectacles, and a two-tone V (Velocity) is its smile. In the wordmark the "w" is drawn as two V's, the first one blue. The full logo carries the caption "BY VELOCITY".

The approved logo package lives in `apps/web/public/brand/` (its notes are in `docs/design/reference/final/logo-README.md`; Kevin's source files in `brand/v2-logo/files/`):

| File | Where it is used |
|---|---|
| `tawd-logo-compact.svg` | The top bar, 30px tall, linking to Projects (icon and wordmark, no caption: at 30px the caption would be under 4px) |
| `tawd-logo-dark-bg.svg` | The navy panel on Sign in and Signed out, 460px wide (280px on a phone) |
| `tawd-logo.svg` | The 404 and error pages (240px), documents |
| `tawd-logo-compact-dark-bg.svg`, `tawd-icon-dark-bg.svg` | Anywhere else on dark backgrounds |
| `favicon.ico` (16, 32: the V alone; 48: the icon), `favicon-16/32.png`, `tawd-favicon.svg` | The browser tab |
| `apple-touch-icon.png` (180px, full navy square) | iPhone and iPad home screen |
| `tawd-icon.svg`, `tawd-icon-192.png`, `tawd-icon-512.png` | The web manifest (`/manifest.webmanifest`) |

**Logo colors:** navy #0E1A3A (the icon tile and wordmark), blue #2B59FF (the V's left arm and the first V of the "w"), cyan #22C7E0 (the V's right arm). On dark backgrounds the tile is white, the wordmark white and the first V of the "w" cyan. Caption #4A5677 on light, #C9D2EA on dark. These are the logo's own colors; the interface's blue stays #205AF2. The lettering is Plus Jakarta Sans (800 for "tawd", 600 for the caption), converted to outlines in the SVGs, so the app does not load it; the interface font stays Hanken Grotesk.

**Navy panel** (Sign in, Signed out): background navy #0E1B3D, "VELOCITY MEDIA LAB" at the top (14/600, letter-spacing 1px, #8FA3D1), the dark logo with one line underneath ("Websites for local service businesses, from intake to launch, built by AI and checked by the VML team.", 20px, #C9D4EE), and "Internal tool. Team accounts only." at the foot (14px, #8FA3D1).

**Rules:** keep clear space around the logo of at least the height of the icon's glasses bar; never recolor, stretch, rotate or add effects; below 32px use the icon only, and at 16 to 32px the V alone (`tawd-favicon.svg`); the full logo with its caption no narrower than 240px. Plain `<img>` tags, not Next's image optimizer: the SVGs are already final.

## Tokens

| Token | Value | Use |
|---|---|---|
| ink | #18212B | Text, headings |
| muted | #5B6570 | Hints, secondary labels |
| ground | #F4F5F2 | Page background |
| surface | #FFFFFF | Cards, header |
| line | #DDE1E4 | Borders, dividers |
| field-border | #CBD2D6 | Input borders |
| blue | #205AF2 | VML blue (Velocity Reports' brand-deep). Primary buttons, done badges and markers, progress bars, stage underlines, status dots, the selected section |
| blue-hover | #1A4DD6 | Primary button hover |
| blue-text | #1A4DD6 | Text on blue tint, links, success text, "Required" on an answered field |
| blue-link-hover | #153FB0 | Link hover |
| blue-tint | #EAF0FE | Selected nav item, done badge, role chips, avatars, text button hover |
| focus | #205AF2, 3px, 2px offset | Focus outline on every control |
| focus-ring | #CFDCFD | 3px ring around a focused input, with a blue border |
| blue-shadow | #205AF2 at 25% | The soft shadow under a primary button |
| secondary-hover | #F6F8FC background, #A8B0C5 border | Secondary button hover; also table headers and note boxes |
| locked | #8A939B | Stages not reached yet |
| amber-bg | #FFF4DD | Missing/warning backgrounds and badges |
| amber-border | #E8C47A | Warning banner border |
| amber-field | #C98A1B border, #FFFBF2 background | Missing required field |
| amber-text | #8A4B00 (on white), #6B3A00 (on amber-bg) | Warning text |
| red | #B42318 (hover #912018) | Destructive or rule-bypassing actions, errors |
| disabled | #E3E6E8 background, #6B747C text | Disabled buttons |

Green is gone: VML blue replaced it everywhere on 24 September 2026. Amber stays for missing and warnings, red for destructive actions.

**Font:** Hanken Grotesk (Google Fonts, self-hosted via next/font), weights 400/500/600/700. Fallback: "Segoe UI", system-ui, sans-serif.

**Type scale:** page title 32/700 (letter-spacing -0.5px), section title 24/700, card title 16/700, body and inputs 15/400, field label 14/600, hint 13/400 muted.

**Radii:** 12px cards, 10px inner panels and upload rows, 8px inputs and buttons, 999px badges and chips.

**Spacing:** page padding 40px; card padding 28-32px; 20-28px between field groups; 6px label-to-input.

## Components

- **Buttons** (min height 44px, 8px radius, 15/600), styled after Velocity Reports so the two VML tools feel like one family: Primary (blue, white text, a soft blue shadow; on hover blue-hover and a 1px lift; one per area), Secondary (white, field-border; on hover secondary-hover), Text (no border, blue-text, blue-tint on hover), Danger (red, only for bypassing a rule or deleting), Disabled (grey tokens, no lift, `cursor: not-allowed`). Every button shows the 3px blue focus outline on keyboard focus. Danger keeps TAWD's red rather than Velocity Reports' lighter #E5484D, because white text on that red is under the 4.5:1 contrast floor.
- **Field:** label (14/600) with a word marker `Required` (blue-text once answered, amber-text while missing; 12/600) or `Optional` (muted, 12/500), never a lone asterisk. Input 15px, min height 44px, 1.5px field-border; on focus a blue border plus a 3px focus-ring. Hint text under the input.
- **Missing required field:** amber-field border and background, plus a hint in amber-text that says why it matters ("Missing. Shown in the trust band and footer.").
- **Error:** red border and a red hint that says how to fix it.
- **Badges:** Done (blue-tint / blue-text), Missing and Needs Growth (amber-bg / #6B3A00), Optional and info (#EDEFEA / #4B555E). 12px, weight 600-700.
- **Team line** (project header, after the chips and a thin divider): "Team:" in muted, then each member as a 26px blue-tint initials circle, first name and roles in brackets ("Jason (PM)"), then an "Edit team" link for people who can change the team.
- **Avatar:** initials in a blue-tint circle with blue-text, 40px in tables, 26px in the team line.
- **Danger area:** the one place a destructive action lives on a page, at the very bottom: a white box with a red-border outline, a red card title, one paragraph saying exactly what goes and what stays, and the danger button on the right. If the action is blocked (a live project), the button is disabled and an amber line says why.
- **Chips** (service areas): blue-tint pill with the city name and an × remove button that has an aria-label.
- **Uploads:** a dashed drop zone ("Drop files or choose", with the limits underneath); while uploading, a row with a blue progress bar and a percentage; when uploaded, a row with the file name and "Uploaded and saved, 75 KB" in blue-text; when rejected, a red-tinted row with the reason and the limit.
- **Save bar:** one per section, pinned to the bottom of the section card (sticky). Clean: blue dot plus "No unsaved changes" (or "Saved just now"), and the button reads "Saved" and is disabled. Dirty: amber background, "Unsaved changes in {Section}", with Discard (secondary) and "Save {Section}" (primary).
- **Warning banner:** amber-bg, amber-border, an alert icon, a bold title, one plain sentence, and an optional action button on the right.
- **Top bar:** white, 64px, the compact logo (30px tall, links to Projects), nav links (muted; the active one ink with a 2px blue underline), user email and Sign out on the right.
- **Top progress bar** (Jason, 7 October 2026): while the next screen loads, a 3px line in the logo blue #2B59FF (solid, no gradient or glow) across the very top of the window, above the top bar. It appears only if the move takes over 150 ms, creeps towards 90%, fills and fades when the new screen shows, and is gone after 15 s at the latest. Not shown for saves that stay on the same screen (`router.refresh()`), new-tab or modifier clicks, other sites, downloads, hash links or the same address. With reduced motion: a still full-width line at 60% while loading, removed when done. Indeterminate `role="progressbar"`, labelled "Loading the next screen", hidden from assistive technology when idle; no focus change. This is the one place the interface uses the logo blue; everything else stays #205AF2.
- **Sign out:** signs out at once, unless the page has unsaved changes. Then a dialog asks "Sign out of TAWD?", names what would be lost ("You have unsaved changes in the Business section of Pat Rivera's intake. Signing out will discard them."), and offers "Stay signed in" (secondary, focused) and "Sign out" (primary). Either way it lands on the Signed-out page, never a bare bounce to Sign in.

## Intake page layout (the approved design)

1. **Project header** (white band under the top bar, the same on every project screen): breadcrumb, project name (32/700), chips for trade, tier, lane and concept count, then the team line. On the right, while required items are missing: the gated "Move to Mockups" primary button (disabled, with a hint under it: "3 required items missing. Complete them to continue.") and, for admins only, a text button "Override gate". Once the intake is complete: a primary "Continue to Mockups" button with an arrow, and under it "Intake complete. All 10 required items answered." Each stage's screen shows the matching "Continue to (next stage)" once that stage is done.
2. **Stage navigation** along the bottom of the header: the project's steps, **one bar, lane-aware** (29 September 2026, see "The project's steps and the Next step card"). Lane 1: Intake, Design, Content, Build & preview, Go live, Updates. Lane 2: Intake, Client's design, Build & preview, Go live, Updates (1 October 2026). There is no QA step. Reached steps are links; a done step has a filled blue circle with a check, a current or next-available step an outlined blue circle with its number. Under each label, one short muted word or two for its state ("Done", "Now", "Can start early", "Next"). The step whose screen you are on is blue-text with a 3px blue underline. Steps not reached yet are locked grey with a lock icon, not links, with a tooltip saying what unlocks them ("Unlocks after the client approves a concept").
3. **Body:** a two-column grid (300px left rail, then the section card).
   - **Left rail** (sticky): a "Required info" card showing the count ("7 of 10"), a progress bar, and the list of missing items. Each item is a button that jumps to its section and focuses the field. When nothing is missing, the card says "Everything required is answered." in blue-text, shows a full-width "Continue to Mockups" button, and "You can still edit the intake later. Changes show up in the next mockup run." Below it, a section nav listing all 9 sections, each with a status badge (Done, N missing, Needs Growth, Optional or a count). The selected section uses blue-tint with blue-text.
   - **Section card:** **only the selected section is shown.** A title (24/700) and a one-line purpose, then the fields, then the sticky save bar.
4. **Uploads live inside their own section:** logo and brand guide in Brand; photos in Photos, as cards (thumbnail, caption input, View, Remove); content documents in Content. Uploads save instantly and say so. **Captions and all typed fields save with the section's Save button.**
5. **Hours:** a 7-row grid (day, opens, closes, closed checkbox) plus a "24/7 emergency service" checkbox above it.
6. **Services:** rows (main-service radio, name, short description, remove), then "Add a service". The Growth-tier warning banner sits at the top of the section when triggered, with a "Change tier" button for PMs and admins.
7. **Content mode:** two large selectable cards (Auto / Manual), not a small radio.
8. **Override dialog** (admins only): a modal with the title "Override the intake gate?", one sentence on the consequence, the missing items in an amber box, a required reason textarea with the hint "Recorded in the activity log with your name, the time and the missing items.", and Cancel plus the danger button "Override and move to Mockups".
9. Leaving a section with unsaved changes asks: save, discard, or stay.

## Team page (approved 24 September 2026)

Reference: `docs/design/reference/cleanup/team.html`, `team-edit-panel.html` and `team-add-dialog.html`; sources in `docs/design/cleanup-team.dc.html`.

1. **Header:** "Team", the line "Everyone who can sign in to TAWD. Only admins see this page.", and the primary "Add team member" button with a plus icon on the right.
2. **Toolbar:** a search box ("Search by name or email", with a search icon) and a segmented Active / Admins / Disabled filter, each with its count. Active is the default; disabled people appear only under Disabled. Deleted people never appear.
3. **Table** in a white card, header row on secondary-hover: Person (avatar, name, a "You" badge on your own row, email underneath), Team roles (blue-tint role chips, or "No roles yet" in amber), Access (an Admin badge), Status (a blue dot and "Active" or a grey dot and "Disabled", with "No password set yet" in amber underneath when it applies), and a secondary Edit button.
4. **Edit side panel** (480px, slides in from the right over a dimmed page): the name and email at the top with a close button; Name; Team roles as toggle chips (selected is solid blue) with "A person can hold several roles. Roles decide who approves what."; an Admin access box with an explanation and a checkbox; an Account box with the status, Enable or Disable account, Reset password, and "Reset password creates a temporary password shown once. They must change it at first sign-in."; Cancel and "Save changes" at the bottom. The guards show as disabled controls with the reason: the last active admin cannot lose admin or be disabled, and nobody can disable themselves. At the bottom, a danger area "Delete team member" (see below).
5. **Add dialog:** "Add a team member", "There is no sign-up page. Accounts exist only because an admin creates them here.", Name, Email ("Must be a velocitymedialab.com address."), the role chips, the Admin checkbox, a grey note about the temporary password, and Cancel / "Create account". After creating, the dialog shows the temporary password once, with Copy.

## Spend page (approved 24 September 2026)

Reference: `docs/design/reference/spend/` (one page and screenshot per tab); source in `docs/design/spend.dc.html`. Admins only, with "Spend" in the top bar for admins.

1. **Header:** "Spend", the line "AI costs across TAWD: where it went and who started it. Admins only.", then on the right a Period dropdown (the last 12 months, Last 3 months, Custom range with two dates and Apply) and a secondary "Export CSV" button with a download icon.
2. **Four cards:** Spent this month (large figure, "of $20.00 monthly limit", a blue bar against the limit that turns amber at 80%, the line about the Anthropic console, and "Change the monthly limit"); Concepts built (with the run count and any that failed before starting); Average per concept (including fix rounds and review); Average per project (across projects with runs). All money shows cents.
3. **By day chart:** one blue bar per day, grey stubs for empty days, four date labels under it, and a dark tooltip on hover or keyboard focus: "Sep 24: $2.59 in 3 runs".
4. **Tabs** in a white card (the selected one blue with a 3px underline): By project (deleted projects labeled "(deleted project)" in muted text), By person, By step (Build, Automatic fix rounds, Creative Director review) and All runs (each linking to its Mockups page; status in blue for Succeeded, amber for anything needing attention, grey otherwise). Each tab ends with a one-line note.
5. **Spend warning:** at 80% of the monthly limit an amber strip under the top bar for admins, on every page; at 100% it turns red and says new runs are paused, and Generate is disabled with the same explanation.

## Sign in, Signed out and Projects (approved 24 September 2026)

Reference: `docs/design/reference/final/` (pages and screenshots); sources `docs/design/final-*.dc.html`.

1. **Sign in:** the split layout, navy panel on the left (see Brand) and the form on the right, 400px wide: "Sign in" (32/700), "Use your velocitymedialab.com account.", Email (placeholder name@velocitymedialab.com), Password with a Show/Hide text button beside its label, a full-width 48px primary "Sign in", and the help line (since 25 September: a "Forgot password?" link under the password, and "New to the team? A TAWD admin creates your account."; see below) Errors sit in a red alert with an icon above the fields: "Email or password is incorrect. After 5 tries, sign-in pauses for 15 minutes." A non-velocitymedialab.com address gets a field error under Email.
2. **Signed out:** the same split layout; on the right a 56px blue-tint circle with a check, "You're signed out", "Your session on this device has ended. If you're on a shared computer, you can close this tab.", and a full-width primary "Sign in again".
3. **Projects:** header "Projects" with "Every website in progress, and where each one stands." and the primary "New project".
   - **Stage tiles** (All projects, Intake, Design, Content, Build & go live, Live; Paused only when a project is paused), across the row, each with its count (grey when 0); they filter the list, and the selected one is blue-bordered on #F3F6FF.
   - **Toolbar:** search by business name, a trade filter (only trades that have projects), "Assigned to me", and Sort (Last activity by default, Name, Stage) on the right.
   - **Rows** in a white card, each linking to the project: name (16/700) with trade and tier chips; a segmented stage bar, one segment per step of the project's lane (5 for Lane 1, 4 for Lane 2; done #205AF2, current #9DB7FA, later #E3E6E8) with the current step's name; Needs attention with a dot (amber for something to fix: required items missing, checks failed on N concepts, Needs PM review, Needs intake info, review didn't finish, last run failed; blue for the next step ready: Ready for Mockups, Ready to generate concepts, Generating concepts, Ready to send to client; a dash for nothing); overlapping 32px team avatars; last activity (a short line such as "Jason ran 1 concept", and "Today, 12:10 PM", "Yesterday" or a date, Pacific time); and a chevron.
   - **Empty states:** no projects at all (only the header, then a card: "No projects yet", one line and New project; no tiles or toolbar), or none matching ("No projects match" with Clear filters).

## Screen sweep additions (24 September 2026)

Built with DESIGN.md's tokens and components; no separate reference design.

1. **New project and Edit project** (`/projects/new`, `/projects/[id]/edit`): breadcrumb, title, one-line lede, then one white card, in a 960px column. Business name and Trade side by side; **Tier** as three selectable cards (Starter "Up to 10 pages", Growth "11 to 20 pages", Pro "21 to 50 pages"); **Lane** as two cards (Lane 1: no design supplied; Lane 2: design supplied), and Lane 2 reveals two more cards, Option A "Client approved, build it" and Option B "Review and improve"; **Concepts** as a 1 / 2 / 3 segmented control (3 for Lane 1, 1 for Option B, hidden for Option A), with a hint; **Team** as a grid of people (checkbox, avatar, name, role chips). Cancel and one primary button on the right: "Create project and open intake" or "Save changes". Selected cards are blue-bordered on blue-tint with a blue title. The cards are real radio inputs, visually hidden. **There is no stage field**: a new project starts at Intake and opens its intake; editing keeps the stage, which only changes through the stage flow and its gates (admins keep the gate override).
2. **Choose your password** (first sign-in): the Sign in split layout. Temporary password, New password (with Show/Hide), New password again, then a grey box of rules that tick blue as they are met (at least 12 characters, different from the temporary password, both match), a hint, and a full-width "Save and continue".
3. **404 and error pages:** centered on the page background: the logo, a heading ("Page not found" / "Something went wrong"), one plain sentence, and a primary "Back to Projects". The error page adds a secondary "Try again" and an error reference for an admin, never the technical message.
4. **Empty states:** a white card with centered content: a title (16/700), one friendly line, and the main action if there is one ("No projects yet" and New project; "No entries match" and Clear filters). In a table, one muted line in the table body ("Nobody matches "x".").
5. **Delete team member** (admins only): a danger area at the bottom of the Team edit panel saying what goes and what stays ("Their history is kept and shown as "(deleted user) Name""), and a danger button "Delete {name}". Blocked with the reason for yourself and for the last active admin. It opens a dialog over the panel: "Delete {name}?", what happens, "Type {name} to confirm", a required reason (at least 10 characters, recorded in the activity log), Cancel and a danger "Delete permanently" that is disabled until both are filled. Everywhere history is shown, the person appears as "(deleted user) Name".
6. **History** (project page) and the **Activity log** read as plain words: the action in bold, who and when on the right, and what changed underneath ("Tier: Starter to Growth", "Added Priya Shah", "Business: phone"), never raw ids or data. The system appears as "TAWD".
7. **Tables:** header cells are 13/600 muted, sentence case, on secondary-hover. Never uppercase.

## Rules

- One primary action per area. Red only for bypassing a rule or deleting.
- Every interactive element is a real `<button>`, `<a>` or `<input>` with a label; icon-only buttons have an `aria-label`.
- Text contrast of at least 4.5:1. Touch targets of at least 44px.
- Light mode only. No emoji as icons (use one stroke icon set). No gradients.
- Copy is plain and specific: say what happens ("Save Business", "Uploaded and saved"), never "Submit".
- Times are Pacific and say so: "Oct 7, 2026, 3:20 PM PT" (fixed "PT", never PDT or PST; 0.96.0). Date-only lines (the legal pages) have no zone.

## Mockup engine screens (Phase 3, approved)

Reference designs: `docs/design/mockups-setup.dc.html`, `mockups-generating.dc.html`, `mockups-concepts.dc.html` and `mockups-detail.dc.html`. They use the same tokens and components as the rest of this file.

1. **Set up concepts** (project stage Mockups; Intake shown as done in the stage strip):
   - A 1/2/3 segmented control for the concept count. The cards and the estimates update to match.
   - One card per concept (A, B, C), each with: a direction dropdown (the 13 from `skills/DIRECTIONS.md`, pre-selected by its rules), a tag (for example "Required for emergency trades"), the direction's one-line look, the skill that builds it, and the design-log result ("No clash nearby", or an amber warning).
   - A "Why these directions" box, then a primary "Generate N concepts" button.
   - Right panel: the 5 steps of what happens next, the estimated time and AI cost, and a note that the user can leave the page.
2. **Generating:**
   - An overall progress bar.
   - A table with one row per concept and 5 step columns (Build, Quality checks, Creative Director, Improve, Final checks). Each cell shows Done (blue), Working (amber), Waiting, Skipped or Not run (grey), or **Didn't finish** (amber), plus a short note. No cell is ever red: a step that stopped needs attention, it is not a crash, and a concept held under 4.5 is a normal outcome (9 November 2026). When something stops a run, only the step that was actually running reads "Didn't finish"; the steps after it never started and read "Not run" in grey.
   - Stop button. Everyone assigned to the project is emailed when it finishes.
3. **Concepts ready:**
   - A blue status banner.
   - One card per concept: the desktop render (top-cropped), name, direction and skill, badges (review score before and after, checks passed, placeholder count in amber, version), the signature line, the open-comment count, a "Send to client" checkbox, and Open.
   - Below the cards, a 3-step strip: team review, Download client pack (the ticked concepts as desktop PNGs labeled Concept A/B/C), Record client decision.
   - **Record client decision** dialog: concept picker cards (with thumbnails), how it came in (phone call, email or meeting), changes requested yes/no, and what the client said. Changes requested creates a new version for the team to check. Approved as-is moves the project to Content.
4. **Concept detail:**
   - Header: concept name, a version selector, All concepts, and Request changes.
   - Left: the full-size render with numbered comment pins. Clicking the design adds a pin.
   - Right: tabs **Team comments**, **Review** (the Creative Director questions, nine since 27 September 2026, before and after scores, with notes), **Checks** (the passed checks plus an amber box listing the placeholders still needed) and **Versions** (what changed in each version, plus a side-by-side comparison).
   - Team comments start with the line "Comments stay with the team. To send them to TAWD, use Request changes." Each comment shows a **Not sent** or **Sent in vN** tag, with Resolve and Reply.
   - **Request changes:** a notes field plus "Include the open pinned comments" (on by default). It creates the next version with the same direction and skill, reruns the checks, and marks the included comments as sent.
   - **Sections and the review round (0.83.0, 2 October 2026):** moving over the design outlines the section under the mouse (2px blue border, a 6% blue wash, the section's name in a blue chip top left); a new pin keeps its section ("Comment for pin 4, on "Our services"") and the outline stays on it until it is posted. An unposted comment and unsent Request changes notes are kept in the browser ("Draft kept in this browser until you post it."). After a round each sent comment also shows **Done in vN** (blue tag) or **Not done in vN** (amber tag) from the Creative Director; the comment stays open until a person resolves it. Not-done comments sent once get an amber box at the top of Team comments, "2 comments not done (3, 5)", with a secondary **Try these 2 again** (confirmation with the estimate; never automatic); after two tries the comment says "Not done after 2 tries. Reword it as a new comment, or ask the Web Designer." Under the header, when nothing is working: "Last requested changes: v5: all checks passed; ...; 2 of 3 comments done." The Request changes estimate is measured from the rounds so far (cents, not dollars).

### As built (3c, 24 September 2026)

The four screens follow the reference designs in layout and wording, in VML blue (the references predate it: their dark green is `--blue`, their green tint `--blue-tint`). Details the references left open:

- **One page, three screens.** `/projects/[id]/mockups` shows Generating while a run is working, the concepts once a run has any, and Set up otherwise. Regenerate asks first ("Generate new concepts?"), then opens Set up (`?setup=1`); the old run moves to **Earlier runs** at the bottom, with its concepts, versions and comments kept.
- **Set up:** the tag on each card is "Required for emergency trades" (amber), "Suggested" (blue-tint) or "Changed by you" (grey). The estimate shows whole dollars ("Around $2 to $9") and the time comes from real runs once there are any ("About 20 minutes"), with the line "Based on N concepts built so far." The footer names the required facts the intake lacks. A run that produced nothing shows a red banner above the count.
- **Generating:** the project header stays (it is on every project screen); Stop is for PMs and admins. The design's "Preview: skip to results" was a prototype shortcut and is not built.
- **Concepts ready:** the banner turns amber when a concept needs a PM's look, failed, or the review didn't finish. A concept being changed shows "Making v3: ..." in amber on its card. Download client pack is a zip of the ticked concepts' newest desktop renders, "Concept A.png" and so on.
- **Record client decision:** no concept or yes/no is pre-selected; Save is disabled until a concept, yes or no, and what the client said are filled. The hint under the text says exactly what will happen ("TAWD makes v3 of Concept B..." or "The project moves to Content with Concept B v2."). Once approved, the Mockups page is read-only with a blue banner: "The client approved Concept B v2", when, how and what they said.
- **Concept detail** (`/projects/[id]/mockups/[conceptId]`): the render scrolls inside its frame (about one screen tall) and pins scroll with it. A new pin shows in amber until its comment is posted. Comments are numbered in the order they were made; a pin appears only on the version it was placed on, and comments from other versions say "Pinned on v1". Resolved comments fold under "Show resolved (N)". Tags: **Not sent** (amber), **Sending in vN** (grey, while it is being made), **Sent in vN** (blue). `?tab=review|checks|versions` opens a tab, `?v=N` an earlier version, `?compare=N` puts a second version beside it (Versions tab: View, Compare with vN; Stop comparing).
- **Checks tab:** eight plain-language groups (text contrast, tap-to-call and a form, no invented facts, no filler words, placeholders shown clearly, the client's logo and photos used, nothing runs off the screen, page title and description), each with a blue check, or amber or red with the message; then the amber box of placeholders still needed.
- **Request changes** replaces the right panel: notes, "Include the N open comments" (on by default when there are any), the cost ("About $1 to $2 of AI"), Cancel and "Create vN". Disabled, with the reason, while a version is being made, while concepts are generating, or at the monthly AI limit.
- **Content stage:** until Phase 7, the project page shows a card "Content arrives in Phase 7" pointing to the Mockups page.

### Slack and the client's pick (3d, 24 September 2026)

- **Slack card** on the project page, above History (anchor `#slack`): title "Slack", one line ("Slack not connected. Updates for this project stay in TAWD." or "Posting to Slack through the webhook ending x9Kq."), and a status pill on the right (grey "Not connected", blue "Connected"). Not connected: an "Incoming webhook URL" field with the hint about the Incoming Webhooks app and that it is stored encrypted and never shown again, and a primary "Connect Slack". Connected: the last update or the last failure (amber), the "Also post new team comments (who commented and on which concept, never the text)" checkbox, then Send test message and Replace (secondary) and Disconnect (text). A closing line lists what is posted. PMs and admins see the controls; everyone sees the status.
- **Slack warning:** when a post fails, an amber strip across the top of every project header (and the concept detail header): "A Slack update didn't go through (time): reason. Check the Slack setting", linking to the card. It clears on the next successful post.
- **Set up cards line up:** the card head keeps the same height whether or not its tag wraps, and "Built with / References / Design log" sit at the bottom of every card. **References** (0.99.0, only once a reference site is studied) uses the Design log's look: a check and "2 of the 3 studied reference sites lean this way", or a warning icon and "None of the 3 studied reference sites lean this way (they lean to Classic Trust, Warm Local)".
- **Reference sites used (0.99.0):** on each ready concept card, under the summary line, a folded `<details className="hint">` "Reference sites used: about N%"; open, a list with one item per site (its address without https and www, 600 weight, ": about N%"), then, each on its own line, "The client likes: ..." when the intake says, "Taken: ..." and "Not taken: ...", and a closing line saying how it was measured (and that an approved wireframe set the order, when it did).
- **Held concept (0.102.0):** a concept scored under 4.5 after its one rewrite keeps its card in the row but shows no render: the render area reads "Held: under 4.5" in the empty-render style; under the direction line, a hint "Held by TAWD, not shown to the team or the client: it scored ... Only concepts at 4.5 or above are shown."; for admins only, a small secondary **Show it anyway**, which opens an inline confirm ("Show Concept B to the team and the client, under 4.5? This is logged.", Cancel, primary **Yes, show it**). No Send to client box, badges or Open on a held card. The ready banner turns amber and names the held concepts; with none shown its title is "No concept reached 4.5".
- **Client's pick:** once the client approved, the chosen concept card has a 2px blue border with a soft blue shadow and a solid blue "Client's pick" badge beside its name; the other cards fade to 60% (back to full on hover or keyboard focus).

### Fixes from the first full test run (25 September 2026)

- **Intake gate is a warning.** With required items missing, "Move to Mockups" stays a primary button (for PMs and admins) and the hint under it is amber: "5 required items missing. You can continue; they show as placeholders." It opens **Continue without these?**: the missing items in the amber box, an optional note, Cancel and a primary "Continue without these". Logged as "Continued without required items" with the list. There is no admin-only override any more.
- **Business section:** two checkboxes under the fields: "New business, no Google Business Profile yet" (the link's marker reads "Not needed") and, for licensed trades only, "License in progress" (the license marker reads "In progress"). For legal, med spa and "other" the license marker reads "Not needed for this trade".
- **For the go-live check:** an amber-tinted card on the project page listing what the founders must see before go-live (a missing or in-progress license for a licensed trade). It never blocks anything.
- **Chips fields** (mood words, competitors): chips inside a bordered box that looks like an input (blue focus ring); Enter or a comma adds one, pasting a list adds several, Backspace in the empty box removes the last.
- **Checks tab:** issues only the client can fix sit in a separate amber "Needs intake info" box ("no automatic fix round is spent on them"); information-only items (the 44px tap targets on desktop) show with a blue check and a grey note.
- **Why the review stopped:** on the concepts banner, a bold "Why the review stopped:" line with a plain sentence, then Anthropic's own words in muted text.
- **Direction advice:** breaking the Bold Emergency rule shows an amber "Worth a second look" banner on Set up; Generate stays available.

### Cheaper fixes and a sturdier review (25 September 2026)

- **Generating, Quality checks column:** fixes made by code are named first, then any AI rounds: "Fixed by code: contrast, title length; 1 fix round; all passed".
- **Concepts banner, review stopped:** the reason names the concept ("Concept B: ..."), and a secondary **Run the review again** button sits under "Finished ..." on the right, for PMs and admins, only while a concept is missing its review. It opens a confirmation: "Run the review again for Concept B?", what it does (only those concepts, from where each stopped; finished reviews kept; nothing built again; still under 3 means flagged for the PM), a second line saying that first, at no cost, it reads again any review answer already paid for and runs the checks again, and only pays for a new review if that is not enough, the cost ("About $1 to $2 of AI", the most it can cost), Cancel and a primary "Run the review again". While it works, Generating reads "Running the review again".
- A concept whose review is missing shows a grey **Not reviewed** pill on its card.
- **Spend, By step:** columns Step, Times run, Per call, Per concept, Share, Total, with the note that code fixes cost nothing and are not counted.

### Sections-only edits and stuck runs (25 September 2026)

- **Spend, By step, second table:** under the first, set off by a thin rule and a 16px bold heading "Whole page vs sections only". Columns Step, Whole page per edit, Sections only per edit, Saving; one row each for Automatic fix rounds, Creative Director improvement and Requested changes. Each cost shows the number of edits in brackets ("$0.58 (5)"); a dash where there were none. The note says when each step changed and that sections only includes the small call that finds the sections.
- **Failed to start:** a run TAWD settled because the worker never finished it shows **Failed to start** (red, like Failed) in Earlier runs when no AI was spent, as it already did on Spend; its reason shows where a failed run's reason does. A run that had built some concepts shows **Review didn't finish** instead, with Run the review again.

### Figma part 1, stop 4a: the designer's design (25 September 2026)

Built from the existing parts (no approved reference yet); screenshots in `E:\tawd-work\tawd-4a-screens`.

- **Intake, Figma design section:** Lane 2, Option B projects only, as a tenth item at the bottom of the section nav, with a badge: Not linked or Can't read (amber missing), "N warnings" (warning), Checked (info), Imported (done). The card has the usual 24/700 title and one-line purpose ("nothing here blocks the project"), then a Figma link field (marker "Lane 2, Option B") with a primary **Save and check** beside it, and a hint that each check uses one of the Figma key's reads, with this month's count. There is no save bar: the buttons save.
- **The check result:** a panel with a light header (file name, "Checked today, 3:19 AM", the warning count and that none blocks) and a secondary **Check again** on the right; then one row per finding, a Done-style "OK" badge or a "Warning" badge, a 15/600 title and a hint line. Warning rows have the amber-field background. Then "Final frames from the page ..." with a text button **Choose a different page** (or, when no page says final, a page select, defaulting to the page with the most frames, and a primary **Use this page**, marked "From the saved file, no Figma read"). Then the import row: a hint and a primary **Import the design**; while importing, the amber working line; once imported, an "Imported" badge with "2 frames, today, 3:19 AM by Jason", any import warnings in amber, **See it on Mockups** and **Import again**.
- **Can't read:** the red error banner "The file couldn't be read" with the plain reason (the key expired or was revoked; the key can't open the file; the read limit; Figma not answering; Figma not set up) and **Check again**.
- **Mockups, The designer's Figma design** (titled "Concept 1: Designer's design" until 26 September 2026, when Concept 1 became the improved version on the board): a white card above everything else on the page for Option B projects. Title 20/700, "From Figma: file name. Imported today, ... by ...", badges "Designer's own" (info), the warning count or Ready, and "Changed in Figma since" when it is out of date; **Figma section** (secondary) and **Open in Figma** (text) on the right. The homepage frame scrolls inside a 720px render frame, labeled "Home (homepage)"; the other frames are 220px thumbnails on the right with their names, each opening full size. A hint says TAWD reviews and improves the homepage; the other frames are kept for the site build. Before the import, the card is one line and a button to the Figma section.

### Figma part 1, stop 4b: the Creative Director's review of the design (25 September 2026)

Built from the existing parts; screenshots in `E:\tawd-work\tawd-4b-screens`.

- **Mockups, Option B:** no Lane 1 set up at all (no Generate), until 4c brings the improved Concept 1 and alternatives. Under the Concept 1 card, a white **Creative Director review** card: title 20/700, then either one paragraph on what the review does plus the estimate line ("About $0.30 of AI (a first guess until a real review has run)", later "from the reviews so far") and a primary **Review the design**; the amber working line while it runs; the red reason if it didn't finish, with **Review again**; or, once done, the score line (20/700, "3.4 of 5 on average, lowest 2"), badges "3 must-fix" (missing), "3 should-fix" (warning) and "2 recommendations" (info), the summary, and a hint with the ticked count, when, who started it and what it cost, with a primary **Open the review** and a secondary **Review again**. Review and Review again open a confirmation dialog with the estimate before anything is spent.
- **Design review page** (`/projects/[id]/mockups/design`, crumb "Design review"; `?tab=scores` opens the scores): the concept detail layout. Left, the homepage frame in the scrolling render frame with a numbered pin on each finding's layer: red for Must-fix, dark amber for Should-fix, grey for Recommendations; a clicked pin selects its finding. Right, a sticky panel: the score line, the summary and the ticked count, then two tabs, **Findings (8)** and **Scores**. Findings come in three groups (Must-fix, Should-fix, Recommendations), each with a one-line explanation; each finding is a bordered panel with its numbered dot, a bold title, a category badge (info), Problem, Change and Why, the layer it is on (or "About the whole page"), and for Must-fix and Should-fix a checkbox **Apply in the improved version** (PMs and admins; saves at once). Recommendations have no checkbox. Scores lists the eight questions with "N of 5" (direction fit "Not applicable") and the reason, then the safety advice in a note box for the content team.

### Pre-filling the intake from the design (25 September 2026)

Screenshots in `E:\tawd-work\tawd-prefill-screens`.

- **Figma section, after the import:** a row "Pre-fill the intake from the design" (15/600) with a hint on what it reads, that it fills only empty fields, marks them, and costs nothing (no AI, no Figma read), and a secondary **Pre-fill the intake** (then **Pre-fill again**). The result sits under it in a light panel: "Pre-filled today, 4:51 AM, by Jason: filled 6 fields.", a list of each field and its value, "Left alone, already filled in: ..." and "Not found in the design: ...".
- **The mark on a filled field:** under the input, a blue-tint strip with an info badge "From the design", the text it was read from ("Read from “(530) 555-0199”. Check it, then confirm or correct it.") and a text button **Confirm**. On Services and Service areas the strip sits under the section heading. It goes when the PM confirms, or saves a different value. Since 0.96.0 the same strip carries a second badge, **From the current site**, for answers TAWD filled from the current website ("Read from finleypest.com/contact/. Check it, then confirm or correct it."), on every project, not only Lane 2.

### The review, reworked after the first real run (25 September 2026)

Screenshots in `E:\tawd-work\tawd-facts-screens`. Supersedes the review page in "Figma part 1, stop 4b".

- **Review card, step 1:** under the title, a strip for the facts from the design: amber with a "Step 1" warning badge while the intake hasn't been pre-filled ("Before the review: pre-fill the intake from the design, then confirm or correct each fact...", with **Pre-fill the intake**) or facts are still unconfirmed ("2 of 3 facts from the design still to confirm...", with **Confirm the facts**); blue-tint with a "Facts confirmed" done badge once all are. The confirmation dialog says so in amber when facts are unconfirmed. A finished review also shows "N facts to confirm" (info badge).
- **Review page, full page:** a white head card with the score line, summary and who and when, **Back to Mockups** (secondary) and **Show the scores** (text; opens the eight questions and the safety advice inside the card). Below, two columns (5:6): the design with its pins stays on screen on the left (sticky, scrolling inside); on the right a sticky toolbar card ("3 of 7 fixes ticked", "0 of 3 facts confirmed", "Ticks save as you go", then "Saving..." and "Saved"; filters for group, category, and ticked or not), then one white card per group: **Must-fix**, **Should-fix**, **Facts to confirm** (blue pins; "In the design" and "To do"; tick box "Confirmed with the client"), **Recommendations** (no tick box). Each group with ticks has **Tick all** and **Untick all** (text buttons). Numbers run in that order. A must-fix in house rules carries a "Confirm with the client" warning badge and starts unticked. Clicking a finding highlights its pin and scrolls the design to it; clicking a pin clears the filters and jumps to its finding.

### The faithful copy (25 September 2026)

Screenshots in `E:\tawd-work\tawd-copy-screens`.

- **Mockups, Option B, after the review:** a white **Faithful copy** card. Before: one paragraph on what it is (a working web page, exactly as designed, nothing fixed; then compared with the Figma frame for free), the estimate line, "From the import" (done badge) with the logo and icons kept, and a primary **Build the faithful copy** (confirmation dialog with the estimate). For an import from before logos and icons were kept, an amber line asks to import again first (not a block). While building, the amber working line. Once built: "Matches the design: 99%" (20/700), the least-alike sections when under 90%, an amber note under 80%, who and when and the cost, **Open the copy** (primary), **Build again** (secondary), and a 220px picture of the copy's first screen on the right.
- **Copy page** (`/projects/[id]/mockups/design/copy`, crumb "Faithful copy"), reworked 25 September 2026 (screenshots in `E:\tawd-work\tawd-copy2-screens`), top to bottom: a head card with "Matches the design: 95%", one plain sentence ("Close to the design, with small differences; the biggest difference is in “Reviews” (72%)."), one line on what the score measures, who and when and the cost, and how many sections were rebuilt after the first look with the first build's match; **Back to Mockups** and **Open the page** (primary; the copy live in a new tab, in a sandbox). Then the Figma frame and the copy side by side, full width, each scrolling in its own frame and keeping the other at the same point. Then "Section by section", only when the copy's sections lined up with the design's (no empty column otherwise): each section with badges ("Rebuilt after the first look" info; "Looks close" done or "Looks off" warning from the eye check; the score, done from 90%, info from 80%, warning below) and what the eye check found, in plain words (for a rebuilt section, under "What the first look found, before the rebuild:"). Then three collapsible cards, closed by default, each with a count in its title: "Notes from the build" (plain words for a PM; layer names, sizes and positions behind a small blue "Details" toggle), "Text check" (text missing, not in the design, repeated, or out of order, per section) and "The usual checks, for information" (the lead form and unused-upload checks are left out: a copy has only what the designer drew).

- **Intake, Business: Other locations** (optional fieldset after the address): one block per extra office (name, phone, street address, city, state) with **Remove this location**, and **Add another location**. Their phones count as the client's own in every check.

### Forgot password, service areas and brand colours (25 September 2026)

Screenshots in `E:\tawd-work\tawd-urgent-screens`.

- **Sign in** now has a "Forgot password?" link (14px, blue) under the password field, and the help line reads "New to the team? A TAWD admin creates your account." After a reset it opens with a blue done alert: "Your password is changed. Sign in with the new one." (`.alert-done`: blue tint, blue text, the focus-ring border; the good-news twin of `.alert-error`).
- **Forgot password** (`/forgot-password`, the split layout): "Forgot password?" (32/700), one line on what happens, Email, a full-width primary "Send the link", "Back to sign in". After sending, always the same: "Check your email", "If that address has an account, we've sent a link to set a new password. It works once, for 30 minutes.", a hint about spam and the admin reset, and a secondary "Back to sign in".
- **Set a new password** (`/reset-password`, from the emailed link): New password with Show/Hide, New password again, the ticking rules (at least 12 characters, both match), the length hint, and "Save the new password". A used or expired link shows the red alert with "Ask for a new link"; a link with no token shows "This link isn't complete" and "Ask for a new link".
- **Change password** (`/change-password`): the first-sign-in page, worded for a change by choice when the account isn't on a temporary password: "Change your password", "Signed in as ... A new password signs you out on every other device.", "Current password", the rules (different from your current password), "Change password", "Back to TAWD", and the blue done alert after saving.
- **Top bar:** under the email, a small "Change password" link (12px, blue), right-aligned by Sign out.
- **Intake, Service areas:** four choice cards, two by two: Specific cities or towns, Whole state(s), Nationwide (USA), A radius around an address. Under the chosen one: the city chips and adder with "Wants individual city pages" (cities only); state chips and an "Add a state..." select (states); nothing more (nationwide); "Miles around the address" and "From this address", both required (radius). Then one line: "The site will say: **Serving all of Nevada and California**", with "No city pages: only a list of cities can have a page each." for anything but cities.
- **Intake, Brand colours:** each colour is a 44px swatch button, the hex box and, in browsers that have one, a 44px eyedropper button. The swatch opens a 280px panel under the field: a 170px saturation-and-brightness square, a 14px hue slider (both draggable and keyboard-operable), the colour's hex and a primary "Done"; Escape or a click outside closes it. Under the two colours, a secondary "Suggest colors from the logo" (only when a logo is uploaded) turns into the logo's colours as swatch buttons (24px chip and hex; one already chosen is marked "In use" and can't be clicked). A click fills Primary, then Accent, then goes with the other brand colours.
### The improved design (4c-1, 25 September 2026)

Screenshots in `E:\tawd-work\tawd-4c1-screens`.

- **Mockups, Option B, after the faithful copy:** a white **Improved design** card in the same shape as the copy card. Before: one paragraph (the ticked fixes made on the copy one section at a time, every change kept with a before and after for the designer to accept or push back; the logo, brand colours and fonts stay the designer's; then the Creative Director scores it again), then "N ticked fixes." and the estimate, and a primary **Build the improved design** (confirmation dialog with the estimate). What is still missing shows as an amber line instead, and the button is disabled: the review, the copy, a review and copy of the same import, or at least one ticked fix. While building, the amber working line with the step ("Fixing section 2 of 3: Services"). Once built: "Creative Director: 2.9 → 4.0 of 5" (20/700), "N tracked changes; N fixes not made (the page says why).", who and when and the cost, an amber line when the review or copy is newer, **Open the changes** (primary), **Build again** (secondary), and the 220px picture on the right.
- **Improved design page** (`/projects/[id]/mockups/design/improved`, crumb "Improved design"), top to bottom: a head card with the scores before and after, the Creative Director's one-sentence summary, one line on what was done, who and when and the cost, **Back to Mockups** and **Open the page** (the improved page live, in a sandbox). The faithful copy and the improved design side by side, scrolling together ("The faithful copy: the design as it is" and "The improved design"). "The Creative Director's scores, before and after": each question with the two scores as badges (done from 4, info at 3, warning under 3) and the new reason. "Changes (N)": each change numbered in page order, with its section name, a kind badge ("Fix from the review" info; "Contrast" or "Font" done), what changed and why in plain words, "From the review: 3. Phone too quiet", and the section's Before and After pictures side by side (a font change shows "In the Figma design" first; stacked under 800px). Then two collapsible cards: "Fixes not made" (open when there are any; each fix with why) and "The usual checks, for information".

### The Email card on Team (26 September 2026)

Screenshots in `E:\tawd-work\tawd-email-screens`.

- Under the team table, a white **Email** card: "Email" (card title), one line on where email goes from ("Sends through smtp.gmail.com:587 as ..., from TAWD <...>. Used for password reset links."; never the password), or, when not set up, an amber line naming the missing Coolify variables. On the right a secondary **Send a test email**, which sends to the admin's own address (said under it). The answer shows in the card: the blue done alert ("Sent to ... Check that inbox, and the spam folder.") or the red alert with what failed in plain words, then the mail server's own words in quotes.

### The designer's decisions (4c-2a, 26 September 2026)

Screenshots in `E:\tawd-work\tawd-4c2a-screens` (5 to 8).

- **Improved design page, "The designer's decisions" card** (between the scores and the changes): "N of M decided: N accepted, N pushed back" (18/700); while any change is open, an amber line "N changes need the Web Designer's (or an admin's) Accept or Push back before the version can be made", and the button disabled; once all are decided, one line on what making the version does ("1 section put back as designed; 1 section edited to take out the pushed-back changes") and its cost ("Free: no AI needed" or the estimate). The primary **Make a version with the designer's decisions** (confirmation dialog with the same two lines), **Make it again** (secondary) once one exists. The version shows under a thin rule: a 220px picture, "Version with the designer's decisions", what was kept, put back or edited, who and when and the cost, an amber line if a decision changed since, and **Open this version** (the live page, `?v=decisions`).
- **Changes card:** a segmented filter on the right (All, Needs a decision, Accepted, Pushed back, each with its count). Each change, after "From the review", has an answer box: grey "Waiting for the designer's decision", blue tint "Accepted by Jen Park, today 12:44 PM", amber tint "Pushed back by ..." with the note in quotes. The Web Designer and admins see a segmented **Accept** / **Push back** on the right (the pressed one white; pressing it again clears the answer) and "Add a note" (or "Change the note") under it, which opens a two-line note box with **Save the note**. Everyone else sees only the answer.
- **Mockups, Improved design card:** one more line, "Designer's decisions: 3 of 3 (2 accepted, 1 pushed back); a version with them is ready." (or "ready to make the version with them", or "making the version with them").

### Option B as one flow, and alternatives (4c-2b, 26 September 2026)

Screenshots in `E:\tawd-work\tawd-4c2b-screens` (9 to 11).

- **Mockups for Lane 2, Option B** is always one page, top to bottom: Concept 1 (the designer's design), the Creative Director review, the faithful copy, the improved design, then the alternatives. The plain Lane 1 setup never shows for Option B.
- **Alternatives card** (white, the copy card's shape): "Alternatives", one paragraph (optional; one or two other homepages built by the usual engine in TAWD's own directions with the designer's logo, colours, fonts and words; on the concept board with the usual checks and review), a segmented choice **None** / **1 alternative** / **2 alternatives** (None chosen at first), then one line: "None chosen: the client sees the designer's design, improved." or the estimate for the choice ("Around $2 to $4 of AI for 1 alternative, about 9 minutes."). A primary **Build alternatives** on the right, disabled on None ("Build 1 alternative" / "Build 2 alternatives" once chosen), with the usual confirmation dialog and the estimate again. A last run that failed shows its reason in red.
- **While they build:** the design's cards stay, then an "Alternatives" heading (section title) and the usual generating panel under it.
- **Once built:** the usual ready banner at the top, the design's cards, the "Alternatives" heading, the usual concept cards and the next-steps strip. The header's secondary button reads **Build alternatives again** (its dialog: "Build new alternatives?" and **Choose again**, back to the Alternatives card).

### Concept 1 on the concept board (26 September 2026)

Screenshots in `E:\tawd-work\tawd-board-screens`.

- **Improved design page, head card:** under **Back to Mockups** and **Open the page**, a primary **Put on the board as Concept 1** (confirmation: which version goes, the version with the designer's decisions or the improved design; where it goes; "Free: no AI"). Once there, a line "On the board as Concept 1 (v1)." linking to the concept, and a secondary **Update Concept 1** only when a newer final version exists.
- **Mockups, Option B, once concepts exist:** the design's cards, then a "The concept board" section title ("Alternatives" while alternatives are building), then the usual concept cards with Concept 1 first: "Concept 1", "The designer's design, improved" (no "built with" line), its checks and version badges, and a summary line saying which changes it carries. It goes in the client pack and takes comments, Request changes and the client's pick like any concept. The top card is now "The designer's Figma design".

### Intake: the brand guide, websites they like (26 September 2026)

Screenshots in `E:\tawd-work\tawd-fields-screens`.

- **Brand, "From the brand guide"** (under the two colour pickers, when a guide has been read): a dashed box on the ground colour, "From the brand guide" with an info badge "Suggestions", one line per guide ("rivera-brand-guide.pdf: Found 3 colours, 2 fonts, 2 logo rules.", amber for a scan with no text and what AI reading would cost, red when it couldn't be read), then rows with a 110px label: **Colours** (a chip per colour: 24px swatch, name and hex, **Use** secondary small, **Dismiss** text), **Fonts** (the same chips), **Logo rules** (a list; each rule with **Add to notes for the designer** and **Dismiss**). Use fills Primary, then Accent, then goes with the others, and adds a font after what the Fonts field already says; it never replaces what the PM typed. A used or dismissed suggestion disappears.
- **Website, "Websites they like":** the hint says a screenshot is taken of each once saved, as inspiration only. Under the three fields, a three-column row of thumbnails (16:10, the site's first screen, 1px border, 8px radius), each with its address under it; "Taking the screenshot..." on the ground colour while waiting, and the reason in amber when a site couldn't be opened.

### Pricing and Revenue (26 September 2026)

Screenshots in `E:\tawd-work\tawd-money-screens`. Admins only, built from the Spend page's parts; "Revenue" in the top bar for admins (it stays underlined on Pricing too). No card or payment data anywhere.

- **Revenue** (`/admin/revenue`): "Revenue", the line "What the clients pay, counted from the day each site went live. Admins only.", and a secondary **Pricing** on the right. An amber warning banner when a live client has no price ("1 live client has no price", naming them: they count as $0 until an admin sets one). Four Spend-style cards: **Monthly revenue** (this month's monthly fees, "From N live clients in September 2026"), **Build fees this month**, **Total this month**, **Last 12 months**. A white **By month** card: the card title, then the Spend table (Month, Build fees, Monthly fees, Total in bold, Live clients; newest first, 12 months) and a one-line note on the counting rule. A white **Live clients** card ("(N active)" muted): Client (links to the project), Plan, Went live, Build fee, Monthly fee ("Not set" muted when blank), Status: a done badge "Active, month N", or an info badge "Cancelled Sep 10, 2026" plus a warning badge "Before the 12-month minimum (5 of 12)" when it ended early. The note: no card or payment details are kept.
- **Pricing** (`/admin/pricing`): "Pricing", "What each package costs the client: a one-off build fee and a monthly fee. Admins only.", a secondary **Revenue** on the right. One table card: Package (bold), Build fee, Monthly fee ("Not set" muted), Projects on it, and a text **Edit** per row. Edit turns the row blue-tint with a name box, two "$" amount boxes and Cancel / **Save {Package}**; under the table a secondary **Add a package** opens the same row empty (**Add package**). Under the card a hint: a project keeps its package's price from the day it was created, so changes reach new projects only; one project's price changes on its page; every change is logged; the 12-month minimum applies to every package.
- **Project overview, "Price and billing"** (admins only, above History): card title and the hint "Admins only. Going live counts as paid. No card or payment details are kept in TAWD."; on the right secondary **Mark cancelled** (or a text **Undo cancellation**) and **Change price**. Five facts in a row (13px muted label over a 15/600 value): Package, Build fee, Monthly fee, Went live ("Not live yet" muted), Cancelled ("No", or the date and the reason). An amber line when no price is recorded. **Change price** dialog: "Change this project's price?", one line (only this project changes; logged with the reason), Package select (choosing one fills its prices), the two amount boxes, a required "Why is it changing?", Cancel / **Save the price** (disabled until a reason of a few words). **Mark cancelled** dialog: "Mark this project cancelled?", what it does (the monthly fee still counts in that month and stops after; the site and project stay; can be undone), "Cancelled on" date (today by default) and a required "Why?", Cancel / **Mark cancelled**.

### Shutterstock previews in mockups (26 September 2026)

Sample in `E:\tawd-work\tawd-stock-screens`. No TAWD screen changes; this is what the concepts themselves show.

- Where none of the client's photos fits, a general-scene frame (the trade at work, a finished job of that kind, tools) is filled with a watermarked Shutterstock preview, covering the frame (its dashed placeholder border goes), with a dark label "Shutterstock preview" in the bottom-left corner (white 12/600 on 78% black, 4px radius). The alt text says it isn't the client's photo.
- Frames for the client's own people, premises, vehicles or work stay labeled placeholder boxes, waiting for their real photos. The client's own photos always come first.

### Content, 7a: keyword research and the page plan (26 September 2026)

Screenshots in `E:\tawd-work\tawd-seo-screens`. The Content stage tab now opens `/projects/[id]/content` (the project page's Content card links there too). Before the client approves a mockup the page still opens by its address, with a blue-tint note "This project is at Mockups" saying research and the plan can start now.

- **Keyword research card** (white): the title with an info badge "Sandbox: test data" while DataForSEO's free sandbox is in use; one line on what it is; a primary **Look up keywords** on the right (secondary **Look up again** once run), which opens a confirmation dialog with the keyword count, the places and the estimate ("Free: DataForSEO's sandbox answers with test data", or "About $0.16 of DataForSEO lookups", noting keywords already known). Amber lines for not set up (the missing Coolify variables), the SEO data cap being reached, and while it runs ("Looking up 20 keywords..."; the page refreshes itself). Once done: a 15/600 line ("20 keywords in 1 place, when, started by, Free (sandbox test data)" or the cost), then the Spend-style table flush to the card edges: Keyword (bold), Service ("The trade" for the trade's own term), Area, Searches a month, Difficulty ("63/100"), Cost per click; the top 12 by searches, with a text **Show all N**.
- **Page plan card** (white): before a plan, one paragraph (free, no AI) and a primary **Make the page plan**. After: "N pages; Starter covers up to 10. In menu order; Home is always first.", an amber line when the plan outgrows the tier ("11 pages: Starter covers up to 10. Remove 1, or talk to the client about Growth. TAWD won't change the tier."), a secondary **Make it again** (dialog: it replaces the plan and any changes). A numbered list flush to the card edges, one row per page: a 28px grey number circle; the name (bold), a kind badge and its address (muted); a two-column list of Main keyword, Supporting, Title, Meta description and H1, with a muted length count after the title and meta ("52/60"), amber and "(too long for search results)" past 60 or 155. On the right: up and down arrow icon buttons (44px, labelled, neutral hover; Home can't move), text **Edit** and **Remove** (not on Home; dialog). Edit turns the row blue-tint with the fields (name, kind, address, main keyword, supporting keywords, H1 in three columns; title and meta full width with their counts) and Cancel / **Save {page}**. A secondary **Add a page** under the list.
- **Spend, "SEO data" card** (under the tabs): the title with the sandbox badge, "DataForSEO keyword lookups, with their own cap" on the right; this month's paid spend "of $25.00 this month" (spend-card figure style) with the blue bar (amber from 80%); a line with the period's lookups (sandbox ones marked free, failures counted); **Change the SEO data cap** (the monthly-limit editor); a table by project: Project, Lookups, Keywords, Cost.

### Content, 7b: page drafts and the content review (26 September 2026)

Screenshots in `E:\tawd-work\tawd-7b-screens`.

- **Content page, "Page drafts" card** (under the page plan): "N of M pages approved by Content. Open a page to read, edit, comment on and approve it."; a primary **Draft N pages** for the pages with no draft (dialog with what the drafts are written from, the no-invented-facts rule and the estimate); the estimate line; the amber "Drafting..." line while any page is being written (the page refreshes itself). The Spend-style table: Page (a link once drafted), Version, Status (badges: Not drafted info, Drafting and To review warning, Failed missing, Approved done), AI writing ("41% (flagged)" in amber over 30%), Placeholders, Open comments.
- **Copy pack** (inside the card, once every page is approved): a blue-tint panel, "Copy pack for the client" (16/700) and one line; secondary **Download the copy pack** (an HTML document of the approved pages, placeholders highlighted amber) and primary **Record the client's decision** (dialog: Approved the copy / Asked for changes as radio lines, how it came in, a required "What the client said"). The last decision shows under the line, blue when approved, amber when changes were asked for.
- **Page review** (`/projects/[id]/content/[pageId]`): "Back to Content", the page name (section title) and a muted line with its address, main keyword and title. Two columns: **The draft** (white card: version line "Version 1 of 1: drafted by AI, when", secondary **Request a redraft** (dialog with a required note and the estimate) and **Edit**; the copy set in Georgia 17px with its headings and lists, placeholders highlighted amber; Edit swaps in a monospace textarea with a hint on the heading marks and **Save as a new version**). On the right, stacked cards: **Approval** (primary **Approve this version**, Content and admins only; a done badge and who and when once approved; placeholders still open are named), **SEO checks** (a Good or Check badge per check with its detail: one H1, heading order, main keyword in the H1 or first paragraph, not overused, supporting keywords, title and meta lengths, reading level, placeholders; none blocks approval), **AI writing** (Originality.ai, information only: the score 18/700, amber over 30% with a hint to rewrite; **Check AI writing** and the credits it takes; an amber line when ORIGINALITY_API_KEY isn't set), **Comments** (bordered items with author, version and when, **Resolve**; resolved ones faded; a textarea and **Add comment**).

### Build A, 8a: the site (26 September 2026)

Screenshots in `E:\tawd-work\tawd-8a-screens` (the Build screen before and after, and a built page). The Build stage tab now opens `/projects/[id]/build`.

- **"The site" card** (white): the title and one line (every page built from the approved mockup's design and its approved copy, a shared header and footer, plain HTML and CSS files; nothing goes live from here). A primary **Build the site** (secondary **Build again** once built) with the usual confirmation dialog and estimate. Amber lines for what is still missing (no approved mockup, no page plan, pages Content hasn't approved; the button is disabled) and, not blocking, "The client hasn't approved the copy pack yet." While building, the amber step line ("Building page 3 of 7: Water heaters") and the page refreshes itself; a failed build shows its reason in red.
- **Once built:** "Version 1, built when: 7 pages, 8 files." (15/600) with a primary **Open the site** on the right (the built files, served inside TAWD for the team), then a grid of page cards (240px minimum): the page's first screen (16:10, 1px border, 8px radius, a link that opens the page), the name (bold) and its path (muted), and "1 placeholder to fill before go-live" in amber or "No placeholders".
- On the built site, missing facts show as `<mark class="tawd-placeholder">[PLACEHOLDER: ...]</mark>` (amber), and an image with no uploaded file becomes "[PLACEHOLDER: image logo]", never a broken picture.

### Build A, 8b: checklist and preview (26 September 2026)

Screenshot in `E:\tawd-work\tawd-8b-screens`.

- **Go-live checklist card** (white, under The site, once built): "Version N: 6 of 14 done. 5 still stop the site going live; a preview can still go to the client." (amber) or "Nothing stops it going live." (blue). One row per item, as the SEO checks: a badge (Done, blue; **To do**, red-tint missing, for what blocks go-live; Check, amber, for what is worth a look), the label (14/600) and a muted detail. Items: custom 404, skip link, expandable FAQ, contact form with thank-you page, the footer line, one H1 per page, titles and descriptions, internal links, alt text, tap-to-call on Home, fits a phone screen (390 wide), domain with canonical URLs and sitemap, no placeholders left, Google Business Profile link tagged.
- **Preview card** (white): "Preview", one line (on Netlify, for the team and the client; kept out of search engines until go-live; free, no AI); primary **Deploy a preview** (secondary **Deploy again** after), with a confirmation dialog saying what happens (the first creates the client's site on VML's Netlify account with forms on and form emails to the client and VML). Amber lines when NETLIFY_AUTH_TOKEN or NETLIFY_FORM_COPY_EMAIL is missing, when the preview shows an older version than the latest build, and while uploading (the page refreshes itself). The site's address and who form messages go to; a list of deploys (badge Live preview / Failed / Uploading, "Version 1, when, by whom", **Open**). Once a preview is ready, the blue-tint panel "The client's decision on the preview" with **Record the client's decision** (dialog like the copy pack's: Approved the site / Asked for changes, how it came in, what they said); the last decision shows in it.

### Move to Build, and deleting a Netlify site (26 September 2026)

- **Content, copy pack panel:** once the client has approved the copy and the project is at Content, a primary **Move to Build** sits before the decision button (which turns secondary).
- **Delete project:** the danger area also names "the built site, and its preview site on Netlify"; if Netlify can't delete the site, the dialog shows why and nothing is deleted.

### Build A, 8c: monthly edits and dev hours (26 September 2026)

Screenshot in `E:\tawd-work\tawd-8c-screens`.

- **Build page, "Monthly edits" card** (under Preview): "1.8 of 8 dev hours this month. The plan includes 8 dev hours a month; new pages and redesigns are quoted separately." (amber when over); on the right secondary **Log time** and primary **Log a request**. One bordered item per request, newest first: a status badge (To make, Starting, Editing, Ready to check and In a new build amber; Done blue; Failed red; Quote grey), the client's words in quotes, and a muted line (asked on, pages, time logged, AI cost, the team's note). A text **See the changes** opens the tracked changes page by page (removed lines struck through on red-tint, added lines on blue-tint). Actions: **Make the edit** (dialog with the estimate), **Put it into the site** (a new build from the saved pages, free), **Make it again**, text **Log time** and **Mark done**.
- **Log a request** dialog: edit or quote (radio lines), the client's words (required), asked on, the pages (checkboxes, for an edit), a team note. **Log dev time** dialog: minutes, the day, what was done.
- **Project page:** a small "Monthly edits" card with the hours line and a link to Build, once the project is at Build, QA or Live.
- **Revenue, Live clients:** a "Dev hours this month" column ("2.3 of 8", amber when over).

### Spend: the prompt cache (26 September 2026)

- In the "Spent this month" card, under the limit line, a hint: "Prompt cache: 64% of input read from cache, saving about $3.20." for the chosen period.
- **By step** table: a "Cache hits" column (the share of each step's input read from cache; a dash with no calls) before Share; the note under the table says what it means.

### Intake: colours, fonts and suggested services (26 September 2026)

Screenshots in `E:\tawd-work\tawd-intake-review-screens`.

- **An empty colour:** instead of a blank square, a button with a rainbow dot (28px, a conic gradient) and "Pick a color" (14/600), dashed field-border, 44px high; it opens the same picker. Once a colour is chosen, the usual colour square. **This is the one gradient in TAWD, on purpose** (Jason's request): the Rules' "No gradients" holds everywhere else.
- **Fonts:** two pickers side by side, "Headings font" and "Body text font", in place of the free-text Fonts field. Each is a select-styled button showing the choice in its own font ("Let TAWD choose (no preference)" by default); it opens a list (white, 1px line border, soft shadow) of radio lines, 44px each, 18px, each font name in its own face: "Let TAWD choose (no preference)" first, ten free Google fonts, then "Other", which shows a text box for the font's name. An older free-text fonts note shows under them as "Fonts (earlier note)" only if one was saved.
- **Services, suggestions:** under the rows, "Common for this trade, one click to add (only what the client offers):" and up to five dashed-blue pill buttons ("+ Water heater repair and installation"), 44px high, from TAWD's own list for the trade (no AI). A suggestion fills an empty row first; one already listed isn't offered.

### Add-ons, and the logo TAWD designs (26 September 2026)

Screenshots in `E:\tawd-work\tawd-logo-screens`.

- **Pricing, "Add-ons"** (under the packages): a section title, one line (one-off extras counted with the build fee; a project keeps the price an add-on had when added), then the same table style: Add-on (bold), Price ("Not set" muted; "Quoted case by case" for the over-100-page audit, which has no Edit), Projects with it, and a text **Edit** that turns the price into a "$" box with Cancel / Save.
- **Project, Price and billing:** a line "Add-ons, with the build fee: Logo design (TAWD designs one): $150." when there are any.
- **Intake, Brand:** under the logo upload, a checkbox "Client has no logo: TAWD designs one". Ticked, a ground-coloured panel "Logo by TAWD": one line (an original wordmark in the brand colours, as SVG and PNG; N options for this tier; the chosen one is used in the mockups and approved with them) and a primary **Design the logo** (secondary **Design again** once designed) with the usual confirmation dialog and estimate; an amber line until the section is saved; the amber working line while designing. Options in a grid (220px minimum): the logo on white (2:1), then its name and a secondary **Use this logo**, or a done badge "In use" with a blue border around the chosen one.

### SEO audits of the current website (26 September 2026)

Screenshot in `E:\tawd-work\tawd-audit-screens`. On the Content page, above Keyword research.

- **"Current website" card:** the title with the sandbox badge; one paragraph ("Don't lose it": the old site's pages, which rank, where each old address goes; the new site redirects them; included with every site and run by itself when the website is saved); a secondary **Check it now** / **Check again**. A 15/600 line ("8 pages in the sitemap; 4 rank for 76 keywords, about 347 visits a month from search."), then the Spend-style table flush to the card: Old address (monospace), Ranks for, Visits a month, Goes to (the new path in monospace and the page's name, or, in amber, "Home page: no planned page covers it" with a text **Add a page for "keyword"** when that old page brings traffic). The first 12, with **Show all N**.
- **"Full SEO audit" card** (info badge "Add-on"): one paragraph on what it includes and that it's priced in bands of 20 pages. Without the add-on, a dashed panel: "TAWD counts the site's pages from its sitemap (free) and suggests the band.", **Count the site's pages**, then "34 pages in the sitemap: **Full SEO audit, 21 to 40 pages** ($450)" (the price for admins only) and a primary **Add the full audit to this project**. With it: "On this project: ..." and the estimate, the optional **Screaming Frog export** uploader (CSV) with "Extra evidence if the SEO team runs one; the audit never waits for it.", and a primary **Run the full audit** (**Run it again** once done) with the usual confirmation and estimate; the amber step line while crawling ("Crawling the site (DataForSEO): 12 of 34 pages"). The report under a rule: "Audited when: N pages.", the summary, **Priorities** (numbered, each with an impact badge: High red, Medium amber, Low grey; the problem, "Fix:", the pages), **Gaps**, and **Pages for the plan**, each with a secondary **Add to the plan**.

### Build: the SEO check before go-live (26 September 2026)

Screenshot in `E:\tawd-work\tawd-seocheck-screens`.

- **"SEO check before go-live" card** (under the go-live checklist): one paragraph (what the Senior SEO Manager checks; safe fixes made; the rest listed; the SEO team signs off), a primary **Run the SEO check** (secondary **Check again**) with the usual confirmation and estimate. Once done: "Version 3, checked when." (15/600), an amber line if a newer build exists, the summary, then one row per finding (a 110px badge column: **Fixed** blue, **Safe fix** amber, **For the team** amber-red; "page: problem" 14/600 and the fix muted). A blue-tint "Sign-off" panel: how many safe fixes are left and how many are for the team, with a secondary **Apply the safe fixes** and a primary **Sign off for go-live** (SEO role and admins; a dialog with an optional note); once signed off, "Signed off by Sam, when: note" in blue.
- **Go-live checklist:** a last item "SEO team sign-off" (To do until this version is signed off).

### Part 2: logo tick, Gallery and Portfolio, TAWD fit, integrations, health rules, client DESIGN.md (26 September 2026)

Screenshots in `E:\tawd-work\tawd-part2-screens`.

- **Record the client's decision:** a checkbox "Logo approved by the client" under "What the client said", with the hint that it covers the logo on the chosen concept (the client's own or TAWD's). Recorded with the decision; the approved banner on Mockups adds "Logo approved by the client." (or "Logo not approved yet.").
- **Set up concepts:** the direction dropdown has 13 directions; the 13th is "Gallery and Portfolio" (Impeccable). For a creative business it is pre-selected with Premium Upscale and Classic Trust, and "Why these directions" says so.
- **Intake, Extras:** the purpose line names the online tools and special requests. Two new blocks under Financing:
  - **Online tools the site links to:** a hint, then a grid like Services (Kind select, Provider with suggestions, Link, remove), "No online tools yet." when empty, and a secondary **Add a link**. A bad address shows the red field error; for a booking page made to sit inside a site (Calendly, Acuity) a checkbox "Show the booking calendar on the Contact page".
  - **Does the client want any of these?** four checkboxes (online store, member logins, complex animation, custom web app), "Anything else special they asked for", and the amber warning banner "Better as a custom VML build" with the reasons as soon as one applies. The Extras nav badge reads "Custom build?" (warning).
- **Project page:** the same "Better as a custom VML build" banner under the tier banner. A white **Client DESIGN.md** card once the client has approved a mockup: title, one-line purpose, "Version 1, from the approved mockup (v1), when." (15/600), the nine section names in a muted line, secondary **View** and **Download** on the right, and a text button "Write it again from the approved design" for PMs and admins (primary "Write it now" when none exists yet).
- **Intake, Photos:** a checkbox "The client gave permission to show before-and-after photos", then (once ticked) "How the client gave permission".
- **Content review and Build checklist:** a "Health and beauty rules" check for health, beauty and medical projects ("For the PM: ..."; on the Build checklist it blocks go-live until each flag is resolved), and a Build checklist item "Booking, shop, portal and review links placed and working" when the intake has any.

- **Build, "Health and beauty rules" card** (health, beauty and medical projects, after the go-live checklist): title, one paragraph (the four rules; each flag fixed or confirmed before go-live), then "Version 3: 2 of 3 still to fix or confirm." (amber) or "all confirmed" (15/600). One row per flag: a "To resolve" (missing) or "Confirmed" (done) badge, "Rule: "the words"" (15/600), a hint (what to do, or "Confirmed with the client by Sam, when: note"), and a secondary small **Confirmed with the client** under it for PMs and admins. It opens "Confirmed with the client?" with the rule and words, a required "How the client confirmed it" note, Cancel and a primary **Confirm**. The checklist's "Health and beauty rules" item blocks go-live until every flag is resolved.
- **New trades** in the project form: Interior design, Art & decorative finishes, Photography, Architecture and remodeling, each with suggested services in the intake.

### Counties and DMAs, tracking codes, estimates (26 September 2026)

Screenshots in `E:\tawd-work\tawd-part3-screens`.

- **Intake, Service areas:** six choice cards in two columns: Specific cities or towns, Counties, Whole state(s), DMA (TV and ad market), Nationwide (USA), A radius around an address. Counties work like cities: chips, an Add field ("Add a county with its state, e.g. Washoe County, NV"), and "Wants individual county pages" (this moves the project to at least Growth). DMA appears only once an admin has loaded the TV markets from DataForSEO (Spend), and offers a market dropdown with chips.
- **Project page, Tracking card** (for everyone; editing for PMs and admins): title, one paragraph (IDs only, nothing loads before consent, the banner and the opt-out link on every page, the policy is a placeholder, changes reach the site on its next build). A two-column grid of four Optional fields (GA4 measurement ID, Google Tag Manager container ID, Meta Pixel ID, Google Ads conversion ID), each with an example placeholder and a red line when the format is wrong. "Consent banner" radios: "Ask first: nothing loads until the visitor accepts" and "On unless the visitor opts out", with a hint about Global Privacy Control. A primary **Save tracking** (disabled until something changes and every ID fits) and "Last saved when."
- **Built site:** a consent banner fixed at the bottom of every page (Accept/Decline, or OK/Opt out), "Privacy and cookie policy · Do not sell or share my information" at the end of the footer, and a /privacy/ page whose policy text is a placeholder. On the Build checklist: "Tracking codes behind the visitor's consent" (blocks go-live if missing).
- **Design review report:** the cost line adds where the money went: "(1 call; 31,200 tokens in ($0.12); ...; 26,000 out, thinking included ($0.52))".
- **Faithful copy pop-up:** "TAWD rebuilds the designer's homepage as a web page a few sections at a time, nothing changed (one AI call per group of sections). A visual check then compares every section with the design, and any that differ are built once more."

### Settings check, the logo after approval, DataForSEO tools, the copy on messy designs (27 September 2026)

Screenshots in `E:\tawd-work\tawd-part4-screens`.

- **Approved Mockups page, "The logo" card** (under the approved banner): the title, a line with the logo's approval ("Logo approved by the client: recorded by Sam (email), ..." in blue, or "isn't recorded yet"), and a secondary **Record logo approval** on the right (PMs and admins). It opens "Record the client's approval of the logo": How it came in (Phone call, Email, Meeting), What the client said, Cancel and a primary **Save**. When the intake's logo is newer than the approved version, an amber banner "The logo changed after the client approved Concept B v2" (free, no AI, a new version that becomes the approved one, the DESIGN.md written again) with a primary **Put the new logo into the approved concept**; then the amber working line, and "The new logo is in: Concept B v3 is the approved version." A concept version made this way reads "v3, with the new logo".
- **Spend, SEO data card** (admins): secondary **Test DataForSEO connection** and **Load TV markets (DMAs)** side by side, a hint about the DMA list, and after a test a result block (blue when connected, red otherwise): the message, which service calls DataForSEO, the endpoint (sandbox or live), the HTTP status with DataForSEO's reason, the login mostly hidden and the password's length only, and anything tidied before sending.
- **Faithful copy card**: a copy that still differs after its one rebuild shows its match and an amber "Not done: This design file has overlapping or leftover content. Clean the frame in Figma, then re-import. Still different after a rebuild: ...", with **Open the copy** and **Build again**. The copy page shows the same line under the match. The import's warnings include "The frame "Home" contains stacked or covered content: ...".
- **Pricing, Add-ons:** six placeholders with no price: Domain purchase (registered in the client's name), Extra pages, Subdomain site or ad landing page, Extra design concept, Licensed stock photos, Rush delivery.
- **Signed-in /api/health:** `settings` lists every environment variable with its purpose and "set", "not set" or "not used" for the web app and the worker, and `missing` names what's required and absent.

### Mockup inputs, the render check, critique and polish (27 September 2026)

Screenshots in `E:\tawd-work\tawd-inputs-screens`. After the Finley Pest Control comparison: inputs beat rules.

- **Mockups, Set up:** under the lede ("TAWD proposes directions from the client's brand, photos and reference sites, and the intake: ..."), a bordered panel **What the proposal is based on** with three rows, each a 130px name, a badge and the value: **Brand** (the colours as 18px swatches and hex, ", taken from the logo" when they were), **Real photos** (the count, how many of the team and of jobs or premises), **Reference sites** (the count and how many studied). The badge is "In" (done) or "Missing" (amber) only when the input isn't there at all; any note sits under the value in amber-text ("No team photo yet ...", "... Results will be weaker ..."). Never a block. Each concept card shows the proposed direction as an 18/700 name instead of the dropdown; a secondary small **Change directions** with the hint "Override the proposal. Your choice is checked against the direction rules and logged." opens the dropdowns (the PM's override). "Why these directions" is "Why TAWD proposes these directions". Above the footer, a checkbox **Critique and polish each concept after the review** (on by default) with a hint; the estimate follows it. What happens next has seven steps: Study the reference sites, Build, Render check, Creative Director review (9 questions, against the reference sites), One improvement round, Critique and polish, Ready for the team; the note under the estimate says what it includes.
- **Intake, Brand:** with no colours entered, the logo's two main colours fill Primary and Accent by themselves, with the hint "Primary and Accent were taken from the logo. Change them if they aren't right." A colour set by hand is the PM's.
- **Intake, Website:** fewer than 2 reference sites shows the warning banner **Ask for 2 to 3 reference sites** at the top of the section. The field is "Reference sites (websites they like)" with the marker "2 to 3". Under each address that has been typed, a 2-row textarea (placeholder "What do they like about it? For example: ...", 600 characters at most), 6px below the address, 12px between sites (0.99.0); the hint under the field says the concepts follow it first. Under the screenshots, a **Reference study** panel (the logo panel's look: ground background, bordered): title, one line, a secondary **Study the reference sites** (then **Study again**) with the estimate in its confirmation dialog, then one row per site: its address (14/600) and either "Studied" (done badge) with the brief's section order, "Read" (info badge) with the outline read for free (bands and trust signals), "Studying..." in amber, or the reason in red.
- **Intake, Photos:** no photos shows the warning banner **Real photos matter most**; photos without a team photo show an amber hint. Under the photo cards, a **Text in the photos** panel in the same look: one line, a secondary **Read the text in the photos** (then **Read again**; confirmation with the estimate), then "Matches" (done) or one row per finding: the file name and a "Check" warning badge with what doesn't match the intake.
- **Concept detail, Review tab:** a "Must-fix, measured by TAWD" amber box when the page was flat, image-poor or unbranded; then, below a rule, **Critique and polish**: the score before to after on the right, "Before (vN)" and "After (vN)" side by side (what was measured), the numbered fixes ("Band 1, type scale: ..."), and a secondary **Critique and polish** / **Critique and polish again** (confirmation with the estimate). The version it made reads "vN, after critique and polish".
- **Checks tab:** three more groups: "The footer and every planned section", "Nothing clipped, no text over faces", "Stock pictures fit the brand".
- **Creative Director review:** nine questions; the ninth is **Client choice**.
- **Spend, By step:** "Mockup inputs" first and "Critique and polish" after the Creative Director review.
- **Project form:** new trade **Pest control**.

### Go-live (Phase 9, 28 September 2026)

Screenshots in `E:\tawd-work\tawd-golive-screens`.

- **Build page, Go live card** (after the preview card): title, one line (the domain is always the client's; email records copied and checked first; every step logged and posted to Slack), a "Live" done badge once live. An amber banner when Cloudflare's settings are missing.
- **Build fee row:** "Build fee", a Paid (done) or Not paid (missing) badge, the payment ("Paid 2026-09-28 by card (INV-1042)."), and for admins **Record build fee paid** (a dialog: date, how it was paid, a note) or the text button **Take back**.
- **Nine numbered steps**, each a 28px circle (outlined blue, filled blue when done), a 15/600 title, a Done or To do badge, one plain line of what it found (who and when), and its own controls while it's the step to do: 1 the domain (domain, registrar, registrant, "Registered in the client's name" tick); 2 read the email records (DKIM selectors field, the records found as code lines); 3 set up Cloudflare (the two nameservers); 4 check the email records (each "Matches" or "Missing"); 5 confirm with the client's email provider (tick plus who and how); 6 put the domain on Netlify; 7 switch the nameservers at the registrar (the instruction with the nameservers, or "Not yet: confirm the email records first"; **Check the switch**); 8 confirm HTTPS; 9 GA4 (property ID, measurement ID, "the client's own, VML has Editor access").
- **The gate:** a red box **Before it can go live** listing every blocker; an amber box **For the founders (not blocking)** (a missing licence for a licensed trade, GA4 not recorded). On the right, **Go live** (primary, disabled until ready; "Put the latest build live" once live) and, once there are two live deploys, **Roll back to the previous deploy** (secondary; its dialog uses the danger button). Only founders and admins see them; others see "Founders and admins press Go live." Both confirm in a dialog first.
- **Previews after go-live** are Netlify drafts with their own link; the preview card lists previews only.

### The design uploaded as a PDF or images (28 September 2026)

Screenshots in `E:\tawd-work\tawd-upload-screens`.

- **Intake, Design section** (was "Figma design"; now on both options of Lane 2, last in the section nav as "Design"): title "Design", one line (from a Figma link or uploaded as a PDF or images; nothing blocks the project). First the uploader "Upload the design (PDF, or one image per page)" with the usual file rows (up to 30 files, 40 MB each), then, once there's a file, a ground-coloured row: how many pages, how many have a text layer (free) and how many are read from the picture by AI, that the first page is the home page and each page becomes a frame; on the right a primary **Read the design** (then **Read the design again**) whose confirmation dialog carries the estimate ("Free: every page has a text layer." when it is). Then the Figma link as before (Option B only).
- **While it reads** (27 September 2026): under the row, the 8px blue progress bar (filling slice by slice) and the amber working line "Reading page 3 of 9, part 2 of 4…" ("Waiting its turn behind any concepts being built…" while queued, "Drawing the pages…" before the first page); the section's badge is "Reading" (info). **When it fails:** the reason in red under the row ("The design couldn't be read: Page 1, part 1 of 3, couldn't be read: ... Nothing more is spent until someone presses “Read the design” again."), the badge "Can't read" (missing), and the button back to **Read the design**. A read the worker lost is marked failed after an hour, as on Mockups. Long pages are read in slices (one AI call each); the estimate counts them ("in about 12 slices"), and anything skipped or cut off shows as an import warning for that page. Screenshots in `E:\tawd-work\tawd-design-read-screens`.
- **Pages kept between reads** (27 September 2026): every page read from the picture is kept as soon as it's read, while the uploaded files stay the same. The row adds "Pages 1 to 8 were read before and are kept."; the failure line ends "Nothing more is spent until someone reads the design again; pages already read are kept." With pages kept, the primary is **Read the design again** and its dialog ("Read the uploaded design again?") has a "Which pages" choice: "Only the N pages not read yet" (default; the kept pages and its estimate under it, "Free" when nothing is missing) or "Every page again" ("For a changed design or a page that read badly." and its estimate); the button says **Read the design** or **Read every page**.
- After the read, everything follows the Figma path unchanged: the import panel, the designer's design on Mockups (no "Open in Figma" link for an upload), the review with facts to confirm, the faithful copy and the rest. A page read from its picture adds an import warning to check its words, colours and fonts.

### Lane 2, Option A: build the design exactly (28 September 2026)

Screenshots in `E:\tawd-work\tawd-optiona-screens`.

- **Intake, Design section** is on Option A too (upload, and from now the Figma link, check and import; the review and the improvement stay Option B's).
- **Intake, Homepage file (Lane 1, 16 November 2026):** a finished homepage made by hand as one HTML file is a mockup, so a Lane 1 project gets its own last item in the section nav, "Homepage file", with a badge from what is stored (Optional, Reading, Not read yet, Can't read, On the board). The card has the usual 24/700 title, one line (what it is; "Nothing here is required and nothing here blocks the project") and the upload section, with no save bar. The Mockups set-up screen links to it under its lede. A Lane 2 project has no such upload; one that already holds a file still shows it in its Design section. On the concept board the "ready" banner speaks of checking and scoring only for generated concepts and says the supplied page is not judged by TAWD's checks or the Creative Director.
- **Mockups, Option A:** no concepts. The designer's design card (as for Option B), then a white card **Build the design exactly**: title, one line (the client approved it, nothing is redesigned, how the phone versions will be made), a badge "Confirm the pages" (warning) or "Pages confirmed" (done); then a table (headers on secondary-hover) with Page, Address, Frame, Phone and Copy. Before confirming, Page and Address are inputs (Home's address is "/ (home)"); **Confirm the pages** (primary). Then **Build every page exactly** (then "Copy the N remaining pages"), **Make the phone versions**, and **Record the client's approval**, one at a time on the right, each with its estimate in the confirmation dialog.
- **Copy column:** "Not copied" (info), "Copying..." (amber), the reason in red, or "Matches 94%" (done from 90%, info from 80%, warning below) with the lowest section when under 90% ("lowest "Gallery" 84%").
- **Phone column:** where it comes from ("From "Home - Mobile"" or "Responsive, for the designer's review"), then "Making the phone version...", or the result with a **View** link to the 390px picture, a red "Scrolls sideways at 390px." when it does, and for a responsive one the designer's **Accept** / **Push back** (text buttons; Push back opens a labelled field and **Send**), "Designer accepted" (done), "Designer pushed back" (warning) or "Waiting for the designer" (info).
- **Approval:** an amber box "Before the approval can be recorded" lists what's missing (a page not copied or still off, no phone version, a responsive one not accepted). The dialog asks how the approval came in (phone call, email, meeting) and what the client said; it then shows "Approved" (done) with that, and the project moves to Build.
- **Build page, Option A:** what's missing refers to Mockups (the approval, the pages, the copies); the build is "Free: the approved design's pages, used exactly, no AI."

### VML's privacy and cookie policies (28 September 2026)

- **Every built site** has `/privacy/` (Privacy Policy) and `/cookies/` (Cookie Policy): VML's templates (`docs/policies/`), filled from the project, with only the parts for the tracking that's on, in the site's simple-page style. The footer of every page links to both; with tracking it also has **Cookie settings** (opens the banner again) and **Do Not Sell or Share My Personal Information**. The banner links to the Cookie Policy and the Privacy Policy.
- **Intake, Business:** two optional fields after Email: **Legal name** (for the policies; the business name when blank) and **Privacy email** (the business email when blank).
- **Go-live checklist:** "Privacy and cookie policies" (both pages filled, linked from every page) is a blocker. (The "Policy reviewed by counsel" tick of 0.49.0 was removed in 0.50.0 at the founders' request.)

### State privacy sections and the Privacy laws page (28 September 2026)

- **Every site's privacy policy** is the baseline (every visitor can ask for access, correction, deletion and opt-out; Global Privacy Control honoured; the SHIELD Act's security point) plus a section for each state its address, other locations or chosen service areas are in, just before "Contact us", in state-name order. Nationwide service areas take every state's section.
- **Admin, Privacy laws** (top bar link, admins only): a Quarterly review card (last review, how many rules are over three months old, **Review privacy laws**, which asks what was checked and marks every rule checked) and one table: State, Law (with its citation), Applies to (a "Small local business: Usually / Sometimes / Rarely" badge and the thresholds), Wording (the section, folded; "No section" when the baseline covers it; notes), Source (the official links, or "No official source reached" in amber), Last checked (a date badge, warning when over three months or "Not verified", and **Checked today**).
- **Reminder:** an admin sees a strip on every page when the quarterly review is due (three months after the last one).
- **Go live card:** the founders' box lists each project state whose rules haven't been checked for three months (an unverified rule counts as unchecked).
- The wording is changed in `docs/policies/` (state-laws.json, states/<key>.md), never on the page.

### System, 20i section (Build B on 20i, 5 October 2026; replaces the Bluehost cards of 4a)

In System, Hosting connections, under the card-title "20i (WordPress, Build B)" and one muted line (each WordPress site gets its own 20i package on VML's reseller account, up to 50; TAWD signs in over SSH with its own key), six white cards:
- **TAWD's 20i SSH key:** as the old key card (title, one line, **Make the key** / **Replace the key** with its danger dialog, the blue secret box with the public key, **Copy**, the fingerprint and who made it when), then one muted line: if 20i only takes keys for the whole account, add it once in My20i, Security, SSH keys (up to 30 minutes to work).
- **Worker settings:** a row per setting (Set done / Missing warning / Blank info badge, the name in monospace, what it is): `TWENTYI_API_KEY` (the worker only, never the web app), `WP_PREVIEW_DOMAIN`, the Cloudflare pair.
- **Check the 20i account:** title, one line (read-only, free, no AI); primary **Check the 20i account** (secondary **Check again** after). An amber line while the worker hasn't the key; the amber working line while it runs; the reason in red when it failed. Done: "Checked <when> by <who>. 20i answers; N of 50 packages used." and the checks list (the key; packages used: amber from 20, warning at 25 (Reseller 25) with the next plan's price; package types; 20i's API lists no data centres, so there is no choice of one). Under it, when types are listed: "The package type TAWD makes sites with", a select of the types, a small primary **Use this type** (**Save the choice** after), and the muted chosen line.
- **HTTPS for WordPress sites:** one line (20i's free certificate needs its nameservers; Check HTTPS confirms whichever way; warnings at 14 and 7 days), a radio fieldset of the three ways (TAWD's own Let's Encrypt certificate; 20i's certificate, $34.99 a year per site; installed by hand in My20i), each with its muted detail; an amber line when `TWENTYI_ACME_STAGING` is on; a muted line on the preview domain (set: previews live under it; blank: 20i's staging address, which the speed gate can't measure).
- **The servers TAWD trusts:** one line (one key per SSH server, remembered at the first sign-in), then per server its fingerprint and when, and a text **Forget this server's key** (a dialog: only when 20i says it changed; danger button). "None yet: the first deploy remembers it."
- **IP watch and certificate renewals:** "IP watch and renewals last ran <when>: N site(s), ..." (amber, with "check the worker is running", after two days), and one muted line on what it does.
- Fingerprints wrap on a phone (no sideways scrolling at 390px). `/admin/bluehost` is gone.

### Build B, 4b1: Hosting and the WordPress hosting add-on (27 September 2026)

Screenshots in `E:\tawd-work\tawd-4b1-screens`.

- **Build page, "Hosting" card** (white, under The site): title and one line ("Where the client's site lives. Build A is always made first; Build B is made from it."), a secondary **Change hosting** on the right (PMs and admins, until the site is live). The choice in 15/600 ("Static site on Netlify (Build A)" or "WordPress on 20i (Build B)"; "WordPress on Bluehost" until 5 October 2026) and a muted line on what it means. On WordPress: "Pro includes WordPress hosting." or "Not a Pro project: WordPress hosting, $25.00 a month." (admins; "price not set yet" before an admin prices it; others read "the WordPress hosting add-on is on its price", never an amount). "Locked: the site is live." once live; "Changed when by whom." under it.
- **Change hosting dialog** ("Change where the site lives?"): a "Hosting" fieldset with the two radio lines, the muted meaning of the chosen one, the amber line when a project that isn't Pro moves to WordPress ("...the monthly WordPress hosting add-on is added to its price: $25.00 a month.", or "no price is set yet (an admin sets it on the Pricing page)", with no amount for non-admins) or "The WordPress hosting add-on comes off its price." going back; "Recorded in the activity log. It can change until the site goes live."; Cancel / **Save hosting** (disabled until the choice changes).
- **Go live card:** while Hosting is WordPress, the first blocker says Netlify's go-live is closed to it (Build B's go-live comes in 4d).
- **Pricing, Add-ons:** a monthly add-on has a muted "Monthly" after its name and "$25.00 a month" as its price; the note under the Packages card says one-off add-ons count with the build fee and monthly ones with the monthly fee, and that a project given an add-on before it was priced gets the first price set.
- **Project overview, Price and billing:** "Monthly add-ons, with the monthly fee: WordPress hosting: $25.00 a month." under the one-off line. **Revenue, Live clients:** the monthly fee cell adds a muted "+ $25.00 add-on".

### Build B, B1: the WordPress package (1 October 2026)

- **Build page, Hosting card**, while Hosting is WordPress and a build is finished: a divider, then "WordPress package" in 15/600, one muted line ("Made from version 4: the client's block theme, every page as WordPress blocks, the contact form, the pictures and the installer. Free, made by code, nothing is sent anywhere."), and a secondary **Download the WordPress package** (a link, PMs and admins; the zip is made on the spot and the download is logged). Before any build: the muted line "Build the site first: the package is made from the finished build."
- The installer and the WordPress side have no screens in TAWD; B2 adds the preview deploy (on 20i since 5 October 2026) to this card.
- **Inside WordPress (VML's dev team, 1 October 2026):** the header's menu is a normal WordPress menu, "Main menu" (Appearance, Menus); the desktop and phone menus both draw it in Build A's own markup, so the look is unchanged and the team edits one menu. The team owns the header, footer and menu once they edit them: Deploy again keeps their changes, and the deploy step's line says so ("Kept (edited in WordPress): header."). The package's README covers a laptop install (XAMPP).

### Build B, B2: the WordPress preview (1 October 2026; on 20i since 5 October 2026)

In the Hosting card, under the package, another divider and "WordPress preview" in 15/600:
- **Not deployed yet:** one muted line ("Makes the site its own 20i hosting package at sample-husky-site.<preview domain>: its own files, database and WordPress, hidden from search engines. Free (it uses one of VML's 50 packages), no AI, about 3 to 5 minutes."; without a preview domain "at 20i's private address for it") and a primary **Deploy the WordPress preview** (PMs and admins). When something is missing, the button is disabled and an amber line says what and where ("20i isn't checked yet: an admin runs Check the 20i account on System.", "Build the site first.").
- **The 26th site:** an amber line "VML's 20i account has 25 of 25 packages: this site would move it to Reseller 50 ($39.99 a month)." with, for admins, a text **Confirm site 26** (a dialog naming the price; primary **Confirm ($69.99 a month)**), and for others "An admin confirms it here first."; the deploy button stays disabled until then.
- **Deploying:** the steps as a list (The hosting package at 20i; with a preview domain, The preview address (DNS) and HTTPS for the preview address; The database; TAWD's access (SSH); WordPress; the plugins; The site; 20i's cache cleared), each with a small state word: Done (success), Working (info), Waiting (muted), Check (warning), Failed (error, with the reason under it). The page refreshes itself. "Deploying version 4, started by Jason Braganza."
- **Ready:** "Version 4 is on the preview, deployed when by whom." **Open the preview ↗**, and while HTTPS isn't confirmed a text link **20i's own address ↗** beside it. "At 20i, IP 185.151.30.12." On 20i's staging address, an amber line that the Speed check can't measure it (a founder lets the build through). An HTTPS line: "HTTPS is on (certificate until <date>)." or, in amber, the certificate's note ("Installed at 20i; it can take up to 30 minutes to show.", "Install a certificate for ... in My20i...", or Let's Encrypt's reason) with text buttons **Check HTTPS** and, after a refusal, **Get the certificate again**. Secondary **Deploy again** and a text-style danger **Remove the preview** (a dialog: its 20i package goes with its files, database and SSH access; a 20i certificate bought for it has to be cancelled in My20i, as 20i's API can't; the site in TAWD and its backups stay). A row of text buttons: **Purge 20i's cache** (PMs and admins) and, for admins, **Suspend the site** (a danger dialog: visitors don't see it, the checks skip it) or **Restore the site**; while 20i is being asked, "Asking 20i to suspend the site... refresh in a minute." in their place (the card refreshes itself), and 20i's refusal in red ("20i didn't suspend the site (when): <reason>. Try again, or do it in My20i."). "Suspended at 20i <when>: visitors don't see the site." in amber while suspended.
- **Admins only:** **Show the WordPress login**, as before. Everyone else reads "An admin can show the WordPress login."
- **Failed:** the steps with the failed one in error and its reason, and **Deploy again (carries on)**. When 20i is still setting up TAWD's key: "20i is still setting up TAWD's key on this package (it can take up to 30 minutes, 20i says). Deploy again in a few minutes; it carries on from here."
- **Left from Bluehost:** an amber line "This preview was on Bluehost, which TAWD no longer uses. Remove it here (nothing is called), then deploy it again on 20i." and **Remove the preview** only.
- **Live:** the title reads "WordPress site (live)", the link opens the client's domain, **Deploy again** says "Backs up the live site first (to TAWD's storage)." under it, and admins see **Remove the site** (taking a live site down: a danger dialog naming the domain and saying the project leaves Live, becoming Paused, so it can then be deleted).

### F1: the Website forms section (1 October 2026)

Jason's approval of `docs/plans/forms-email-domains.md`. A tenth intake section, **Website forms**, after Content (nav label "Website forms"; badge Done once anything is set, Optional before, never "missing": with nothing set, the site gets the standard form and messages go to the business email).

- Purpose line: "What the site's forms ask, and who gets the messages. Nothing set: Name, Phone, Email and Message, sent to the business email."
- **Send website messages to:** up to 5 email fields with **Add another address** (text button) and a Remove text button on each extra row. Under them, muted: "Blank: the business email (bob@finleypest.com)." or, in amber when there's no business email either, "No address yet: add one here or the business email (Business), or the messages go nowhere." An address that isn't an email turns the field amber ("That isn't an email address.").
- **What the form asks:** a list of checkbox rows, one per field, each with a Required toggle (a small checkbox "Required" on the right). Name is always on and required (the row shows "Always"). The rest: Phone, Email, Message, Service needed ("a list of the services from Services"), Address or ZIP code, Best time to call, How did you hear about us, Photos (one upload, up to 8 MB), This is an emergency, OK to text me (texting consent; its line says "Tick only if the client texts leads, and keep the wording").
- **Request a quote form:** a yes/no. Yes: the Contact page's form becomes "Request a quote" with every field above; the forms on other pages keep it short (Name, Phone, Email if ticked, Message).
- **After sending:** "Thank-you line" (text area, optional): the line under "Thanks, we got your message" on the thank-you page.
- A muted line at the end: "Booking links (Calendly, Housecall Pro, Jobber…) are under Extras, Online tools."
- On a phone, each field row wraps its Required toggle under the label (no sideways scrolling at 390px).

### F2: Form messages through TAWD (1 October 2026)

Build page, Go live part, a **Form messages** card above the Go live card (white):
- Two sections under the title, **Sent to** and **Latest messages**, each with a 14/600 heading and a divider above it (polished 1 October 2026 after Jason's look). The test button and its line sit side by side (stacked on a phone); each message shows its form and visitor on one line, the time under it, and small text buttons View and Send again.
- Title "Form messages" and the line "Every message from the site's forms comes to TAWD, which emails it to the client from VML's address and checks it arrived. Kept 90 days."
- **Before Postmark is set up:** a warning banner "Postmark isn't set up yet: the site's forms email the client directly, as before. An admin adds POSTMARK_SERVER_TOKEN and FORMS_FROM_EMAIL to the web app in Coolify." Nothing else.
- **Sent to:** the recipients from Website forms, each with a state badge: Confirmed (success, "confirmed when"), Test sent (info, "waiting for the client to click I got it, sent when"), Bounced (error, the reason), or none yet. A secondary **Send a test message** (PMs and admins; a dialog isn't needed: it sends to every recipient at once and says so in a line under the button). A muted line under it: "The client clicks I got it in the test email. Go-live waits for one confirmation."
- **Latest messages:** up to 10 rows: when, the form ("Contact", "Quote"), the visitor's name, and a state badge (Delivered: success, Sent: info, Bounced or Marked as spam: error, Failed: error with **Send again** as a text button). An empty list says "No messages yet." Message contents are never shown in the list (they're the client's customers' details); **View** opens one, and that is logged.
- On a bounce or a spam complaint, an error banner at the top of the card: "A message to bob@example.com bounced: mailbox full. Check the address with the client." and Slack gets the same line.

**The confirmation page** (`/forms/confirm/<link>`, no login, like the client's domain page): "Thanks, we've recorded that you got it." and "Website messages from finleypest.com will come to bob@example.com from Velocity Media Lab's address. If one ever lands in spam, mark it Not spam." An expired link says "This link has expired."

**Go live, Launch card:** a new blocker "Form messages: the client hasn't confirmed the test message yet (Form messages, Send a test message)." once Postmark is set up.

### Build B: Gravity Forms as the second form option (1 October 2026)

Jason: "keep both options, we have a paid licence for Gravity Forms". Hosting card, WordPress projects only, under the hosting line:
- **Forms:** "Contact Form 7 (free)" or "Gravity Forms (VML's licence)", as the current choice in 15/600 with a secondary **Change** (PMs and admins, logged, locked once live). A muted line: Contact Form 7: "Keeps the site's own form markup; photos go with WordPress's own email." Gravity Forms: "Gravity Forms' fields in the site's own classes; messages are kept in WordPress (Forms, Entries) as well as in TAWD; photos go as links."
- The change takes effect at the next deploy of the WordPress preview (a line says so after a change: "Deploy the WordPress preview again to switch the forms.").
- When Gravity Forms is chosen and the worker has no licence key, an amber line: "The worker needs GRAVITY_FORMS_LICENSE_KEY (Coolify, tawd-worker-new) to install Gravity Forms."
- The preview's plugins step reads "Gravity Forms, Rank Math and MalCare" for a Gravity Forms project.
- **Check the form** (1 October 2026), in the WordPress preview section of a Gravity Forms project while the preview is ready and not live: a muted line and a text button **Check the form** (PMs and admins). Before any check: "Check the form: TAWD sends the weekly check through the preview's Gravity Forms form and sees it arrive. It isn't emailed to anyone and leaves no entry." After: "Form check: sent <when>, waiting for it to arrive (refresh in a minute).", "Form check: arrived in TAWD, <when>." or "Form check: didn't go through, <when>. <the site's reason>". Once live, the weekly check (System, Email delivery) covers it.

### Build B, B3: WordPress go-live and rollback (1 October 2026; on 20i since 5 October 2026)

When Hosting is WordPress, the Go live card's steps are, on the records path (the default): Build fee paid, The domain in the client's name, Connect the domain, **Put the domain on 20i**, Point the domain at the new site (the records are the site's own package's: `A @ <its IP>`, `CNAME www finleypest.com`), **HTTPS: the certificate**. VML-run DNS (Cloudflare) is allowed for WordPress now: then the nameserver steps (email records read, a Cloudflare zone with two A records at the package's IP, checked, confirmed, the switch), with **Put the domain on 20i** in place of Netlify's step. The header line reads "The client's domain, always registered in their name, stays where it is: two records point it at the WordPress site's own 20i package, and their email isn't touched." (or, on VML-run DNS, that it moves to VML's Cloudflare with the email records copied first).

**Step: Put the domain on 20i:**
- One line: "TAWD adds finleypest.com and www to the site's own 20i package: the same WordPress as the preview, not a copy." Primary **Put the domain on 20i**.
- While working: "Adding it at 20i..." and the page refreshes itself. When 20i refuses: its reason in red, and **Try again**.
- Done line: "finleypest.com and www are on the site's 20i package (IP ...), added when."

**Step: HTTPS: the certificate** (once the domain is on 20i), by the way chosen on System:
- The certificate's line when there is one ("TAWD's Let's Encrypt certificate for finleypest.com until <date>: being installed at 20i (up to 30 minutes).", "...: HTTPS works.", "...: not issued.") and its note.
- TAWD's own: one muted line (free, asked for by itself once the records point at the site and the domain is on 20i) and a primary **Get the certificate** (**Try again** after a refusal, or when a request hasn't finished after half an hour; **Get the certificate again** with a muted line when 20i still isn't showing TAWD's certificate two hours after it was installed), disabled until the records point at the site.
- 20i's: "This site uses 20i's certificate: $34.99 a year, renewed by 20i until it's cancelled (20i's API can't cancel it: when the site is removed, an admin cancels it in My20i). An admin buys it." Admins get a primary **Buy 20i's certificate ($34.99 a year)** with a dialog naming the price, the yearly renewal and the free way; primary **Buy it ($34.99 a year)**.
- By hand: "Certificates are installed by hand (System, 20i): in My20i, Manage hosting, SSL/TLS, install one for finleypest.com and www.finleypest.com, then Check HTTPS here."
- A secondary **Check HTTPS**, shown only once the records point at the site (before that a muted line says the domain still shows whatever answers there now), and one muted line: it opens the site as a browser would and reads its certificate; TAWD also looks again once a day.

**Launch card, WordPress:** extra blockers "The WordPress preview isn't on the latest build (version 5): deploy it again first (Hosting)." and "The domain isn't on the site's 20i package yet (Put the domain on 20i)." **Go live** opens the same dialog. While working, the steps as a list (A backup of the site, kept in TAWD's storage; The address; Search engines let in; 20i's cache cleared; The live site answers over HTTPS) with the same badges as the preview. Above it, amber lines when the daily IP watch found 20i moved the site ("20i moved the site to ..., and the domain still points at ...: the client changes the A record...", or that TAWD pointed it there itself on VML's Cloudflare) and when the site is suspended. **Roll back** (text danger button, founders and admins, once live): the same dialog, which adds that TAWD backs the site up as it is now first; the steps are that backup, then the restore. Then a secondary **Undo the roll back** (live or rolled back, while nothing was deployed since): a dialog "Undo the roll back?" with a danger button, restoring the backup taken just before the Roll back. A backup made on Bluehost can't be restored ("The newest backup was made on Bluehost and can't be restored on 20i.").

### F4: proving form messages keep arriving (1 October 2026)

System, a third section **Email delivery** (`#delivery`, admins), under Hosting connections:

- **Test inboxes:** the line "One inbox at each provider our clients use. TAWD emails them all once a month (and when you press the button); whoever checks the inbox clicks where it landed." A text area, one inbox per line as "address, provider" (for example "vml.test@gmail.com, Gmail"), with **Save the inboxes** (secondary). Under it, muted: "Postmark sends to any address once VML's account is approved."
- **The results:** a table, one row per inbox: Provider, Address, and the last result as a badge: Inbox (success), Spam (warning), Bounced or Not sent (error, with the reason), No answer yet (info, "sent when"). **Send the delivery test now** (primary). "Last sent when; next automatically on the 1st."
- **Each live site's form** (the weekly check): the line "Every week TAWD fills in each live site's form, marked as a test, and checks the message reaches TAWD. The client isn't emailed." One row per live site: the client, the address, and a badge: Working ("checked when"), Not arriving (error, "sent when, nothing came back within an hour"), or Not checked yet (info). A failure also goes to Slack. **Check all now** (secondary).

**The test email's page** (`/forms/lab/<link>`, no login): "Where did this test land?" with two buttons, **In my Inbox** (primary) and **In Spam or Junk** (secondary). After a click: "Thanks, recorded." (A page with buttons, not the link itself, so email scanners don't answer for a person.)

### F3: Connect the domain (1 October 2026)

Jason: "the most valuable and required setup". The Go live card's steps follow the path.

**Step: Connect the domain** (after "The domain, in the client's name"):
- Before the look-up: one line ("TAWD looks up who runs the domain's DNS and its email, what it points at now, and anything in the way. Free.") and a primary **Look up the domain**.
- After: three facts in a row of small labelled values: **DNS at** GoDaddy (a link to where the client signs in), **Email** Microsoft 365, **Points at now** 104.21.5.57 (or "nothing yet"). Under them, "Looked up when" and a text button **Look up again**.
- **How it connects:** three radio lines, the recommended one marked "Recommended" with its reason under the group:
  - "The client points two records" (the default; "their email isn't touched");
  - "VML points them (the client gives access)";
  - "VML runs the DNS (Cloudflare)" (today's nameserver steps).
  
  **Use this way** (secondary) saves a change, logged. Locked once live.
- Done line: "The client points two records at GoDaddy. Email (Microsoft 365) isn't touched."

**The records paths** (client points them, or VML with access), in order: Add the domain to Netlify (as now: first, so the certificate is ready when the records change), **Point the domain at the new site**, Confirm HTTPS. No email-copy, Cloudflare or nameserver steps, and the Launch card's blockers say "The domain's two records aren't pointing at the new site yet (Connect the domain)."

**Step: Point the domain at the new site:**
- **The records** as a small table (Type, Name, Value), monospace values: `A @ 75.2.60.5` and `CNAME www tawd-x.netlify.app`.
- **What to change** (until it's right): one line per change with an action badge (Add: info, Change: warning, Remove: warning), the record in monospace, and its reason in muted text ("The bare domain points at your old website."). A muted line under the list: "Leave everything else alone: the email records (MX, TXT) for Microsoft 365 must not change."
- **For the client** (records path): **Make the client's link** (secondary). Once made, the link in a monospace box with **Copy**, the line "Private, no login. It shows them these changes with steps for GoDaddy, and an I've done it button. Making a new link stops the old one." and "Made when by whom." A text button **Copy the steps as text** (for an email or their IT person) copies the same steps as plain text.
- **For VML** (access path): the provider's way to give VML access without a password (GoDaddy Delegate Access, Namecheap Share Access, Cloudflare Members) in a muted box, then the same changes for the PM to make.
- **The check:** "Checked when (by the PM / by the client / automatically): not yet." in amber with the remaining changes, or the success line "Pointing at the new site on both public resolvers since when." **Check now** (primary while open). A muted line: "Checked every 15 minutes by itself once the client has the link." When the client pressed I've done it: "The client said it's done, when." (info badge).

**The client's page** (`/connect/<link>`, no login, no TAWD menu):
- A plain white page, TAWD's type, max width 640px, 16px side gutter on a phone. At the top, small muted "Velocity Media Lab", then the title "Connect finleypest.com to your new website" and the line "Two changes where your domain's DNS is managed (GoDaddy). Your email isn't touched."
- **1. Sign in at GoDaddy** (with a link) and the provider's own words for where the DNS records are, as a numbered list.
- **2. Make these changes**: one card per change: the action in bold ("Change", "Add", "Remove"), then Type, Name and Value as labelled rows with **Copy** beside the value, and the reason in muted text. The provider's watch-outs under the cards, in an amber box.
- **3. Tell us you're done:** a primary **I've done it** button. After it: the check's result at once: success "All set: finleypest.com points at your new website. We'll take it from here." or amber "Not yet: still to change: …" and "Changes can take up to an hour to show. We check every 15 minutes, so there's nothing else to do."
- **Not the one to do it?** A text button **Copy these steps for your IT person** and, when the provider has one, "Or give us access instead" with the provider's way to grant it (VML's email shown).
- A link that's no longer good shows only "This link has expired. Ask your Velocity Media Lab contact for a new one."

### A model per AI step, and reading chosen design pages (27 September 2026)

Screenshots in `E:\tawd-work\tawd-models-screens`.

- **Spend, "AI model per step" card** (white, under the tabs): title, "Changes apply from the step's next call and are logged" on the right, one muted line with each model's prices and the rule (reading and checking steps on a cheaper model by default; building, the Creative Director and critique and polish on Opus). The Spend table: Step (bold) with its group muted, Model (a select: Opus 5.5, Sonnet 5, Haiku 4.5; saves on change, "Saved: Sonnet 5 from the next call." under the step, or the reason in red), Default (muted; amber "Opus 5.5 (changed)" when changed).
- **Spend, By step tab:** a Model column (the models the step ran on in the period); the note adds that each call is priced at its own model's rates; the rate note lists all three models' prices. "Mockup inputs" is now "Reading and inputs" and includes the uploaded design's reading.
- **Estimates** name the model: "About $0.05 of AI on Sonnet 5 for 1 page read from the picture...".
- **Intake, Design, "Read the design" dialog** (whenever pages are read from the picture): "Read the uploaded design?" (or "...again?" once pages are kept), the usual paragraph, a fieldset "Pages to read from the picture" with text buttons **Only the home page**, **The pages not read yet** (when some are kept) and **Every page**, then a checkbox line per page ("Page 1 (home)" and muted "2 slices", ", read before and kept" or ", read before: reads it again"); pages not read yet are ticked by default. Under it: the free text-layer pages, the pages left for later ("Pages 3 to 9 aren't read this time..."), and the live estimate (amber "Choose at least one page." when there is nothing to do). Cancel / **Read 2 pages** (or **Put the design together** when nothing new is read). The design then has only the pages read so far, with an import warning naming the rest.
- The dialog's empty gap is gone: the upload row's 320px line rule no longer reaches the dialog's paragraphs.

### Exact copies a page at a time, and the client-supplied design add-on (27 September 2026)

Screenshots in `E:\tawd-work\tawd-copies-screens`.

- **Mockups, "Build the design exactly" card:** the primary is **Build the exact copies** (or **Copy the N remaining pages**) and opens "Copy the design's pages?": the usual paragraph, a fieldset "Pages to copy" with text buttons **Only the home page** and **Every page not copied yet**, a checkbox line per page not copied yet (its name, "(home)", and its address muted, or "the last copy failed"); all ticked by default; the running estimate ("About $0.40 of AI for 1 page (on Sonnet 5, sections rebuilt after a low score on Opus 5.5, look check on Sonnet 5...)", amber "Choose at least one page." when none); Cancel / **Copy 1 page**.
- **Spend, AI model per step:** "Exact and faithful copies, first build" (Sonnet 5 by default) and "Copy sections rebuilt after a low score" (Opus 5.5).
- **Pricing, Add-ons:** "Client-supplied design (per page)" with a muted "Per page" and "$20.00 a page"; the note says it is added by itself when a project's design is read or imported, the page count taken from the design, except on Pro (as for WordPress hosting).
- **Project overview, Price and billing:** "Client-supplied design (per page): 9 pages at $20.00, $180.00".

### The typeface, the copies list, and the registrar and DNSSEC (28 September 2026)

Screenshots in `E:\tawd-work\tawd-night-screens`.

- **Typeface:** Hanken Grotesk is served from the repo (`apps/web/src/app/fonts`, the variable font's Latin subset, 400 to 700, with its SIL Open Font License) through next/font/local. Nothing changes on screen; the build no longer needs Google's font servers.
- **Build the design exactly, Copy column:** a waiting page reads amber "Waiting (1st in line)" (its place in the one queue, next is 1st); the page being copied shows the 8px blue bar and an amber line: "Copying: 5 of 11 sections built", then "Checking all 11 sections against the design", then "Rebuilding 2 low-scoring sections: 1 of 2 done".
- **Content, Page drafts, "Draft the pages?" dialog** (was "Draft N pages?"): the paragraph adds that Slack says when they're ready; a fieldset "Pages to draft now" with text buttons **Only the home page** and **Every page not drafted yet** and a checkbox line per page with no draft (muted "the last draft failed" where so), all ticked by default; an optional "Direction for these drafts" textarea (1,000 characters, an example placeholder, a hint that the writer follows it for voice and emphasis, the house rules still apply, and it is kept with each draft and in the activity log); the running estimate; Cancel / **Draft 3 pages**. When the last draft of a batch finishes, the project's Slack channel gets "N page drafts are ready for Content to review" with a link to Content.
- **Opening a copied page:** on "Build the design exactly", a copied page's name and its match badge link to its copy page (`/projects/[id]/mockups/design/copy?copy=<id>`; crumb "Copy: <page>"): the design and the copy side by side, "Built when on Sonnet 5", "N sections were rebuilt after the first look on Opus 5.5", the section list with a "Rebuilt on Opus 5.5" badge on each rebuilt section, and **Open the page** (that page's copy as a real web page in a new tab; it used to open the project's newest copy of any page).
- **Go live, step 7 (Switch the nameservers):** once the domain is confirmed and before the switch, a ground-coloured panel: "Registered with GoDaddy.com, LLC" (a link to the registrar's site when RDAP gives one), "Nameservers now: ...", and a badge DNSSEC off (done) / DNSSEC on (missing) / DNSSEC unknown (info); when on, the plain explanation in red (turn it off at the registrar, wait, check again; the switch would take the site and email offline); "Checked when (RDAP and public DNS)."; a secondary **Check the registrar and DNSSEC** (then **Check again**). While DNSSEC is on the switch instructions read "Not yet: DNSSEC has to be off first (above).", **Check the switch** refuses with the same explanation, and it is the first blocker under "Before it can go live".

### The page plan's hub rule (28 September 2026)

- **Page plan card:** a hub page has the kind badge "Service hub" and a muted "Links to 3 detailed pages" after its address; each of its detailed pages has a muted "In the Air conditioning hub". Hubs sit just before their detailed pages and count in the page total (and the tier warning); the PM removes a hub with the usual **Remove**, and its pages then stand alone.

### Accepting a copy as it is (28 September 2026)

- **Build the design exactly, Copy column:** a copy that still differs after its rebuild shows, under its match badge, an amber line ("Some sections still differ after the rebuild."; for a Figma design it adds "clean the frame in Figma, or accept it.") and a secondary small **Accept this copy as it is** (PM, designer, admin). Once accepted: a muted "Accepted as it is".
- **The dialog** ("Accept the Home copy as it is?"): one line (sections still differ; accepting counts the page as copied so approval and the build go ahead; nothing is rebuilt or spent), an optional "Why it's fine as it is" textarea with an example, "Recorded in the activity log with your name and shown on the copy.", Cancel / **Accept as it is**.
- **Copy page:** the same button next to Back to Mockups while it still differs; once accepted, "Accepted as it is by Priya, when: "note"".
- **PDF and image designs** never show "clean the frame in Figma": their advice is to compare side by side, then accept the copy or build it again (copies saved with the Figma wording are shown with the new one).

### Stop on running work (28 September 2026)

- **Stop** (a small danger button) sits next to every running line: the design read (in its status block), each copying page ("Stop this page") and "Stop all copies" beside the copies button, the phone versions, the Option B copy, the design review, the improvement and its decisions version, requested changes on a concept, critique and polish, the reference study and the photo text check (inside their "Working..." buttons), page drafts, the site build, the SEO audit and the SEO check, the logo, and monthly edits. The mockup run keeps its own Stop, which now also ends a concept being built at its next AI call.
- **The dialog** ("Stop <what>?"): what is finished is kept; the part running ends before its next AI call, so nothing more is spent; anything waiting doesn't start; it's logged; it can be started again. **Keep going** / **Stop** (danger).
- A stopped job shows its usual failure line with "Stopped by <name> before the next AI call; what was finished is kept." (or "...before it started." for one still waiting).

### A test project's AI cap (28 September 2026)

- **Project page, "Test project and AI cap"** (admins only, before the money panel): card title and the hint "Admins only. A run that would take this project's AI spend past the cap doesn't start." plus the current cap line. One row: a **Test project** checkbox, an "AI cap" amount box (Optional: "Blank is $5" for a test project, "Blank is none" otherwise), "Spent so far: $X", and a small **Save**. "Saved and logged." under it, or the red error.
- **The block:** any paid start on a capped project whose spend plus the run's estimate would pass the cap refuses with "This test project has used $X of its $Y AI cap, and this run (about $Z) would pass it. An admin can raise the cap on the project's page, or try fewer pages." shown where the button is, like the monthly limit.

### Replay on saved answers (28 September 2026)

- **Copy page, admins only:** a small **Replay on saved answers ($0)** button beside the page's other actions. Its dialog ("Replay the Home copy for $0?"): TAWD builds the page again with today's code from the AI answers saved with this copy; nothing is sent to Anthropic and nothing is spent; the replay becomes the page's newest copy, marked as a replay, and this one stays in the history; if the code asks for something the saved answers don't have, it stops and says so, still at $0. Cancel / **Replay for $0** (primary), then the new copy opens.
- **A replayed copy** says so under its score: "A replay: built with today's code from the saved AI answers of the copy made {when}. No AI was asked, $0."

### The style kit (28 September 2026)

- **Mockups, Option A, a "Style kit" card** between the design and "Build the design exactly". Title and one hint (the design's colours, fonts, panels, boxes, buttons, ribbons and icons, found by code; every copy is built with it and checked item by item against it; $0, no AI). On the right **Build the style kit ($0)** (primary; "Build it again ($0)" once built, secondary unless out of date) for the PM, the designer and admins. States: "Not built yet. It takes about a minute."; "Building the style kit... about a minute. This page refreshes itself." (amber, refreshes every 5 s); a red "The style kit didn't finish: <reason>"; an amber line when the design was read again since.
- **Built:** a row of colour swatches with their hex; a small table (Lettering, Font, Match) with one select per kind of lettering (the chosen font first, then the matched alternatives; choosing one builds the kit again and is logged), "Chosen by the team" when it was, and an amber "Its file couldn't be fetched"; one line counting the part styles and icons ("8 icons matched to official marks (tiktok, youtube, instagram, facebook), 13 icons traced from the design as vectors"); amber notes (a loose font match and its alternatives). Under a rule: "The home page put together from the kit alone: matches the design 95%", the hint "Fixed positions and no AI: it shows the kit has everything, not how the site will be built.", the design and the page from the kit side by side (one column on a phone), the element check's misses as a list (or "every item present..."), and **Open the kit sheet**.
- **Shared layouts:** under the counts, one muted line per group of pages that share a layout: "These pages share a layout (64% alike): Mia, Dakota, Willow. The first is the one to build; the others can be filled in from it."
- **The design card is labelled by its source:** "The designer's design (uploaded PDF)" or "(uploaded images)" with "Uploaded: <file>. Read <when>", "Uploaded again since", **Design section**, and "page" in place of "frame"; a Figma import keeps "The designer's Figma design", "From Figma: ...", "Changed in Figma since" and **Figma section**.
- **Repair the copies with the kit** (on the kit card, once there are finished copies): hint (each page's newest copy gets the kit's panels, boxes, ribbons, buttons, icons and fonts by code, then is checked again; a section that comes out worse is put back; $0; anything still wrong is listed with the price of rebuilding just that section), a small **Repair the copies ($0)** ("Repair them again ($0)"), "Repairing N copies..." (amber, refreshes), then a table (Page linking to the copy, "(filled from Mia)" when filled; Match "77% to 84%"; Kit items put in, "kept as before: <sections>"), red lines for failures, and an amber "N sections need a paid rebuild, about $0.21 each on Opus 5.5 (a first guess until one is measured); about $X in all. Nothing is rebuilt without a go." with a list "<Page>: "<section>" (about $0.21): <reasons>", or "Every section passes the kit check: nothing needs a paid rebuild."
- **Shared layouts:** each group's line explains that the other pages can be filled from the first page's copy by code, with a small **Fill Dakota and Willow from Mia ($0)**; a fill is kept only if it matches its own design at least as well as its current copy (else dropped and logged).
- **Copy page:** "Repaired with the style kit by code ($0): N kit items put into the copy made <when>; it matched 77%, now 84%." or "Filled by code from the Mia copy, which shares this page's layout ($0): its layout with this page's words and photos (N words put in)."
- **Copy page:** when the copy was built with the kit, under the score: "Style kit check: N of M items not right" (red) with each miss by name ("Meet the pack: the ribbon "Mia" (kit-ribbon-1) is missing (4 of 5).", "... is in the wrong font (Times New Roman instead of Lato).", "... is cut off.", "... overlaps (...)"), or "Style kit check: all M items present, in the kit's fonts, nothing cut off or overlapping."

### Phone versions by code, and the shared phone header and footer (29 September 2026)

- **Build the design exactly:** once every page is copied, a small **Make the phone versions by code ($0)** beside the other actions (the PM, the designer, admins). The Phone column says "By code", then "Phone check passed." or an amber "Phone check: N to fix (sideways scrolling: ...; small tap target: ...)" (all of them on hover), with **View** for the 390px picture and the designer's Accept / Push back as for a responsive version.
- **On a phone (under 768px) every page shows the same header:** the logo (or the business name) on the left, a menu button (three lines, a cross when open) on the right, 60px tall, sticky; the menu drops down under it with each page (44px rows), a page with a submenu as a row that opens in place ("All of Meet the Pack", then each dog), the current page in the accent colour and bold, then the tagline and the social icons (44px). The design's own header sections are hidden on a phone.
- **The same footer on a phone:** the logo, each link column as a row that folds open (+ / -), the social icons, the copyright line, then TAWD's Privacy policy and Cookie policy links. No script: all of it is <details>.
- **Phone rules** (by code, from each page's layout): no fixed heights or widths, rows of three or more like cards as 2 columns, other rows stacked, one alignment per section, big headings scaled down, images never larger than they are, button-like links at least 44px tall, nothing wider than the screen.

### Page names after confirming, and words and links (29 September 2026)

- **Build the design exactly:** once the pages are confirmed, a small **Change page names and addresses** turns the Page and Address cells back into fields, with **Save names and addresses** (primary) and Cancel; only what changed is logged, before and after; the copies stay as they are.
- **A "Words and links" card** under it (once pages are copied): hint (what the $0 pass fixes: a "MEET" button's garbled name from its card, Terms of Use and Disclaimer out, the footer's privacy and cookie links, Contact out, links to the pages their words name), a small **Fix the words and links ($0)** ("Fix them again ($0)"), "Fixing every page... refresh the page to see what changed." (amber), then per page "<Page>: <change>; <change>", and an amber "N links don't say where they go. Choose for each, then save" with a table (Link "READ MORE" x12, On <pages>, Goes to: a select of Leave it / Remove the link / each page, the suggested one marked) and **Save and fix the pages ($0)**; or "Every link goes to a page."

### Videos from social links (29 September 2026)

- **A "Videos from social links" card** on Option A's Mockups page (under Words and links): hint (paste TikTok and Instagram video links, one per line, a title after " | "; the site gets a Videos page and the home page's featured videos show the first ones; each plays only when clicked), an Optional "Video links" textarea ("N saved"), **Save the videos**, then "Saved N videos." with any lines left out named.
- **In the built site:** the home page's featured video cards become buttons that swap in the video's player on a click (captions become the videos' titles when given); a Videos page with the site's header and footer, an H1, the line "Each video plays from TikTok or Instagram when you click it; nothing is loaded from them before.", and a grid of 9:16 thumbnails with a round play mark (2 columns on a phone). TikTok thumbnails come from TikTok's public oEmbed at build time; Instagram ones use the design's featured-video pictures.

### SEO basics and sharing the preview (29 September 2026)

- **An "SEO basics" card** on Option A's Mockups page: hint (each page's title and description in search results, its H1 and picture descriptions, suggested by code from the page's own words, changed as wanted, approved page by page; the design and words stay; $0), a small **Suggest the SEO basics ($0)** ("Suggest again ($0)"), "N of M pages approved.", then a list of pages (name, address, Approved / To approve badge, **Review**). Review opens amber heading notes (no H1, several H1s, a skipped level), Title (count "of about 60"), Description (count "of about 155"), Main heading (H1) ("Now: no H1"), a field per picture without a description, and **Approve this page** (primary). The build uses the approved values: alt text on the pictures, the H1 made from the element holding those words (its look kept), the title and description.
- **Preview card, "Share for review"** (once a preview is live): the line "Send this link to the client or the team: only people with it can see the preview, and it's kept out of search engines until go-live.", the address in code style and a small **Copy the link** ("Copied").

### Lane 2, simplified: Build site from the design (29 September 2026)

Jason's direction: an uploaded or Figma design is a reference to build a site close to, not a pixel copy.

- **Mockups for a Lane 2 project** is one card with a step line: **Design · Build site · Preview · Launch** (the current step bold, done steps ticked).
- **Build site:** the pages table (Page, Address, a note "Same layout as <page>: filled by code, $0" where it applies) with a small **Change page names and addresses**; the Video links textarea with **Save the videos**; the estimate as a hint line ("About $X of AI on Sonnet 5: the header and footer, N pages built from its design, M filled by code"); **Build Home first** (primary, `PaidStepButton`) and **Build every page** (or "Build the other N pages"). While building: an amber "Building... refresh to see it" with **Stop**.
- **Preview:** per page, the design and the built page side by side (two columns, one under 720px), labelled "Design" and "Built"; the automatic check's notes as a short amber list; the search listing (Title, Description, H1) with **Approve the listing**; a Feedback textarea with **Rework this page** (paid, its estimate shown; only the page is rebuilt, from the feedback). Under the pages: **Put in the approved listings and videos ($0)**, **Deploy the preview**, then the share link with **Copy the link**, and **Approve** (how the client said so, what they said), then **Launch the site** (to Build's go-live).
- **Not on the screen any more:** exact copies, section scores, repair, fill, per-section rebuilds, and phone versions as a step. Admins keep them under a collapsed **Advanced (admins)** card, with **Undo the kit repair and fill**. On an Option B project, Advanced also links to **the earlier Option B screen** (the Creative Director's review, the improved design and the alternatives), for admins only.

### Option B: Review & suggestions first; retries for $0 (29 September 2026)

- **Option B's steps** are **Review & suggestions · Build site · Preview · Launch**. Section 1 names the design (with Open the design), then:
  - not reviewed: a line on what the review does and its estimate, **Review the design** (primary, `PaidStepButton`, Sonnet 5 by default) and **Skip the review ($0)** (secondary);
  - reviewing: amber "The Creative Director is reviewing the design... This page refreshes itself.";
  - failed: the reason in red, **Review again**, and the skip;
  - done: the review's summary, "N suggestions: A accepted, O still to decide. Must-fix ones start accepted." with **See them pinned on the design** (the report page), **Accept the O still open** / **Reject the O still open**, then one bordered row per suggestion: grade badge (Must-fix amber, others info), bold title, where (hint), the problem (hint), "Change:" and the change, a state badge (Accepted / Accepted (must-fix) / To decide / Rejected; a rejected row is dimmed) with small **Accept** and **Reject**. Facts to check show as an amber line with **Confirm the facts**. A small **Review again** (paid) at the end.
  - skipped: "Review skipped: the site is built from the design as drawn."
- **Build site** under it shows "Building opens once the review is done (or skipped)." until then. The accepted suggestions go into the reviewed page's build.
- Under the steps, a hint: "Want other designs to compare? **Build alternatives or open the concept board** (paid; the estimate shows before anything runs)." It opens the earlier Option B screen (`?classic=1`).
- **A build that stopped after paying** says so in red with "Build again below: the answers it already paid for are reused, for $0." The build buttons then read "Build Home first ($0, reusing saved answers)" and the estimate line "$0, reusing saved answers: the header and footer and Home, from the build that didn't finish."
- **The client approving the preview** moves a Lane 2 project to Build (logged).

### Site check (29 September 2026)

- **Site check** (top bar, admins; `/admin/e2e-check`): page title "Site check", lede "Checks the whole path from a design to a shared preview link on this server, with no AI and no spend. Admins only."
- One card, "End-to-end check": a hint on what it does (a test project from a small made-up design, built with stand-in answers, deployed as a Netlify preview, the share link opened page by page and picture by picture; about 5 minutes; the test project stays until the next check), then the result line (Passed / "Failed at the step marked below." / stopped), an ordered list of the five steps, each with a badge (Passed done, Failed missing, Running warning, Waiting info), its label and a detail line (red when it failed), the test preview's link and the test project, and **Run the end-to-end check ($0)** (primary; "Run the check again ($0)" after a run). It refreshes itself while running.

- **A preview Netlify keeps private** (29 September 2026): each ready preview is opened as a signed-out visitor; if refused, an amber line beside it (the Build screen's Preview card, and the Lane 2 Preview step above the share link) says "Netlify is keeping this preview private..." and names the setting (Project configuration > General > Visitor access > Project visibility: Public for production and previews; the team default on Public for new projects), then "deploy again". It goes on the next deploy that opens.

### The sample client's fixes: locked stages, video links, share link (29 September 2026)

- **A locked stage page** (Build or Content opened before the project reaches it) shows a card at the top: title "Not yet: this stage is locked", the reason ("Build unlocks after content is approved."; Lane 2: "Build unlocks when the client approves the preview of the site built from their design."; Lane 2 Content: "no Content step"; paused), a hint with what to do next, and a small primary button to where the work is ("Go to Content", "Go to Mockups", "Open the project"). Never "Page not found".
- **Video links** (Lane 2 Build step): links may be on lines or separated by commas or spaces; after **Save the videos** a line says "Saved N videos." and, in amber, any links that couldn't be read.
- **Share for review** shows only once a deploy has finished, with that deploy's own address.
- **Site check** has a sixth step: "Open every stage link (Intake, Design, Content, Build & preview, Go live) for every lane".
- **The automatic Site check after a deploy** (1 October 2026) runs the first four steps only and stops before Netlify (each Netlify deploy costs the VML team credits): the card lists those four. The full check, with the deploy and the share link, is **Run the check again ($0)** on System.
- **Built sites** (by code, the finishing pass): visible `[PLACEHOLDER: ...]` marks (amber on cream, a dashed box for a missing photo) where the design only had stand-ins; photo galleries open a picture large on a click (a dark backdrop, a round close button).

- **Check first ($0)** (Lane 2 Build step, secondary, before the paid buttons): a free run of the same build with stand-ins for the AI; nothing kept or deployed. While it runs, an amber "Checking the build for free..." (the page refreshes itself); then a hint line "The free check passed: the build would ask the AI N times and reuse M saved answers ($0), about $X (pages). K pictures ready, J from the intake's originals, T trimmed of design marks. Nothing was spent." or, in red, "The free check found a problem, so a paid build would have failed too: ... Nothing was spent."
- **What a build cost:** the Preview's hint "Version N cost $X of AI (estimated $Y); M saved answers reused, $0."; a build that didn't finish says the same after its reason.
- **A build stops itself at twice its estimate** ("Stopped at twice its estimate: this build has spent $X (estimate $Y). Nothing more was spent; <page> wasn't built. Check the model and the estimate on Spend before building again.").

### The project's steps and the Next step card (29 September 2026)

Jason's decisions after the screens review (29 September 2026): the team must always see **what happens next and whose job it is**. These rules override anything above that says otherwise.

**Names.** The Mockups stage is called **Design** everywhere on screen (buttons, crumbs, lock cards, hints): "Continue to Design", "Go to Design", "Back to Design". In Lane 2 the step is **Client's design**. Build is **Build & preview**, and **Go live** is its own step. The saved stage values and the addresses (`/mockups`, `/build`) do not change. **QA is not a step**: its checks (the SEO check, the Site check, the client's approval of the preview) belong to Build & preview.

**The steps, by lane** (`lib/journey.ts`, one source for the header bar, the Projects board and the Next step card):

| Step | Lane 1 | Lane 2 | Opens |
|---|---|---|---|
| Intake | stage Intake | stage Intake (the Design section holds the client's design) | Intake |
| Design / Client's design | stage Design | stage Design, until the design is read and (Option B) reviewed or the review skipped | Design |
| Content | stage Content; from Design it shows "Can start early" (keywords and the page plan) | not shown | Content |
| Build & preview | stage Build until the client approves the preview | stage Design once building opens, until the client approves the preview | Build (Lane 2: Design, its Build site part) |
| Go live | stage Build after the client approves the preview | stage Build | Build, its Go live card |

A Live project shows every step done. A paused project keeps Intake and Design open and the rest locked ("This project is paused"). Lane 2's own four-step strip inside Design is removed: the header bar is the only step bar.

**Project page** (`/projects/[id]`), top to bottom under the header:

1. **Tabs**: Overview, Settings, History (`?tab=settings`, `?tab=history`; Overview is the default). Tier and fit warnings stay above the tabs.
2. **Overview**:
   - The **Next step card**: white, a 2px blue border, 12px radius. It holds:
     - a small blue uppercase label "Next step", then the step's title (24/700),
     - one plain sentence on what to do,
     - "Whose job:" with the avatars and names of the assigned people in that role, or the role alone when nobody is assigned ("A PM"). When the step waits on someone outside the team: "Waiting on: the client" or "Waiting on: an admin or a founder".
   - On the right, one primary button that goes to where the work is done ("Open the intake", "Open the concepts", "Draft the pages", "Open Build", "Open the go-live steps"), and at most one secondary link. While TAWD itself is working: "Waiting on: TAWD", with the work's name and no primary button. A Live project says "Live since {date}", and its button is "Open monthly edits".
   - **Where things stand**: a card with one row per step of the lane. On the left the step name, on the right a short state in words: done in blue-text, waiting in amber, not started muted. Examples: "Done", "3 concepts ready, waiting on the client's decision", "Can start now", "After the client approves the preview".
   - Then, unchanged: the intake completeness summary, the client's DESIGN.md card, "For the go-live check" and the Monthly edits card.
3. **Settings**: Tracking, Slack (`#slack`), Test project and AI cap (admins), Price and billing (admins), Delete project (admins).
4. **History**: the History card.

The header's right side on the project page keeps only "Edit project details". The Next step card replaces the old Intake, Mockups and "Continue to Mockups" header buttons, and the Content card.

### The main menu, System, the Run book and My work (29 September 2026)

Jason's decisions (29 September 2026). These rules override the top-bar links described above.

**Top bar.** On the left: the logo, then **Projects** and **My work** for everyone. **Run book** follows for anyone who isn't an admin (admins find it in the Admin menu). **Admin ▾** comes last, for admins only. The right side is unchanged: email, Change password, Sign out. The logo goes to My work, or to Projects for admins.

**On a phone** (720px and narrower, 30 September 2026): the top bar has two rows. The logo, Change password and Sign out on the first; Projects, My work and Admin ▾ (or Run book) underneath, 48px tall. The email is left out to make room.

**Admin menu.** A button "Admin" with a chevron. It opens a white panel under the bar (12px radius, the card shadow). The panel closes on Escape, on a click outside and after choosing. It holds four groups, each with a small muted uppercase heading (12/700), then links (15/500, 40px tall, blue-tint on hover):
- **People:** Team, Activity.
- **Money:** Spend, Revenue, Pricing.
- **Rules:** Privacy laws, Run book.
- **System:** Site check, Hosting connections.

The button is underlined like a current link while any admin page is open. Pages keep their addresses. `/admin/e2e-check` opens the System page at its section (`/admin/bluehost` was removed with Bluehost, 5 October 2026).

**System** (`/admin/system`, admins): the page title "System", with the lede "The checks and connections TAWD runs on. Nobody needs these day to day." Two sections follow:
1. **Site check** (`#site-check`): the Site check card, unchanged.
2. **Hosting connections** (`#hosting`): 20i (Build B, since 5 October 2026), under a card-title "20i (WordPress, Build B)": see "System, 20i section" above.

When the latest Site check failed, admins see a red strip under the top bar on every page: "The last Site check failed at <step>: <detail>." with a link "Open System".

**The Site check after each deploy** (Jason, 29 September 2026):
- The Site check section adds one hint: "It runs by itself after each deploy, once the worker is on the new version. Only a failure is announced: …, switched off with `TAWD_AUTO_SITE_CHECK=off`."
- An automatic run shows "by TAWD after a deploy" where a manual one shows the person.
- A failure is announced three ways, and a pass by none:
  - the red strip;
  - an email to each admin (subject "TAWD: the Site check after <version> failed", with the step, the detail and a link to System);
  - one line in the team Slack channel.

**Team Slack channel card** (under the Site check):
- A card-title "Team Slack channel", with the badge "Connected" (done) or "Not set" (info), and one line on what it is for.
- When it isn't set and a project has a webhook: a primary "Use the channel your projects post to (ending XXXX)", which copies that webhook as it is stored, encrypted.
- Always: a webhook field with "Connect" or "Replace webhook".
- When set: "Webhook ending XXXX. Stored encrypted and never shown." and a text button "Disconnect".

**Run book** (`/runbook`, everyone signed in): a 760px reading column. A title, a one-line lede, a short contents list of links, then sections with section titles (24/700) and plain paragraphs and lists:
- What TAWD does.
- The two lanes.
- The steps, and whose job each one is.
- Your role.
- Money and the AI.
- The house rules.
- When something goes wrong.
- Going live.
- Words TAWD uses.

The words live in the code (`app/(app)/runbook/page.tsx`) and are updated whenever a step changes.

**My work** (`/my-work`, everyone; where anyone who isn't an admin lands after signing in):
- The title "My work", with the lede "What's waiting on you, across every project."
- **Waiting on you:** a white table card with the columns Project (name, trade and tier chips), Next step (the Next step card's title, and its sentence under it, muted), Step (the lane-aware step name), Last activity, and a primary **Open**. Open goes to the Next step card's button address.
  - A row appears when the next step's job names you, or names your role while nobody in that role is assigned, or waits on "an admin or a founder" and you are one.
  - Rows are sorted oldest activity first.
- **Waiting on someone else:** your projects whose next step belongs to someone else, TAWD or the client. Each shows one muted line: the project name, what, and who.
- **Empty:** "Nothing is waiting on you right now." and a link to Projects.

### The next-step bar (30 September 2026)

Jason's decision (29 September 2026): the same bar, in the same place, on every stage page, so nobody hunts for the next button. These rules override the older placements above (the intake header's gate button, the concept board's header buttons, Content's "Move to Build").

**Where:** fixed to the bottom of the window on Intake, Design (every state, Lane 1 and Lane 2), Content and Build. Not on the project page (its Next step card says the same), Edit project or the admin pages. White, a 1px line on top, a soft shadow upwards, 72px tall, the content in the page's width (40px side padding; 16px on a phone, where it stacks: status on top, buttons full width). The page leaves room for it, and a section's sticky save bar sits just above it.

**Left, the status** (one source: `lib/next-step.ts`, the same as the Next step card):
- a badge: "Now" (blue-tint / blue-text) when the next step's work is on this page, "Waiting" (amber) when it waits on TAWD, the client, or an admin or a founder, or "Next step" (info) when it's on another page;
- the Next step card's title (15/700);
- under it, 13/400 muted: "Whose job: Priya (PM)" or "Waiting on: the client", and, when the work is on another page, "· on Content".

**Right, the one next action** (at most one secondary and one primary):
- The work is **on this page** and is a plain action: the real button, moved here from the page. Intake: "Continue to Design", or "Move to Design" while answers are missing (it opens the same "Continue without these?" dialog). The concept board: "Record client decision" (primary) and "Download client pack" (secondary, once a concept is ticked). Content: "Move to Build & preview" once the client approved the copy.
- The work is **on this page** inside a card: a primary link that scrolls to that card, with the Next step card's words ("Draft the pages ↓", "Run the SEO check ↓", "Deploy the preview ↓"). **The bar never starts a paid step**: paid work always starts from its card, beside its model and estimate.
- The work is **on another page**: a primary link there, with an arrow ("Open Content →").
- **TAWD is working** on this page, or the project is paused: no button, only the status.
- Other tools stay where they are, quietly: "Regenerate concepts" stays top right as a secondary button.

Pages keep their cards; only the one next action moves into the bar. Section anchors the bar scrolls to: Design `#setup`, `#concepts`, Lane 2 `#client-design`, `#review`, `#build`, `#preview`; Content `#research`, `#plan`, `#drafts`; Build `#site`, `#seo-check`, `#preview`, `#go-live`, `#edits`.

### Build split into Build, Check and Preview; Go live as a guided checklist (30 September 2026)

Jason's decisions (29 September 2026): the Build page was nine cards stacked on one page. It becomes short parts, and Go live gets its own view. These rules override "Build A, 8a/8b" and "Go-live (Phase 9)" above wherever they differ.

**Parts.** Under the project header, a segmented row of links (the Spend tabs' style: white card, the selected part blue with a 3px underline), one per part, each with its number, its name and one muted word for its state ("Done", "Now", "Later"):
1. **Build**: the Site card and the Hosting card.
2. **Check**: the Before go-live checklist, the health and beauty rules and the SEO check with its sign-off.
3. **Preview & client approval**: the Preview card (deploy, share, the client's decision).
4. **Go live**: the go-live checklist, the Launch card and Monthly edits.

Each part has its own address (`/build?part=build`, `check`, `preview`, `golive`). With no part in the address the page opens where the work is: Build until a build has finished, Check until the SEO team has signed off the latest version, Preview until the client approves it, then Go live. The step bar's **Build & preview** opens the Build page at its current part; **Go live** opens `?part=golive`. Lane 2 builds and previews on Design, so its Build page shows only the Go live part, without the row of parts. Old links to `#go-live` and `#edits` still land on the Go live part.

**Go live, a guided checklist** (the Go live part, two columns; one on a phone):
- **The checklist card** (left): the title "Go live: N of 9 done" (the build fee plus the eight domain steps), the one-line purpose, then the steps as a list:
  1. Build fee paid; 2. The domain, in the client's name; 3. Read the client's email records; 4. Set up Cloudflare; 5. Check the email records on Cloudflare; 6. Confirm with the client's email provider; 7. Put the domain on the Netlify site; 8. Switch the nameservers at the registrar; 9. Confirm HTTPS. Then, apart, "GA4: the client's property, VML as Editor", marked "Not blocking".
  - A **done** step: a filled blue circle with a check, its name and its line ("Recorded by Jason, 29 Sep"). A text button "Do again" opens its controls, for the steps that can be repeated.
  - The **current** step (the first domain step not done): blue-tint background, an outlined blue circle with its number, its name, its line, "Whose job:" with the assigned PM's name (or "A PM"), and its controls: the only step with its form and buttons open.
  - A **later** step: a grey outlined circle with its number and its name only, muted.
  - The **build fee** can be recorded at any time, so while it isn't recorded its step keeps its button for admins and founders, with "Waiting on: an admin or a founder". GA4 keeps its form open until recorded.
- **The Launch card** (right): "Launch", "Opens when every step is done." (or the live line once live), the founders' notes in an amber box ("For the founders (not blocking)"), anything else still blocking in the red box, then "Go live" (primary, founders and admins; disabled until ready) and "Roll back to the previous deploy" (secondary) once live. Others see "Founders and admins press Go live."
- **Monthly edits** (`#edits`) follows under both.

The next-step bar on the Build page links to the part and the card where the work is ("Run the SEO check ↓" on Check; "Open the go-live steps" from another part).

### The designer's Design section, Pause and Resume project (30 September 2026)

Two blockers from the screens review, approved by Jason on 29 September 2026.

**The intake's Design section (Lane 2) is the web designer's too.** A web designer can do everything in the intake's Design section that a PM can: upload the design (PDF or images) and remove it, link the Figma file, choose the pages, read the design and read it again. The rest of the intake stays with PMs and admins: a designer sees the other sections read-only, as before, and filling intake answers from the design (the pre-fill) stays with the PM. On the Design section, the upload zone and its buttons show for PMs, web designers and admins; anyone else sees the files and "Only a PM, a web designer or an admin can change the design."

**Pause project** (PM or admin; Jason, 30 September 2026). On the project page's **Settings** tab, a card "Pause the project": one line ("Nothing moves while it is paused: the stages lock, and anything already running finishes. Resume it from the Overview."), and a secondary button **Pause project**. It opens a dialog: "Pause {name}?", what happens, a **required reason** (at least 10 characters, with the hint "Recorded in the activity log with your name and the time."), Cancel and "Pause project" (disabled until the reason is long enough). Not shown for a project that is already paused. The change is logged like any stage change, with the reason. Others see the card without the button and "A PM or an admin can pause it."

A paused project's Next step card then also says who paused it, when, and why: "Paused by Priya Nair, 30 Sep: waiting for the client's deposit."

**Resume project** (PM or admin). A paused project's Next step card (project page, Overview) says "This project is paused", one line ("Nothing moves until it is resumed. Its screens stay open to read."), and, for PMs and admins, a primary **Resume project** button. It opens a small dialog: "Resume {name}?", "It goes back to {stage}, where it was when it was paused.", an optional note, Cancel and "Resume project". The project returns to the stage it was paused at (from the activity log), and the change is logged like any stage change, with the note. If TAWD can't tell where it was, it goes back to Intake and the dialog says so. Others see "A PM or an admin can resume it."

### Updates: the step after Go live (1 October 2026)

Jason's decisions (30 September 2026, `docs/plans/updates.md`). These rules override "Build A, 8c: monthly edits and dev hours" wherever they differ.

**The step.** **Updates** is the last step of both lanes, after Go live: Lane 1 has 6 steps, Lane 2 has 5. It opens once the project is Live ("Now" under it); before that it is locked ("Unlocks when the site goes live"). Its page is `/projects/[id]/updates`. The Monthly edits card moves there from the Build page's Go live part, which keeps a one-line link "Monthly edits are on Updates". The Next step card of a Live project reads "Updates: N of M hours this month" with "Open Updates".

**The month card** (top, white card):
- Title "{Month}: N of M included hours". M comes from the project's tier (an admin setting on Pricing; 8 for every tier until changed).
- A meter: done (blue), planned (light blue: the estimates of open requests not yet worked) and left (grey), with a legend, and one line: "Anything over the included hours, and every new page or redesign, becomes a quote the client approves first."
- Buttons on the right: **Log time** (secondary) and **Log a request** (primary).
- The requests, one item each: the state badge, the category badge, the client's words in quotes, and a muted line "Asked {day} · {pages} · Estimate {hours} · Time {logged} · AI {cost}". States: To make, Editing, Ready to check, In a new build, Done, Quote: waiting on the client, Declined). The row's actions stay as today (Make the edit, See the changes, Put it into the site, Mark done, Log time), each shown only when it applies.

**Log a request** (dialog):
- What the client asked (required), Asked on.
- **Category**, required, as chips: Content, Design, New page / landing page, Technical, SEO, Tracking & integrations. A fixed list for now.
- With Design: a tick box "This is a redesign (always quoted)".
- **Pages**: tick boxes of the built site's own pages (the latest finished build), for every lane; "A new page" for New page / landing page.
- **Hours estimate** (required, in hours, quarter hours allowed).
- A team note.
- Before saving, an amber box when it becomes a quote: "This becomes a quote." and why: "New pages are always quoted.", "Redesigns are always quoted.", or "This month has N hours left of M: the X hours over are quoted at the hourly rate." The primary button then reads **Log it and draft the quote** instead of **Log the request**.

**Quotes** (a card beside the month card; one row per quote):
- Drafted by TAWD from the Pricing page only: New page, Landing page (the existing "Subdomain site or ad landing page"), Redesign, and Hours over the plan (hours × the hourly price). A line whose price isn't set reads "Price not set: an admin sets it on Pricing", and the quote can't be recorded as approved until every line has a price.
- Each row: the request, the total, the state (Draft, Waiting on the client, Approved, Declined), **Download the quote** (a clean page to print or save as PDF), and **Record the client's answer** (approved or declined, how they said it, their words; logged).
- A quoted request's work (the AI edit included) is locked until the quote is approved: "Waiting on the client's approval of the quote." Declined closes the request.

**The monthly invoice** (admins only; a card under the month card):
- A month picker (this month and the ones before, since go-live) and **Prepare {month}'s invoice**, which starts it from the month's work: one line per request with time logged that month (task, category, hours) at $0 as included hours, one line per quote approved that month at its total, and the monthly plan line at the project's monthly price.
- Every line is the admin's to change: date, task, category, hours, amount. Add a line, remove a line. **Save the invoice** (logged). The hours are the team's, never the AI's time or TAWD's AI cost.
- **Download**: "Open to print or save as PDF" (a clean page with VML's name, the client's, the month, the lines and the total) and "Download CSV".
- No client logins and no email: the admin sends the file.

**Pricing page** (admins): three new rows, Hours over the plan (per hour), New page and Redesign, each blank until an admin sets it, and a card **Included hours a month** with one number per tier (Starter, Growth, Pro), each logged when changed.

### Content first, part 1: the current website and the three content choices (1 October 2026)

Jason's decisions (30 September 2026, `docs/plans/content-first.md`).

**The current website** (intake, Website section):
- The field reads **Required**, not Optional. Under it, a tick box **No current website available**. Ticking it greys the field out (and keeps any address typed, unused); unticking brings it back.
- It is a required item in the Required info card ("Current website, or No current website"), and **the only one that blocks**:
  - "Move to Design" is disabled while it's missing, with the hint "Add the current website, or tick No current website: it decides where the mockup's words come from." The "Continue without these" dialog can't skip it.
  - **Generate** on Design is disabled too, for every project, with a red banner "Add the current website first": no paid concept run starts until it's answered.
  - Every other missing item stays a warning, as before.
- **Reading the current site ($0, no AI):** since 0.96.0 one read for the whole site: see "One read of the current site" below. It's the client's own content: data, never instructions.

**The three content choices** (intake, Content section, three cards instead of Auto and Manual):
- **Keep all content as is**: the current site's words, page by page; TAWD only suggests SEO fixes. The cheapest, with no drafting. Greyed out with "Needs a current website" when there's none.
- **Content provided by the client**: their documents or pasted copy; TAWD only suggests SEO fixes.
- **New site**: TAWD writes every page, as today, starting from the current site's words when there is one.
- Existing projects keep their choice: Auto reads as New site and Manual as Content provided by the client.

Parts 2 and 3 (the Home words card before Generate, and Content as SEO suggestions for the first two choices) follow once Jason has seen a first real run.

### Content first, part 2: the Home page words before the concepts (1 October 2026)

Jason's decisions (30 September 2026, `docs/plans/content-first.md`). Lane 1 only; Lane 2 keeps the client's design and its words.

**The Home page words card** (Design, above the set up, before Generate):
- Title "Home page words", the line "The concepts use these words, section by section. Edit anything out of date, then use them.", and a badge for where they came from: **From the current site**, **From the client's copy**, or **Written by TAWD**.
- **Where they come from**, by the intake's content choice:
  - **Keep all content as is:** the current site's home page as TAWD read it ($0).
  - **Content provided by the client:** the copy pasted in the intake's Content section, split at its headings; the current site's words where there's none ($0).
  - **New site:** one AI call writes the words from the intake (and the current site's words, when there are some). Its model and estimate show on the button, "Write the Home words (about $0.03 on Sonnet 5)", and nothing runs until it's pressed.
  - Nothing to start from: the card says so and offers the AI writing.
- **The words, section by section:** one block per section (Menu, Hero, Services, Why us, About, Reviews, Contact, or the site's own headings), each a text area the team can edit. A section can be removed.
- **Checks, by code:**
  - A phone number, a founding year or a licence number that differs from the intake is flagged in amber beside its section: "Differs from the intake (916-555-0100): the intake wins." The concepts use the intake's fact.
  - Testimonials are listed apart, each with a tick box "Confirmed with the client that it's real". An unticked one reaches the concepts only as a visible [PLACEHOLDER: a testimonial to confirm with the client].
- **Use these words** (primary) saves and approves them (who and when, logged). Changing anything afterwards needs **Use these words** again.
- **Required:** Generate is disabled until the words are used, with the banner "Use the Home page words first". The server refuses a run without them too.

**The concepts** then use those words as the page's text, section by section, in their own layouts: every fact exactly as written, nothing added (anything missing is a [PLACEHOLDER]).

### One decision that overrides the above

Jason's decision, 24 September 2026: **3c ships without email.** The
generating screen's line "Everyone assigned to the project is emailed when it
finishes" reads "Everyone assigned sees it on the project" instead, and TAWD
sends no email at all. Email needs an outside provider and an account, and it
was not worth holding the release for. Revisit when one is added.

### Speed check (1 October 2026)

Build page, Go live part, a **Speed check** card first (above Form messages), white card, title "Speed check" and one muted line: "Google PageSpeed on each preview, on a phone and a computer: the scores Google gives the site. Free, about a minute. 90 and up is good."
- One section per preview that exists (heading "Netlify preview" / "WordPress preview" in 14/600, as Form messages' sections): a small table, rows **Phone** and **Computer**, columns Speed, Accessibility, Best practices, SEO. Each score is a pill in Google's bands: 90 and up blue (the done badge's colours), 50 to 89 amber, under 50 red (`--red` on `--red-bg`), none "–".
- Under it, "Main things to fix (phone)" and up to four of Google's own titles with what each would save in muted text ("Render-blocking requests (Est savings of 2,890 ms)"). On a preview, a muted line: "SEO reads lower on a preview: search engines are kept out of it until go-live."
- The button row (PMs and admins): primary **Check speed** the first time, secondary **Check again** after, and a muted line "Checked <when>, <address>". While checking: "Checking <address>… about a minute; this page refreshes itself." A failure in red with the reason (for example Google's daily allowance, naming PAGESPEED_API_KEY and where it goes).
- With no preview yet: "Deploy a preview first (Netlify or WordPress): the check runs on it."
- **The speed gate** (Jason, 1 October 2026), under the card's line, for the preview of the hosting the site goes live on: muted "Speed for go-live: phone 94, computer 100. Good." or "…, within the buffer (the aim is 90)."; amber "Go live needs a Speed check of the Netlify preview of the latest build: 85 or more on a phone and a computer (the aim is 90)." and "Speed for go-live: phone 69, computer 78. Both need 85 or more (the aim is 90), or a founder lets it go live." For founders and admins, beside the last one, a secondary **Let it go live anyway** (logged; for this build only). The Go live card lists the same as a blocker or a flag.

**Speed up this build** (The site card, Build page): when the latest build was made before the speed pass, a secondary **Speed up this build** with the muted line "This build was made before the speed pass. Free, no AI, a few minutes: a new version with smaller pictures, the fonts on the site and faster loading. Then deploy the preview again."

The **speed pass** has no screen of its own: each build's checks list gains "Made fast: pictures, fonts, loading" with one line of what it did (it never blocks go-live).

### The page review (step 3a, 3 October 2026)

Every page of the latest build is checked in TAWD before go-live by a PM, the Web Designer, a founder or an admin (Jason, 1 and 3 October 2026).

- **Review pages card** (Build › Check, after the checklist, `#review-pages`): "Version N: 3 of 8 pages approved. Go-live waits for the rest." (amber) or "Version N: all 8 pages approved." (blue). One row per page, as the health flags: a badge (**Approved**, blue; **To review**, red-tint missing), the page name as a link with its path in muted text, and a muted detail ("Approved by Sam on version 5, today, 10:12 AM", "Approved before; only the header or footer changed since", "2 open comments", or "Not reviewed yet"). Buttons: primary **Start reviewing** / **Review the next page** / **Open the review**; secondary **Approve all unchanged (N)** when only the header or footer changed since pages were approved; for founders and admins, secondary **Let it go live anyway** (a dialog naming the pages not approved; for this version only; logged), after which the status line says who let which version go live.
- **The review screen** (`/projects/[id]/build/review/[pageId]`): the concept screen's two columns (stacked under 1,100 px). Left card: a page picker ("2. Drain cleaning (approved)"), "Page 2 of 8, version 5. Click a section to comment on it.", and a **Computer / Phone** segmented control (1,280 or 390 wide, scaled to fit). Under it the real page from TAWD's own viewer, 760 px tall, scrolling inside. Moving over the page outlines the section under the mouse exactly as on the concept screen (2px blue border, 6% blue wash, the section's name in a blue chip): the header, the footer, or each part of the page's own content. A click pins a comment there (an amber numbered dot until it's posted, then blue); links and forms don't act while reviewing. Right card (sticky): the page name, then its approval: "Approved by Sam on version 5, ..." (blue) with a **Take the approval back** link, or a hint ("Not approved yet. Go-live waits until every page is." plus "2 comments are still open.") and the primary **Approve and go to the next page** (or **Approve this page** for the last one). Then "3 of 8 pages approved. Next to review: Services. Back to Build". Then the comments as on the concept screen (number, author, time, words, where: "Header", "Footer", the section's name or "The whole page", and "on version 4" when older; Resolve, Reply; resolved ones folded) and the composer ("Comment 4, on "Our services"" with Remove pin; "Draft kept in this browser until you post it.").
- **Go-live checklist:** a line "Every page reviewed and approved", blocking: "3 of 8 approved: review the rest (Check, Review pages)", "All 8 pages approved", or "6 of 8 approved; a founder let this version go live".
- Approvals carry over to a later version while the page's own content and the shared header and footer are unchanged.

### The wireframe (3 October 2026)

On Growth and Pro (Lane 1), before the Home page words and the concepts; a PM can switch it on for Starter or off.

- **Wireframe card** (Design page, first card, `#wireframe`): the title, a hint ("The site's pages and the home page's sections in order, made by TAWD from the intake (free). Reorder, add or remove sections, then approve: every concept is built in this order, and the Home page words follow these sections when TAWD writes them."), and a badge on the right ("On for Growth", "On for Pro" or "Switched on").
- **Two columns** (one under 900 px): **Pages** (the site map, hubs with their pages indented; "From the page plan." or "As Content would draft them from the intake; Content can change them later.") and **Home page, top to bottom**: one grey box per section (the ground colour, a 1.5px dashed field-border outline, the header and footer boxes on the info tint, the hero taller). Each box: the section's name in an input (600), Up / Down / Remove text buttons (not on the header or footer, which stay first and last), a muted line of what the section is for, the intake's facts for it as a short list (placeholders in amber text), and an optional note for the designer. Under the boxes: a section picker and **Add before the footer**.
- **Status and actions:** "Approved by Sam, today, 10:12 AM." (blue), "Changed since it was approved: approve it again.", or "Not approved yet: Generate waits for the wireframe."; secondary **Save** and primary **Approve the wireframe**; under **More**, **Start again from the intake** and (PMs) **Switch it off for this project**. When off: one line saying so, and **Switch the wireframe on**.
- **The draft** shows only what the intake has: a trust band only with real credentials, service areas only when listed, hours only when given, reviews as a visible placeholder.
- **Generate** waits for it (an error banner "Approve the wireframe first", with a link to the card), and the Next step card says "Approve the wireframe" (PM or Web Designer).
- **Fix these (step 3b, 3 October 2026):** in the review screen's right card, between the approval and the comments, a section headed "Fix these": a hint ("TAWD changes only the parts the 2 unsent comments are on, then builds a new version of the site from the saved pages (no AI for the other pages).", or "Pin a comment on the page first: Fix these sends the ones not sent yet.") and a secondary **Fix these (2)** (confirmation with the estimate, on Sonnet 5; the rebuild after it is free). While it runs, an amber line with its step ("Making the changes…", "Building version 6…"); after, "This is version 6, made from the comments (changed: part 2, the footer). Check it, then approve or comment again." or the failure in red. Each comment carries a tag: **Not sent** (amber), **Being fixed** (muted) or **Sent in v6** (blue). Lane 2 sites don't show it.
- **After a fix (3c, 5 October 2026):** between Fix these and the comments, TAWD's free check of the changed parts: an amber box (`.amber-box`) titled "TAWD's check found:" with one line per problem ("Header at computer width: the phone number "(555) 555-5555" wraps onto two lines.") and a hint ("It tried once more (version 7) and stopped there. Check these on the page, then comment again or ask the Web Designer.", or why the retry made no version); a blue notice "TAWD's check found a problem on version 6 and tried once more: version 7 passed the check."; or a muted hint "TAWD's check found nothing wrong in the changed parts (wrapping, things sticking out, pictures)." Each sent comment adds a second tag beside **Sent in v6**: **Changed in v6** (blue) or **Nothing changed here** (amber); for reviewers, a row "Done in v6?" with secondary small **Done** and **Not done**. Done resolves it (**Done in v6**, blue tag); Not done puts it back to **Not sent** with an amber **Not done in v6** tag. Not done twice adds an amber hint under the comment: "Not done twice. Ask the Web Designer before sending it again." (it never blocks). The Fix these confirmation says the check and the one retry, and the estimate line ends "; up to $0.20 if TAWD's check finds a problem and it tries once more".

### One read of the current site (7 October 2026, 0.96.0)

Jason, 7 October 2026 (`docs/plans/flow-a-one-read.md`). Free, no AI. Replaces the separate home page read and pages read; supersedes the Use these pages button, the dialog and the "Go to Content" lines below.

- **Intake, Website section, under the Current website field:** the panel (white-on-tint card, `role="status"`, `.current-site-panel`). Title by state: "Reading finleypest.com (no AI)" (with the route and its cost so far once a paid route was used) with the amber step line ("Reading page 12 of 23: /ant-control/... this page refreshes itself.", every 4 s; after the read "Filling the intake and making the page plan... this page refreshes itself." for at most 3 minutes); "Read 23 pages from acme.com, free (no AI)", or with a paid route "Read 50 pages from finleypest.com through Jina Reader for $0.30 (no AI)" ("about $X" when a cost is TAWD's estimate, "Jina Reader and Zyte" when both were used; 0.97.0); "Read the home page of finleypest.com, free (no AI)" for a read from before (amber hint and **Read every page**); "Read the home page of finleypest.com only" for a JavaScript-only site (amber "Read the home page only: the other pages came back without words (the site draws them with JavaScript)."); or "Couldn't read finleypest.com". Under it a hint "Home page: 6 sections, a menu of 7 links (...), the phone (916) 555-0142, 2 testimonials (to confirm with the client). Read Oct 7, 2026, 3:20 PM PT."; a row (`.site-read-look`) with the first screen (160px wide, 1px line, control radius) and up to six colour swatches (20px, `.site-read-swatch`) with "Fonts: ..." under them; a blue line "Filled in from the site: Phone, Email, Services. Each is marked; check it, then confirm or correct it."; amber lines for what was found but not filled ("The site shows (916) 555-0199; the intake says (916) 555-0142: the intake's stays."). Failed: the reason in red, then the numbered ways forward (`.content-ways`). Text buttons: **See the words**, **See the pages** (Content `#kept-pages`, a small text ButtonLink like its neighbours), **Read again** (PMs, SEO, Content). The Next step card: "TAWD is reading the current site" while reading, "TAWD is making the page plan" once read and the plan isn't made yet; a plan that couldn't be made shows as a failure with the reason.
- **Blocked site:** the reason in red: "finleypest.com blocks TAWD's server (it showed a bot check, "One moment, please..."), so its pages can't be read from here. Reading again won't change that." then 1. "Paste the words: choose “Content provided by the client” in the intake's Content section." 2. "Let TAWD write new words: choose “New site” in the intake's Content section." Read again stays a small text button, never a numbered way forward; nothing says "later". Any other failure lists "Read again: the site didn't answer this time." first.
- **Content, Current site's pages card:** shown for a keep project or once pages were read. The paragraph says the read happens with the Website section and, for Keep, that the plan makes itself. No Use these pages; a link "Read again on the intake's Website section". Once in the plan, a blue line "In the page plan since Oct 7, 2026, 3:20 PM PT (TAWD, automatically): ...". Amber lines "Changed on the current site since it was kept (left as the team has it): About." and "No longer on the current site (left in the plan): Specials.". **The one decision** (a plan with work not made from the read): an amber line "The page plan has work that isn't from the current site, so TAWD didn't replace it. This deletes 4 approved pages. Generate on Design waits for this decision." and, top right, primary **Replace the plan with the current site's 23 pages** (content.plan), whose dialog "Replace the page plan with the current site's 23 pages?" says what it deletes in bold; Cancel and primary **Replace with 23 pages**.
- **Page plan:** for a keep project, no **Make the page plan** or **Make it again**; the empty card says the plan makes itself when the read is done.
- **Design, Home page words (makeover):** reading "TAWD is reading the current site (free, no AI)..."; failed: the reason in red with "Read Oct 7, 2026, 3:20 PM PT.", the ways forward and **Open the intake's Website section**; the decision: amber line with **Decide on Content**. No "Go to Content".
- **Next step card:** "TAWD is reading the current site" / "The current site couldn't be read" with **Open the Website section** (Intake); "Decide on the page plan" with **Open Content**.
- **A read over $1 (after Fable's review):** the Intake panel's title "finleypest.com blocks TAWD's server: reading it needs a go", the blocked reason in amber, a hint naming the service and the estimate in bold ("TAWD can read it through **Jina Reader** for about **$2.10** (no AI). Reads under $1 run by themselves; this one waits for a go. The service's monthly cap still applies."), a primary small **Read it for about $2.10** (PM, SEO, admins; others see "A PM or the SEO team gives the go."), then "Or, without paying:" and the two ways forward. Spend's per-route line says "The worker has no key for it: TAWD skips it." or "The worker hasn't reported its settings yet." from the worker's own report.
- **Blocked sites read through a paid route (Part D):** while reading, the amber step line starts "finleypest.com blocks TAWD's server: reading it through Jina Reader and Zyte."; the pages table's **From** column says "Jina Reader" or "Zyte" per page; the muted line under the done line "23 pages read through Jina Reader for finleypest.com." **Spend** gains a white card "Blocked-site reads" (`#blocked-sites`, after SEO data): per route (`.spend-route`, a 1px rule between) its label ("Jina Reader (blocked site)"), the month's spend "of $5.00 this month", the progress bar (amber from the warning ratio), "Not set up on the worker yet: TAWD skips it." when there's no key, and the cap editor ("Change the Jina Reader cap", admins); then a hint with the period's total and the $1 rule, and a table Project, Route, Calls, Cost ("(estimate)" for Zyte's).

### Keep the current site: a makeover with the client's own words (6 October 2026)

Jason, 6 October 2026 (`docs/plans/keep-current-site.md`). Lane 1, when the intake's Content choice is **Keep all content as is** and there is a current website. Free, no AI.

- **Intake, Content section:** the Keep card reads "A makeover: the current site's pages and words, kept exactly, in a new design. TAWD suggests SEO fixes (titles, descriptions, headings) for the team to decide. The cheapest: no drafting." Under the cards (Keep chosen, a website given) a hint says what happens after saving; the old "Coming next" hint is gone.
- **Intake, Content, the project type (0.100.0):** with a current website, a field label "Project type" (Required) over four `choice-cards` (two columns, one on a phone): **Design only**, **Design + content**, **Everything new**, **The client is sending their own words**, each with a one-line description; a missing answer shows the amber `hint-missing` line under them. Without a current website, two cards (Everything new, the client's own words). Lane 2: one hint "Lane 2: the words come from the client's design." Changing the type on a project with work shows an amber hint under the cards ("This project has 12 planned pages (3 approved) and 2 concepts. Changing the type deletes nothing by itself. ..."). Under the Website section's Current website, a hint "Next: choose the project type ... in the Content section." The type is a `meta-chip` in the project header after the lane.
- **Content as one step (0.100.0):** under the header, for Everything new and the client's words until the Home page has words, a white **Prepare the content** card (`#prepare`): the title, a hint ("TAWD runs these in order by itself, the Home page first..."), a numbered list (keyword research with its cost or why it's skipped, the page plan, the Home page's draft with the model and estimate; a skipped step muted), a checkline "Include keyword research", the cheaper way as a hint, then the primary **Prepare the content: Home page first** with the total beside it; its dialog repeats the steps, the total and what comes back, with Cancel and **Start**. Then one white card (`content-steps-card`, no padding on the sides) holding an ordered list of steps: each row a full-width button (16px 24px; 14px 16px on a phone) with a 28px round number (blue tint; solid blue with a check when done; red tint for a problem; grey when not needed), the 16/600 title with its state badge (Done = done, To do = warning, Needs a look = missing, TAWD is on it and Waiting = info) and "Optional" in muted 13px when optional, one muted line under it, and a + / − on the right. One row open at a time; its body (indented to the title, 66px) holds the step's existing card without its frame or title. A step the project doesn't need: grey number, muted title, "Not needed for this project" in muted 13px, its reason as a hint, no body. The SEO suggestions and the full audit sit under a text button "More: ..." at the bottom. A link to #drafts, #plan, #research, #kept-pages, #improve or #site-suggestions opens the step that holds it.
- **Content, Improve the words (Design + content, 0.100.0):** the card in the words step, above Page drafts: title and a hint on what TAWD keeps; the primary **Improve the Home page first** with "About $0.04 of AI on Sonnet 5." beside it; then a hint (the others unlock once the Home page is approved or put back) and a list of the other pages, each a checkline (box, the page's name as a link, its word count, an info badge with its state: The current words, Improving, Improved: to review, Approved, Didn't finish, Kept the current words) and, for an unticked page, why ("Blog articles stay as they are unless you tick them.", "Only 32 words: too little to improve."); then the primary **Improve N pages** with its estimate. Both open a dialog with the model, the cost, the cheaper way and what comes back (Cancel, **Improve**).
- **Content, a page's review on Design + content (0.100.0):** the draft card's buttons read **Improve it again** (its dialog: "Improve it again?") and **Put back the current site's words**. Over the words, a text button **Compare with the current site** / **Show the improved words** with "About N% of the words are new." beside it, and an amber line for new or missing facts. Comparing shows the words with added ones underlined in blue on blue tint and removed ones struck through in muted grey. A failed improvement shows **Try again** (primary, small), **Keep the current site's words** and the estimate.
- **Design, Set up, when the intake blocks Generate (0.100.0):** the red banner is "Finish the intake first", its line names the blocking answers ("Finish the intake first: Project type. The project type decides the steps ..."), and its link opens that intake section ("Open the Content section" or "Open the Website section").
- **Content on Design only (0.100.0):** the pages' step "The kept pages" is optional (not greyed): its hint says there is nothing to write or approve; the pages table's state reads "Kept as is" and there is no Approve all kept pages. A page the read couldn't give is named on Build ("These pages have no words from the current site yet ...").
- **Design, the wireframe on Design only (0.100.0):** the card shows only its title and "Not needed for Design only: the new design keeps the current home page's sections, in their order."
- **Content, "Current site's pages" card** (white, `#kept-pages`, after "Current website"): the title with an info badge "Free, no AI" ("No AI" when the read went through a paid route; its line ends "... requests, $0.30 through Jina Reader." instead of "free", 0.97.0); one paragraph on what is kept and left out and what **Use these pages** does; on the right, primary **Use these pages** (once read and not yet in the plan) and secondary small **Read the pages** / **Read again** (PMs, SEO, Content). While reading: the amber step line ("Reading page 12 of 50: /ant-control/... one page at a time; this page refreshes itself."). Failed: the reason in red. Read: a 15/600 line ("50 pages read from https://finleypest.com (its sitemap), when: 54,210 words. 54 requests, free."), a muted line for a makeover's blog articles kept on top of the limit ("18 blog articles kept on top of Pro's 50 pages: a makeover's articles don't count toward the limit (up to 100).", 0.98.0), an amber line when pages were over the tier's limit ("18 more pages are over Pro's limit of 50 and weren't read..."), and once used a blue line "In the page plan since <when> (<who>): Content reviews and approves each page under Page drafts." Then the Spend-style table flush to the card: Page (name in bold, path in monospace), Kind (info badge), Words, Notes (muted: "Had a form (the new page gets TAWD's)", "A review widget, left out", "A second H1 ... is kept as an H2", "The page had no H1 ..."); the first 12 with **Show all N**. Under it, folded lists: "Left out (N): not pages, or replaced by TAWD's own" (each address with its reason), "Over the page limit, not read (N)", and, open and amber, "Couldn't be read (N)".
- **Use these pages dialog:** "Use the current site's N pages?", one paragraph (the plan becomes these pages at the same addresses; each page's words become version 1 "From the current site (kept as is)"; it replaces the plan and any drafts; free; Content approves each page, SEO sets keywords), Cancel and primary **Use these N pages**.
- **Content, "Current site: SEO suggestions" card** (`#site-suggestions`, under it, once read): the title with an info badge "Suggestions only"; one paragraph (TAWD's own rules, by code, free; nothing changes by itself; titles and descriptions change in the page plan, words on a page's review); a 15/600 count line; then a numbered list, one group per rule, most important first, each separated by a rule line: an importance badge (**High** missing red-tint, **Medium** warning amber, **Low** info grey) and the group's title (15/600), "why it matters" as a hint, "**What TAWD would do:** ...", and up to six items (path in monospace and what was found), the rest folded ("N more"). At the end a blue-tint panel "What TAWD does better automatically" with a short list.
- **Page drafts:** a kept page's status badge reads **Kept: to review** (warning) until approved. Beside **Draft N pages**, a secondary **Approve all kept pages (N)** (Content and admins), shown while kept pages are waiting, opening a dialog: "Approve all N kept pages?", one paragraph (each page still exactly as it came, with no open comments, is approved by you, one approval per page in the activity log; edited or commented pages wait for their own review; read them first: approving says the words are right and any customer quotes are real), Cancel and primary **Approve N pages**.
- **Page review:** the version line reads "Version 1 of 1: from the current site (kept as is), <when>. Read from <old address>." Kept pages may carry H4 to H6 headings, numbered lists, quotes (a grey left rule) and tables (thin borders); their links show as underlined words with the path on hover, never followed.
- **Build › Check:** a line "The current site's words, kept word for word": Done ("All 1,204 sentences of the 50 kept pages are on the built pages.") or the amber **Check** badge with the pages and a first missing or changed sentence each. Never blocks go-live.
- **The Next step card** on Content for Keep: "TAWD is reading the current site's pages", "Read the current site again" (with the reason), or "Use the current site's pages" (Content, SEO or a PM) before the usual steps.

### Blocked sites: the Internet Archive, automatically (7 October 2026)

Removed in 0.96.0 (Jason scrapped the archive): see "One read of the current site". Rows 0.94.0 read keep their From column and dates.

Jason, 7 October 2026 (`docs/plans/blocked-sites-fallbacks.md` draft 4, Fable's review). On the **Current site's pages** card. Free, no AI, nobody clicks anything.

- **Working:** the usual amber step line starts with "finleypest.com blocks TAWD's server: reading the Internet Archive's copy." then the step ("Reading page 3 of 50: /ant-control/... one page at a time; this page refreshes itself.").
- **Waiting** (the archive was busy): an amber hint "The Internet Archive was busy. TAWD carries on at <when> (try 2 of 3). What was read so far is kept; nothing to do." The card refreshes itself every minute; **Read again** stays (it replaces the waiting read). The Next step card says "TAWD carries on reading the current site later" with the same line.
- **Done from the archive:** the 15/600 done line names the list's source truthfully: "(its sitemap)", "(its menu: there's no sitemap)" or "(the archive's list of its pages)", then "(read from the Internet Archive)". Under it a muted hint: "28 pages from the Internet Archive's copy of finleypest.com (copies from 2 Mar 2026 to 17 Jun 2026); 6 are over 6 months old. Free. 3 read from the live site." (one date reads "(a copy of 17 Jun 2026)").
- **The table** gains a **From** column (only when the read used the archive): "Live" or "Archive 2 Mar 2026" (muted); a copy over 6 months old makes the row amber (`tr.kept-old`, the amber field tint) and the cell amber text "Archive 2 Mar 2026 (over 6 months old)".
- **Gaps:** an amber box (`.kept-gaps`: amber tint, amber border, control radius, 14px) above the table: "**These 3 pages couldn't be read** (blocked on the live site, and no copy in the Internet Archive from the last 24 months):", the paths in monospace, then "Use these pages adds them with a placeholder to paste their words into; the site can't go live while one is left." Gap pages aren't table rows; the Use these pages dialog counts them and adds "The 3 pages that couldn't be read come with a placeholder for the words." A live page that's gone (404) is under "Left out" as "No longer on the live site".
- **Page review:** a kept page from the archive's version line ends "Read from <address>. From the Internet Archive's copy of 13 May 2026: check prices, hours and service areas."; a gap page's reads "Not read from the current site (<address>): ... Paste the page's words or remove the page." and its words are the highlighted [PLACEHOLDER]. **Approve all kept pages** leaves pages with a placeholder for their own review.
- **Failed** (no usable copy of the home page, or busy 3 times): the reason in red, then the ways forward above.

### Staged site builds (6 October 2026)

Jason, 6 October 2026 (`docs/plans/staged-builds.md`; standing rules 2 and 8). Lane 1 only; Lane 2 keeps its Build site on Design. The Lane 2 Option A exact build (admins) keeps the one-button card of 8a.

- **"The site" card** (white, `#site`): the title and one paragraph (built in stages, one page first: the home page, which also makes the shared header and footer, then each main page, then each group's first page alone and the rest together; each stage a new version with every page built so far; nothing goes live from here). Once a version exists, a badge on the right with the count: info "12 of 49 pages built", done when all are built.
- **Lines** under it, in order: the amber "missing" lines and the copy-pack warning as in 8a; while building, the amber step line ("Building page 1 of 11 (The other 11 service pages): Bed bugs") with Stop; a failed stage's reason in red; for a partial site an amber line ("12 of 49 pages built. The pages not built yet show a "Coming soon" page on the site and the preview. Go-live waits until every planned page is built."); then a muted line "Check About (version 2) first (Open the site, or Review pages on Check), then build the next. Next: Pricing. About $0.21 of AI on Opus 5.5 for 1 page, scaled by each page's copy, from the builds so far."
- **Buttons** (`.stage-actions`, PMs and admins, each a paid step with the confirmation dialog and its estimate): primary **Build Home first** / **Build About** / **Build the first service page (Ant control)** / **Build the other 11 service pages** (the next stage); secondary **Build all remaining pages (N)** once Home is built and more than the next stage is left ("For a confident team..."); secondary **Build the whole site again** once every page is built.
- **The stages list** (`.stage-list`, `aria-label="Build stages"`): one row per stage separated by a 1px line: the stage's name (600 for the next one; Home adds a muted "(and the header and footer)"), a muted line of its pages for a bundle ("Bed bugs, Cockroaches, Fleas and 8 more"), and a badge on the right: done **Built v3**, info **Next**, plain **Waiting**. The last row, "TAWD's own pages", says the privacy and cookie policies, thank-you and 404 pages, sitemap and robots are written by code with every stage, $0, with a done badge **Free**.
- Under the list, as in 8a: Speed up this build (when offered), the version line with **Open the site**, and the built pages' pictures (built pages only, never the Coming soon ones).
- **Coming soon page** (on the built site, not TAWD): the site's own header and footer around TAWD's simple page: a dashed pill "NOT BUILT YET", the H1 "About: coming soon", one sentence, and "Back to the home page". `noindex`, not in the sitemap.
- **Check:** the checklist gains "Every planned page built" (blocks go-live): "All 49 pages" or "12 of 49 pages built; still to build: Pricing, Contact, ... (Build)". **Preview:** an amber line on the Preview card for a partial version ("12 of 49 pages built in version 4: the others show a "Coming soon" page. Go-live waits until every planned page is built."). The Build part stays the current part until every page is built; the Next step card says "Build the home page first" before the first version and "Build the next stage of the site" while pages are left.

### Blocked sites, and makeovers without the Home words step (6 October 2026)

Jason, 6 October 2026 (`docs/plans/blocked-sites-and-makeover-words.md`, reviewed by Fable). Free, no AI.

- **Current site's pages card, a blocked read:** the reason in red ("finleypest.com showed TAWD a bot check ("One moment, please...") instead of its pages, so nothing was read." or "... refused or blocked TAWD's server (503) ..."), then a short numbered list (`.content-ways`, hint text): 1. Read again: a host's block is sometimes temporary. 2. Paste the words on Content (Content provided by the client). 3. Change the intake's content choice to New site, followed by the link **Open the intake's Content section**. Any other failed read (a JavaScript-only site) shows only items 2 and 3. (Since 0.94.0 this shows only when even the Internet Archive has nothing: see below; the server-address item is gone.) A read saved before this change that kept a check page as a one-page site shows as failed the same way.
- **Design, Home page words, for a makeover** (Keep all content as is): read only. The title, the line "The concepts use the current site's home page words, as they are. To change them, edit the Home page on Content." (Content linked), and on the right the info badge **Kept from the current site**. Ready: a blue line "From the Home page on Content, version N."; amber fact flags (a phone or founding year differing from the intake) if any; a folded **See the words** with each section's name (field label) and its words (`.home-words-kept`, read only, line breaks kept); under "Quotes to confirm with the client" the old home page's customer quotes, with the hint that they show on the concepts as a [PLACEHOLDER] until confirmed. Not ready: one line, by state: amber "Use these pages on Content first (free): the concepts use the Home page from there. Go to Content"; amber "Reading the current site's pages (Content)..." (refreshes itself); or the read's reason in red and "Go to Content for what to do." No boxes, no Start again, no Use these words.
- **Generate's banner** for the Home words is titled "The Home page words come first" (a makeover's says to use the pages on Content). **The Next step card** on Design for a makeover: "Use the current site's pages", "TAWD is reading the current site's pages" or "The current site couldn't be read", each with **Open Content** / **Use these pages** linking to `#kept-pages`.
