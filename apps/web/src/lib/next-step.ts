import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { wireframeBlocked } from "@/lib/wireframe";

import type { Database } from "@tawd/core/db";
import type { TeamRole } from "@tawd/core/enums";
import { keptHomeWords, type KeptHomeWords } from "@tawd/core/kept-home-words";
import { projectTypeFor, workWords } from "@tawd/core/site-read";
import { buildFeePayment, clientDecision, concept, designReview, editRequest, figmaDesign, goLive, mockupRun, project, siteBuild, siteDeploy, updateQuote, wpPreview } from "@tawd/core/schema";
import { monthPlan } from "./updates";
import { isRunActive } from "@tawd/core/queue";
import { loadDraftsOverview } from "./content-drafts";
import { missingMenuItems } from "./design-menu";
import { ensureKeptPlan } from "./site-read";
import { goLiveChecklist } from "./golive";
import { currentStep, journeySteps, loadJourneyFacts, stepHref, type JourneyFacts, type StepKey } from "./journey";
import { dayLabel } from "./pricing";
import { loadSeoGoLive } from "./seo-golive";
import { loadIntake } from "@tawd/core/intake/service";
import type { Viewer } from "@tawd/core/permissions";
import { getProject } from "./projects";

/*
  The Next step card and "Where things stand" on the project page (Jason,
  29 September 2026): what happens next, and whose job it is. Read-only;
  every button goes to the screen where the work is done.
*/

export interface Member {
  id: string;
  name: string;
  roles: TeamRole[];
}

export interface NextStep {
  title: string;
  line: string;
  /** Assigned people in the role, or the role alone when nobody is. */
  who: {
    label: "Whose job" | "Waiting on";
    people: { id: string; name: string }[];
    text: string;
    /** The roles whose job it is (for My work); empty when it waits on TAWD or the client. */
    roles: TeamRole[];
    /** Waits on an admin or a founder (the build fee, Go live). */
    adminOrFounder?: boolean;
  };
  action: { label: string; href: string } | null;
  secondary: { label: string; href: string } | null;
}

export interface StandingRow {
  key: StepKey;
  label: string;
  text: string;
  tone: "done" | "wait" | "later";
}

export interface ProjectNextView {
  next: NextStep;
  standing: StandingRow[];
}

const ROLE_WORDS: Record<TeamRole, string> = {
  pm: "A PM",
  web_designer: "A web designer",
  seo: "The SEO team",
  content: "The content team",
  founder: "A founder",
};

function job(members: Member[], roles: TeamRole[]): NextStep["who"] {
  const people = members.filter((m) => m.roles.some((r) => roles.includes(r))).map((m) => ({ id: m.id, name: m.name }));
  return { label: "Whose job", people, text: people.length ? "" : roles.map((r) => ROLE_WORDS[r]).join(" or "), roles };
}

