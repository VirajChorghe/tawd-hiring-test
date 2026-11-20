# TAWD Requirements Profile (v1.1, September 2026)

The fixed checklist every skill is matched against. Loaded alongside whichever design skill builds a mockup. If a skill's instructions conflict with this file, **this file wins**.

## 1. What TAWD builds

- **Stage 1: Homepage mockup.** One self-contained HTML/CSS file (Google Fonts allowed, no frameworks, no build step, JavaScript only if essential). It is rendered as a **desktop-only** high-res PNG/JPEG and sent to the client for approval. Three mockups are made per client, one per design skill (#1, #2, #3), each in a different direction chosen from `DIRECTIONS.md`.
- **Credit:** a small "Website by Velocity Media Lab" line in the footer. No other VML branding or watermark.
- **Stage 2: The website.** Built only after the mockup and content are approved, in one of two ways:
  - **Build A: static site on Netlify (the default, built first).** Plain HTML/CSS pages, no CMS. SEO is written into each page (title, meta description, headings, schema). Forms use Netlify Forms and email the client, with a copy to VML. The domain is registered in the client's name; DNS runs through Cloudflare and points at Netlify, and the existing email (MX) records are copied into Cloudflare before anything is switched.
  - **Build B: WordPress on 20i (for Pro clients or on request).** WordPress with native blocks (block theme), Rank Math for SEO, Gravity Forms for forms, MalCare installed.
- **Sizes:** Starter up to 10 pages (Home, About, Contact, up to 5 services, one Service Areas page, FAQ or Reviews). Growth 11-20 pages. Pro 21-50 pages.

## 2. Who it is for

Local service businesses in Sacramento and Reno/Northern Nevada: plumbing, HVAC, electrical, roofing, legal, glass and windows, garage doors, well and pump, home services, med spa. Visitors arrive in one of two modes:

- **Emergency** (burst pipe, no AC in July): on a phone, stressed, needs the phone number in 3 seconds. Near-zero motion.
- **Research** (remodel, choosing a lawyer): comparing 3-4 companies, needs proof.

## 3. Conversion floor (every mockup)

- Phone number visible without scrolling, as a tappable `tel:` link. Sticky call button on mobile.
- The hero says what they do and where ("Emergency Plumbing in Sacramento"), never a vague slogan.
- One short lead form (name, phone, message) reachable within one scroll.
- Trust band built from the client's REAL credentials (license number, years in business, review count, service areas).
- Service-area section naming real cities, **only when the intake lists service areas**. With none in the intake there is no service-area section and no placeholder for one (Jason, 1 October 2026). Opening hours likewise appear only when the intake has them.
- Name, address and phone in the footer, identical to the intake form.

## 4. Brand inputs

If the intake form supplies colors, fonts or type size, they are **locked**. The three mockups then differ in layout, structure and signature element, never in palette or fonts. If nothing is supplied, each skill picks its own, drawn from the trade's world. Avoid the local-service cliche (trust blue + orange button + Poppins/Open Sans) unless the brief justifies it.

## 5. Look and feel defaults

- Light mode only, unless the client's brand requires dark.
- Motion: at most one signature moment. Must respect `prefers-reduced-motion`. Nothing may delay the phone number.
- Accessibility floor: 4.5:1 text contrast, visible keyboard focus, labeled form fields, 44px tap targets, one H1, alt text on every image.
- Mobile first. 60-80% of local-service traffic is on phones.

## 6. Images

- Mockups use **Shutterstock watermarked comps** supplied by TAWD, or clearly labeled image placeholders ("Photo: crew and truck").
- Never pull random stock URLs (for example picsum.photos) or generate fake photos of the client's staff.
- Licensed images replace the comps only after the client approves.

## 7. House rules (non-negotiable)

1. **No fake reviews or testimonials.** Show real Google reviews; with none, the page has no reviews section (no placeholder).
2. **No invented facts.** No made-up license numbers, years in business, ratings, job counts, staff names, or statistics.
3. **No invented phone numbers, names or addresses.** Contact details come only from the intake form.
4. **Missing required information is shown as a highlighted `[PLACEHOLDER: ...]`** on the rendered page, never hidden in a code comment. The site cannot go live while any remain. Optional information the intake doesn't have is left out: no placeholder, card or section for it (Jason, 8 October 2026).
5. **Plain, specific copy.** No filler ("elevate", "seamless", "unleash"). Specifics beat superlatives.

## 8. Running inside TAWD (automated)

- Nothing is asked mid-run. All answers come from the intake form. A missing required field becomes a `[PLACEHOLDER]`; anything else missing is left out.
- Output per mockup: the HTML file, plus a 3-line summary (palette, fonts, signature element) and a list of every placeholder used.
- No package installs, no network calls beyond Google Fonts, no telemetry.

## 9. Two lanes

**Lane 1 (no design supplied):** TAWD builds all three mockups, one per design skill, in three directions from `DIRECTIONS.md`.

**Lane 2 (the Web Designer supplies a design; Figma is the house standard).** At upload, the designer picks one of two options:

### Option A: "Client approved: build it"

- The design is final. TAWD builds the whole site to match it: all designed pages, the gap pages (from the designer's own design system), and the mobile layout.
- A fidelity check compares each built page with the Figma frame.
- Only **critical issues** are raised before building: accessibility failures, a missing phone or form, or invented reviews and facts. The designer decides on each; nothing is changed silently.

### Option B: "Reference: review and improve"

TAWD works on the design properly, not just a glance. It produces three things:

1. **A review report:** every finding, graded Must-fix / Should-fix / Recommendation, with a reason.
2. **An improved Concept 1:** the designer's design with Must-fix and Should-fix items applied. Every change is logged like tracked changes (before, after, why), and the designer can accept or reject each one.
3. **Concepts 2 and 3:** alternatives in two other directions, built from the designer's brand, content and sections.

**What TAWD fixes (Must-fix and Should-fix):**

- Accessibility: contrast, text size, tap targets, labeled form fields
- Conversion floor: phone above the fold, tap-to-call, mobile sticky call button, form within one scroll, call to action mid-page and before the footer
- Missing required sections: trust band, service areas (when the intake lists them), footer name/address/phone
- SEO structure: one H1, correct heading order
- House rules: stock or fake testimonials and invented numbers become placeholders; lorem ipsum is flagged for the content team
- Consistency: one button style, one spacing scale, aligned grids
- Missing mobile layout
- Fonts without a web license: swapped for the closest free font, with approval required

**What stays the designer's:** logo, brand colors and fonts. For contrast, TAWD adds a darker shade of a brand color; it never replaces the color. Recommendations (layout ideas, copy suggestions) are suggested only, never applied.

**The original file is never edited.** TAWD's improved version lives in the project workspace. The designer brings any accepted changes into Figma.

### Number of concepts (all lanes)

A selector on every project: **1, 2 or 3 concepts**, to avoid spending AI time on alternatives nobody needs.

- **Lane 1** defaults to 3. Choosing 1 or 2 uses the top pre-selected directions.
- **Lane 2, Option B** defaults to 1 (the improved Concept 1). Choosing 2 or 3 adds alternatives in other directions.
- **Lane 2, Option A** has no concepts: the approved design is built directly.

### Both options

- The client sees neutral labels (Concept A, B, C). No label says who, or what, made each one.
- If the client picks Concept 1, the site is built to match it exactly, with a fidelity check. If the client picks Concept 2 or 3, the Lane 1 build applies. Mix-and-match requests go to the Web Designer.

## 10. Build checklist additions (from the September 2026 reel review)

Every site gets:

- **A custom 404 page** with the phone number, main service links and a way home.
- **An expandable FAQ.** Build A: an HTML `<details>` element. Build B: the native WordPress Details block. FAQ schema is optional and never a goal (Jason, 26 September 2026: Google stopped showing FAQ rich results in May 2026); when it is written, it matches the visible questions and answers word for word.
- **A skip-to-content link** as the first focusable element (accessibility).
- **A form confirmation message:** a clear "we got it, here's what happens next" message (Build A: a Netlify Forms thank-you page; Build B: Gravity Forms).
- **A UTM-tagged website link for the Google Business Profile,** so GA4 shows visits from the Business Profile, for example `?utm_source=google&utm_medium=organic&utm_campaign=gbp`.
- **Cloudflare (free plan) for DNS,** with the domain in the client's name. Copy the email (MX) records into Cloudflare first, then point the site at Netlify (Build A) or 20i (Build B).
- **Build B only: a page-caching plugin** as a standard install (Build A is served as static files by Netlify).

By direction or tier:

- **Sticky header:** optional, decided per direction.
- **"Updated on" dates on blog posts:** Growth and Pro tiers only.

Considered and skipped for local service sites: dark mode toggle, site search, loading animations, newsletter signup, scroll progress bar, back-to-top button, animation libraries (GSAP), React component kits (Aceternity, Tremor).
