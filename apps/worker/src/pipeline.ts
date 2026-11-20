import { dropHollowReviews, unifyCallButtons, unifyFormButtons } from "@tawd/core/site";
import { examplesFor, seedSectionLibrary } from "@tawd/core/section-library";
import { BEFORE_AFTER } from "@tawd/core/content";
import { and, asc, desc, eq, inArray, lt, or, sql } from "drizzle-orm";
import type { Browser } from "playwright-core";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { imageBlock } from "./image-type";
import { stepModel } from "./step-model";
import { isReplaying } from "./replay";
import { designColors, designTextsBySection } from "@tawd/core/figma";
import type { ImportedFrame } from "@tawd/core/figma/service";
import {
  aiCall,
  concept,
  conceptStep,
  conceptVersion,
  designLogEntry,
  figmaDesign,
  intakeFile,
  likedSiteShot,
  photoTextCheck,
  mockupRun,
  project,
  homeWords,
  siteImport,
  wireframe,
  type AiCallStep,
} from "@tawd/core/schema";
import { homeOfRow } from "@tawd/core/site-read";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { loadIntake } from "@tawd/core/intake/service";
import { loadIntakeForBuilding, type IntakeForBuilding } from "@tawd/core/intake/unconfirmed";
import { hasCurrentWebsite, isLicensedTrade, likedNoteFor, projectTypeOf } from "@tawd/core/intake";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { postProjectSlack } from "@tawd/core/slack";
import { getStorage, projectStoragePrefix } from "@tawd/core/intake/storage";
import {
  type DesignerDesign,
  DESIGNER_CONCEPT,
  directionInfo,
  buildConceptPromptParts,
  CACHE_1H,
  stableSystem,
  buildDesignerSystemPrompt,
  buildSharedSystemPrompt,
  buildSkillSystemPrompt,
  MAX_FIX_ROUNDS,
  describeChecks,
  embedAssets,
  fillFramesWithClientPhotos,
  confirmablePlaceholderKeys,
  featuresTheIntakeAllows,
  findSiteFeatures,
  type SiteFeature,
  type SiteSectionLike,
  FABLE_MODEL,
  FABLE_RETENTION_HINT,
  MOBILE_TAP_TARGET_CSS,
  buildLocatePrompt,
  buildSectionEditPrompt,
  buildSectionFixPrompt,
  outlineBands,
  parseLocateReply,
  STYLES_PART,
  styleSection,
  describeFactsForPrompt,
  applyElementFindings,
  existingFixRules,
  isPositionRule,
  keepLiveRules,
  numberElements,
  ruleTarget,
  parseSectionReplies,
  replaceSections,
  sectionsForIssue,
  splitSections,
  extractHtml,
  fixTitleAndDescription,
  isFixable,
  replaceFixStyle,
  intakePhones,
  listIntakeFacts,
  paletteFamily,
  requiredFieldsStillMissing,
  runHtmlChecks,
  confirmedFactsFrom,
  removeStrayPlaceholders,
  fixPictures,
  fillIcons,
  spreadRepeatedPhotos,
  stampStockPicks,
  mergeRunNotes,
  markBrandBands,
  brandBandRule,
  type CheckFacts,
  type CheckIssue,
  type DirectionId,
  type IntakeFact,
  type RunNote,
  type NeedsIntakeField,
  type SkillId,
  type StoredReview,
  type ReferenceBrief,
  type ReferenceForBuild,
  type ReferenceOutline,
  type PhotoTextFinding,
  photoTextNotes,
  photoToken,
  photoKind,
  type HomeWords,
  type WireframeSection,
  wireframeApplies,
  sitePhotoAlts,
  SETTLED_STEPS,
} from "@tawd/core/mockups";
import { keptHomeWords } from "@tawd/core/kept-home-words";
import { applyPhotoAlt, formatPhonesInHtml } from "@tawd/core/site";

import { MAX_PHOTOS, prepareAssets, type AssetFile, type PreparedAsset } from "./assets";
import { currentSitePhotos, siteAddress, pagePhotoKey, MAX_PAGE_PHOTO_PAGES, PAGE_PHOTO_KINDS } from "./site-photos";
import type { ImportedPageSummary } from "@tawd/core/site";
import { StockPictures, stockClientFromEnv } from "./stock";
import { loadDesignSource } from "./design-source";
import { complete, PaidCallError, type CompleteResult, type RawTurn, type Usage } from "./claude";
import type { WorkerConfig } from "./config";
import { renderConcept, runRenderedChecks } from "./render";
import { computeRenderedFixes } from "./rendered-fixes";
import { readProfile, readSkillDefinition } from "./skills";

/*
  Building one concept, and the pieces the Creative Director reuses.

  A concept job builds the page, checks it, and runs up to MAX_FIX_ROUNDS
  rounds of fixes, each re-checked. Once every concept in the run is built,
  one review job looks at them all side by side (review.ts) and uses the
  same pieces here to improve, re-check and, at most once, rebuild.

  Every model call is written to the ai_call ledger the moment it returns,
  with its step. That ledger is what the Spend page reads.

  One job at a time, always. The queue enforces that, and it is the main
  reason a 4 GB droplet shared with a client-facing app survives this.
*/

export interface ConceptJob {
  runId: string;
  conceptId: string;
  projectId: string;
  label: string;
  direction: DirectionId;
  skillId: SkillId;
}

export type Db = ReturnType<typeof getDb>;
export type Storage = ReturnType<typeof getStorage>;

export async function setStep(
  db: Db,
  conceptId: string,
  step: string,
  status: string,
  detail?: string,
): Promise<void> {
  const now = new Date();
  await db
    .update(conceptStep)
    .set({
      status,
      detail: detail ?? null,
      ...(status === "working" ? { startedAt: now } : {}),
      ...((SETTLED_STEPS as readonly string[]).includes(status) ? { finishedAt: now } : {}),
    })
    .where(
      and(eq(conceptStep.conceptId, conceptId), eq(conceptStep.step, step)),
    );
}

/* ---------- what every call about a project needs ---------- */

export interface ProjectContext {
  projectId: string;
  runId: string;
  startedByUserId: string | null;
  clientName: string;
  trade: string;
  tier: string;
  /** Read through loadIntakeForBuilding: a claim from the old site that nobody has confirmed is not in it (B3). */
  intake: IntakeForBuilding;
  assets: PreparedAsset[];
  intakeFacts: IntakeFact[];
  facts: CheckFacts;
  profileText: string;
  /** Lane 2, Option B concepts: the designer's brand and words, for an alternative to the design (4c-2b). */
  designerDesign: DesignerDesign | null;
  /** Lane 1 (1 October 2026): the home page's words the team approved before Generate. */
  homeWords: HomeWords | null;
  /** The approved wireframe's sections when the project uses one (3 October 2026). */
  wireframe: WireframeSection[] | null;
  /** "Websites they like": their first screens, for the build as inspiration only (never to copy). */
  likedSites: { url: string; image: Buffer }[];
  /** The reference sites' outlines and briefs (27 September 2026): structure and craft to follow, never identity. */
  references: ReferenceForBuild[];
  /** Photos whose visible text contradicts the intake, for the builder (the latest photo text check). */
  photoTextNotes: string;
  /** Shutterstock previews for the placeholder frames, looked up once per project; none without the keys. */
  stock?: StockPictures | null;
  /** The client's current website's home sections and features (5 November 2026); null without a read. */
  currentSite?: { features: SiteFeature[]; sections: SiteSectionLike[] } | null;
}