function waiting(text: string, adminOrFounder = false): NextStep["who"] {
  return { label: "Waiting on", people: [], text, roles: [], adminOrFounder };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/* A makeover whose kept words aren't ready (0.96.0): reading and failures point at Intake's Website section; the one decision at Content. */
function keptNext(kept: KeptHomeWords, id: string, members: Member[]): NextStep {
  const intake = `/projects/${id}/intake?section=website`;
  // A done read whose plan is still being made has its date (0.97.0): the step after reading.
  if (kept.state === "reading" && kept.readAt) return { title: "TAWD is making the page plan", line: "From the current site's pages, no AI. The concepts use its Home page's words, as they are.", who: waiting("TAWD"), action: { label: "Open the Website section", href: intake }, secondary: null };
  if (kept.state === "reading") return { title: "TAWD is reading the current site", line: "No AI. The page plan makes itself from its pages; the concepts use its Home page's words, as they are.", who: waiting("TAWD"), action: { label: "Open the Website section", href: intake }, secondary: null };
  if (kept.state === "failed") return { title: "The current site couldn't be read", line: kept.failure ?? "The read didn't finish. The intake's Website section says what to do.", who: job(members, ["pm", "seo", "content"]), action: { label: "Open the Website section", href: intake }, secondary: null };
  return { title: "Decide on the page plan", line: `The page plan has work that isn't from the current site, so TAWD didn't replace it.${kept.work ? ` ${workWords(kept.work)}` : ""}`, who: job(members, ["content", "seo", "pm"]), action: { label: "Open Content", href: `/projects/${id}/content#kept-pages` }, secondary: null };
}

interface Input {
  projectId: string;
  facts: JourneyFacts;
  laneOption: string | null;
  members: Member[];
  /** Missing required intake answers, by label. */
  missing: string[];
}

export async function loadProjectNext(db: Database, input: Input): Promise<ProjectNextView> {
  const { projectId: id, facts, members } = input;
  const at = currentStep(facts);
  const href = (key: StepKey) => stepHref(id, key, facts.lane);
  const standingText = new Map<StepKey, { text: string; tone: StandingRow["tone"] }>();
  let next: NextStep;

  if (at === "paused") {
    next = { title: "This project is paused", line: "Nothing moves until it is resumed. Its screens stay open to read.", who: job(members, ["pm"]), action: null, secondary: null };
  } else if (at === "updates") {
    next = await updatesNext(db, id, members, standingText);
  } else if (at === "intake") {
    if (input.missing.length) {
      next = {
        title: "Finish the intake",
        line: `${plural(input.missing.length, "required answer")} missing: ${input.missing.slice(0, 4).join(", ")}${input.missing.length > 4 ? ", and more" : ""}.`,
        who: job(members, ["pm"]),
        action: { label: "Open the intake", href: href("intake") },
        secondary: null,
      };
      standingText.set("intake", { text: `${plural(input.missing.length, "required answer")} missing`, tone: "wait" });
    } else {
      next = {
        title: facts.lane === "lane_2" ? "Move on to the client's design" : "Move on to Design",
        line: "Every required answer is in. Continue from the intake page.",
        who: job(members, ["pm"]),
        action: { label: "Open the intake", href: href("intake") },
        secondary: null,
      };
      standingText.set("intake", { text: "Complete: ready to move on", tone: "done" });
    }
  } else if (at === "design" && facts.lane !== "lane_2") {
    next = await designNext(db, id, members, href("design"), standingText);
  } else if (at === "design" || (at === "build" && facts.lane === "lane_2")) {
    next = await lane2Next(db, id, input.laneOption, members, href("design"), standingText, at);
  } else if (at === "content") {
    next = await contentNext(db, id, members, href("content"), standingText);
  } else if (at === "build") {
    next = await buildNext(db, id, members, href("build"), standingText);
  } else {
    next = await goLiveNext(db, id, members, href("golive"), standingText);
  }

  const standing = journeySteps(id, facts).map((step): StandingRow => {
    const own = standingText.get(step.key);
    if (own && step.state !== "done") return { key: step.key, label: step.label, ...own };
    if (step.state === "done") return { key: step.key, label: step.label, text: at === "paused" ? "Open to read" : "Done", tone: "done" };
    if (step.state === "current") return { key: step.key, label: step.label, text: "In progress", tone: "wait" };
    if (step.state === "available") return { key: step.key, label: step.label, text: step.note === "Can start early" ? "Can start now (keywords and the page plan)" : "Ready to start", tone: "later" };
    return { key: step.key, label: step.label, text: step.lockedReason ?? "Later", tone: "later" };
  });

  return { next, standing };
}

type Standing = Map<StepKey, { text: string; tone: StandingRow["tone"] }>;

/* Lane 1, Design: concepts, the team's review, the client's pick. */
async function designNext(db: Database, id: string, members: Member[], href: string, standing: Standing): Promise<NextStep> {
  const [run] = await db.select({ id: mockupRun.id, status: mockupRun.status, count: mockupRun.conceptCount }).from(mockupRun).where(eq(mockupRun.projectId, id)).orderBy(desc(mockupRun.createdAt)).limit(1);
  if (!run) {
    standing.set("design", { text: "No concepts yet", tone: "wait" });
    // Growth and Pro (3 October 2026): the wireframe comes first.
    if (await wireframeBlocked(db, id)) {
      return { title: "Approve the wireframe", line: "The site's pages and the home page's sections in order, made by TAWD from the intake. Reorder, add or remove sections, then approve: every concept follows it.", who: job(members, ["pm", "web_designer"]), action: { label: "Open the wireframe", href: `${href}#wireframe` }, secondary: null };
    }
    // A makeover: the concepts use the Home page on Content, made by itself from the current site's read (0.96.0).
    await ensureKeptPlan(db, id);
    const kept = await keptHomeWords(db, id);
    if (kept && kept.state !== "ready") return keptNext(kept, id, members);
    return { title: "Generate the concepts", line: "Check the directions TAWD proposes, then generate the concepts. The estimate shows before anything is spent.", who: job(members, ["pm"]), action: { label: "Set up the concepts", href: `${href}#setup` }, secondary: null };
  }
  if (isRunActive(run.status)) {
    standing.set("design", { text: "TAWD is making the concepts", tone: "wait" });
    return { title: "The concepts are being made", line: "TAWD builds, checks and reviews each concept. Everyone assigned sees them here when they are ready.", who: waiting("TAWD"), action: { label: "Watch the progress", href }, secondary: null };
  }
  if (run.status === "failed") {
    standing.set("design", { text: "The last run failed", tone: "wait" });
    return { title: "The last concept run failed", line: "Open Design to see why, then run it again.", who: job(members, ["pm"]), action: { label: "Open Design", href: `${href}#setup` }, secondary: null };
  }
  // The 4.5 gate (8 October 2026): every concept held, none shown.
  const latestConcepts = await db.select({ status: concept.status }).from(concept).where(eq(concept.runId, run.id));
  if (latestConcepts.length > 0 && latestConcepts.some((c) => c.status === "held") && !latestConcepts.some((c) => c.status === "ready")) {
    standing.set("design", { text: "No concept reached 4.5", tone: "wait" });
    return { title: "No concept reached 4.5", line: "TAWD held every concept back: each scored under 4.5 after one rewrite, and its card says why. An admin can Show it anyway, or set up a new concept.", who: job(members, ["pm"]), action: { label: "Open the concepts", href: `${href}#concepts` }, secondary: { label: "Set up a new concept", href: `${href}#setup` } };
  }
  const [decision] = await db.select({ changes: clientDecision.changesRequested }).from(clientDecision).where(eq(clientDecision.projectId, id)).orderBy(desc(clientDecision.createdAt)).limit(1);
  if (decision?.changes) {
    standing.set("design", { text: "The client asked for changes", tone: "wait" });
    return { title: "Make the client's changes", line: "Open the chosen concept and use Request changes, then send the new version and record the client's answer.", who: job(members, ["pm"]), action: { label: "Open the concepts", href: `${href}#concepts` }, secondary: null };
  }
  standing.set("design", { text: "Concepts ready: waiting on the client's decision", tone: "wait" });
  return {
    title: "Get the client's decision on the concepts",
    line: "The team reviews the concepts, sends the client pack, then records which concept the client chose and any changes.",
    who: job(members, ["pm"]),
    action: { label: "Open the concepts", href: `${href}#concepts` },
    secondary: null,
  };
}

/* Lane 2: the client's design, then building and previewing it (both on the Design page). */
async function lane2Next(db: Database, id: string, laneOption: string | null, members: Member[], href: string, standing: Standing, at: StepKey): Promise<NextStep> {
  const [figma] = await db.select({ status: figmaDesign.importStatus, skipped: figmaDesign.reviewSkippedAt }).from(figmaDesign).where(eq(figmaDesign.projectId, id)).limit(1);
  if (figma?.status !== "done") {
    standing.set("design", { text: figma ? "Being read" : "No design yet", tone: "wait" });
    return figma && (figma.status === "queued" || figma.status === "running")
      ? { title: "TAWD is reading the design", line: "Each page of the design is read into its words, pictures and colours.", who: waiting("TAWD"), action: { label: "Open the Design section", href: `/projects/${id}/intake?section=figma` }, secondary: null }
      : { title: "Add the client's design", line: "Upload the design as a PDF or images, or link the Figma file, in the intake's Design section.", who: job(members, ["pm", "web_designer"]), action: { label: "Open the Design section", href: `/projects/${id}/intake?section=figma` }, secondary: null };
  }
  if (at === "design" && laneOption === "b") {
    const [review] = await db.select({ status: designReview.status }).from(designReview).where(eq(designReview.projectId, id)).orderBy(desc(designReview.createdAt)).limit(1);
    const running = review && (review.status === "queued" || review.status === "running");
    standing.set("design", { text: running ? "TAWD is reviewing the design" : "Review the design, or skip it", tone: "wait" });
    return running
      ? { title: "The Creative Director is reviewing the design", line: "The suggestions appear on Design when the review finishes.", who: waiting("TAWD"), action: { label: "Open Design", href: `${href}#review` }, secondary: null }
      : { title: "Review the design, or skip the review", line: "The Creative Director suggests changes to accept or reject; skipping costs nothing. Building opens after.", who: job(members, ["web_designer", "pm"]), action: { label: "Open the review", href: `${href}#review` }, secondary: null };
  }
  standing.set("design", { text: "Done", tone: "done" });
  const [built] = await db.select({ status: siteBuild.status }).from(siteBuild).where(and(eq(siteBuild.projectId, id))).orderBy(desc(siteBuild.version)).limit(1);
  if (!built || built.status === "failed") {
    standing.set("build", { text: built ? "The last build failed" : "Not built yet", tone: "wait" });
    return { title: built ? "The last build failed" : "Build the site, home page first", line: built ? "Open Design to see why; a retry reuses the answers already paid for." : "Check first costs nothing. Then build the home page, check it, and build the rest.", who: job(members, ["pm", "web_designer"]), action: { label: "Open Build site", href: `${href}#build` }, secondary: null };
  }
  if (built.status === "queued" || built.status === "working") {
    standing.set("build", { text: "TAWD is building the site", tone: "wait" });
    return { title: "The site is being built", line: "Each page is built from its design. It shows beside its design when done.", who: waiting("TAWD"), action: { label: "Watch the progress", href: `${href}#build` }, secondary: null };
  }
  return previewNext(db, id, members, `${href}#preview`, standing);
}

/* The preview and the client's approval (Lane 1 on Build, Lane 2 on Design). */
async function previewNext(db: Database, id: string, members: Member[], previewHref: string, standing: Standing): Promise<NextStep> {
  /*
    A WordPress project (8 October 2026): its preview is the WordPress one
    on the Hosting card, never the Netlify card (the bar used to send the
    team to the Netlify deploy).
  */
  const [hosting] = await db.select({ hosting: project.hosting }).from(project).where(eq(project.id, id)).limit(1);
  if (hosting?.hosting === "wordpress") {
    const wpHref = previewHref.includes("?part=") ? `${previewHref.split("?")[0]}?part=build#hosting-title` : previewHref;
    const [wp] = await db.select({ state: wpPreview.state, deployedVersion: wpPreview.deployedVersion }).from(wpPreview).where(eq(wpPreview.projectId, id)).limit(1);
    if (wp?.state !== "ready" || wp.deployedVersion == null) {
      standing.set("build", { text: wp?.state === "deploying" ? "Deploying the WordPress preview" : "Built: the WordPress preview isn't deployed", tone: "wait" });
      return { title: "Deploy the WordPress preview", line: "Put the built site on its own 20i preview (free, no AI), then send the link to the client.", who: job(members, ["pm"]), action: { label: "Open the WordPress preview", href: wpHref }, secondary: null };
    }
    standing.set("build", { text: "Preview sent: waiting on the client's approval", tone: "wait" });
    return { title: "Get the client's approval of the preview", line: "Send the WordPress preview link, then record what the client said: approved, or the changes they asked for.", who: job(members, ["pm"]), action: { label: "Record the client's decision", href: previewHref }, secondary: null };
  }
  const [deploy] = await db.select({ state: siteDeploy.state }).from(siteDeploy).where(and(eq(siteDeploy.projectId, id), eq(siteDeploy.kind, "preview"))).orderBy(desc(siteDeploy.createdAt)).limit(1);
  if (deploy?.state !== "ready") {
    standing.set("build", { text: deploy?.state === "uploading" ? "Deploying the preview" : "Built: the preview isn't deployed", tone: "wait" });
    return { title: "Deploy the preview", line: "Put the built site on its private preview link (free, no AI), then send the link to the client.", who: job(members, ["pm"]), action: { label: "Open the preview", href: previewHref }, secondary: null };
  }
  standing.set("build", { text: "Preview sent: waiting on the client's approval", tone: "wait" });
  return { title: "Get the client's approval of the preview", line: "Send the preview link, then record what the client said: approved, or the changes they asked for.", who: job(members, ["pm"]), action: { label: "Record the client's decision", href: previewHref }, secondary: null };
}

/* Lane 1, Content: the page plan, the drafts, the client's approval of the copy. */
async function contentNext(db: Database, id: string, members: Member[], href: string, standing: Standing): Promise<NextStep> {
  const drafts = await loadDraftsOverview(db as never, id);
  const total = drafts.rows.length;
  // Keep the current site: the plan makes itself from the current site's read (0.96.0); only reading, a failure or the one decision wait.
  await ensureKeptPlan(db, id);
  const kept = await keptHomeWords(db, id);
  if (kept && kept.state !== "ready") {
    standing.set("content", { text: kept.state === "reading" ? "Reading the current site" : kept.state === "failed" ? "The current site couldn't be read" : "The page plan needs a decision", tone: "wait" });
    return keptNext(kept, id, members);
  }
  if (!total && !drafts.nothingToApprove) {
    standing.set("content", { text: "No page plan yet", tone: "wait" });
    // One starting button (8 October 2026): where Prepare the content shows, the bar points to it.
    const type = await projectTypeFor(db as never, id);
    /*
      Only where Prepare the content is actually on the screen (a review, 17
      November 2026). With the home page supplied and no keyword research to
      decide on, that card is not rendered, and the bar pointed at an anchor
      that was not there.
    */
    /*
      Prepare the content ends with the Home page's draft, so it is the way
      in only where that draft happens. With the home page supplied there is
      no draft to run, and the card is not shown at all once the research is
      done or cannot be run, so the bar sends the team to the page plan's own
      step instead: it is on the same screen, and it is there for everyone
      (two reviews of #107 — the bar pointed at an anchor that was not on the
      page, and the card's own visibility depends on who is looking).
    */
    if (!drafts.suppliedHome && (type === null || type === "everything_new" || type === "client_words")) {
      return { title: "Prepare the content", line: "Keyword research (when wanted), the page plan and the Home page's draft, in that order, with the estimate first.", who: job(members, ["content", "seo", "pm"]), action: { label: "Prepare the content", href: `${href}#prepare` }, secondary: null };
    }
    if (drafts.suppliedHome) {
      return { title: "Make the page plan", line: "The site's pages, from the menu of the design the client approved. Keyword research, when it is wanted, runs from Prepare the content on the same screen. The home page keeps the supplied design's own words, so it is never drafted.", who: job(members, ["seo", "content", "pm"]), action: { label: "Make the page plan", href: `${href}#plan` }, secondary: null };
    }
    return { title: "Make the page plan", line: "The site's pages, each with its keyword, title and description. Look up keywords first for real search numbers.", who: job(members, ["seo", "content", "pm"]), action: { label: "Make the page plan", href: `${href}#plan` }, secondary: null };
  }
  if (drafts.drafting) {
    standing.set("content", { text: "TAWD is drafting pages", tone: "wait" });
    return { title: "The pages are being drafted", line: "Each draft appears in the table on Content when it is ready to review.", who: waiting("TAWD"), action: { label: "Open Content", href: `${href}#drafts` }, secondary: null };
  }
  /*
    The plan does not have the design's menu items (the browser walk of
    #107, on live TAWD). The Page plan card said so, but the bar went on
    saying "Draft 4 pages" and the drafting is paid: the team would have
    been sent to buy drafts of the pages the approved design does not have,
    with the sentence that says otherwise folded inside a step marked Done.
    Checked before the drafting steps and after the drafting one, so a run
    already going is never interrupted, and the plan is never remade here:
    that replaces every page and takes the drafts with them, so it is the
    team's decision and their button.
  */
  const missingMenu = await missingMenuItems(db as never, id);
  if (missingMenu.length > 0) {
    standing.set("content", { text: "The page plan doesn't follow the approved design", tone: "wait" });
    return {
      title: "The page plan doesn't follow the approved design",
      line: `The design the client approved has ${plural(missingMenu.length, "menu item")} this plan has no page for: ${missingMenu.join(", ")}. Drafting now writes the pages in the plan, not these. Making the plan again follows the design's menu, and replaces every page in the plan.`,
      who: job(members, ["seo", "content", "pm"]),
      action: { label: "Open the page plan", href: `${href}#plan` },
      secondary: null,
    };
  }
  if (drafts.undrafted) {
    standing.set("content", { text: `${drafts.approved} of ${plural(total, "page")} approved; ${drafts.undrafted} not drafted`, tone: "wait" });
    return { title: `Draft ${plural(drafts.undrafted, "page")}`, line: "Drafts are written from the page plan and the intake's facts. The estimate shows first.", who: job(members, ["content", "seo", "pm"]), action: { label: "Draft the pages", href: `${href}#drafts` }, secondary: null };
  }
  const toReview = total - drafts.approved;
  if (toReview) {
    standing.set("content", { text: `${drafts.approved} of ${plural(total, "page")} approved`, tone: "wait" });
    return { title: `Approve ${plural(toReview, "page draft")}`, line: "Read each page, comment or edit, then approve it.", who: job(members, ["content"]), action: { label: "Review the drafts", href: `${href}#drafts` }, secondary: null };
  }
  if (!drafts.nothingToApprove && drafts.decision?.outcome !== "approved") {
    standing.set("content", { text: "Every page approved: waiting on the client", tone: "wait" });
    return { title: "Get the client's approval of the copy", line: "Download the copy pack, send it, and record what the client said.", who: job(members, ["pm"]), action: { label: "Open the copy pack", href: `${href}#copy-pack` }, secondary: null };
  }
  standing.set("content", { text: drafts.nothingToApprove ? "No copy to approve" : "The client approved the copy", tone: "done" });
  return { title: "Move to Build & preview", line: `${drafts.nothingToApprove ? "The only page is the homepage the client approved, so there is no copy to approve." : "The client approved the copy."} Move the project on from the bar at the bottom of Content.`, who: job(members, ["pm"]), action: { label: "Open Content", href: `${href}#copy-pack` }, secondary: null };
}

/* Lane 1, Build & preview: the build, the SEO check, the preview, the client's approval. */
async function buildNext(db: Database, id: string, members: Member[], href: string, standing: Standing): Promise<NextStep> {
  // Design only (0.100.0) comes here straight from Design: until the plan has made itself from the current site, that's the next thing.
  await ensureKeptPlan(db, id);
  const kept = await keptHomeWords(db, id);
  if (kept && kept.state !== "ready") {
    standing.set("build", { text: kept.state === "reading" ? "Reading the current site" : kept.state === "failed" ? "The current site couldn't be read" : "The page plan needs a decision", tone: "wait" });
    return keptNext(kept, id, members);
  }
  const [build] = await db.select({ status: siteBuild.status }).from(siteBuild).where(eq(siteBuild.projectId, id)).orderBy(desc(siteBuild.version)).limit(1);
  if (build && (build.status === "queued" || build.status === "working")) {
    standing.set("build", { text: "TAWD is building the site", tone: "wait" });
    return { title: "The site is being built", line: "Every page is built from the approved design and copy.", who: waiting("TAWD"), action: { label: "Open Build", href: `${href}?part=build#site` }, secondary: null };
  }
  const checklist = await goLiveChecklist(db, id);
  if (checklist.version === null) {
    standing.set("build", { text: build?.status === "failed" ? "The last build failed" : "Not built yet", tone: "wait" });
    return { title: build?.status === "failed" ? "The last build failed" : "Build the home page first", line: "The site is built in stages from the approved design and copy: the home page first (with the header and footer), then the rest. The estimate shows first.", who: job(members, ["pm"]), action: { label: "Open Build", href: `${href}?part=build#site` }, secondary: null };
  }
  // Staged builds (6 October 2026): the rest of the planned pages before the SEO check.
  const unbuilt = checklist.items.find((i) => i.key === "all-pages-built" && !i.ok);
  if (unbuilt) {
    standing.set("build", { text: unbuilt.detail.split(";")[0]!, tone: "wait" });
    return { title: "Build the next stage of the site", line: `${unbuilt.detail.replace(/ \(Build\)$/, "")}. Check each new page, then build the next.`, who: job(members, ["pm"]), action: { label: "Open Build", href: `${href}?part=build#site` }, secondary: null };
  }
  const seo = await loadSeoGoLive(db, id);
  if (!seo.signedOff) {
    standing.set("build", { text: "Built: the SEO check isn't signed off", tone: "wait" });
    return { title: "Run the SEO check and sign off", line: "The Senior SEO check makes the safe fixes and lists the rest; the SEO team signs off this version.", who: job(members, ["seo"]), action: { label: "Open the SEO check", href: `${href}?part=check#seo-check` }, secondary: null };
  }
  return previewNext(db, id, members, `${href}?part=preview#preview`, standing);
}

type GoLiveRow = typeof goLive.$inferSelect;
type GoLiveStep = { title: string; who: TeamRole[]; done: boolean };

/*
  The go-live steps for the way this site goes live, as the gate counts them
  (13 October 2026, the whole-code review: the card listed Cloudflare's steps
  only, so on the default two-records path and on WordPress "Go live" never
  reached the founders). WordPress: the preview on the latest build and the
  domain on 20i, then two records or VML's DNS. Netlify: two records and the
  domain on the Netlify site, or VML's DNS (Cloudflare). HTTPS last.
*/
export function goLiveSteps(row: GoLiveRow | undefined, route: { wordpress: boolean; path: string | null; wp?: { previewCurrent: boolean; onHost: boolean } }): GoLiveStep[] {
  const at = (key: keyof GoLiveRow) => Boolean(row?.[key]);
  const records = route.path === "records" || route.path === "access";
  const viaCloudflare: GoLiveStep[] = [
    { title: "Read the client's email records", who: ["pm"], done: at("emailReadAt") || at("emailVerifiedAt") },
    { title: "Set up Cloudflare", who: ["pm"], done: at("cloudflareReadyAt") || at("emailVerifiedAt") },
    { title: "Check the email records on Cloudflare", who: ["pm"], done: at("emailVerifiedAt") },
    { title: "Confirm with the client's email provider", who: ["pm"], done: at("emailConfirmedAt") },
  ];
  const switchNameservers: GoLiveStep = { title: "Switch the nameservers at the registrar", who: ["pm"], done: at("nameserversSwitchedAt") };
  const twoRecords: GoLiveStep = { title: "Connect the domain (the two records)", who: ["pm"], done: at("recordsOkAt") };
  const middle: GoLiveStep[] = route.wordpress
    ? [
        { title: "Deploy the WordPress preview on the latest build", who: ["pm"], done: route.wp?.previewCurrent ?? false },
        { title: "Put the domain on 20i", who: ["pm"], done: route.wp?.onHost ?? false },
        ...(route.path === "vml_dns" ? [...viaCloudflare, switchNameservers] : [twoRecords]),
      ]
    : records
      ? [twoRecords, { title: "Put the domain on the Netlify site", who: ["pm"], done: at("netlifyDomainAt") }]
      : [...viaCloudflare, { title: "Put the domain on the Netlify site", who: ["pm"], done: at("netlifyDomainAt") }, switchNameservers];
  return [
    { title: "Confirm the domain is in the client's name", who: ["pm"], done: at("domainConfirmedAt") },
    ...middle,
    { title: "Confirm HTTPS", who: ["pm"], done: at("httpsConfirmedAt") },
  ];
}

/* Go live: the build fee, the go-live steps in order, then the founders' Go live. */
async function goLiveNext(db: Database, id: string, members: Member[], href: string, standing: Standing): Promise<NextStep> {
  const [fee] = await db.select({ id: buildFeePayment.id }).from(buildFeePayment).where(and(eq(buildFeePayment.projectId, id), isNull(buildFeePayment.removedAt))).limit(1);
  const [row] = await db.select().from(goLive).where(eq(goLive.projectId, id)).limit(1);
  const [proj] = await db.select({ hosting: project.hosting }).from(project).where(eq(project.id, id)).limit(1);
  const wordpress = proj?.hosting === "wordpress";
  const wpLive = wordpress ? await (await import("@/lib/wp-golive")).loadWpLive(db, id) : null;
  const steps = goLiveSteps(row, { wordpress, path: row?.connectPath ?? null, wp: wpLive ? { previewCurrent: wpLive.previewCurrent, onHost: wpLive.onHost } : undefined });
  const left = steps.filter((s) => !s.done);
  const done = steps.length - left.length + (fee ? 1 : 0);
  const count = `${done} of ${steps.length + 1} go-live steps done`;
  if (!fee) {
    standing.set("golive", { text: `${count}: the build fee isn't recorded`, tone: "wait" });
    const step = left[0];
    return {
      title: "Record the build fee",
      line: step ? `Go-live can't finish until the $199 build fee is recorded as paid. Meanwhile the PM can start: ${step.title.toLowerCase()}.` : "Every other go-live step is done; the build fee is the last one.",
      who: waiting("an admin or a founder, to record the build fee", true),
      action: { label: "Open the go-live steps", href: `${href}#go-live` },
      secondary: null,
    };
  }
  const step = left[0];
  if (step) {
    standing.set("golive", { text: count, tone: "wait" });
    return { title: step.title, line: `Next of the go-live steps (${count}). Each is logged and posted to Slack.`, who: job(members, step.who), action: { label: "Open the go-live steps", href: `${href}#go-live` }, secondary: null };
  }
  standing.set("golive", { text: "Every step done: ready for Go live", tone: "wait" });
  return { title: "Go live", line: "Every go-live step is done. A founder or an admin checks the last list and presses Go live.", who: job(members, ["founder"]).people.length ? job(members, ["founder"]) : waiting("a founder or an admin", true), action: { label: "Open Go live", href: `${href}#go-live` }, secondary: null };
}


/*
  The next-step bar on each stage page (30 September 2026): the same Next
  step as the project page, loaded from the project id alone. The intake's
  missing answers are only read while the project is at Intake.
*/
export async function loadNextStepFor(db: Database, viewer: Viewer, projectId: string): Promise<NextStep | null> {
  const found = await getProject(db, viewer, projectId);
  if (!found) return null;
  const intake = found.status === "intake" ? await loadIntake(db, viewer, projectId) : null;
  const facts = await loadJourneyFacts(db, projectId, intake?.completeness.isComplete ?? false);
  if (!facts) return null;
  const view = await loadProjectNext(db, {
    projectId,
    facts,
    laneOption: found.laneOption,
    members: found.members,
    missing: intake?.completeness.missing.map((m) => m.label) ?? [],
  });
  return view.next;
}

/* Updates (1 October 2026): a quote waiting on the client, open requests, or the month's hours. */
async function updatesNext(db: Database, id: string, members: Member[], standing: Standing): Promise<NextStep> {
  const href = `/projects/${id}/updates`;
  const [live] = await db.select({ at: goLive.wentLiveAt }).from(goLive).where(eq(goLive.projectId, id)).limit(1);
  const since = live?.at ? ` Live since ${dayLabel(live.at)}.` : "";
  const quotes = await db.select({ id: updateQuote.id }).from(updateQuote).where(and(eq(updateQuote.projectId, id), eq(updateQuote.status, "waiting")));
  const plan = await monthPlan(db, id);
  standing.set("updates", { text: plan.line.replace(/^[A-Za-z]+: /, ""), tone: "wait" });
  if (quotes.length) {
    return { title: `Get the client's answer on ${plural(quotes.length, "quote")}`, line: `Send the quote, then record whether the client approved it. The work waits until they do.${since}`, who: job(members, ["pm"]), action: { label: "Open the quotes", href: `${href}#quotes` }, secondary: null };
  }
  const open = await db.select({ id: editRequest.id }).from(editRequest).where(and(eq(editRequest.projectId, id), inArray(editRequest.status, ["open", "failed", "edited"])));
  if (open.length) {
    return { title: `Make ${plural(open.length, "update")}`, line: `The client's requests that fit the included hours. Make each one, log the time, then put it into the site.${since}`, who: job(members, ["pm"]), action: { label: "Open the requests", href: `${href}#requests` }, secondary: null };
  }
  return { title: `Updates: ${plan.line.replace(/^[A-Za-z]+: /, "")} this month`, line: `Log each request from the client with its category and an hours estimate.${since}`, who: job(members, ["pm"]), action: { label: "Open Updates", href }, secondary: null };
}
