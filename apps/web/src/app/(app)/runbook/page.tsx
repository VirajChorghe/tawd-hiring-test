import type { Metadata } from "next";
import Link from "next/link";

import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Run book - TAWD" };
export const dynamic = "force-dynamic";

/*
  The Run book (Jason, 29 September 2026): how TAWD actually works, in
  plain words, for anyone new to the team. Everyone signed in can read it.
  Keep it true: when a step, a role or a rule changes, change it here in
  the same commit (and in docs/context for the developers).
*/

const SECTIONS = [
  ["what", "What TAWD does"],
  ["lanes", "The two lanes"],
  ["steps", "The steps, and whose job each one is"],
  ["roles", "Your role"],
  ["money", "Money and the AI"],
  ["rules", "The house rules"],
  ["wrong", "When something goes wrong"],
  ["live", "Going live"],
  ["site-read", "Reading the current site"],
  ["wordpress", "WordPress sites"],
  ["words", "Words TAWD uses"],
] as const;

export default async function RunbookPage() {
  await requireUser();
  return (
    <div className="page">
      <article className="runbook">
        <h1 className="page-title">Run book</h1>
        <p className="page-lede">How TAWD works, from a new client to a live website. Start here if you are new.</p>

        <nav className="runbook-contents" aria-label="Contents">
          <ol>
            {SECTIONS.map(([id, title]) => (
              <li key={id}>
                <a href={`#${id}`}>{title}</a>
              </li>
            ))}
          </ol>
        </nav>

        <section id="what">
          <h2 className="section-title">What TAWD does</h2>
          <p>
            TAWD turns a client&rsquo;s brief into a live website for a local service business (plumbing, HVAC, legal, glass, home services and more), much faster
            than a normal build. Only the VML team signs in; clients never do. The client pays a $199 build fee and $99 a month, with a 12-month minimum.
          </p>
          <p>
            Sites are built as fast static sites on Netlify. A project on any tier can be switched to WordPress on 20i instead: the same
            site, delivered as WordPress pages the client&rsquo;s team can edit. See <a href="#wordpress">WordPress sites</a>.
          </p>
          <p>
            <strong>Where to start each day:</strong> <Link href="/my-work">My work</Link> lists what is waiting on you, across every project. Each project&rsquo;s
            page shows a <strong>Next step</strong> card: what happens next, whose job it is, and a button to where it is done. On every stage page the
            same next step sits in the bar at the bottom of the window, with the one button to press next.
          </p>
        </section>

        <section id="lanes">
          <h2 className="section-title">The two lanes</h2>
          <p>
            A PM picks the lane when making the project, and the tier: <strong>Starter</strong> (up to 10 pages), <strong>Growth</strong> (11 to 20) or{" "}
            <strong>Pro</strong> (21 to 50). TAWD warns in the intake when a Starter project looks bigger, but never changes the tier itself. For Lane 1 the PM
            also picks how many concepts (3 by default).
          </p>
          <ul>
            <li>
              <strong>Lane 1, no design supplied:</strong> TAWD designs the site. It makes 1 to 3 homepage concepts in different design directions; the client picks
              one.
            </li>
            <li>
              <strong>A finished homepage as one HTML file:</strong> it is a mockup made by hand, so it belongs to Lane 1: on a Lane 1 project&rsquo;s intake, open
              &ldquo;Homepage file&rdquo; (also linked from the Mockups set-up screen) and upload the file (one at a time; remove it first to replace it). A Lane 2 project
              has no upload for it (Lane 2 is for a design TAWD reproduces); one that already holds a file still shows it in its Design section. The moment the upload is saved TAWD reads it by itself, free: no AI and no network. It takes out the scripts, the inline handlers (onclick and the like)
              and javascript: links, leaves out any picture or font that fails a check, lifts the pictures and fonts into files, and puts the page on the Mockups board as
              concept S, photographed with script switched off. Every note it makes (what was taken out, what was left out) is shown on Intake and on the concept&rsquo;s
              Checks tab. At this stage TAWD&rsquo;s own page checks (fake reviews, invented phone numbers, placeholders, the house rules) do not run on it, so it is shown as not checked (the go-live checks do read the built home page),
              never as passed; no AI ever reviews, changes or polishes it, and a change the client wants is made in the file and uploaded again (a new version).
              Once the client approves it, the site build keeps it as the home page: nothing a visitor reads in its main part is changed, neither by the AI nor by TAWD&rsquo;s own tidy-up rules (call-to-action wording, phone number layout, form fields and labels, picture frames, icons), and the home page&rsquo;s copy is not asked for on Content. TAWD still does what the page needs to work: picture and font paths, the form&rsquo;s sending settings, the search and sharing tags, tracking and the consent banner. The header and footer are the shared ones every page has: they are TAWD&rsquo;s own, they carry the menu that points at the real pages, and TAWD&rsquo;s tidy-up rules still apply to them, so they can differ from the supplied page &mdash; the same phone number can read one way in the kept page and another in the header. Where a tidy-up rule would have changed something, the build&rsquo;s checklist says what under &ldquo;The supplied home page, kept as supplied&rdquo; and changes nothing, so the team can judge it (a long list shows its first few changes on the line and every one of them in a fold-out under it, so nothing is hidden behind &ldquo;and more&rdquo;; and on that page the &ldquo;Page rules&rdquo; line says TAWD left a button or reviews band as it is, never that it rewords it); that check also names the header-and-footer difference, says so plainly when a page had too many pieces of text to list the changes one by one, and says so when TAWD could not hold the page&rsquo;s main part out of the rules&rsquo; reach and so left the page alone entirely. A supplied home page put into a WordPress package (Build B) is kept the same way. The build then makes the other pages from its design, and prices one page fewer.
              <strong>The design&rsquo;s own menu says what pages the site has</strong> (Jason, 17 November 2026): when the page plan is made, each item in the
              supplied page&rsquo;s menu becomes a page, in the design&rsquo;s own order, with the kind its words name (&ldquo;About Sarah&rdquo; an About page,
              &ldquo;Insights&rdquo; a blog page, a name TAWD doesn&rsquo;t know simply a page). Where the ordinary plan had a page of the same kind, that
              page&rsquo;s keywords and words are kept under the design&rsquo;s name, so the SEO work is not thrown away. The shared header then lists exactly
              those pages, in that order, whole &mdash; the grouping used for a big site TAWD planned itself does not apply to a menu the client approved. A page
              the menu does not name (one the team added or renamed by hand) is listed after them, so no page TAWD builds is left with nothing linking to it. A link
              inside the kept page that pointed at one of its own sections (<code>#services</code>) points at the page that now holds it (<code>/services/</code>);
              only an exact match is changed, and nothing a visitor reads is touched. <strong>Links the design left going nowhere</strong> (<code>href=&quot;#&quot;</code> or an empty one,
              which a design often uses for a page it has not drawn yet) are listed on the build&rsquo;s checklist under &ldquo;The supplied home page&rsquo;s
              links&rdquo;, with the words a visitor would click. They are read from the page that was built, in the part the design supplied (the shared header
              and footer are TAWD&rsquo;s own), so a rebuild still reports them. TAWD never guesses where they should go: decide with the client, change the file and upload it
              again. It does not block go-live. Re-making the plan (&ldquo;Make it again&rdquo;) reads the menu again, and says so in its dialog; as always it replaces
              every page in the plan, and the dialog counts the drafts, comments and edits that would go with them. <strong>If the plan has no page for a menu item</strong>{" "}
              &mdash; a plan made before this design was approved, or a page the team renamed by hand &mdash; the Page plan card names the items it is missing and says that
              making the plan again follows the menu and replaces every page. TAWD never remakes it by itself: that would take the drafts with it, so the team decides.
              The card compares the names and nothing else, so it does not say which of the two reasons it is. The step itself
              reads <strong>&ldquo;Needs a look&rdquo;</strong> rather than Done, the sentence shows on the step&rsquo;s own line with the step closed, and the
              <strong>Next step bar refuses to offer the drafts</strong> until the plan follows the menu: drafting is paid, and it would write the pages in
              the plan rather than the ones the client approved. A <strong>Testimonials or Reviews page the
              menu asks for, when the intake has no testimonials</strong> (Jason, 17 November 2026), is written as visible placeholders, one for each real
              testimonial to come: nothing is invented, and the placeholder gate holds the site until the team puts the real ones in. A script-driven part of the page (a menu button, an open-and-close FAQ) does not work on the
              kept home page. If the client approved an earlier version, the build still uses that one until the new version is approved. A page plan with no Home page stops
              the build with a message. <strong>The Home stage costs nothing for the page:</strong> Build A never sends the supplied page to the AI, so nothing is written
              for it: the words a visitor reads are kept as they were uploaded (the build still moves the menu&rsquo;s links onto the new pages, wires up the form and
              adds the shared header and footer, and the Build checklist says what it did). That stage&rsquo;s estimate is the shared header and footer alone, and it says so (&ldquo;for the shared header and footer&rdquo;,
              not &ldquo;for 1 page&rdquo;); the confirmation before spending says the same. <strong>Whoever supplies the page answers for what it says:</strong> the words a visitor reads in the main part of the page as it was uploaded count as the client&rsquo;s own words. At go-live, when an invented-fact or
              unsupported-claim finding on the home page is one of those words, whole word for whole word (a price such as $49 counts; $150 is not backed by $1,150), it is not counted as a problem and
              nobody else checks it. The words are read from the stored upload, never from the built page, so words added to the home page afterwards (a client edit request or a Fix these round) are not backed.
              The Build checklist says how many findings were left uncounted. A finding whose words the upload does not show (such as a rating found only in the page&rsquo;s structured data), every other page,
              and the shared header and footer are checked as usual, unless the same words also appear in the uploaded main part.
            </li>
            <li>
              <strong>Lane 2, design supplied:</strong> the client already has a design (a PDF, pictures or a Figma file). TAWD builds a site close to it: its colours,
              fonts, photos and words, as pages that also work on phones. A Figma file too large to read whole (over 60 MB from Figma) is read as its list of pages
              plus the final page only, by itself; choosing another page then reads that page. If even the final page is too large, the check says which, and the
              designer moves the site&rsquo;s frames to a page of their own. An uploaded PDF page that is only one picture (no text layer in it) is read from that
              picture at the picture&rsquo;s own size, not redrawn at 1440 wide, when what is left after the trim is 800 to 1920 pixels wide (and the picture is no
              more than 24 million pixels); anything else is drawn 1440 wide as before. Flat margins are cut off first: a margin is a run of lines from the edge that
              are almost all one colour (a thin feature such as a logo or a nav bar ends it, and is kept), and both sides must match in colour and be within a few pixels (2% of the width) of each other in size, or nothing is cut. A design whose own side gutters are nearly the margin colour may lose them: the read&rsquo;s note says how much was cut. Only the sides are ever cut:
              the top and bottom are kept whole, because a frame there can&rsquo;t be told from the design&rsquo;s own band of the same colour. A page that was read before this was added keeps being drawn 1440 wide, so its kept read still counts
              and is not paid for again. The read result says so in its notes, for example &ldquo;Page 1: the design&rsquo;s own picture was used at 1400
              &times; 4056 px &hellip; trimmed flat #0e0e0e margin (580 px off the left, 580 px off the right)&rdquo;. The cost estimate for such a page uses the
              larger of the two slice counts (the tallest picture in the PDF, read from the file without opening the pictures, plus 5%), so it is never low. A PDF page that has text, and every image upload, is drawn 1440 wide as before.
              A PDF page with text has letter-spaced capitals rejoined (&ldquo;W H AT W E D O&rdquo; reads &ldquo;WHAT WE DO&rdquo;) and a heading drawn with a
              shadow, read twice in the same place, kept once. <strong>Admins only, while it is being built:</strong> in the intake&rsquo;s Design section, under the design&rsquo;s own cards, &ldquo;New design read
              (admin, being built)&rdquo; reads page 1 of the last finished upload read again with the new route (a look at the whole page for its bands, a second one if
              the list doesn&rsquo;t cover the page, then one at each band for its words, colours, fonts and pictures, a very tall band in parts; every
              picture is sized for the AI model the read runs on), after a dialog with its cost estimate, with Stop while it runs. It can&rsquo;t be started twice;
              a read that started working and has had no news for 30 minutes counts as stopped and can be run again, and so does a waiting one whose job the queue no longer holds (one still waiting its turn never does). It shows the bands it found and anything it couldn&rsquo;t do, including
              every letter-spaced heading it rejoined, and changes nothing else on the project. After the read, TAWD cuts every picture it named out of the
              design and prepares it by kind, with no AI: a background has the text or cards drawn over it wiped and filled, a logo or cut-out has its plain
              background made see-through, a silhouette is faded into its band, and an icon is matched to TAWD&rsquo;s icon set by the word beside it (an
              unmatched word gets TAWD&rsquo;s plain dot; an icon with no word beside it gets none; both are flagged). While the pictures are being
              prepared the panel says so; if the worker restarts or goes quiet for 30 minutes during that step, it says the read is complete and only
              its pictures were not finished. A background has at most 10 boxes drawn over it wiped (together at most twice its own area);
              any more are left in the picture and flagged. A picture that takes over a minute to save counts as not prepared. If the pictures
              can&rsquo;t be loaded for a moment, the panel says so and asks for a reload; the count says how many were cut, how many are icons
              (never cut) and how many could not be cut. &ldquo;Pictures from the design&rdquo; shows each one on a checked ground (the checks show what is
              see-through), its kind and size, each patch with whether it was blended or smoothed over and a link to what it hid, and every note on what
              would make it better (usually: upload the clean picture). It always shows the pictures of the read above it, never those of a newer read still
              running. If the pictures could not be prepared, the read is kept and the panel says so (the reason is in the worker&rsquo;s log).
              <strong> Prepare the pictures again</strong> does that step on its own, for the read already saved: it is free, makes no AI call and does not
              read the design again. It applies the picture corrections below first, cuts and treats every picture again, and removes the files of the
              last attempt that the new one no longer names. While it runs the panel counts the pictures done (the count moves when the page is
              reloaded); it can&rsquo;t be started twice, and one that has had no news for 10 minutes can be started again, whether it stopped part-way or is
              still waiting its turn, which the panel tells apart. The read itself is never touched by it. <strong>Correcting the band list:</strong> each band has a
              <strong> Correct</strong> button for its name, kind (header, band or footer) and edges in pixels. Moving an edge moves the neighbouring
              band&rsquo;s edge with it, so the bands still cover the page; an edge change that would leave a band under 8 px, or move the top of the
              first band or the bottom of the last, is refused with the reason, and nothing is saved. A corrected band shows who corrected it and when,
              and every correction is in the activity log with the band before and after (and any neighbour whose edge moved). Corrections are kept when
              the same upload is read again: each goes to the band of the new read in the same place (the two spans share at least half of their
              length taken together). A name and kind always carry over; edges carry over only if the band was read in nearly the same place, and
              otherwise the panel says so and asks for them to be corrected again. One that no band matches, or that two bands match equally, is
              listed as kept, not applied. A Correct form left open while the design is read again closes, and a save from it is refused, so its
              fields never land on another band. A new upload starts with no corrections.
              <strong> Correcting the words and the pictures:</strong> the words the read found are listed with the band each sits in, and a word the
              read could not make out for certain is marked unsure. Each has a <strong>Correct</strong> button for the words themselves and what kind of
              text they are (heading, paragraph, button, link, label or other); a corrected word is no longer marked unsure, because a person has read it.
              Each picture has one for its kind (photo, background, cut-out, logo, silhouette or icon) and its box in pixels; a correction whose box would
              leave the design is refused with the reason and nothing is saved, so the kind has to be sent again on its own. Picture corrections are what &ldquo;Prepare the pictures again&rdquo; uses, so a
              kind read wrong can be put right without paying for the read a second time. Both are admins only while the new route is built, both are in
              the activity log with the item before and after, and both are kept when the same upload is read again: each goes to the word or picture of
              the new read in the same place (the two boxes share at least half of their area taken together). A word&rsquo;s text and kind and a
              picture&rsquo;s kind always carry over; an exact box carries over only if the picture was read in nearly the same place, and otherwise the
              panel says so. One that nothing matches, or that two things match equally, is listed as kept, not applied.
              <strong> Build the page from this read:</strong> one paid AI call, admins only, with its estimate and the model shown before it
              starts and a Stop like any other paid step. The whole design, the band list, every measurement and the prepared pictures go in,
              and one page with one stylesheet comes out. Only the home page is built. The page is laid out at the design&rsquo;s own width,
              where the bands sit at the tops and heights the read measured, and flows normally below that width. Every correction above is
              applied first &mdash; the band list, the words and the pictures &mdash; so the build is never given a band, a word or a kind somebody has
              already put right. The read&rsquo;s pictures have to be prepared before it will run: without them the page would be built with none of them, and
              &ldquo;Prepare the pictures again&rdquo; is free, so it is refused rather than charged for. It can&rsquo;t be started twice, and one that has had
              no news for 25 minutes can be started again, whether it stopped part-way or is still waiting its turn (longer than the worker holds the job, so a
              slow build is never called stopped while it is still running).
              When it finishes, <strong>Open the built page</strong> shows it inside TAWD, in a new tab, with nothing in the page allowed to
              run. The page is kept whatever code finds wrong with it, and what was found is listed underneath: a band with none of its words,
              a band missing some of them, a menu item missing, a prepared picture not placed, a phone number or address re-written into a different
              shape, JavaScript, a page that sends the browser elsewhere on its own, or a picture, stylesheet or font fetched from another address
              (an ordinary link to the client&rsquo;s own Facebook page is not that, and is not reported). Those checks read the page&rsquo;s text
              only: they can tell that a band&rsquo;s words are missing from the page, not that they were drawn in the wrong band. An empty list does
              not mean the page matches the design: how closely it matches is measured in a real browser, which is not built yet. A separate list, <strong>Could not be copied from the design</strong>, is kept apart
              from those: it is what the design itself could not give us (a picture that would not cut, an icon matched to nothing in
              TAWD&rsquo;s set, a menu item with no page yet) and it asks for an upload or a page rather than meaning the build went wrong.
              Menu items with no page are drawn exactly as the design draws them, not left out. If the last build did not finish, the page shown is
              the one from the build before it, and the panel says so.
              <ul>
                <li>Option A, &ldquo;client approved, build it&rdquo;: straight to building.</li>
                <li>Option B, &ldquo;review and improve&rdquo;: the Creative Director reviews the design first and suggests changes you accept or reject (or skip).</li>
              </ul>
            </li>
          </ul>
        </section>

        <section id="steps">
          <h2 className="section-title">The steps, and whose job each one is</h2>
          <p>The bar under each project&rsquo;s name shows these steps. Lane 2 has no Content step: its words come from the design.</p>
          <p>
            A new project starts connected to the team&rsquo;s Slack channel (set on System, Team Slack), with comments off; change or disconnect it on
            the project. With no team channel set, a new project has no Slack until someone connects it.
          </p>
          <ol className="runbook-steps">
            <li>
              <strong>Intake</strong> (PM). The client&rsquo;s facts: business, services, areas, brand, photos, logo. A missing required field shows on the site as a visible
              placeholder rather than being made up; anything optional left blank (pricing, scheduling, guarantees, offers, hours, service areas, reviews)
              simply isn&rsquo;t on the site: no placeholder, card or section. A concept&rsquo;s placeholder for anything else is removed by code, free, with the card or
              section around it. Each section has its own Save button. If something a save starts (the liked sites&rsquo; screenshots, the current
              site&rsquo;s read, the logo add-on, the form recipients) doesn&rsquo;t update, the section is still saved, and the save bar says, in amber, what
              didn&rsquo;t update, with a <strong>Try again</strong> button. The{" "}
              <strong>Website forms</strong> section says who gets the site&rsquo;s form messages, which fields the forms have, and the thank-you line. One answer can&rsquo;t be skipped: the <strong>current website</strong>, or &ldquo;No current website
              available&rdquo; ticked. Design and Generate wait for it, because it decides where the mockup&rsquo;s words come from. When the Website section is saved
              with an address, TAWD reads the whole site once, free (no AI) unless the site blocks TAWD: see <a href="#site-read">Reading the current site</a>. With a current
              website, the Content section asks one more required question, the <strong>project type</strong>: <strong>Design only</strong>, <strong>Design + content</strong>,{" "}
              <strong>Everything new</strong> or <strong>The client is sending their own words</strong> (see <a href="#makeover">Project types</a>); without one, Everything
              new or the client&rsquo;s words. The type shows as a chip in the project&rsquo;s header and sets the steps. Changing it deletes nothing by itself: a note under
              the choice says what exists and what happens next. For Lane 2, the design goes in the intake&rsquo;s Design section, which the web designer can change too.
              When a design read finishes (a Figma import or an upload), TAWD <strong>pre-fills the intake from the design</strong> by itself, by code
              (no AI, no Figma read): only empty answers are filled (the business name from the copyright line, the phone, email, street address, city
              and state, other locations named by the town shown above the number or beside it on the same line, a licence number, the year founded
              with words that say so, the services listed under a services heading with the words under each, and the service areas), each marked
              &ldquo;From the design&rdquo; until someone confirms or corrects it. An answer someone corrected or cleared after TAWD filled it is
              never filled again by TAWD. The result says &ldquo;by TAWD, automatically after the design was read&rdquo;; <strong>Pre-fill again</strong> runs it by hand.
              It is all or nothing: if it can&rsquo;t finish, nothing is filled, the read still finishes, and the button can try again.
              <strong>A form that was open while TAWD filled answers is not saved over them.</strong> When the intake page loads it notes the newest time TAWD filled an answer; if TAWD (from the design or from the
              current site) filled answers in a section after that, and Save would change any of them from what TAWD filled, nothing is saved: an amber banner says &ldquo;TAWD
              filled in N answers while you were editing &mdash; reload to see them&rdquo; (N counts those answers in that section) with a <strong>Reload</strong> button (a refused save made from the
              &ldquo;unsaved changes&rdquo; box closes the box, so the banner shows). Reloading drops what was typed and shows the filled answers; <strong>Discard</strong> then reloads
              the page too. A save that leaves TAWD&rsquo;s answers as they are, changes only other sections, or touches an answer a person already corrected goes through as usual,
              and a refused save never counts as correcting an answer.
              Under each of the 2 to 3 <strong>reference sites</strong> (websites the client likes), write what the client likes about it. The concepts follow
              that first, ahead of the direction&rsquo;s own choices; only the house rules, the intake&rsquo;s facts and brand, and an approved wireframe come
              before it. The Creative Director&rsquo;s review is told it too.
              A US phone number is saved as <strong>(916) 555-0142</strong> however it is typed (916.555.0142, +1 916 555 0142). A phone number in the intake (the business&rsquo;s and each location&rsquo;s) must be a US number: 10 digits, or 11 starting with 1, with an area code and exchange that don&rsquo;t start with 0 or 1 (an extension such as &ldquo;x2&rdquo; or &ldquo;#2&rdquo; is fine); anything else (&ldquo;call us&rdquo;, &ldquo;555&rdquo;, letters) is refused on save with a message beside the field. A number read from the current site or a design that isn&rsquo;t one is not filled in, and the read says so. A bad number saved before that rule stays as it is, counts as missing in Required info, and is left out of what the AI is told.
              Every site and concept shows US numbers that way, including numbers in the AI&rsquo;s words and a makeover&rsquo;s kept words (free, by code).
            </li>
            <li>
              <strong>Design</strong> (PM, with the web designer).
              <ul>
                <li>
                  Lane 1: on Growth and Pro (never on Design only), first the <strong>Wireframe</strong>: the site&rsquo;s pages and the home page&rsquo;s sections in order, as grey boxes,
                  made by TAWD from the intake for free (never a Reviews section; Why choose us and an FAQ only when the intake has at least two facts for
                  them; the house rules come before the wireframe). The PM or the web designer reorders, adds or removes sections, then approves it; every concept then follows
                  that order, and so do the Home page words. Any change after approval needs approving again. A PM can switch the wireframe on for Starter, or
                  off for Growth and Pro. Then the <strong>Home page words</strong> (Everything new with a current website: TAWD starts from that site&rsquo;s home page words, section by section, keeps their facts and order and works in the Home page&rsquo;s keywords when the page plan has them): a PM checks them and presses <strong>Use these words</strong> (a makeover has no such step: its
                  concepts use the Home page on Content, see <a href="#makeover">Project types</a>). Then generate the concepts: the setup shows the time, the AI
                  cost and the model first (with &ldquo;concept build on Fable 5.1&rdquo; when Spend sets the concept build to Fable, priced at its rate).
                  With a current website, every concept must keep what that site&rsquo;s home page has: its sections, and its call and text numbers, ratings,
                  comparison table, project showcase, process, partner brands, warranty and licence. A rating, review or licence number that isn&rsquo;t in the
                  intake shows as a [PLACEHOLDER: ... to confirm with the client]. A feature missing from a concept fails its checks and the fix round puts it back;
                  one left out on purpose is listed in the checks with the reason. The concepts also get up to 8 of the larger photos from the current site&rsquo;s
                  home page (after the intake&rsquo;s uploads, up to 12 in all), labelled &ldquo;from the client&rsquo;s current website&rdquo; (a photo there can
                  be stock the client licensed), and an empty picture area on a card fails the checks. An iPhone photo saved as HEIC/HEIF &mdash; whether
                  uploaded or found on the current site, and even when it arrives named &ldquo;.jpg&rdquo; &mdash; is turned into a JPEG by code when it comes in
                  (the original is kept), since a browser can&rsquo;t show HEIC. <strong>A file whose kind the browser doesn&rsquo;t report</strong> (Windows and
                  Chrome say nothing at all for a .HEIC) is taken from its name instead, so an upload is no longer refused by the same screen that lists heic as
                  allowed; a name never overrules a kind the browser did give. <strong>Every upload&rsquo;s first bytes are checked against its kind</strong> when it
                  comes in: a &ldquo;.png&rdquo; that is really something else, a &ldquo;.pdf&rdquo; that isn&rsquo;t a PDF, or an SVG with a script in it is refused with
                  a message, and the upload is removed. Only those first bytes are read, not the whole file. A solid coloured band or corner block the old site
                  baked into a photo (a border, a corner tab) is cut off first, never more than a fifth of a side; pale edges are left as they are. The site
                  build gets the same photos, so a photo the approved concept shows is in the built site. Each concept card shows
                  <strong>References</strong>: how many of the studied reference sites lean to its direction, or &ldquo;None of the ... lean this way&rdquo;
                  when the direction matches none of them.
                </li>
                <li>
                  <strong>Only concepts at 4.5 or above are shown.</strong> The Creative Director scores each concept on eleven questions, including
                  <strong>Pop and rhythm</strong>, <strong>Pictures fit</strong> and <strong>Ready to send</strong> (would the web designer send it as it is?). At 4.5 or
                  above, with no question under 3, it is shown straight away. Under that, TAWD rewrites only the sections the notes name, once, and scores it again;
                  there is no rebuild. A concept is also held when, after its fix rounds, it still breaks a house rule (a phone number, call button, licence, price, year, address, town, person or rating not from the intake,
                  a claim the intake doesn&rsquo;t back, a section built on nothing, or a placeholder for something the intake has), or when its review didn&rsquo;t finish
                  (<strong>Run the review again</strong> reviews it, and shows it if it passes). A concept still under 4.5 is <strong>held</strong>: its card says why, it isn&rsquo;t in the client pack or the client&rsquo;s
                  choice, and Slack says so. An admin can open it with <strong>Look at it</strong> and press <strong>Show it anyway</strong> (logged); when no concept
                  reached 4.5, the Next step card says so. The header counts the concepts built.
                </li>
                <li>
                  Before any review, code fixes each concept for free: stock pictures only in the hero, services, service areas and job sections (never in
                  &ldquo;why us&rdquo;, the process, FAQs, reviews, guarantees or calls to action), every empty picture frame searched on Shutterstock with the
                  trade in the search &mdash; of the answers, the picture whose own description best matches the frame&rsquo;s label wins, and one showing another
                  company&rsquo;s colours or a named competitor is passed over (if every answer clashes, the best match is still used and flagged as a warning
                  for the team). When that search finds nothing, a shorter phrase is tried where the label has more than two words, then a general
                  scene of the trade at work; and a picture whose description matches
                  <strong>none of the frame&rsquo;s own subject words</strong> is listed under <strong>What TAWD did to this page</strong>, so a photo that
                  doesn&rsquo;t suit its place reads as TAWD&rsquo;s compromise rather than the builder&rsquo;s choice &mdash; a picture in the hero; icons from TAWD&rsquo;s own icon set by the word the builder wrote, then the card&rsquo;s heading (insects get a bug,
                  rodents a paw, and texting or chat a chat bubble however it is worded &mdash; &ldquo;text us&rdquo;, &ldquo;send a text&rdquo;, &ldquo;live
                  chat&rdquo;) &mdash; and when TAWD has no icon for the word, <strong>a plain dot</strong>, never a near-enough icon that would say
                  something the page never said: the words it had no icon for are named on the concept&rsquo;s Checks tab as an amber line and listed under
                  <strong>What TAWD did to this page</strong>;
                  and the colour rhythm of the design direction: enough sections in the full brand colour and never a long run of pale ones, with pale
                  sections turned to the brand colour where needed and the text colours fixed to stay readable &mdash; text that already
                  used one of the brand&rsquo;s colours, or a grey, keeps its colour and is only made darker or lighter, while text in a colour that is
                  neither is given <strong>a brand colour that can be read there</strong> (or plain near-black) rather than a darker version of the wrong
                  colour. <strong>Plain white or plain black text that can&rsquo;t be read is treated the same way</strong> &mdash; a brand colour where one can be read there, otherwise plain near-black or near-white &mdash; rather than a grey: white inside a white
                  card was never a colour anybody chose. <strong>Every colour change is listed</strong> under <strong>What TAWD did to this page</strong>, not
                  only the ones that changed the colour&rsquo;s family. The colour rule TAWD writes is made strong enough to beat the page&rsquo;s own styling, so
                  the text on the page really does change; if the page&rsquo;s own styling still wins, the list <strong>names that rule</strong>, because it is the
                  one the designer or a fix round can remove. <strong>A line nobody can see</strong> &mdash; a rule drawn in the same colour as the background
                  behind it &mdash; is given a colour that shows, by the same rule, and listed there too. The page rules are checked too: the form&rsquo;s button
                  says <strong>Request a quote</strong> and a call button <strong>Call</strong> and the number (both fixed by code), a reviews band that only
                  asks for reviews is taken out, no fact repeated on the first screen, at most one small label above a heading in a band, no drawn map, and a
                  heading over both columns, not one. A picture frame Shutterstock can&rsquo;t fill gets one of the client&rsquo;s photos not used elsewhere.
                  <strong>Each concept gets a different picture:</strong> the search is made once for the project and every answer kept, so a second concept
                  asking the same thing takes the next one rather than the same photograph, and each concept&rsquo;s page records which it took, so it never
                  changes underneath you. When the answers run out, concepts share again rather than a frame going empty. <strong>The same photo of the
                  client&rsquo;s is never left in two bands</strong> while another of their photos is unused: TAWD swaps the repeat, and says so under
                  <strong>What TAWD did to this page</strong>. With none spare it says that instead, and leaves the page alone.
                </li>
                <li>
                  The <strong>Checks</strong> tab lists <strong>every</strong> check TAWD made, in groups. A check that belongs to no group yet is shown under
                  <strong> Other checks</strong> rather than left out, so nothing can fail without the team seeing what it was. The one-line summary on the
                  concept card and the generating screen <strong>names the fixes</strong> &mdash; &ldquo;2 fixes: text that cannot be read, no footer&rdquo;
                  &mdash; instead of counting them.
                </li>
                <li>
                  Every concept version&rsquo;s <strong>Checks</strong> tab lists <strong>What TAWD did to this page</strong>: the changes TAWD&rsquo;s own
                  code made after the page was written, free and automatic, each saying what it did, to what, and why &mdash; for example an icon word it has
                  no icon for, shown as a plain dot. <strong>The Creative Director is given the same list</strong> and told never to ask for one of them back,
                  because the builder can&rsquo;t undo them: before that, a review could spend itself writing fixes nobody could make and the score wouldn&rsquo;t
                  move. Nothing here means something went wrong; it is what code changed.
                </li>
                <li>
                  Each finished concept has <strong>Reference sites used: about N%</strong>: for each site, what the concept took (its sections in its order,
                  its kind of hero, its kinds of proof, its service layout) and what it didn&rsquo;t, with what the client likes about it. Measured by code, free:
                  the order counts for half, the hero a fifth, the proof and the services the rest. When an approved wireframe set the section order, it says so.
                  Colours, fonts, words and photos never come from a reference, so they aren&rsquo;t counted.
                </li>
                <li>
                  Review each concept: click the design to pin a comment (the section under the mouse is outlined, and the pin belongs to that section), then
                  <strong> Request changes</strong>; <strong>Create v2</strong> shows the model and the estimate first, and <strong>Yes, create v2</strong> spends it. TAWD changes only those sections, and the Creative Director marks each comment <strong>Done</strong> or{" "}
                  <strong>Not done</strong>, with one line on why (matched to the comment by its label, never by its place in the list). Comments stay open until someone resolves them. A Not done comment can be sent once more with{" "}
                  <strong>Try it again</strong> (it shows the cost first); after that, reword it as a new comment or ask the web designer. An unposted comment is kept in your browser, so switching tabs loses nothing.
                  On the concept&rsquo;s <strong>Review</strong> tab, the earlier notes and requests that were <strong>not</strong> made in this version are listed
                  under <strong>Not done in this version</strong>, each with the Creative Director&rsquo;s own reason, instead of only a count of how many were
                  addressed. A version that was never scored (a polish whose scoring didn&rsquo;t finish) shows the last score there was and says which
                  version it is for, and the list reads <strong>Not done in vN</strong> for that version. <strong>Direction fit</strong> is scored whenever the run has more than one concept; every concept the run holds is counted, the designer&rsquo;s own design on an Option B run
                  and any concept that failed included: on a polished or revised concept too, and when the run&rsquo;s other concepts aren&rsquo;t part of that pass, it is scored on how clearly the
                  concept feels like its own direction and says that the comparison could not be made there. (An older answer read again by
                  <strong>Run the review again</strong> may have left it unscored; it then says &ldquo;Not scored in the saved answer this was read from&rdquo;.)
                </li>
                <li>Download the client pack and send it; record which concept the client chose (on Design, or <strong>Record the client&rsquo;s decision</strong> on the concept&rsquo;s own page) (and any changes they asked for: the dialog shows the estimate, and <strong>Save and make v2</strong> starts the paid round).</li>
                <li>Lane 2 (&ldquo;Client&rsquo;s design&rdquo;): the design is read, and for Option B reviewed or the review skipped.</li>
              </ul>
            </li>
            <li>
              <strong>Content</strong> (SEO and content team; Lane 1 only; Design only has no Content step). One list of TAWD&rsquo;s steps, in order: the current
              site&rsquo;s pages, the SEO quick check, keyword research, the page plan, the pages&rsquo; words and the client&rsquo;s approval of the copy; the SEO
              suggestions and the full audit under <strong>More</strong>. When pages in the plan have <strong>no main keyword</strong>, the plan says so once as a number: without one TAWD cannot tell which page should win which
              search, so two pages can end up competing for the same one. It never invents one &mdash; that is keyword research, or the SEO team&rsquo;s own
              call. The audit&rsquo;s redirect table sends each old address to one new page, looked for in this order: the same address
              written differently (capitals, a file ending), the page it shares most words with (plurals and endings count as the same word when at least four letters are left, so &ldquo;drains&rdquo; finds
              &ldquo;Drain cleaning&rdquo; but &ldquo;rats&rdquo; does not fold to &ldquo;rat&rdquo;), a page whose address is nearly the same, then its parent address (the same address written differently, or nearly the same). Endings come off a word only when four letters are left, so &ldquo;news&rdquo; never finds &ldquo;New installations&rdquo;. On any address but the home page a query string is set aside and the path is used. An address that finds
              no page is <strong>not sent to the home page</strong>: it is listed first as &ldquo;No match&rdquo; with a page chooser, and the new site
              has no redirect for it until someone chooses a page. An old address told apart only by its query string (such as <code>/?page_id=12</code>, an old WordPress
              site on plain permalinks) is kept and listed with the reason, but no redirect is written for it yet, on Build A or Build B. An address with <code>*</code>, <code>:</code>,
              <code>!</code> or a space is listed with the reason and never written to the redirect file. An <strong>old privacy policy, cookie policy or terms page</strong> can only go to the new site&rsquo;s own page of
              that kind, or home &mdash; never to an article that happens to share a word with it. Each row says where it stands (Done, To do, TAWD is on it, Needs a look, Waiting); one is
              open at a time, the next to do by default. A step the project doesn&rsquo;t need stays in the list, greyed, with &ldquo;Not needed for this
              project&rdquo; and why. For Everything new (and the client&rsquo;s words), <strong>Prepare the content: Home page first</strong> runs the paid parts
              from one approval, in order, by itself: keyword research (it can be left out; the plan then uses the intake&rsquo;s words; while DataForSEO is on its
              free sandbox it starts unticked, with the reason, because the sandbox&rsquo;s numbers are test data; and with <strong>no services in the
              intake</strong> it will not run at all, because every keyword would be the trade&rsquo;s own word rather than what this business sells &mdash; it
              says so and asks for the services first), the page plan (code,
              free), then the Home page&rsquo;s draft; its dialog shows each cost, the total and the cheaper way. <strong>With a supplied home page</strong> (one the
              team uploaded as an HTML file and the client approved) the Home page keeps its own words, so this step never offers its draft and never charges
              for one: it runs the keyword research and the plan only. It is shown only while there is keyword research to decide on; once that is done, or it
              cannot be run, the step is not shown at all &mdash; the page plan has its own step and the other pages are drafted from <strong>Draft and approve
              each page</strong>. For these projects the Next step bar points at <strong>Make the page plan</strong>, never at a step that may not be on the
              screen. With the plan already made and the research left out, Start would do nothing, and says so instead. Check and approve the Home page, then draft the
              other pages together under <strong>Draft and approve each page</strong>, approve each, send the copy pack and record the client&rsquo;s approval. Until
              there is a plan, the Next step bar and the page plan&rsquo;s step both point to Prepare the content (<strong>Only the page plan</strong> makes the
              plan alone). On a page&rsquo;s draft, <strong>Previous page</strong> and <strong>Next page</strong> follow the plan&rsquo;s order; after
              <strong> Approve</strong>, <strong>Next to approve</strong> opens the next page waiting; <strong>Back to Content</strong> lands on that page&rsquo;s
              row, highlighted. The copy pack&rsquo;s download and <strong>Record the client&rsquo;s decision</strong> are in their own step, <strong>The
              client&rsquo;s approval of the copy</strong>, once every page is approved. The page plan aims Home at the trade, and each service page at its service, in the business&rsquo;s own city from the intake (&ldquo;Plumber in
              Sacramento&rdquo;), whatever the service area (cities, counties, a TV area, a state or the country); a makeover follows the city the current site
              focuses on, and only when the intake has no city does the first service area lead. A page&rsquo;s keyword never names a different city or county from its title (one with no place in it, like &ldquo;plumber near me&rdquo;, can lead); city and county pages use their own place. It plans an About or FAQ page only when the intake has facts for it. The PM
              then moves the project to Build; if any page was added, removed or redrafted after the client approved the copy, TAWD asks for the client&rsquo;s
              decision on the current copy first. Keywords and the plan can start while the client picks a concept. For Design + content the words come from the
              current site and are improved: see <a href="#makeover">Project types</a>.
            </li>
            <li>
              <strong>Build &amp; preview</strong> (PM; SEO signs off; a PM, the web designer, a founder or an admin reviews the pages). Parts on the Build page:
              <ul>
                <li>
                  <strong>Build</strong> the site (Lane 2 builds on Design: home page first, then the rest). Every build is made fast by code: pictures resized,
                  fonts kept on the site, nothing loaded before it&rsquo;s needed. No picture is ever shown wider than it really is, so nothing comes out blurry.
                  An older build can be made fast for free with <strong>Speed up this build</strong>.
                  <ul>
                    <li>
                      <strong>In stages</strong> (Lane 1, PMs and admins): the home page first (it also makes the header and footer every page shares), then each
                      other main page one at a time (about, pricing, contact, the services and areas overviews, the blog page, other single pages), then for
                      services, service-area pages and articles the first page alone and the rest together (&ldquo;Build the first service page (Ant
                      control)&rdquo;, then &ldquo;Build the other 11 service pages&rdquo;). One button for the next stage, with its estimate; check the new
                      page before building the next. Each stage is a new version with every page built so far: the pages built before are reused as they are
                      (no AI). The list on the card shows each stage as <strong>Built vN</strong>, <strong>Next</strong> or <strong>Waiting</strong>.
                      On a makeover, only the first blog article is built with AI: every other kept article is filled into its layout by code, free (the
                      estimate says how many).
                    </li>
                    <li>
                      Pages not built yet show a <strong>Coming soon</strong> page (marked &ldquo;Not built yet&rdquo;, hidden from search engines) so every
                      menu link works. The privacy and cookie policies, thank-you and 404 pages, sitemap and robots file are written by TAWD with every stage,
                      free. The preview can be deployed with only some pages built; it says how many.
                    </li>
                    <li>
                      Once the home page is built, <strong>Build all remaining pages</strong> builds every page not built yet in one run (the full estimate
                      first). Once every page is built, <strong>Build the whole site again</strong> rebuilds every page with a new header and footer. Each
                      run stops itself at twice its estimate.
                    </li>
                  </ul>
                </li>
                <li>
                  Every build of TAWD&rsquo;s own design is tidied by code, free: empty picture frames get the client&rsquo;s unused photos (or are taken out),
                  every form button says <strong>Request a quote</strong> and every call button <strong>Call</strong> and the number, a label that only repeats the
                  business name goes, a reviews band that only asks for reviews goes, and the icons are filled again. The checklist&rsquo;s <strong>Page rules</strong>
                  line says what code fixed and lists, page by page, what&rsquo;s left to look at (repeats on the first screen, too many small labels, a drawn
                  map); it never blocks go-live.
                  <strong>The home page is built to the approved mockup&rsquo;s own bands.</strong> TAWD works out the approved home page&rsquo;s bands by code
                  &mdash; their order, each one&rsquo;s heading and what it is made of &mdash; and the built home page keeps them one for one: a band is never
                  split in two or merged, and the contact form goes inside the band that already had one rather than becoming a band of its own. Where the
                  approved words have nothing for a band, the band stays and is filled from the nearest part; nothing is invented, and no band is added. The
                  checklist&rsquo;s <strong>The home page keeps the approved layout</strong> line says how many bands were approved and, if they differ, names
                  both orders so you can see which band went where; it never blocks go-live, because the mockup&rsquo;s words and the approved words are two
                  different texts and a band with nothing to say is possible.
                  <strong>Every band shows its words</strong> (Lane 2, a site built from a design): after the build, each page is opened in a real
                  browser as a visitor sees it, with every section drawn, and each band is checked: its words must not be hidden, the same colour as the
                  plain colour behind them, or covered by a picture or another layer. Words over a photo or a gradient count as seen (their colour
                  can&rsquo;t be judged against a picture). Words not meant to show at that width are left out: a phone menu&rsquo;s copy of the links,
                  a form&rsquo;s hidden trap field, the off-page &ldquo;Skip to content&rdquo; link. A band where fewer than half of its words can be
                  seen, or that takes up room with none of its words laid out, is named in that page&rsquo;s Preview notes, and the checklist&rsquo;s
                  <strong> Every band shows its words</strong> line blocks go-live until a build passes. If the check can&rsquo;t run, the line says
                  so and blocks too.
                  When TAWD photographs and checks a built page, the page may load only its own files and Google Fonts, so an embedded booking
                  widget or map shows as a grey box saying &ldquo;Shown on the live site&rdquo; in TAWD&rsquo;s pictures; on the site itself it works as normal.
                  The Creative Director and the checks treat that box as expected: it is never scored down or sent for fixing.
                  Pictures lose their hidden details (where and when a photo was taken, the camera) before they go on the site, and the picture shared on social
                  sites is a photo, never the logo drawing.
                </li>
                <li>
                  <strong>Check:</strong> the checklist, the SEO check and its sign-off, and <strong>Review pages</strong>: open each page of the site inside TAWD (at
                  computer or phone width; the site&rsquo;s own scripts, such as tracking, don&rsquo;t run there), click a section to comment on it, then <strong>Approve</strong> and go to the next page. PMs, the web designer and
                  founders approve. An approval carries over to a new build while the page, header and footer are unchanged. If only the header or footer
                  changed, <strong>Approve all unchanged</strong> approves those pages again in one click.
                </li>
                <li>
                  <strong>Fix these</strong> (Lane 1 sites): pin comments on a page, then press <strong>Fix these</strong>. The estimate shows first (Sonnet 5 by
                  default, changeable on Spend). TAWD changes only the parts the comments are on and builds a new version, with no AI for the other pages. One
                  fix at a time per site. Each comment shows <strong>Not sent</strong>, <strong>Being fixed</strong> or <strong>Sent in vN</strong>. Afterwards,
                  approve the page again (every page, if the header or footer changed), deploy the preview again and run the Speed check again.
                  <ul>
                    <li>
                      <strong>TAWD&rsquo;s check</strong> (free, no AI): after the fix, TAWD opens the changed parts at computer and phone width and looks for a
                      phone number, a button or a menu link on two lines, something sticking out past the edge of the page, and pictures that don&rsquo;t
                      load. What it finds shows above the comments as &ldquo;TAWD&rsquo;s check found: &hellip;&rdquo;.
                    </li>
                    <li>
                      <strong>One automatic retry:</strong> only when the check finds a problem, the AI tries once more with the problems and pictures, and
                      TAWD builds one more version. It never tries a third time. Cost: up to about twice the estimate, and only when the check finds something.
                    </li>
                    <li>
                      Each sent comment says <strong>Changed in vN</strong> or <strong>Nothing changed here</strong> (worked out by code). A PM, the web
                      designer, a founder or an admin then clicks <strong>Done</strong> (it&rsquo;s resolved) or <strong>Not done</strong> (it&rsquo;s open
                      again as Not sent and goes with the next Fix these). A comment marked Not done twice says <strong>Ask the Web Designer</strong>, so
                      nobody keeps paying for the same failed fix.
                    </li>
                  </ul>
                </li>
                <li>
                  <strong>Preview:</strong> put it on a private preview link, send the link, and record the client&rsquo;s decision. Each preview has its own link; the
                  Netlify site&rsquo;s plain address (and the client&rsquo;s domain) shows the site only from go-live. The{" "}
                  <strong>Speed check</strong> (Google&rsquo;s scores on phone and computer) is on the Go live part.
                </li>
              </ul>
            </li>
            <li>
              <strong>Go live</strong> (PM, then a founder or an admin). The build fee, the domain, connecting it (usually two records), Netlify, HTTPS, then Go live.
              See <a href="#live">Going live</a>.
            </li>
            <li>
              <strong>Updates</strong> (PM; the invoice is an admin&rsquo;s). After go-live, each change the client asks for is logged with a category and an hours
              estimate, against the hours their plan includes each month (8 to start, set per tier on Pricing). A new page, a redesign, or hours over the plan
              become a quote from the Pricing page, and the work waits until the client approves it. At the end of the month an admin prepares the invoice,
              checks every line, and downloads it (print or save as PDF, or CSV) to send.
            </li>
          </ol>
        </section>

        <section id="roles">
          <h2 className="section-title">Your role</h2>
          <p>Everyone signed in can see every project and comment on concepts. A person can hold more than one role.</p>
          <ul>
            <li><strong>PM:</strong> makes projects, fills the intake, approves the wireframe, runs the designs and builds, reviews and approves the built pages, records the client&rsquo;s decisions, and runs the go-live steps.</li>
            <li><strong>Web designer:</strong> reviews designs, accepts or pushes back on the changes TAWD suggests to a client&rsquo;s design, approves the wireframe, and reviews and approves the built pages.</li>
            <li><strong>SEO:</strong> keyword research, the page plan, the SEO check, and the SEO sign-off before go-live.</li>
            <li><strong>Content:</strong> the page plan and drafts, and approving each page&rsquo;s copy.</li>
            <li><strong>Founder:</strong> the final Go live (and rolling back), recording the build fee, approving pages, and letting a build go live when it misses the speed minimum or an approval (recorded, for that build only).
              <strong> Never cancel, or let lapse, the tawdpreviews.com package at 20i or the tawdpreviews.com domain:</strong> every WordPress preview and every live WordPress site depends on them.</li>
            <li><strong>Admin</strong> (a separate switch, not a role): accounts, spend limits, prices, the build fee, the Admin menu, and deleting projects.</li>
          </ul>
        </section>

        <section id="money">
          <h2 className="section-title">Money and the AI</h2>
          <ul>
            <li><strong>Every paid step shows its cost first</strong>, with the AI model it uses, before anything is spent. Nothing paid starts without a click.</li>
            <li><strong>One page first:</strong> a multi-page run offers &ldquo;Only the home page&rdquo; first; build the rest once that one looks right.</li>
            <li><strong>Free checks:</strong> &ldquo;Check first ($0)&rdquo; runs a design build with no AI to show what a real one would do (if a page can&rsquo;t be opened in the browser, or the design&rsquo;s style kit can&rsquo;t be made, it says so in plain words; press it again, and tell an admin if it happens twice); &ldquo;Skip the review ($0)&rdquo; skips Option B&rsquo;s review.</li>
            <li><strong>Exports:</strong> on Spend, <strong>Export CSV</strong> gives one row per run (its cost by group); <strong>Cost per call</strong> gives one row per AI call: its step, model, tokens, dollars and time (the time is kept from 0.101.0); <strong>Comments and
              fixes</strong> gives every team comment on a concept: the project, concept, section, Done or Not done and why (any period).</li>
            <li><strong>AI model per step</strong> (Spend): each step&rsquo;s model, changed by an admin. <strong>Fable 5.1</strong> ($10 in, $50 out per million tokens, about $1 more per concept than Opus 5.5) is offered for the concept build only. It runs only if VML&rsquo;s Anthropic account has 30-day data retention on; if not, the concept stops at once with that reason and nothing is charged for the refused call.</li>
            <li><strong>Test DataForSEO connection</strong> (Spend): checks the login (free), then makes one real keyword lookup (about $0.01 on the live service, free in the sandbox) so a refused server address shows here before real SEO work. The lookup&rsquo;s cost is shown and logged, but not counted against the keyword data cap.</li>
            <li><strong>Limits:</strong> admins set a monthly AI limit on Spend (a warning at 80%, new runs paused at 100%), a cap for keyword data, and a cap per project (test projects $5), which an admin raises on the project&rsquo;s page.</li>
            <li><strong>A build stops itself</strong> if it reaches twice its estimate.</li>
          </ul>
        </section>

        <section id="rules">
          <h2 className="section-title">The house rules</h2>
          <p>These are built into TAWD and cannot be switched off.</p>
          <ul>
            <li>No fake reviews or testimonials.</li>
            <li>
              <strong>What the AI writes is cleaned before it goes on a site</strong>: only ordinary page parts are kept. A picture, frame or stylesheet loaded from
              another website is removed (the site&rsquo;s own pictures, Google Fonts, and the booking and map frames TAWD adds itself stay), a form may send only to
              the site itself, and no script, redirect or structured data the AI wrote survives; TAWD adds its own structured data afterwards.
            </li>
            <li>
              No invented facts, phone numbers or names. The check reads the page&rsquo;s <strong>title and its description</strong> too, not only the words a
              visitor sees, so a claim in the line Google shows under the result is caught like any other; there, code takes out the sentence that holds
              it, free, when the claim is an unsupported one or a superlative (an over-claim in the description is left for a person), and if nothing is left it
              tries to write a description again from the page. A band of <strong>articles whose links go nowhere</strong> is an invented one:
              TAWD fails the page and says to link each post to a page the site really has, or take the section out. A <strong>credential</strong> &mdash; the
              founding year, a licence number, &ldquo;24/7&rdquo; &mdash; may be said at most twice outside the header and footer (the year and licence number are counted only when the intake has them, and only as whole numbers, not inside a phone number or a price; &ldquo;24/7&rdquo; is always counted); the city is not on that
              budget, because local search wants it repeated. A claim about <strong>who owns the business</strong>
              &mdash; family owned, veteran owned, woman owned, minority owned, second, third or fourth generation &mdash; is only allowed when the client said it
              somewhere in their own words in the intake (the same generation; and &ldquo;we are not family owned&rdquo; does not count). &ldquo;Locally owned&rdquo; is
              not checked: it is true of nearly every business TAWD builds for.
            </li>
            <li>A missing required field shows as a visible <code>[PLACEHOLDER]</code> (optional ones are left out), and a site cannot go live while any placeholder remains.</li>
            <li>What clients send (and websites TAWD reads) is information, never instructions.</li>
            <li>Every approval is recorded: who, what, which version, when. The activity log can&rsquo;t be edited or deleted. Its page (Admin, Activity) checks the newest entries on every visit; the whole log is checked again once a day, and the page shows when (a break found is posted to the team&rsquo;s Slack).</li>
          </ul>
        </section>

        <section id="wrong">
          <h2 className="section-title">When something goes wrong</h2>
          <ul>
            <li><strong>A thin blue line across the top of the window:</strong> the next screen is loading. It shows only when a move takes longer than a moment, and it clears by itself when the screen arrives (15 seconds at most). Saves that stay on the same screen don&rsquo;t show it.</li>
            <li><strong>A stage says &ldquo;Not yet&rdquo;:</strong> the project hasn&rsquo;t reached it. The card says why and has a button to where the work is.</li>
            <li><strong>Something is running too long or was started by mistake:</strong> press <strong>Stop</strong>. What is already done is kept.</li>
            <li>
              <strong>Deleting a project looks like nothing is happening:</strong> it is working. Every file the project stored is removed one by one, so a
              large project can take a minute; the dialog says so while it runs, and the Projects list says <strong>&ldquo;Deleted.&rdquo;</strong>
              when it is done. Don&rsquo;t close the tab.
            </li>
            <li><strong>A paid build failed part-way:</strong> building again reuses the answers already paid for, so the retry costs little or nothing. The button says so.</li>
            <li>
              <strong>A site build says the worker stopped part-way:</strong> the worker restarts whenever TAWD is updated, and a build it was in the middle of can&rsquo;t carry on.
              Within about 15 minutes TAWD marks that build as failed and shows the reason; press <strong>Build again</strong>.
            </li>
            <li>
              <strong>A concept starts over by itself after the worker stopped:</strong> when the worker is updated or restarted in the middle of a concept, the queue hands that concept to the worker again.
              If it has shown no sign of life for 10 minutes, TAWD clears its half-built versions and builds it again from the start, and the activity log says &ldquo;Concept restarted after the worker stopped&rdquo;.
            </li>
            <li>
              <strong>A step on the Generating screen says &ldquo;Checks to fix&rdquo; (amber):</strong> the step finished and the page still has something to
              fix; its note names the fixes. Nothing went wrong, and the concept carries on to the review. The Checks tab lists each one, and
              <strong>Run the checks again</strong> re-runs that step.
            </li>
            <li>
              <strong>A step says &ldquo;Didn&rsquo;t finish&rdquo; (amber):</strong> that step stopped and its note says why. It is not a crash, and nothing
              is red on that screen. Steps after it read <strong>Not run</strong> in grey because they never started. Press <strong>Run the review again</strong> on the concepts
              screen, or Generate again; what is already paid for is reused.
            </li>
            <li>
              <strong>&ldquo;The model ran out of room part-way through the page&rdquo;:</strong> the AI hit its output limit mid-page. Nothing is saved, because a page cut off
              part-way is broken rather than unfinished. Build again; if it keeps happening on the same concept, tell an admin, who can put that step on a different model on Spend.
            </li>
            <li><strong>&ldquo;Something went wrong&rdquo; with a reference number:</strong> press Try again; if it keeps happening, send the reference to an admin.</li>
            <li>
              <strong>Finding out why a job failed (admins):</strong> every time the worker fails a job, it saves one record: when, the queue and job, the
              project, what was running, the error&rsquo;s name and message, and its stack. <strong>Failed jobs</strong> in the Admin menu lists the last 100,
              newest first, with the stack under <strong>Stack</strong>. The records stay after TAWD is updated. Web addresses lose everything after the
              <code>?</code>, and values after <code>key=</code>, <code>token=</code>, <code>password=</code> and <code>Bearer</code> are removed.
              If the record names an AI call, that was the newest AI call of that run (or of that project, when the job has no run) in the hour before the failure.
            </li>
            <li><strong>Limit reached:</strong> an admin raises it on Spend.</li>
            <li><strong>A project is paused:</strong> a PM or an admin presses <strong>Resume project</strong> on its project page. It goes back to where it was paused, and it is logged.</li>
          </ul>
        </section>

        <section id="live">
          <h2 className="section-title">Going live</h2>
          <p>
            The Go live steps run in this order, as a checklist on the Build page&rsquo;s Go live part: only the current step is open, with whose job it is. Each one
            is logged and posted to Slack. The build fee can be recorded at any time.
          </p>
          <ol>
            <li>The build fee is recorded as paid (an admin or a founder).</li>
            <li>The domain is confirmed as registered in the client&rsquo;s name.</li>
            <li>
              <strong>Connect the domain:</strong> TAWD finds who runs the domain&rsquo;s DNS and email and recommends a way. Usually the client points two
              records at the new site, and their email isn&rsquo;t touched: they get their own steps for their DNS provider on a private page (no login), and
              TAWD checks the records until they are right. Only when VML runs the DNS (VML bought the domain, or it is already on VML&rsquo;s Cloudflare): the
              email records are copied into Cloudflare, checked and confirmed, then the nameservers are switched at the registrar (TAWD checks it, and warns if
              DNSSEC is on).
            </li>
            <li>The domain is added to the Netlify site.</li>
            <li>HTTPS is confirmed.</li>
            <li>GA4: the client&rsquo;s own GA4 property is recorded, with VML as Editor (the same measurement ID as on the Tracking card). Not blocking, but flagged until done.</li>
            <li>
              Tracking and consent: the Tracking card takes IDs only &mdash; GA4, Tag Manager, Meta Pixel, Google Ads and CallRail (its
              &ldquo;company/key&rdquo;, the two parts of CallRail&rsquo;s own snippet address) &mdash; and TAWD writes the code into every page itself. Nothing
              loads before the visitor&rsquo;s consent. The banner follows the strictest consent rule among the project&rsquo;s states (no state known: the
              strictest rule there is; today that is California&rsquo;s): the team&rsquo;s &ldquo;Ask first&rdquo; choice may be stricter than the state&rsquo;s
              floor but never weaker, Accept and Decline are equally prominent, a browser&rsquo;s Global Privacy Control counts as an opt-out (a later Accept
              still wins), the opt-out link reads <strong>Opt-Out Request Honored</strong> once an opt-out is processed, and every page keeps a
              <strong> Your Privacy Choices</strong> link that reopens the banner. Closing the banner is neither a yes nor a no. Before go-live, the
              checklist looks at every page&rsquo;s banner and blocks go-live if its two buttons no longer work (the page&rsquo;s code shows it); <strong>Speed up
              this build</strong> runs that check again on the new version rather than copying the old result.
            </li>
            <li>A founder or an admin checks the last list and presses <strong>Go live</strong>. A second press while it is publishing is told it is already running
              (one go-live at a time per site, for up to 15 minutes). If TAWD was restarted in the middle, the go-live screen asks Netlify once those 15 minutes
              have passed: when Netlify published it and the site still serves it, it is recorded as live (the log says TAWD recorded it); otherwise it is shown
              as failed with the reason, so press Go live again. Rolling back is one click; each Roll back goes one live version further back, and the button
              goes away at the first live version.</li>
          </ol>
          <p>
            <strong>Three gates before go-live.</strong> Go live only works when nothing blocks it. The three most often missed:
          </p>
          <ul>
            <li>
              <strong>The speed gate:</strong> a Speed check of the preview of the latest build must score 85 or more on phone and computer (the aim is 90; 85
              to 89 is allowed and noted). On a WordPress site it is the WordPress preview, otherwise the Netlify preview. After every new build (Fix these
              included), deploy the preview again and run the check again: an older score doesn&rsquo;t count.
            </li>
            <li>
              <strong>Every planned page built</strong> (Lane 1): no Coming soon page left. Build the remaining stages on Build.
            </li>
            <li>
              <strong>Every page approved</strong> in Review pages.
            </li>
          </ul>
          <p>
            The others: the SEO sign-off of this version, the checklist&rsquo;s red items (no placeholders, read on every page including the 404 page, and no labeled photo frame such as &ldquo;Photo: ...&rdquo; left where a picture belongs; <strong>no unconfirmed or over-stated claims</strong> &mdash; a
            warranty, free offer or financing the intake doesn&rsquo;t back, a guarantee stated stronger than the intake gives, or a superlative (a superlative is allowed only if the client&rsquo;s own words contain it). The claims check compares what the page says with what the client said, not whether a field is filled: a &ldquo;1-year&rdquo; and a &ldquo;12 months&rdquo; warranty agree, &ldquo;$500 off&rdquo; needs a $500 offer in the client&rsquo;s words even when Current offers lists another, and a ticked financing box backs a general mention but not a term such as &ldquo;0% APR for 60 months&rdquo;. A free offer or &ldquo;Special offers&rdquo; on a button or link of a few words (&ldquo;Get a free estimate&rdquo;) is a call to action, not a claim; the same words in a sentence are checked, and any other claim on a button (a number off, &ldquo;24/7&rdquo;, &ldquo;Financing&rdquo;) is checked as usual. It also checks, and blocks on: credentials such as licensed, bonded, insured, background-checked, a BBB rating or an EPA or NATE certification (backed by a licence number, the certifications field or the client&rsquo;s words), &ldquo;24/7&rdquo; and &ldquo;same-day&rdquo; (backed by the 24/7 emergency box or the client&rsquo;s words), job and head counts, discounts other than &ldquo;N% off&rdquo; or &ldquo;$N off&rdquo;, a guarantee promised in other words (&ldquo;if you are not happy we come back&rdquo;, &ldquo;for life&rdquo;), and any claim found only in image alt text or in the page&rsquo;s structured data. An offer that differs from a filled Current offers, a financing term the client never gave, and a guarantee that covers more than the client&rsquo;s words (&ldquo;full&rdquo;, &ldquo;parts and labor&rdquo;) block too; <strong>keeps the current site&rsquo;s features</strong> &mdash; the built home page must keep the ratings, warranty, licence, process, brands, showcase, comparison table and call/text the approved concept kept from the client&rsquo;s current site, unless one is left out with a reason; the 404 page, tap-to-call, broken links), the build
            fee, and the form test below. The checklist also has <strong>Facts match the intake</strong>: every page, the 404 page included, is read for a call button
            that dials a number the intake doesn&rsquo;t have, a phone number or licence number not in the intake, a price the client never wrote, a founding year other than
            the intake&rsquo;s, more years in business than that year allows, an address that isn&rsquo;t the intake&rsquo;s, a town the service area doesn&rsquo;t list
            (only when the service area is a list of towns), a person named as part of the business (&ldquo;founded by &hellip;&rdquo;, &ldquo;owner &hellip;&rdquo;, &ldquo;I&rsquo;m &hellip;&rdquo;, a lead technician or master plumber by name) whom the client never named, and a rating or review count, the page&rsquo;s
            structured data included. A visible placeholder is not counted. It blocks go-live. The same check runs on each concept: a failure gets a fix round, and a
            concept that still fails after it is held. On a project copied from a design, a fact the design shows that the intake doesn&rsquo;t have is flagged the same way:
            a person adds it to the intake (or corrects the copy) before the site goes live. A founder or an admin can let one build through the speed gate or the page approvals with{" "}
            <strong>Let it go live anyway</strong> (only after a Speed check has run); it is recorded with their name, for that build only.
          </p>
          <p>The domain is always registered in the client&rsquo;s name, never VML&rsquo;s.</p>
          <p>
            <strong>Form messages</strong> from the client&rsquo;s site come through TAWD (by Postmark, from VML&rsquo;s address, with the visitor as Reply-To,
            kept 90 days) and are emailed to the client (VML gets a copy). Before go-live, send a test from the <strong>Form messages</strong> card on the Go
            live part: a recipient must click <strong>I got it</strong> in the email, and go-live waits for it. Each live site&rsquo;s
            form is tested every Monday without emailing the client; if a test doesn&rsquo;t arrive within an hour, Slack is told. On the System page, the
            team&rsquo;s test inboxes check each month that messages land in the inbox, not spam.
          </p>
        </section>

        <section id="site-read">
          <h2 className="section-title">Reading the current site</h2>
          <p>
            When the intake&rsquo;s Website section is saved with an address, TAWD reads the site once, by itself, for every project (both lanes, every content
            choice). Free, no AI (a site that blocks TAWD costs cents: see below). First the home page as a browser sees it (each of its sections, up to 30, its
            menu, phone numbers, customer quotes, colours, fonts and a picture of its first screen), then every page&rsquo;s words, one page at a time, up to the
            tier&rsquo;s page limit. A 50-page site takes about a minute. Review widgets on the home page are kept apart as reviews to confirm, never used as the
            page&rsquo;s words.
          </p>
          <p>
            The result shows under the address: &ldquo;Read 23 pages from acme.com, free (no AI)&rdquo; (or, for a site read through a paid service, what it
            cost: &ldquo;Read 50 pages from finleypest.com through Jina Reader for $0.30 (no AI)&rdquo;; Content&rsquo;s card says the same), the home page line with when it was read (in PT),
            the first screen and colours, and <strong>See the words</strong>, <strong>See the pages</strong> (Content) and <strong>Read again</strong> (PMs, SEO and
            the content team). While reading it says which page it&rsquo;s on and refreshes itself, and keeps refreshing while it fills the intake and makes the page plan after the
            read (&ldquo;Filling the intake and making the page plan&rdquo;; the Next step card says &ldquo;TAWD is making the page plan&rdquo;). If the plan
            can&rsquo;t be made, Content, Design and the Next step card say why, with Read again on the Website section. The same site at another spelling (http or https, www or not, a
            trailing slash) isn&rsquo;t read again; another address is. Ticking &ldquo;No current website available&rdquo; or clearing the address removes the read
            (the plan and its drafts stay). A project read before this change shows &ldquo;Read the home page of ...&rdquo; with <strong>Read every page</strong>.
          </p>
          <p>
            <strong>Answers filled in from the site.</strong> An intake answer that is empty is filled with what the site proves, and only that: the phone (the one
            number the home page links to, or the one on at least half the pages; two main numbers fill nothing and are listed), the email (the one email link on
            the home or contact page), the address (only from the business&rsquo;s own structured data on the home or contact page, never from its words; a state written out becomes its two
            letters, and a city that repeats the state loses it; &ldquo;Lane&rdquo; and &ldquo;Ln&rdquo; count as the same when compared with a typed address), the services (its service pages; the
            main service is left for the team to choose) and the towns served (its town pages, when the areas are towns and the town reads cleanly: &ldquo;Pest
            Control In Elk Grove, CA&rdquo; gives &ldquo;Elk Grove, CA&rdquo;; anything else is left empty). From the home page&rsquo;s own words, three more are suggested for Process and Extras:
            a stated warranty or guarantee, a free offer (consultation, estimate, quote or inspection) and whether financing is offered &mdash; taken only from
            the clearest phrasing, never from a review, and left for the team to confirm like any other. <strong>Until one of those three is confirmed, it is not used:</strong>
            the concepts, the page words and the built site leave it out (the concept and site builders are also told what the old site says and not to state it), it does not count as
            the intake backing a claim, and the go-live checklist lists it under &ldquo;Claims from the current website confirmed&rdquo; (that item doesn&rsquo;t block go-live by itself;
            a page that states the claim anyway fails the claims check, which tells you to confirm it on the intake, unless the words are the client&rsquo;s own
            current-site words kept and approved on Content, which count as the client&rsquo;s words). Changing it on the intake makes it the team&rsquo;s answer, used as given. Never the name, licence numbers, years, hours, prices or reviews. Each filled answer carries a
            blue &ldquo;From the current site&rdquo; mark with where it was read and <strong>Confirm</strong>; changing it (even after confirming) takes the mark off,
            and TAWD never fills that answer again. A person&rsquo;s save at the same moment always wins. Anything the team typed is never changed; when the site says something else the panel says so in amber (&ldquo;The site shows ...;
            the intake says ...: the intake&rsquo;s stays.&rdquo;). One of those amber lines is worth knowing: when the site&rsquo;s <strong>home page names a
            town the service areas don&rsquo;t list</strong> in its title, main heading or description (&ldquo;Patio Covers in Sacramento&rdquo; while the areas say Folsom and Rocklin), it says the page
            mentions it and asks the team to add it if the client serves it. It only knows the town is mentioned, not that the client works there. Nothing is added for you: only the client knows where they work, and the rest of the build &mdash; the concepts, the Creative
            Director and the page plan &mdash; all follow the intake, so a town missing from it is a town the new site will not sell to.
          </p>
          <p>
            A site drawn only by JavaScript (some Wix sites) gives the home page&rsquo;s words only; the panel says so. Times across TAWD say PT (Pacific).
          </p>
        </section>

        <section id="makeover">
          <h2 className="section-title">Project types: Design only and Design + content</h2>
          <p>
            Some clients want the same pages in a better-looking, faster site. With a current website, the intake&rsquo;s Content section asks the project type
            (Lane 1):
          </p>
          <ul>
            <li>
              <strong>Design only</strong>: the same pages and words, kept exactly. No wireframe (the new design keeps the current home page&rsquo;s sections, in
              their order) and no Content step: the kept pages need no approval, because they&rsquo;re the client&rsquo;s own words and the build checks them word for
              word. When the client picks a concept, the project goes straight to Build; until the plan has made itself, the Next step says so.
            </li>
            <li>
              <strong>Design + content</strong>: the same pages, the words improved by TAWD from the current site&rsquo;s. The wireframe (Growth and Pro) is drafted
              from the current home page&rsquo;s own sections; the concepts are designed from the current words. On Content, <strong>Improve the words</strong>:{" "}
              <strong>Improve the Home page first</strong> (its dialog shows the model, the cost and the cheaper way), then, once its improved words are approved
              (or it&rsquo;s put back), tick the other pages and <strong>Improve N pages</strong>. Blog articles and pages under 50 words stay as they are unless
              ticked. TAWD is told to keep every fact, number, link, table and customer quote, and that the intake wins where the page and the intake disagree;
              a code check lists any number, phone, price or year that is new or went missing, and any name the current page used that this version dropped or changed (the business, its city, a service area or a service). Each page&rsquo;s
              review has <strong>Compare with the current site</strong> (new words underlined, removed ones struck through, and &ldquo;About N% of the words are
              new&rdquo;), an amber line for any number, phone, price or year that&rsquo;s new or went missing, and for any name that&rsquo;s been dropped or changed &mdash; a shortened service area such as &ldquo;Carson City&rdquo; written &ldquo;Carson&rdquo; is named there (all checked by code), <strong>Improve it again</strong>{" "}
              (with a note), and <strong>Put back the current site&rsquo;s words</strong> (free). An improvement that didn&rsquo;t finish offers <strong>Try
              again</strong> or <strong>Keep the current site&rsquo;s words</strong>. Approve each page, then the client&rsquo;s approval of the copy, as for
              Everything new. The step is <strong>Improve a page&rsquo;s words</strong> on Spend (Sonnet 5 by default).
            </li>
          </ul>
          <p>Both start the same way:</p>
          <ol>
            <li>
              Save the intake. TAWD reads every page of the current site by code (see <a href="#site-read">Reading the current site</a>), up to the
              tier&rsquo;s page limit (Starter 10, Growth 20, Pro 50; the site&rsquo;s own pages first, then the newest blog posts), plus up to 100 blog articles on
              top: their blog articles don&rsquo;t count toward the limit. It keeps each page&rsquo;s own
              words and leaves out the menu, footer, cookie bar, forms and review widgets. The old privacy and cookie policies are replaced by TAWD&rsquo;s own.
            </li>
            <li>
              When the read finishes, the page plan makes itself: the current site&rsquo;s pages at the same addresses (so rankings carry over), each page&rsquo;s
              words its version 1, &ldquo;From the current site (kept as is)&rdquo;. Blog posts become plain article pages, and the blog page a list of them.
              Content&rsquo;s <strong>Current site&rsquo;s pages</strong> card lists what was read, what was left out and why, the blog articles kept on top of the
              limit, any pages over it, and &ldquo;In the page plan since &lt;when&gt; (TAWD, automatically)&rdquo;. <strong>Make the page plan</strong> isn&rsquo;t offered for these types.
            </li>
            <li>
              Nothing the team did is ever wiped. When the site is read again (Read again on Intake, or a higher tier), new pages are added; a kept page nobody has
              touched (not approved, not edited, no open comment) gets the site&rsquo;s new words as a new version; a page the team has worked on is left and listed
              &ldquo;Changed on the current site since it was kept&rdquo;; a page gone from the site stays and is listed &ldquo;No longer on the current site&rdquo;.
              If a page plan was made another way (Make the page plan, by hand, or from another address), TAWD never replaces it by itself: the card shows
              one button, <strong>Replace the plan with the current site&rsquo;s N pages</strong>, and its dialog says what it replaces and deletes (&ldquo;It
              replaces the current page plan (12 pages). This deletes 4 approved pages.&rdquo;).
            </li>
            <li>
              On Design there is no Home page words step: the concepts use the Home page&rsquo;s words on Content, as they are. Generate waits only while the site
              is being read, after a failed read, or for that one decision. To change the home page&rsquo;s words, edit the Home page on Content; the next
              concepts use the edit. Customer quotes on the old home page show on the concepts as a [PLACEHOLDER] until someone confirms with the client that
              they&rsquo;re real.
            </li>
            <li>
              Design + content: the content team improves, compares and approves each page (above). Approvals still count on Design only if someone gives them, but
              the build doesn&rsquo;t wait for them. A page the team adds is drafted by TAWD as usual (estimate first); a page with the current site&rsquo;s words is
              never drafted from the intake.
            </li>
            <li>
              The SEO team reads <strong>Current site: SEO suggestions</strong>: titles, descriptions, headings, missing alt text, thin or near-duplicate pages, broken
              links, canonical tags, phone numbers that differ from the intake, star ratings in the page code. A city page whose title names its own place counts
              as having a city. Pages nothing links to aren&rsquo;t listed: the new site&rsquo;s menu, footer and blog list link every kept page. On a site read
              through Jina before 0.99.0 the canonical tags weren&rsquo;t read, so they&rsquo;re not checked until the site is read again. Suggestions only, free:
              nothing changes until the team changes it (titles and descriptions in the page plan; words on the page&rsquo;s review).
            </li>
            <li>
              Build as usual. TAWD keeps the words exactly and only changes the design; a big site&rsquo;s menu is grouped (Services, Service areas). On Check,
              &ldquo;The current site&rsquo;s words, kept word for word&rdquo; lists any sentence the build missed or changed, page by page (it never blocks go-live;
              fix it with Fix these on the page review).
            </li>
          </ol>
          <p>
            <strong>If the site blocks TAWD</strong> (a bot check such as &ldquo;One moment, please&rdquo; or &ldquo;Checking your browser&rdquo;, or a bare
            refusal): some hosts block visitors from servers like TAWD&rsquo;s. TAWD then reads the site by itself through a paid reading service, in this
            order: <strong>Jina Reader</strong> (the home page&rsquo;s full page for its look and a screenshot, the other pages a few at a time), then{" "}
            <strong>Zyte</strong> for any page Jina couldn&rsquo;t give (or for the whole site when Jina is off). A read costs cents (a 50-page site about
            $0.10 to $0.30; the pages are asked a few at a time, so a page the live site would have given may be paid for too); under $1 it runs
            without asking; over $1 the read waits on the intake&rsquo;s Website section with the service and the estimate and a button{" "}
            <strong>Read it for about $X</strong> (a PM or the SEO team), then carries on; and every call is listed on Spend under <strong>Blocked-site reads</strong> (&ldquo;Jina Reader
            (blocked site)&rdquo;, &ldquo;Zyte (blocked site)&rdquo;) with the project. Each service has a monthly cap (an admin sets it on Spend; $5 by
            default): past it TAWD doesn&rsquo;t call it, the activity log says so, and Slack too when the project has it. The pages table&rsquo;s{" "}
            <strong>From</strong> column says which service gave each page. When neither service can read the site (out of credit, limited, over the cap,
            or not set up), the read says so plainly, with what to do about each (&ldquo;Jina Reader&rsquo;s balance is used up (402): top it up on jina.ai (API
            key &amp; billing).&rdquo;; when one service stops mid-read the other carries on, and the activity log and Slack say so): &ldquo;finleypest.com blocks TAWD&rsquo;s server (...), so its pages can&rsquo;t be read from here.
            Reading again won&rsquo;t change that.&rdquo; Then the two ways that work: paste the words (choose &ldquo;Content provided by the client&rdquo; in
            the intake&rsquo;s Content section), or let TAWD write new words (choose &ldquo;New site&rdquo;). A read the 0.94.0 Internet Archive route made
            keeps its pages and the dates it showed; that route is gone. A host that doesn&rsquo;t answer TAWD&rsquo;s server at all is treated the same way
            (&ldquo;... didn&rsquo;t answer TAWD&rsquo;s server. If the site opens in your browser, its host is blocking servers like TAWD&rsquo;s ...&rdquo;).
          </p>
          <p>
            Not yet: the current site&rsquo;s logo isn&rsquo;t copied (upload it in the intake), its photos reach the concepts only (not the built site), and words
            shown only inside pictures (coupons) need typing in by hand.
          </p>
        </section>

        <section id="wordpress">
          <h2 className="section-title">WordPress sites</h2>
          <ul>
            <li>
              A PM chooses <strong>WordPress</strong> on the Build page&rsquo;s Hosting card (any tier; a project that isn&rsquo;t Pro gets the monthly WordPress hosting add-on), and the form plugin: Contact Form 7
              (the default) or Gravity Forms. The choice is locked once the site is live.
            </li>
            <li>
              TAWD turns the built site into WordPress pages, a theme and the forms. <strong>Download the WordPress package</strong> gives VML&rsquo;s dev team the
              whole thing, with a README for a laptop install.
            </li>
            <li>
              <strong>Deploy the WordPress preview</strong> gives the site its own 20i hosting package (its own files, database and WordPress, hidden from search
              engines). The preview&rsquo;s address is <em>name</em>.<em>VML&rsquo;s preview domain</em> when one is set up; otherwise it is 20i&rsquo;s own
              staging address, which runs on slower servers, so the speed gate can&rsquo;t measure it and a founder lets the build through. Deploy again after
              each new build. If a step stops (20i still setting up TAWD&rsquo;s key on a new package, for example), <strong>Deploy again</strong> carries on from
              that step. With the preview domain set up, the package is named after the preview address itself, so the client&rsquo;s domain isn&rsquo;t
              needed to deploy; it is added to the same package at go-live. Without the preview domain, the package is named after the client&rsquo;s own
              domain, from the intake (the Domain name, or the current site&rsquo;s address), and without one the card asks for it; nothing changes at the
              domain itself until go-live. A preview made before 3 November 2026 has a package named after the client&rsquo;s domain: if it is on 20i&rsquo;s own
              address, the card says to <strong>Remove the preview</strong>, then <strong>Deploy again</strong>, which makes a new package named after the
              preview address with the same pages and pictures ($0, no AI). Two projects can&rsquo;t share a package. TAWD makes its own 20i SSH key at the first deploy if there isn&rsquo;t one (nothing to do on System). Each new site gets its own WordPress login name (<strong>Show the WordPress login</strong>, admins only, shows it); visitors never see it: pages show &ldquo;Website team&rdquo;, and WordPress&rsquo;s user list, author pages and user sitemap are closed to them. A site installed before 13 October 2026 keeps its old login. If 20i says no, the card shows
              20i&rsquo;s whole answer. On a WordPress project there is no Netlify preview card: the client&rsquo;s decision is recorded on the WordPress preview
              (<strong>Record the client&rsquo;s decision</strong>), and the Next step card points there. VML&rsquo;s 20i plan (Reseller 25) holds 25 sites: the 26th needs an admin&rsquo;s confirm on the Hosting card, with the new monthly price.
            </li>
            <li>
              <strong>Previews on VML&rsquo;s preview domain.</strong> 20i takes a preview address only once the account has a package for the preview domain
              itself, so TAWD makes that placeholder package at the first deploy that needs it, before the preview&rsquo;s own package. It counts as one of the
              plan&rsquo;s 25, and System&rsquo;s 20i check shows it. Never suspend or delete it in My20i (every preview&rsquo;s package depends on it); TAWD never does. While 20i is still setting it up,
              the deploy stops and says so: <strong>Deploy again</strong> a few minutes later. If all 25 packages are used and there is no placeholder yet, the deploy
              stops, makes nothing, and says to free a package or move to the next plan. A preview with its own package that is on 20i&rsquo;s own address moves to the preview domain on <strong>Deploy
              again</strong>: WordPress&rsquo;s address is changed with WP-CLI&rsquo;s search-replace, then TAWD searches the database for anything still
              pointing at the old address and the WordPress step lists it. For the next hour TAWD opens the moved preview every 5 minutes. If its
              certificate failed at the move, TAWD gets it again by itself at minutes 5, 30 and 55 (four tries in all with the deploy&rsquo;s own); a certificate it has just
              installed gets up to 30 minutes from its install for 20i to show it. If the preview never loads over HTTPS, TAWD moves it back to 20i&rsquo;s address by itself, and the card says why. TAWD no longer switches the
              placeholder off to test it: previews depend on it. <strong>The tawdpreviews.com package and the tawdpreviews.com domain must never be cancelled or
              allowed to lapse: live sites depend on them</strong> (a site that went live from a preview stays on a package under tawdpreviews.com). Every hour TAWD
              checks the package at 20i: if it is off, TAWD switches it back on, and the team&rsquo;s Slack is told the first time it is found off or missing and
              again once a day while it stays that way, then once when it is back. Once a day TAWD reads the domain&rsquo;s expiry date and tells the team&rsquo;s
              Slack 30, 14, 7, 3 and 1 days before, then every day from the day before and after it lapses. If 20i&rsquo;s API hasn&rsquo;t answered TAWD for a
              whole day, Slack is told once: TAWD then can&rsquo;t see the package, so check 20i&rsquo;s API key and its approved-address list.
            </li>
            <li>
              Go live on WordPress: the domain confirmed, the WordPress preview deployed on the latest build, <strong>Put the domain on 20i</strong>, then the
              domain connected: the client points two records at the site (the default), or VML runs its DNS on Cloudflare (allowed for WordPress now).
            </li>
            <li>
              <strong>HTTPS: the certificate</strong> comes the way an admin chose on System: TAWD&rsquo;s own free certificate (it asks for it by itself once the
              records point at the site and the domain is on 20i, whichever of the two happens last), 20i&rsquo;s certificate ($34.99 a year, bought only after an
              admin confirms the price on the card; 20i&rsquo;s API can&rsquo;t cancel it, so when the site is removed an admin cancels it in My20i), or one installed by hand in 20i&rsquo;s panel. 20i can take up to 30 minutes to show a new one:
              <strong>Check HTTPS</strong> confirms it, and TAWD looks again once a day. Check HTTPS only counts once the records point at the site (before that,
              the domain still shows whatever answered there, often the client&rsquo;s old site). A request that hasn&rsquo;t finished after half an hour shows
              <strong>Try again</strong>; TAWD&rsquo;s own certificate isn&rsquo;t issued again within two hours of the last one, and if 20i still isn&rsquo;t showing
              it after that, <strong>Get the certificate again</strong> appears. For a client replacing a live site, run Connect the domain, the certificate and Go
              live in one sitting: the old site stops answering as soon as the records change.
            </li>
            <li>
              Go live first checks again that the client&rsquo;s domain serves a working certificate from the site&rsquo;s package. If it doesn&rsquo;t, Go live
              stops before changing anything: the site stays on its preview, search engines are still kept out, HTTPS shows as not confirmed, TAWD asks for
              its own certificate again (when that is the way chosen on System), and the project&rsquo;s Slack says so. Press <strong>Go live</strong> again once
              Check HTTPS passes.
            </li>
            <li>
              Go live backs the site up first (to TAWD&rsquo;s own storage, not the hosting), and so does each later deploy, before anything on the site changes. If
              a backup can&rsquo;t be saved, Go live (or the deploy) stops there and nothing changes. <strong>Roll back</strong> (founders and admins) backs the site
              up as it is now, then restores the newest backup; <strong>Undo the roll back</strong> puts it back as it was just before. <strong>Purge 20i&rsquo;s
              cache</strong> clears 20i&rsquo;s copy after a change made in WordPress itself (TAWD clears it after every deploy).
            </li>
            <li>
              Once a day TAWD checks each live WordPress site&rsquo;s address: if 20i moves a site, it fixes the records itself where VML runs the DNS, and otherwise
              tells the PM in Slack and on the Go live card what the client has to change (Make a new client link sends them the steps again).
            </li>
            <li>
              Admins can <strong>Suspend</strong> a site (a client who stopped paying: visitors don&rsquo;t see it) and <strong>Restore</strong> it (the card shows
              while 20i is asked, and 20i&rsquo;s reason if it says no), and take a live site down with <strong>Remove the site</strong>: the project then leaves
              Live (it becomes Paused). A project with a WordPress site at 20i can only be deleted after the site is removed, and no project while work is still running for it
              (deleting names which: a site build, a page draft and so on; a job started over three hours ago doesn&rsquo;t count). A project that has ever gone
              live can&rsquo;t be deleted at all, even after Pause or Remove the site: its record and billing are kept.
            </li>
            <li>
              <strong>Replace the key</strong> (System, 20i) makes a new SSH key for TAWD. Each site&rsquo;s package gets it at its next deploy: until then that
              site&rsquo;s go-live and Roll back say the key was replaced, and the daily check holds its certificate renewal and lists it. Deploy again on each
              site after replacing the key.
            </li>
          </ul>
        </section>

        <section id="words">
          <h2 className="section-title">Words TAWD uses</h2>
          <dl className="runbook-words">
            <dt>Wireframe</dt>
            <dd>The site&rsquo;s pages and the home page&rsquo;s sections in order, as grey boxes, approved before the concepts (Growth and Pro).</dd>
            <dt>Concept</dt>
            <dd>One homepage design TAWD makes for Lane 1, in one design direction.</dd>
            <dt>Direction</dt>
            <dd>A design style (for example Bold Emergency, Modern Clean), chosen to suit the trade.</dd>
            <dt>Creative Director</dt>
            <dd>TAWD&rsquo;s own review step: it scores a design against set questions and suggests fixes. A concept is shown only at 4.5 or above.</dd>
            <dt>Client pack</dt>
            <dd>The pictures of the chosen concepts, labelled, to send to the client.</dd>
            <dt>Page plan</dt>
            <dd>The site&rsquo;s pages, each with its main keyword, title, description and heading.</dd>
            <dt>Kept page</dt>
            <dd>A page whose words come from the client&rsquo;s current site, word for word, for Design only and Design + content (until a page is improved).</dd>
            <dt>Copy pack</dt>
            <dd>All the approved page words, to send to the client.</dd>
            <dt>Done / Not done</dt>
            <dd>After changes are made to a concept, the Creative Director&rsquo;s verdict on each comment that went in.</dd>
            <dt>Speed check</dt>
            <dd>Google&rsquo;s PageSpeed scores for the preview of the latest build (the WordPress preview for a WordPress site), on phone and computer. Free, about a minute. Go-live needs 85 or more on both.</dd>
            <dt>Review pages</dt>
            <dd>The page-by-page check of the built site, inside TAWD, before go-live.</dd>
            <dt>Preview</dt>
            <dd>The built site on a private link, hidden from search engines, for the client to check.</dd>
            <dt>Placeholder</dt>
            <dd>A visible mark where a required fact is missing, so nothing is made up. Optional facts that are missing are left out instead.</dd>
            <dt>Updates</dt>
            <dd>Changes after go-live, within the hours a month the plan includes; anything over, and every new page or redesign, is quoted first.</dd>
          </dl>
        </section>
      </article>
    </div>
  );
}