export async function loadProjectContext(
  db: Db,
  storage: Storage,
  browser: Browser,
  config: WorkerConfig,
  /* conceptId, when one concept is being worked on: F28, so its first pick of a shared phrase differs from a sibling's. */
  input: { projectId: string; runId: string; conceptId?: string | null },
): Promise<ProjectContext> {
  const [projectRow] = await db
    .select()
    .from(project)
    .where(eq(project.id, input.projectId))
    .limit(1);
  if (!projectRow) throw new Error("That project no longer exists.");

  const [run] = await db
    .select({ startedByUserId: mockupRun.startedByUserId })
    .from(mockupRun)
    .where(eq(mockupRun.id, input.runId))
    .limit(1);

  // B3: an unconfirmed warranty, offer or financing from the old site is neither stated nor counted as backing a claim.
  const intake = await loadIntakeForBuilding(db, SYSTEM_ACTOR, input.projectId);
  if (!intake) throw new Error("That project has no intake.");

  // loadIntake's file list leaves out the storage key, so read it here.
  const fileRows = await db
    .select()
    .from(intakeFile)
    .where(
      and(
        eq(intakeFile.projectId, input.projectId),
        eq(intakeFile.status, "ready"),
        inArray(intakeFile.kind, ["logo", "photo"]),
      ),
    )
    .orderBy(asc(intakeFile.createdAt))
    // Health and beauty rules: a before-and-after photo is used only with the client's recorded permission.
    .then((rows) => (intake.data.photos.beforeAfterPermission ? rows : rows.filter((row) => !BEFORE_AFTER.test(`${row.caption ?? ""} ${row.fileName}`))));

  /*
    The client's photos from their current website (Jason, 4 November 2026:
    no empty cards), after the team's uploads: a real concept run of a Lane 1
    project with a current website. Before-and-after photos follow the same
    permission rule as uploads.
  */
  /*
    Gap 10 (5 November 2026): Build A and every other job get them too, but
    only the ones already saved for the concepts (never a fresh read), and
    all of them, so a photo the approved concept shows is always in the
    built site (it used to come out blank or broken: no makeover could ship).
  */
  const siteUrl = projectRow.lane !== "lane_2" && hasCurrentWebsite(intake.data.website) ? siteAddress(intake.data.website.currentWebsiteUrl) : null;
  // Twelve photos in all for a concept, the uploads first (each photo is inlined into the page: memory on a 4 GB server).
  const uploadedPhotos = fileRows.filter((row) => row.kind === "photo").length;
  const sitePhotos = siteUrl
    ? (await currentSitePhotos(storage, { projectId: input.projectId, url: siteUrl, browser, storedOnly: !run }))
        .filter((photo) => intake.data.photos.beforeAfterPermission || !BEFORE_AFTER.test(photo.caption ?? ""))
        .slice(0, run ? Math.max(0, MAX_PHOTOS - uploadedPhotos) : undefined)
    : [];

  /*
    Crawl-% (7 November 2026): on a real concept run (the site is reachable
    then; the connect-only-to-checked-address rule means we never re-fetch at
    build), also capture the main service/area/about pages' own photos — the
    same secure navigation + framing + HEIC pipeline as the home's, under
    per-page tokens. The build matches each new page to its closest old page
    and loads these; the home's photos stay the fallback. Capped tight so a
    large site can't balloon the run; best-effort (a page failing is skipped).
  */
  if (run && siteUrl) {
    const [imported] = await db.select({ pages: siteImport.pages }).from(siteImport).where(eq(siteImport.projectId, input.projectId)).limit(1);
    const mainPages = ((imported?.pages as ImportedPageSummary[] | null) ?? [])
      .filter((p) => p.url && p.path !== "/" && PAGE_PHOTO_KINDS.has(p.kind) && !p.gap)
      .slice(0, MAX_PAGE_PHOTO_PAGES);
    for (const p of mainPages) {
      try {
        await currentSitePhotos(storage, { projectId: input.projectId, url: p.url, browser, pageKey: pagePhotoKey(p.path) });
      } catch (error) {
        console.warn(`[page photos] couldn't capture ${p.path} (${error instanceof Error ? error.message : "unknown"}); skipped.`);
      }
    }
  }

  const uploaded = await prepareAssets(
    browser,
    storage,
    [
      ...fileRows.map(
        (row): AssetFile => ({
          kind: row.kind as AssetFile["kind"],
          fileName: row.fileName,
          contentType: row.contentType,
          caption: row.caption,
          storageKey: row.storageKey,
        }),
      ),
      ...sitePhotos,
    ],
  );

  /*
    Lane 2, Option B: concepts are alternatives to the designer's design, so
    they get its logo, photos, colours, fonts and words too. Only for a real
    concept run (the design's own jobs pass their own id, which is no run).
  */
  let assets = uploaded;
  let designerDesign: DesignerDesign | null = null;
  if (run && projectRow.lane === "lane_2" && projectRow.laneOption === "b") {
    const [figma] = await db.select().from(figmaDesign).where(eq(figmaDesign.projectId, input.projectId)).limit(1);
    const home = ((figma?.frames as ImportedFrame[] | null) ?? []).find((f) => f.isHome);
    if (figma?.importStatus === "done" && home) {
      const design = await loadDesignSource(db, storage, browser, { projectId: input.projectId, frameId: home.id, frameName: home.name, purpose: "build alternatives" });
      assets = [
        ...uploaded,
        ...design.assets.map((a) => ({
          ...a,
          caption: a.token === "tawd-asset:design-logo" ? "the designer's logo" : a.token.includes("icon") ? `a drawing from the design (${a.caption ?? "icon"})` : "a photo from the designer's design",
        })),
      ];
      designerDesign = {
        colors: designColors(design.home),
        fonts: design.readiness.fonts.map((f) => ({ family: f.family, usable: f.usable })),
        sections: designTextsBySection(design.home).map((s) => ({ name: s.name, texts: s.texts })),
      };
    }
  }

  // "Websites they like", photographed at intake: only a real concept run shows them to the builder.
  const likedSites: { url: string; image: Buffer }[] = [];
  const references: ReferenceForBuild[] = [];
  if (run) {
    // The study of each site runs on another queue: wait for it, so the builder gets the brief it paid for.
    await waitForReferenceStudies(db, input.projectId);
    const shots = await db
      .select()
      .from(likedSiteShot)
      .where(and(eq(likedSiteShot.projectId, input.projectId), eq(likedSiteShot.status, "done")));
    for (const shot of shots) {
      const image = shot.imageKey ? await storage.get(shot.imageKey) : null;
      if (image) likedSites.push({ url: shot.url, image });
      references.push({
        url: shot.url,
        liked: likedNoteFor(intake.data.website, shot.url),
        outline: (shot.outline as ReferenceOutline | null) ?? null,
        brief: shot.briefStatus === "done" ? ((shot.brief as ReferenceBrief | null) ?? null) : null,
      });
    }
  }

  // The latest photo text check: which photos show text that contradicts the intake.
  const [textCheck] = await db
    .select()
    .from(photoTextCheck)
    .where(and(eq(photoTextCheck.projectId, input.projectId), eq(photoTextCheck.status, "done")))
    .orderBy(desc(photoTextCheck.createdAt))
    .limit(1);
  const photoTokens = Object.fromEntries(
    fileRows.filter((row) => row.kind === "photo").slice(0, MAX_PHOTOS).map((row, index) => [row.id, photoToken(index)]),
  );
  const photoTextNotesText = textCheck ? photoTextNotes((textCheck.findings as PhotoTextFinding[] | null) ?? [], photoTokens) : "";

  /*
    The brand comes from the client (27 September 2026): with no colours in
    the intake, the logo's own main colours are the palette, never a guess.
  */
  const logoColors = uploaded.find((a) => a.kind === "logo")?.palette ?? [];
  if (intake.data.brand.colors.length === 0 && logoColors.length > 0) {
    intake.data.brand = { ...intake.data.brand, colors: logoColors.slice(0, 3), colorsFromLogo: true };
  }

  const intakeFacts = [
    ...listIntakeFacts(intake.data, intake.files, { trade: projectRow.trade }),
    // What the old site says that nobody has confirmed: named, so the model knows not to state it (B3). A missing detail fact, so it is left out with no placeholder.
    ...intake.unconfirmed.map((c) => ({ key: `unconfirmed.${c.key}`, label: `${c.label} (the client's current website says "${c.value}", but nobody has confirmed it: do not state it)`, value: null, tier: "detail" as const })),
  ];
  const stockClient = stockClientFromEnv();
  // The approved-section library starts from past client picks, the first time it is needed (8 October 2026).
  await seedSectionLibrary(db, storage).catch((error) => console.warn("[section library] seeding failed:", error instanceof Error ? error.message : error));

  const words = run && projectRow.lane !== "lane_2" ? await approvedWordsFor(db, input.projectId) : null;
  /*
    The confirmed facts the checks hold every page to: the intake without any
    unconfirmed old-site claim (B3), plus the approved home words, which are
    the client's own (review H2). An unconfirmed testimonial is not.
  */
  const confirmed = confirmedFactsFrom(intake.data, {
    unconfirmed: intake.unconfirmed.map((c) => ({ key: c.key, value: c.value })),
    keptWords: words ? [...words.sections.map((s) => s.words), ...words.testimonials.filter((t) => t.confirmed).map((t) => t.text)].join(" . ") : undefined,
  });
  // What the client's current website has (5 November 2026): every concept keeps it, or says why not.
  const inventory = run && projectRow.lane !== "lane_2" && !designerDesign ? await currentSiteInventory(db, storage, input.projectId) : null;
  const b = intake.data.business;
  const currentSite = inventory
    ? {
        ...inventory,
        features: featuresTheIntakeAllows(inventory.features, {
          licenseInProgress: b.licenseInProgress,
          licensedTrade: isLicensedTrade(projectRow.trade),
          noGoogleBusinessProfile: b.noGoogleBusinessProfile,
          googleBusinessProfileUrl: b.googleBusinessProfileUrl,
          licenseNumbers: b.licenseNumbers,
        }),
      }
    : null;
  const confirmable = [
    ...confirmablePlaceholderKeys(currentSite?.features ?? []),
    // A testimonial copied from the old site shows as a placeholder until the client confirms it (not for a business with no Google profile).
    ...(words?.testimonials.some((t) => !t.confirmed) && !(b.noGoogleBusinessProfile && !b.googleBusinessProfileUrl) ? ["page.reviews"] : []),
  ];

  return {
    projectId: input.projectId,
    runId: input.runId,
    startedByUserId: run?.startedByUserId ?? null,
    clientName: projectRow.clientName,
    trade: projectRow.trade,
    tier: projectRow.tier,
    intake,
    assets,
    intakeFacts,
    facts: {
      serviceNames: intake.data.services.items.map((s) => s.name).filter(Boolean),
      phones: intakePhones(intake.data),
      licenseNumbers: intake.data.business.licenseNumbers,
      yearFounded: intake.data.business.yearFounded,
      businessName: intake.data.business.name,
      cities: intake.data.serviceAreas.cities,
      intakeFacts,
      assets,
      // Offer facts (gap 12), so a warranty, free offer or financing on the page is checked against what the intake gave; the client's own words come with them (confirmed-facts.ts).
      claims: confirmed.claims,
      // B1: the wider fact check (call buttons, prices, years, addresses, towns, names, ratings).
      confirmed,
      // TAWD's own concepts follow the picture rules; a copy of the designer's design keeps its own pictures.
      ...(designerDesign ? {} : { pictures: { stockAvailable: stockClient !== null, brandColors: intake.data.brand.colors, trade: projectRow.trade } }),
      ...(currentSite?.features.length ? { siteFeatures: currentSite.features } : {}),
      ...(confirmable.length ? { confirmablePlaceholders: [...new Set(confirmable)] } : {}),
    },
    currentSite,
    profileText: await readProfile(config.skillsDir),
    designerDesign,
    homeWords: words,
    wireframe: run ? await approvedWireframeFor(db, { id: input.projectId, lane: projectRow.lane, tier: projectRow.tier }) : null,
    likedSites,
    references,
    photoTextNotes: photoTextNotesText,
    stock: new StockPictures(
      db,
      storage,
      input.projectId,
      stockClient,
      {
        colors: intake.data.brand.colors,
        competitors: intake.data.brand.competitorsToAvoid,
        trade: projectRow.trade.replace(/_/g, " "),
      },
      input.conceptId ?? null,
    ),
  };
}

/* ---------- one concept's prompts ---------- */

export interface ConceptContext {
  project: ProjectContext;
  conceptId: string;
  label: string;
  direction: DirectionId;
  skillId: SkillId;
  system: Anthropic.TextBlockParam[];
  userPrompt: string;
  /** The first user turn as blocks: the project's part (cached), anything extra (pictures), then this concept's skill and brief. */
  opening: (extra?: Anthropic.ContentBlockParam[]) => Anthropic.ContentBlockParam[];
}

export async function conceptContext(
  project: ProjectContext,
  config: WorkerConfig,
  input: {
    conceptId: string;
    label: string;
    direction: DirectionId;
    skillId: SkillId;
  },
): Promise<ConceptContext> {
  // Concept 1 on an Option B project is the designer's design: no skill, the designer's rules instead.
  const designer = (input.skillId as string) === DESIGNER_CONCEPT;
  const skillText = designer ? "" : await readSkillDefinition(config.skillsDir, input.skillId);

  /*
    What repeats goes first (prompt caching, 26 September 2026): the shared
    rules (the same for every concept in every project, cached for an hour),
    then the project's part of the brief (the same for every concept in this
    run and every fix round, cached for an hour), then what is this
    concept's own: its skill and its direction. The end of the conversation
    is marked on every turn as well (claude.ts).
  */
  const system = stableSystem(buildSharedSystemPrompt(project.profileText)) as Anthropic.TextBlockParam[];
  const skillPrompt = designer ? buildDesignerSystemPrompt() : buildSkillSystemPrompt(input.skillId, skillText);

  const parts = buildConceptPromptParts({
    brief: {
      skillId: input.skillId,
      direction: input.direction,
      conceptLabel: input.label,
    },
    project: {
      clientName: project.clientName,
      trade: project.trade,
      tier: project.tier,
    },
    intake: project.intake.data,
    // The prompt gets the tokens and descriptions, never the image bytes.
    assets: project.assets.map((asset) => ({
      token: asset.token,
      kind: asset.kind,
      caption: asset.caption,
      fileName: asset.fileName,
      width: asset.width,
      height: asset.height,
      tone: asset.tone ?? null,
    })),
    facts: project.intakeFacts,
    designerDesign: project.designerDesign,
    homeWords: project.homeWords,
    wireframe: project.wireframe,
    likedSites: project.likedSites.map((s) => s.url),
    references: project.references,
    stockAvailable: Boolean(project.stock?.available),
    photoTextNotes: project.photoTextNotes,
    currentSite: project.currentSite ?? null,
    // Approved sections from earlier client picks (8 October 2026); none for the designer's own concept.
    // Never in the way: no database (a test) or a failed read means no examples.
    examples: designer ? [] : await (async () => examplesFor(getDb(), input.direction))().catch(() => []),
  });

  const opening = (extra: Anthropic.ContentBlockParam[] = []): Anthropic.ContentBlockParam[] => [
    { type: "text", text: parts.project, cache_control: CACHE_1H },
    ...extra,
    { type: "text", text: `${skillPrompt}\n\n${parts.concept}` },
  ];
  const userPrompt = `${parts.project}\n\n${skillPrompt}\n\n${parts.concept}`;

  return { project, ...input, system, userPrompt, opening };
}

/* ---------- the ledger ---------- */

/* "page": the whole page sent and rewritten; "sections": only the parts involved; "locate": finding those parts. */
export type CallScope = "page" | "sections" | "locate" | "slice" | "band_list" | "band";

/** Where a call's full answer is kept: in the project's folder in R2. */
export function aiResponseKey(projectId: string, callId: string): string {
  return `${projectStoragePrefix(projectId)}ai-responses/${callId}.json`;
}

/* What is saved for every call: the model's answers, untouched, and what they were about. */
export interface SavedResponse {
  callId: string;
  step: AiCallStep;
  round: number | null;
  conceptId: string | null;
  /** The version a review call scored, so a saved review is only ever applied to it. */
  versionId: string | null;
  label: string | null;
  model: string;
  savedAt: string;
  turns: RawTurn[];
  /** The question's fingerprint, so a retry reuses the answer only for the same question (design builds). */
  requestHash?: string | null;
}

/*
  Writes the call to the ledger, and first saves the model's full answer
  to R2. Saving never stops the work: if R2 fails, the row is written
  without a key, the reason is logged, and the answer is still in hand.
*/
export async function recordCall(
  db: Db,
  input: {
    projectId: string;
    runId: string;
    conceptId: string | null;
    startedByUserId: string | null;
    model: string;
    step: AiCallStep;
    round?: number | null;
    usage: Usage;
    /** The answers this call was paid for. */
    turns?: RawTurn[];
    /** For a review call: the version it scored and the concept's letter. */
    versionId?: string | null;
    label?: string | null;
    /** How much of the page the call worked on (see ai_call.scope). */
    scope?: CallScope | null;
    requestHash?: string | null;
  },
): Promise<{ callId: string; responseKey: string | null }> {
  const callId = crypto.randomUUID();
  let responseKey: string | null = null;
  // A replayed call cost nothing and its answer is already saved: nothing goes in the ledger.
  if (isReplaying()) return { callId, responseKey };

  if (input.turns && input.turns.length > 0) {
    const saved: SavedResponse = {
      callId,
      step: input.step,
      round: input.round ?? null,
      conceptId: input.conceptId,
      versionId: input.versionId ?? null,
      label: input.label ?? null,
      model: input.model,
      savedAt: new Date().toISOString(),
      turns: input.turns,
      ...(input.requestHash ? { requestHash: input.requestHash } : {}),
    };
    const key = aiResponseKey(input.projectId, callId);
    try {
      await getStorage().put(key, Buffer.from(JSON.stringify(saved), "utf8"), "application/json");
      responseKey = key;
    } catch (error) {
      console.error(
        `[worker] could not save the ${input.step} answer for call ${callId}:`,
        error instanceof Error ? error.message : error,
      );
    }
  }

  await db.insert(aiCall).values({
    id: callId,
    responseKey,
    projectId: input.projectId,
    runId: input.runId,
    conceptId: input.conceptId,
    step: input.step,
    round: input.round ?? null,
    model: input.model,
    startedByUserId: input.startedByUserId,
    inputTokens: input.usage.inputTokens,
    outputTokens: input.usage.outputTokens,
    cacheReadTokens: input.usage.cacheReadTokens,
    cacheWriteTokens: input.usage.cacheWriteTokens,
    cacheWrite1hTokens: input.usage.cacheWrite1hTokens,
    scope: input.scope ?? null,
    durationMs: input.usage.ms === undefined ? null : Math.round(input.usage.ms),
  });

  return { callId, responseKey };
}

/** Reads a saved answer back; null if there is none or it cannot be read. */
export async function readSavedResponse(key: string): Promise<SavedResponse | null> {
  try {
    const body = await getStorage().get(key);
    return body ? (JSON.parse(body.toString("utf8")) as SavedResponse) : null;
  } catch {
    return null;
  }
}

/** The text of a saved answer's last turn: what the model finally said. */
export function savedText(saved: Pick<SavedResponse, "turns">): string {
  const last = saved.turns.at(-1);
  return (last?.content ?? [])
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("");
}

/** A builder call for one concept, written to the ledger when it returns. */
export async function builderCall(
  db: Db,
  ctx: ConceptContext,
  config: WorkerConfig,
  client: Anthropic,
  input: {
    step: AiCallStep;
    round?: number;
    messages: Anthropic.MessageParam[];
    onToolUse?: (name: string) => void;
    /** A small edit: low effort, no tools. */
    light?: boolean;
    /** Editing parts of the page: usual effort, no tools, a smaller ceiling. */
    edit?: boolean;
    scope?: CallScope;
  },
): Promise<CompleteResult> {
  const model = await stepModel(db, input.step);
  const ledger = {
    projectId: ctx.project.projectId,
    runId: ctx.project.runId,
    conceptId: ctx.conceptId,
    startedByUserId: ctx.project.startedByUserId,
    model,
    step: input.step,
    round: input.round,
    scope: input.scope ?? null,
  };

  let result: CompleteResult;
  try {
    result = await complete({
      client,
      config,
      model,
      skillId: ctx.skillId,
      system: ctx.system,
      messages: input.messages,
      onToolUse: input.onToolUse,
      light: input.light,
      edit: input.edit,
    });
  } catch (error) {
    // Answered, then failed: still paid for, so still charged and saved.
    if (error instanceof PaidCallError) {
      await recordCall(db, { ...ledger, usage: error.usage, turns: error.turns });
    }
    // Fable refused before it started (no 30-day data retention on the account, most likely): say so, nothing was charged.
    if (model === FABLE_MODEL && (error as { status?: number } | null)?.status === 400) {
      throw new Error(`${FABLE_RETENTION_HINT} Anthropic said: ${error instanceof Error ? error.message.slice(0, 200) : "refused"}`, { cause: error });
    }
    throw error;
  }

  await recordCall(db, { ...ledger, usage: result.usage, turns: result.turns });

  return result;
}

/* ---------- checks and versions ---------- */

export type CheckResult = Awaited<ReturnType<typeof checkEverything>>;

/*
  The HTML checks read the page as the model wrote it, with image tokens;
  the browser checks read it as it will look, with the images in place,
  because an image changes the layout and so the contrast and the fold.
*/
export async function checkEverything(
  browser: Browser,
  html: string,
  facts: CheckFacts,
  assets: PreparedAsset[],
  stock?: StockPictures | null,
  /** The concept's direction, for the colour rhythm (TAWD's own concepts only). */
  direction?: string,
) {
  const outcome = runHtmlChecks(html, facts);
  await stock?.ensure(html);
  // hasPhotos: real photos exist (the client's or the current site's), so a photo-led band can be asked for.
  const rhythm = direction && facts.pictures?.brandColors?.length ? { brandColors: facts.pictures.brandColors, direction, hasPhotos: assets.some((a) => a.kind === "photo") } : undefined;
  // TAWD's own concepts: the client's photos the page hasn't used, for the empty-picture check (5 November 2026).
  const unusedPhotoTokens = facts.pictures ? assets.filter((a) => a.kind === "photo" && !html.includes(a.token)).map((a) => a.token) : undefined;
  const rendered = await runRenderedChecks(browser, withImages(html, assets, stock), { services: facts.serviceNames, rhythm, pageRules: Boolean(facts.pictures), unusedPhotoTokens });

  /*
    Split what the builder can fix from what only the intake can. With no
    phone number in the intake there is nothing to make a tap-to-call link
    from, so those checks wait for the client instead of costing a round.
  */
  const noPhone = facts.phones.length === 0;
  const issues: CheckIssue[] = [...outcome.issues, ...rendered, ...(stock?.issues(html) ?? [])].map((issue) =>
    noPhone && issue.id.startsWith("conversion.tel")
      ? { ...issue, needsIntake: true }
      : issue,
  );

  const needsIntake: NeedsIntakeField[] = facts.intakeFacts
    ? requiredFieldsStillMissing(html, facts.intakeFacts)
    : [];

  return {
    ...outcome,
    issues,
    needsIntake,
    // Passed means nothing left the builder could fix.
    passed: !issues.some(isFixable),
  };
}

/* The page with its pictures: the client's uploads for their tokens, and any Shutterstock previews already looked up. */
export function withImages(html: string, assets: PreparedAsset[], stock?: StockPictures | null): string {
  // The client's photos of people are marked, so the render check keeps text off their faces.
  let marked = html;
  for (const asset of assets) {
    if (asset.kind !== "photo" || photoKind(asset.caption, asset.fileName) !== "people") continue;
    const token = asset.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    marked = marked.replace(new RegExp(`<img\\b(?![^>]*data-tawd-people)([^>]*?\\ssrc=(["'])${token}\\2)`, "gi"), "<img data-tawd-people$1");
  }
  const embedded = embedAssets(
    marked,
    Object.fromEntries(assets.map((asset) => [asset.token, asset.dataUri])),
  );
  const pictured = stock ? stock.apply(embedded) : embedded;
  // Frames Shutterstock couldn't fill get the client's own photos not used elsewhere (0.103.5).
  return fillFramesWithClientPhotos(
    pictured,
    assets.filter((asset) => asset.kind === "photo" && photoKind(asset.caption, asset.fileName) !== "people").map((asset) => asset.dataUri),
  ).html;
}

/** How a version came to exist, for the "v3: ..." note on screen. */
export type VersionStage = "build" | "fix" | "cd_improve" | "rebuild" | "changes" | "logo_swap" | "polish";

/** Where a version's source - the page with image tokens - is kept. */
export function sourceKeyFor(htmlKey: string): string {
  return htmlKey.replace(/page\.html$/, "source.html");
}

/*
  Gap 14 (security): the RENDERED page carries the site photos' old alts, put
  there by code. The token source stored beside it stays without them: that
  source is what the Creative Director and the improvement rounds read, and
  the scraped alt is data, never instructions — it must not reach a model
  that way either.
*/
export function conceptFinalHtml(html: string, assets: PreparedAsset[], stock?: StockPictures | null): string {
  return withImages(applyPhotoAlt(html, sitePhotoAlts(assets)), assets, stock);
}

export async function storeVersion(
  db: Db,
  storage: Storage,
  input: {
    conceptId: string;
    projectId: string;
    version: number;
    html: string;
    assets: PreparedAsset[];
    browser: Browser;
    outcome: CheckResult;
    stage: VersionStage;
    /** The automatic fix round that produced this version, if one did. */
    fixRound?: number;
    /** What code fixed to make this version, if it was code. */
    codeFixes?: string[];
    runNotes?: RunNote[];
    stock?: StockPictures | null;
  },
): Promise<string> {
  // Stored with the images inlined, so "View HTML" is the page as rendered.
  // Every US phone number in the page's words as "(916) 555-0142" (6 October 2026). Code only.
  const phoned = formatPhonesInHtml(input.html);
  await input.stock?.ensure(phoned);
  /*
    F28: the version carries which stock picture it took for each phrase, so
    every later render of it - the review, a polish pass, a changes run -
    loads the same photograph without having to know which concept it is.
    Before this, the phrase was re-resolved against a cache saved per
    project, so two concepts asking the same phrase got the same picture.
  */
  const html = input.stock ? stampStockPicks(phoned, input.stock.picks()) : phoned;
  const finalHtml = conceptFinalHtml(html, input.assets, input.stock);
  const shot = await renderConcept(input.browser, finalHtml);

  const base = `projects/${input.projectId}/concepts/${input.conceptId}/v${input.version}`;
  const htmlKey = `${base}/page.html`;
  const pngKey = `${base}/full.png`;
  const foldKey = `${base}/fold.png`;

  await storage.put(htmlKey, Buffer.from(finalHtml, "utf8"), "text/html");
  // The source, with image tokens rather than megabytes of images: what the
  // Creative Director reads and what an improvement round edits.
  await storage.put(
    sourceKeyFor(htmlKey),
    Buffer.from(html, "utf8"),
    "text/html",
  );
  await storage.put(pngKey, shot.fullPage, "image/png");
  await storage.put(foldKey, shot.fold, "image/png");

  // The concept's running total so far, from the ledger; see conceptSpend().
  const [spent] = await db
    .select({
      input: sql<number>`coalesce(sum(${aiCall.inputTokens}), 0)::bigint`,
      output: sql<number>`coalesce(sum(${aiCall.outputTokens}), 0)::bigint`,
      cacheRead: sql<number>`coalesce(sum(${aiCall.cacheReadTokens}), 0)::bigint`,
      cacheWrite: sql<number>`coalesce(sum(${aiCall.cacheWriteTokens}), 0)::bigint`,
    })
    .from(aiCall)
    .where(eq(aiCall.conceptId, input.conceptId));

  const [row] = await db
    .insert(conceptVersion)
    .values({
      conceptId: input.conceptId,
      version: input.version,
      htmlKey,
      pngKey,
      foldPngKey: foldKey,
      checks: {
        passed: input.outcome.passed,
        issues: input.outcome.issues,
        needsIntake: input.outcome.needsIntake,
        stage: input.stage,
        fixRound: input.fixRound ?? null,
        codeFixes: input.codeFixes ?? null,
        runNotes: ((notes) => (notes.length ? notes : null))(mergeRunNotes(input.runNotes, input.stock?.runNotes(input.html))),
        heightPx: shot.heightPx,
        truncated: shot.truncated,
        imageHeightPx: shot.imageHeightPx,
        bands: shot.bands,
      },
      placeholderCount: input.outcome.placeholderCount,
      inputTokens: Number(spent?.input ?? 0),
      outputTokens: Number(spent?.output ?? 0),
      cacheReadTokens: Number(spent?.cacheRead ?? 0),
      cacheWriteTokens: Number(spent?.cacheWrite ?? 0),
    })
    .returning({ id: conceptVersion.id });

  return row!.id;
}

/*
  Up to MAX_FIX_ROUNDS rounds of automatic fixes, each re-checked.

  Each round gets exactly the items still failing, each with its target.
  The conversation carries on across rounds so the model edits the page it
  just wrote rather than starting over. Two rounds, because a third rarely
  fixes what two could not and costs as much as the others.
*/
export async function runFixRounds(
  db: Db,
  storage: Storage,
  ctx: ConceptContext,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
  input: {
    conversation: Anthropic.MessageParam[];
    html: string;
    outcome: CheckResult;
    version: number;
    /** The concept-step row that shows this progress on screen. */
    stepName: string;
  },
): Promise<{
  conversation: Anthropic.MessageParam[];
  html: string;
  outcome: CheckResult;
  version: number;
  rounds: number;
  /** What code fixed, free, before or between AI rounds. */
  codeFixed: string[];
}> {
  let { conversation, html, outcome, version } = input;
  let rounds = 0;
  const codeFixed = new Set<string>();

  /*
    Code first, every time: it is free and exact. Then the checks again,
    and only what is still failing and fixable goes to an AI round. The
    round counter counts AI rounds only.
  */
  const tryCode = async () => {
    if (!outcome.issues.some((issue) => CODE_FIXABLE.has(issue.id))) return;
    const coded = await applyCodeFixes(browser, html, outcome, ctx.project.assets, ctx.project.facts);
    if (coded.html === html) return;

    html = coded.html;
    coded.fixed.forEach((f) => codeFixed.add(f));
    // The model's own copy of the page, so a later AI round edits this one.
    const last = conversation.at(-1);
    if (last?.role === "assistant") {
      conversation = [...conversation.slice(0, -1), { role: "assistant", content: html }];
    }
    version += 1;
    outcome = await checkEverything(browser, html, ctx.project.facts, ctx.project.assets, ctx.project.stock, ctx.direction);
    await storeVersion(db, storage, {
      stock: ctx.project.stock,
      conceptId: ctx.conceptId,
      projectId: ctx.project.projectId,
      version,
      html,
      assets: ctx.project.assets,
      browser,
      outcome,
      stage: "fix",
      codeFixes: coded.fixed,
      runNotes: coded.notes,
    });
  };

  await tryCode();

  for (let round = 1; round <= MAX_FIX_ROUNDS; round += 1) {
    // Only what the builder can fix. Missing intake facts never get a round.
    const failures = outcome.issues.filter(isFixable);
    if (failures.length === 0) break;

    await setStep(
      db,
      ctx.conceptId,
      input.stepName,
      "working",
      `Fix round ${round} of ${MAX_FIX_ROUNDS}: ${
        failures.length === 1 ? "1 issue" : `${failures.length} issues`
      }`,
    );

    /*
      Only the bands the problems are in. The page is never sent whole and
      never regenerated for a fix.
    */
    const sections = splitSections(html);
    if (sections.length === 0) break;
    const targets = [...new Set(failures.flatMap((issue) => sectionsForIssue(issue, sections)))].sort((a, b) => a - b);
    if (targets.length === 0) break;

    const improved = await builderCall(db, ctx, config, client, {
      step: "fix",
      round,
      light: true,
      scope: "sections",
      messages: [
        {
          role: "user",
          content: buildSectionFixPrompt({
            clientName: ctx.project.clientName,
            directionLabel: directionInfo(ctx.direction).label,
            sections: targets.map((index) => ({ index, html: sections[index]!.html })),
            issues: failures,
            factsKnown: describeFactsForPrompt(ctx.project.intakeFacts).known,
            designerNotes: ctx.project.intake.data.photos.notes,
            round,
            totalRounds: MAX_FIX_ROUNDS,
          }),
        },
      ],
    });

    const replies = parseSectionReplies(improved.text, targets);
    if (replies.size === 0) break;

    html = replaceSections(html, sections, replies);
    version += 1;
    rounds = round;

    outcome = await checkEverything(browser, html, ctx.project.facts, ctx.project.assets, ctx.project.stock, ctx.direction);

    await storeVersion(db, storage, {
      stock: ctx.project.stock,
      conceptId: ctx.conceptId,
      projectId: ctx.project.projectId,
      version,
      html,
      assets: ctx.project.assets,
      browser,
      outcome,
      stage: "fix",
      fixRound: round,
    });

    // The AI may have brought back something code can tidy.
    await tryCode();
  }

  return { conversation, html, outcome, version, rounds, codeFixed: [...codeFixed] };
}

/* ---------- editing parts of a page ---------- */

/* The edit could not be made: nothing to place it on, or nothing came back. */
export class SectionEditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SectionEditError";
  }
}

/*
  The improvement round and Request changes, part by part (Jason, 25
  September 2026): only the bands the notes or the request are about, and
  the style sheet for a page-wide change, go to the AI; only changed parts
  come back and are swapped in. The page is never sent whole.

  `known` are the parts already placed (a note's band, a pinned comment's
  band). `unplaced` is whatever could not be placed; one small call finds
  its parts from an outline of the page. Both calls are charged to `step`,
  marked "locate" and "sections" for the before-and-after on Spend.
*/
export async function editBySections(
  db: Db,
  ctx: ConceptContext,
  config: WorkerConfig,
  client: Anthropic,
  input: {
    step: "improve" | "changes" | "polish";
    html: string;
    /** The notes or the request, in words, as the AI is to read them. */
    request: string;
    known: number[];
    /** Text of what could not be placed; empty when everything was. */
    unplaced: string;
    /** Sections of the render with the team's pins drawn on, shown after the code. */
    pictures?: { caption: string; jpeg: Buffer }[];
  },
): Promise<{ html: string; parts: number[] }> {
  const sections = splitSections(input.html);
  if (sections.length === 0) throw new SectionEditError("The page has no sections to change.");
  const styles = styleSection(input.html);

  const targets = new Set(input.known);
  if (input.unplaced.trim()) {
    const located = await builderCall(db, ctx, config, client, {
      step: input.step,
      light: true,
      scope: "locate",
      messages: [
        { role: "user", content: buildLocatePrompt({ request: input.unplaced, outline: outlineBands(sections) }) },
      ],
    });
    for (const part of parseLocateReply(located.text, sections.length)) targets.add(part);
  }

  const parts = [...targets]
    .filter((index) => (index === STYLES_PART ? styles !== null : index >= 0 && index < sections.length))
    .sort((a, b) => a - b);
  if (parts.length === 0) throw new SectionEditError("Could not tell which part of the page to change.");

  const all = styles ? [...sections, styles] : sections;
  const pictures = (input.pictures ?? []).flatMap((p): Anthropic.ContentBlockParam[] => [
    { type: "text", text: p.caption },
    jpegBlock(p.jpeg),
  ]);
  const edited = await builderCall(db, ctx, config, client, {
    step: input.step,
    edit: true,
    scope: "sections",
    messages: [
      {
        role: "user",
        content: withPictures(pictures, buildSectionEditPrompt({
          kind: input.step,
          clientName: ctx.project.clientName,
          directionLabel: directionInfo(ctx.direction).label,
          request: input.request,
          sections: parts.map((index) => ({ index, html: all.find((s) => s.index === index)!.html })),
          factsKnown: describeFactsForPrompt(ctx.project.intakeFacts).known,
          designerNotes: ctx.project.intake.data.photos.notes,
        })),
      },
    ],
  });

  const replies = parseSectionReplies(edited.text, parts);
  if (replies.size === 0) throw new SectionEditError("The AI did not return any changed part.");

  return { html: replaceSections(input.html, all, replies), parts: [...replies.keys()].sort((a, b) => a - b) };
}

/* The prompt alone, or the prompt followed by the pinned pictures. */
function withPictures(pictures: Anthropic.ContentBlockParam[], text: string): string | Anthropic.ContentBlockParam[] {
  if (pictures.length === 0) return text;
  return [
    { type: "text", text },
    {
      type: "text",
      text: "# Where the pinned comments are\n\nEach picture is that section of the page as it looks now, with the comment numbers drawn where the team clicked.",
    },
    ...pictures,
  ];
}

/* ---------- fixes by code ---------- */

/*
  Issues code can fix without any AI. The mobile tap-target sizes are not
  on the list: that is information only on a desktop mockup, so it never
  makes a version of its own; its CSS rides along with any other code fix.
*/
export const CODE_FIXABLE = new Set([
  "seo.title.long",
  "seo.description.long",
  "seo.description.missing",
  "a11y.contrast",
  "images.logo.invisible",
  // Placeholders for anything but an empty required field (8 October 2026): taken out with their card or band.
  "placeholders.detail",
  "placeholders.notRequired",
  // Stock only in the bands that need it, and every frame asked for (8 October 2026).
  "images.stockOutOfPlace",
  "images.frameWithoutStock",
  // Icons from TAWD's set, by code.
  "icons.unfilled",
  // F8: the same photo in several bands, swapped for unused ones by code.
  "images.repeatedPhoto",
  // Too pale for the direction: code turns the planned bands to the brand colour.
  "design.colourRhythm",
  // A button to the form not worded "Request a quote" (8 October 2026).
  "copy.formButton",
  // A call button not worded "Call (number)", and a reviews band that only asks for reviews (0.103.5).
  "copy.callButton",
  "copy.hollowReviews",
  /*
    A claim in the meta description (12 November 2026): the AI fix round
    never sees the head, so code takes the sentence out. A claim in the
    page's copy is still the AI's; this only makes the code pass run first.
  */
  "house.claim.unsupported",
  "house.claim.superlative",
]);

export async function applyCodeFixes(
  browser: Browser,
  html: string,
  outcome: CheckResult,
  assets: PreparedAsset[],
  facts?: CheckFacts,
): Promise<{ html: string; fixed: string[]; notes: RunNote[] }> {
  const fixed: string[] = [];
  // Stage 1 of the self-check plan: every substitution code makes, said out loud.
  const notes: RunNote[] = [];
  const meta = fixTitleAndDescription(html, outcome.issues);
  let out = meta.html;
  fixed.push(...meta.fixed);

  if (facts?.intakeFacts && outcome.issues.some((i) => i.id === "placeholders.detail" || i.id === "placeholders.notRequired")) {
    const cleaned = removeStrayPlaceholders(out, facts.intakeFacts, facts.confirmablePlaceholders ?? []);
    if (cleaned.removed.length > 0) {
      out = cleaned.html;
      fixed.push(`removed ${cleaned.removed.length} placeholder${cleaned.removed.length === 1 ? "" : "s"} for optional facts`);
    }
  }

  if (outcome.issues.some((i) => i.id === "copy.formButton")) {
    const unified = unifyFormButtons(out);
    if (unified.changed > 0) {
      out = unified.html;
      fixed.push(`${unified.changed} form button${unified.changed === 1 ? "" : "s"} now "Request a quote"`);
    }
  }

  if (outcome.issues.some((i) => i.id === "copy.callButton")) {
    const calls = unifyCallButtons(out, facts?.phones ?? []);
    if (calls.changed > 0) {
      out = calls.html;
      fixed.push(`${calls.changed} call button${calls.changed === 1 ? "" : "s"} now "Call" and the number`);
    }
  }

  if (outcome.issues.some((i) => i.id === "copy.hollowReviews")) {
    const reviews = dropHollowReviews(out, { keepToConfirm: (facts?.confirmablePlaceholders ?? []).includes("page.reviews") });
    if (reviews.dropped > 0) {
      out = reviews.html;
      fixed.push(`${reviews.dropped} reviews band${reviews.dropped === 1 ? "" : "s"} with no customer's words taken out`);
    }
  }

  if (outcome.issues.some((i) => i.id === "icons.unfilled")) {
    const icons = fillIcons(out);
    if (icons.filled > 0) {
      out = icons.html;
      fixed.push(`${icons.filled} icon${icons.filled === 1 ? "" : "s"} from TAWD's icon set`);
    }
    notes.push(...icons.notes);
  }

  /*
    F8: the same photograph in several bands, swapped for ones nobody used.
    The check only fails when there is something spare to swap in, so this
    never runs with nothing to do.
  */
  if (outcome.issues.some((i) => i.id === "images.repeatedPhoto")) {
    const spread = spreadRepeatedPhotos(out, assets.filter((a) => a.kind === "photo").map((a) => a.token));
    if (spread.swapped.length > 0) {
      out = spread.html;
      fixed.push(`${spread.swapped.length} repeated photo${spread.swapped.length === 1 ? "" : "s"} given one of the client's unused photos`);
      for (const swap of spread.swapped) {
        notes.push({
          step: "photos",
          action: "substituted",
          what: `${swap.from} where it appeared a second time`,
          with: swap.to,
          why: "the same photograph was in more than one band while that one was unused",
        });
      }
    }
  }

  if (facts?.pictures && outcome.issues.some((i) => i.id === "images.stockOutOfPlace" || i.id === "images.frameWithoutStock")) {
    const pictures = fixPictures(out, facts.pictures);
    out = pictures.html;
    fixed.push(...pictures.fixed);
  }

  /*
    One rule per element, not per selector (10 November 2026): the fix rule
    repeats its class to out-rank the page's own CSS, and how many times it
    repeats can change between runs, so the raw selector would have kept
    both the old rule and the new one. ruleTarget counts a repeated class
    once.
  */
  const rules = new Map<string, string>();
  const existing = existingFixRules(out);
  for (const rule of keepLiveRules(out, existing)) rules.set(ruleTarget(rule), rule);

  /*
    Rules aimed by position, from before the classes, come out first; the
    browser then works out again whatever they were fixing.
  */
  const hadPositionRules = existing.some(isPositionRule);
  if (hadPositionRules) out = replaceFixStyle(out, [...rules.values()].join("\n"));

  const ids = new Set(outcome.issues.map((issue) => issue.id));

  /*
    The colour rhythm (8 October 2026): the planned pale bands take the
    brand colour, as Jason did by hand on Finley; the contrast fix below
    then runs on the result, so text on those bands stays readable.
  */
  let recoloured = false;
  const rhythm = outcome.issues.find((issue) => issue.id === "design.colourRhythm");
  const brandHex = facts?.pictures?.brandColors?.[0];
  if (rhythm?.where && brandHex) {
    const plan = rhythm.where.split(",").map(Number).filter((n) => Number.isInteger(n));
    const marked = markBrandBands(out, plan);
    if (marked !== out) {
      out = marked;
      const rule = brandBandRule(brandHex);
      rules.set(ruleTarget(rule), rule);
      recoloured = true;
      fixed.push(`${plan.length} section${plan.length === 1 ? "" : "s"} in the brand colour`);
    }
  }

  /*
    design.invisibleRule joins this list because its fix is code's too: a
    line drawn in the colour of the background behind it (10 November 2026,
    New Dawn Awning's articles band). Without it the fix pass would only
    run when something else had already failed.
  */
  if (ids.has("a11y.contrast") || ids.has("images.logo.invisible") || ids.has("design.invisibleRule") || hadPositionRules || recoloured) {
    if (recoloured) out = replaceFixStyle(out, [...rules.values()].join("\n"));
    const rendered = await computeRenderedFixes(browser, withImages(numberElements(out), assets), facts?.pictures?.brandColors ?? []);
    const applied = applyElementFindings(out, rendered);
    out = applied.html;
    for (const rule of applied.rules) rules.set(ruleTarget(rule), rule);
    fixed.push(...rendered.fixed);
    notes.push(...rendered.notes);
  }
  if (ids.has("a11y.tapTargets") && !rules.has(ruleTarget(MOBILE_TAP_TARGET_CSS))) {
    rules.set(ruleTarget(MOBILE_TAP_TARGET_CSS), MOBILE_TAP_TARGET_CSS);
    fixed.push("tap targets on mobile");
  }

  out = replaceFixStyle(out, keepLiveRules(out, [...rules.values()]).join("\n"));
  return { html: out, fixed, notes };
}

export function describeFixes(outcome: CheckResult, rounds: number, codeFixed: string[] = []): string {
  const summary = describeChecks(outcome);
  const parts = [
    codeFixed.length > 0 ? `Fixed by code: ${codeFixed.join(", ")}` : null,
    rounds > 0 ? `${rounds} fix round${rounds === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.length === 0 ? summary : `${parts.join("; ")}; ${summary.toLowerCase()}`;
}

/* ---------- the concept job ---------- */

/** A "running" concept with no heartbeat for this long was left by a worker that stopped. */
export const CONCEPT_STALLED_AFTER_MS = 10 * 60_000;
export const CONCEPT_HEARTBEAT_MS = 60_000;

export async function runConceptJob(
  job: ConceptJob,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<boolean> {
  const db = getDb();

  /*
    Claimed in one step (audit F-007, 12 November 2026): a "queued" concept
    becomes "running". BullMQ delivers a job again after a stall or a
    restart; before this, the second delivery built the concept again, paid
    for every AI call again and wrote versions 1, 2, 3 a second time.
    A concept already "running" is taken over only when its heartbeat (every
    minute while it is built) is over ten minutes old, which means the
    worker that held it stopped: its partial work is cleared and it is built
    again from the start. A fresh heartbeat means a live delivery has it.
    False: another delivery has it, nothing was done.
  */
  const [before] = await db
    .select({ status: concept.status })
    .from(concept)
    .where(eq(concept.id, job.conceptId))
    .limit(1);
  const now = new Date();
  const staleBefore = new Date(now.getTime() - CONCEPT_STALLED_AFTER_MS);
  const [claimed] = await db
    .update(concept)
    .set({ status: "running", heartbeatAt: now })
    .where(
      and(
        eq(concept.id, job.conceptId),
        or(
          eq(concept.status, "queued"),
          // ISO text cast by Postgres, never a raw Date beside a sql`` left side (it throws on postgres-js; see stuck-work.ts).
          and(eq(concept.status, "running"), lt(sql`coalesce(${concept.heartbeatAt}, ${concept.createdAt})`, sql`${staleBefore.toISOString()}::timestamptz`)),
        ),
      ),
    )
    .returning({ id: concept.id });
  if (!claimed) return false;

  if (before?.status === "running") {
    // Taken over: the stopped worker's versions and step lines would otherwise sit beside the new ones. AI calls stay (the money was spent) and so do stored files.
    await db.delete(conceptVersion).where(eq(conceptVersion.conceptId, job.conceptId));
    await db
      .update(conceptStep)
      .set({ status: "waiting", detail: null, startedAt: null, finishedAt: null })
      .where(eq(conceptStep.conceptId, job.conceptId));
    await recordActivity(db, {
      action: "mockups.concept_resumed",
      entityType: "project",
      entityId: job.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { concept: job.label },
      ipAddress: null,
      userAgent: null,
    });
  }

  const beat = startConceptHeartbeat(db, job.conceptId);
  try {
    return await buildClaimedConcept(job, config, client, browser);
  } finally {
    clearInterval(beat);
  }
}

/** Stamps the concept every minute while it is "running"; errors are swallowed (the next beat tries again). */
export function startConceptHeartbeat(db: ReturnType<typeof getDb>, conceptId: string, everyMs = CONCEPT_HEARTBEAT_MS): ReturnType<typeof setInterval> {
  const beat = setInterval(() => {
    void db
      .update(concept)
      .set({ heartbeatAt: new Date() })
      .where(and(eq(concept.id, conceptId), eq(concept.status, "running")))
      .catch(() => undefined);
  }, everyMs);
  beat.unref?.();
  return beat;
}

async function buildClaimedConcept(
  job: ConceptJob,
  config: WorkerConfig,
  client: Anthropic,
  browser: Browser,
): Promise<boolean> {
  const db = getDb();
  const storage = getStorage();

  await setStep(db, job.conceptId, "build", "working", "Fetching the logo and photos");

  const projectCtx = await loadProjectContext(db, storage, browser, config, job);
  const ctx = await conceptContext(projectCtx, config, job);

  /* ---------- 1. build ---------- */

  await setStep(db, job.conceptId, "build", "working", "Designing the page");

  // The sites the client likes, as pictures before the brief: inspiration only (the prompt says never to copy).
  const liked: Anthropic.ContentBlockParam[] = projectCtx.likedSites.flatMap((site) => [
    { type: "text" as const, text: `A website the client likes: ${site.url}` },
    jpegBlock(site.image),
  ]);
  const built = await builderCall(db, ctx, config, client, {
    step: "build",
    messages: [{ role: "user", content: ctx.opening(liked) }],
    onToolUse: (name) => {
      void setStep(
        db,
        job.conceptId,
        "build",
        "working",
        name === "run_skill_search" ? "Searching the design database" : "Reading the skill",
      );
    },
  });

  const html = extractHtml(built.text);
  if (!/<html[\s>]/i.test(html)) {
    throw new Error("The model did not return an HTML document.");
  }

  await setStep(db, job.conceptId, "build", "done", "Built");

  /* ---------- 2. checks, and up to two fix rounds ---------- */

  await setStep(db, job.conceptId, "checks", "working", "Checking layout");

  const outcome = await checkEverything(browser, html, projectCtx.facts, projectCtx.assets, projectCtx.stock, job.direction);

  await storeVersion(db, storage, {
    stock: projectCtx.stock,
    conceptId: job.conceptId,
    projectId: job.projectId,
    version: 1,
    html,
    assets: projectCtx.assets,
    browser,
    outcome,
    stage: "build",
  });

  const fixed = await runFixRounds(db, storage, ctx, config, client, browser, {
    conversation: built.messages,
    html,
    outcome,
    version: 1,
    stepName: "checks",
  });

  /*
    "needs_fixes", not "failed": the step finished, and what it found was a
    page with fixes outstanding (10 November 2026). Written as "failed" it
    read "Didn't finish" on the generating screen for both of New Dawn's
    concepts, on a run that produced two finished pages.
  */
  await setStep(
    db,
    job.conceptId,
    "checks",
    fixed.outcome.passed ? "done" : "needs_fixes",
    describeFixes(fixed.outcome, fixed.rounds, fixed.codeFixed),
  );

  await recordActivity(db, {
    action: "mockups.concept_built",
    entityType: "project",
    entityId: job.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      concept: job.label,
      direction: job.direction,
      skill: job.skillId,
      checksPassed: fixed.outcome.passed,
      fixRounds: fixed.rounds,
      placeholders: fixed.outcome.placeholderCount,
    },
    ipAddress: null,
    userAgent: null,
  });

  // The Creative Director looks at every concept together, once all are built.
  await setStep(db, job.conceptId, "review", "waiting", "Once every concept is built");

  /* ---------- the design log ---------- */

  await db.insert(designLogEntry).values({
    projectId: job.projectId,
    conceptId: job.conceptId,
    trade: projectCtx.trade,
    city: projectCtx.intake.data.business.city || null,
    direction: job.direction,
    paletteFamily: paletteFamily(projectCtx.intake.data.brand.colors[0]),
  });

  await db
    .update(concept)
    .set({ status: "ready" })
    .where(eq(concept.id, job.conceptId));
  return true;
}

/* ---------- finishing a run ---------- */

export interface VersionReviewRecord {
  passes: StoredReview[];
  /** Set when a question is still under 3 after the one rebuild. */
  needsPmReview?: boolean;
  /*
    A review pass that did not finish for this concept, and why. Cleared
    when a later pass succeeds. "Run the review again" starts from here.
  */
  failed?: { pass: string; reason: string; at: string };
}

/*
  Called after every concept job. Once every concept has settled, either
  the review job is queued (there is something to review) or the run is
  finished (nothing was built, or it was stopped).
*/
export async function afterConceptJob(
  runId: string,
  queueReview: (runId: string, projectId: string) => Promise<void>,
): Promise<void> {
  const db = getDb();

  const concepts = await db
    .select({ id: concept.id, status: concept.status, label: concept.label })
    .from(concept)
    .where(eq(concept.runId, runId));

  const allSettled = concepts.every(
    (c) => c.status === "ready" || c.status === "failed" || c.status === "stopped",
  );
  if (!allSettled) return;

  const [run] = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.id, runId))
    .limit(1);
  if (!run || run.status === "stopped") return;

  if (concepts.some((c) => c.status === "ready")) {
    await queueReview(runId, run.projectId);
    return;
  }

  await finalizeRun(runId);
}

/*
  The run's final status, most serious first. A page that failed its
  checks is not client-ready whatever else is true of it; a concept still
  under 3 after its rebuild needs the PM; a missing required field needs
  intake information.
*/
export async function finalizeRun(
  runId: string,
  options: { reviewFailed?: string } = {},
): Promise<void> {
  const db = getDb();

  const [run] = await db
    .select()
    .from(mockupRun)
    .where(eq(mockupRun.id, runId))
    .limit(1);
  if (!run || run.status === "stopped") return;

  const concepts = await db
    .select({ id: concept.id, status: concept.status, label: concept.label, reason: concept.failureReason })
    .from(concept)
    .where(eq(concept.runId, runId));

  const ready = concepts.filter((c) => c.status === "ready").map((c) => c.id);
  const held = concepts.filter((c) => c.status === "held");
  const outcome = await readyConceptOutcomes(db, ready);

  // A review that didn't finish comes first (B4): its concepts are held now, and "Run the review again" is offered only on this status.
  const status =
    ready.length === 0 && held.length === 0
      ? "failed"
      : options.reviewFailed
      ? "review_incomplete"
      : ready.length === 0
        ? "needs_pm_review"
        : outcome.checksFailed
          ? "checks_failed"
          : outcome.needsPmReview
            ? "needs_pm_review"
            : outcome.needsIntake
              ? "needs_intake"
              : "succeeded";

  await db
    .update(mockupRun)
    .set({
      status,
      finishedAt: new Date(),
      ...(options.reviewFailed ? { failureReason: options.reviewFailed } : {}),
    })
    .where(eq(mockupRun.id, runId));

  await recordActivity(db, {
    action: "mockups.run_finished",
    entityType: "project",
    entityId: run.projectId,
    ...actorFields(SYSTEM_ACTOR),
    valueAfter: {
      concepts: concepts.length,
      failed: concepts.filter((c) => c.status === "failed").length,
      held: held.map((c) => c.label),
      status,
    },
    ipAddress: null,
    userAgent: null,
  });

  // Slack, if the project has it. Never throws, and gives Slack 5 seconds.
  if (held.length > 0) {
    await postProjectSlack(db, run.projectId, {
      kind: "concepts_held",
      held: held.map((c) => ({ label: c.label, reason: c.reason ?? "under 4.5" })).sort((a, b) => a.label.localeCompare(b.label)),
      shown: ready.length,
    });
  }
  if (ready.length > 0) {
    await postProjectSlack(db, run.projectId, { kind: "concepts_ready", count: ready.length });
    const flagged = concepts
      .filter((c) => outcome.flaggedIds.includes(c.id))
      .map((c) => c.label)
      .sort();
    if (flagged.length > 0) {
      await postProjectSlack(db, run.projectId, { kind: "needs_pm_review", labels: flagged });
    }
  }
}

/** What each ready concept's newest version says about being client-ready. */
async function readyConceptOutcomes(
  db: Db,
  conceptIds: string[],
): Promise<{ checksFailed: boolean; needsIntake: boolean; needsPmReview: boolean; flaggedIds: string[] }> {
  if (conceptIds.length === 0) {
    return { checksFailed: false, needsIntake: false, needsPmReview: false, flaggedIds: [] };
  }

  const versions = await db
    .select({
      conceptId: conceptVersion.conceptId,
      version: conceptVersion.version,
      checks: conceptVersion.checks,
      review: conceptVersion.review,
    })
    .from(conceptVersion)
    .where(inArray(conceptVersion.conceptId, conceptIds));

  const newest = new Map<string, (typeof versions)[number]>();
  for (const v of versions) {
    const seen = newest.get(v.conceptId);
    if (!seen || v.version > seen.version) newest.set(v.conceptId, v);
  }

  const latest = [...newest.values()];
  const checks = latest.map(
    (v) => (v.checks ?? {}) as { passed?: boolean; needsIntake?: unknown[] },
  );

  return {
    checksFailed: checks.some((c) => c.passed === false),
    needsIntake: checks.some(
      (c) => Array.isArray(c.needsIntake) && c.needsIntake.length > 0,
    ),
    needsPmReview: latest.some(
      (v) => (v.review as VersionReviewRecord | null)?.needsPmReview === true,
    ),
    flaggedIds: latest
      .filter((v) => (v.review as VersionReviewRecord | null)?.needsPmReview === true)
      .map((v) => v.conceptId),
  };
}

/* A JPEG as an image block for a message. */
function jpegBlock(data: Buffer): Anthropic.ImageBlockParam {
  return imageBlock(data);
}

/*
  The reference sites' study (one AI call each) is queued by startRun on the
  mockups queue, while the concepts run on their own queue, so a concept could
  start before the study finished and be built from the outline alone, with
  the study still paid for (found 30 September 2026). A concept now waits for
  studies still queued or working, up to a limit; after it, it builds with what
  is there, as before.
*/
export const REFERENCE_STUDY_WAIT_MS = 5 * 60 * 1000;

export async function waitForReferenceStudies(
  db: Db,
  projectId: string,
  options: { timeoutMs?: number; pollMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<"none" | "done" | "timed_out"> {
  const timeoutMs = options.timeoutMs ?? REFERENCE_STUDY_WAIT_MS;
  const pollMs = options.pollMs ?? 5000;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pending = async () =>
    (await db.select({ id: likedSiteShot.id }).from(likedSiteShot).where(and(eq(likedSiteShot.projectId, projectId), inArray(likedSiteShot.briefStatus, ["queued", "working"])))).length;
  if ((await pending()) === 0) return "none";
  for (let waited = 0; waited < timeoutMs; waited += pollMs) {
    await sleep(pollMs);
    if ((await pending()) === 0) return "done";
  }
  return "timed_out";
}

/* The approved wireframe, when the project uses one (Lane 1; Growth and Pro unless switched): its sections in order. */
export async function approvedWireframeFor(db: Db, proj: { id: string; lane: string; tier: string }): Promise<WireframeSection[] | null> {
  const [row] = await db.select().from(wireframe).where(eq(wireframe.projectId, proj.id)).limit(1);
  // Design only has no wireframe (0.100.0): an older approved one is ignored.
  const intake = await loadIntake(db, SYSTEM_ACTOR, proj.id).catch(() => null);
  const designOnly = intake ? projectTypeOf({ lane: proj.lane, mode: intake.data.content.mode, hasCurrentWebsite: hasCurrentWebsite(intake.data.website) }) === "design_only" : false;
  if (!wireframeApplies({ lane: proj.lane, tier: proj.tier, enabled: row?.enabled ?? null, designOnly })) return null;
  if (!row?.approvedAt) return null;
  const sections = row.sections as WireframeSection[];
  return sections.length ? sections : null;
}

/*
  What the client's current website has, from TAWD's one read of it ($0):
  the home page's sections as the browser read them, and the features found
  in them and in the kept home page (whose tables survive). null when the
  site wasn't read, or the read saw no home page.
*/
export async function currentSiteInventory(db: Db, storage: Storage, projectId: string): Promise<{ features: SiteFeature[]; sections: SiteSectionLike[]; colours: string[]; menu: string[]; sectionOrder: string[] } | null> {
  const [row] = await db.select({ home: siteImport.home, pages: siteImport.pages }).from(siteImport).where(eq(siteImport.projectId, projectId)).limit(1);
  const home = homeOfRow(row);
  if (!home || home.sections.length === 0) return null;
  const pages = (row?.pages as { kind?: string; key?: string }[] | null) ?? [];
  const homeKey = pages.find((p) => p.kind === "home" && p.key)?.key;
  const kept = homeKey ? ((await storage.get(homeKey).catch(() => null))?.toString("utf8") ?? null) : null;
  const sections = home.sections.map((s) => ({ heading: s.heading, words: s.words }));
  return {
    features: findSiteFeatures({ sections, keptMarkdown: kept, phones: home.phones }),
    sections,
    // Crawl-% Mockup stage (7 November 2026): design signals the crawl already has but the concepts never saw.
    colours: home.look?.colours ?? [],
    menu: home.menu.map((m) => m.label.trim()).filter(Boolean),
    sectionOrder: home.sections.map((s) => (s.heading || s.kind).trim()).filter(Boolean),
  };
}

/* The home page's words the team used (approved) before Generate, for a Lane 1 concept (1 October 2026). */
async function approvedWordsFor(db: Db, projectId: string): Promise<HomeWords | null> {
  // A makeover (6 October 2026): the Home page's words on Content, as they are.
  const kept = await keptHomeWords(db, projectId);
  if (kept) return kept.words;
  const [row] = await db.select().from(homeWords).where(eq(homeWords.projectId, projectId)).limit(1);
  if (!row?.approvedAt) return null;
  return { source: row.source as HomeWords["source"], sections: row.sections, testimonials: row.testimonials };
}
