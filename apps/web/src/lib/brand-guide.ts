import { after } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { extractText, getDocumentProxy } from "unpdf";

import { brandGuideReading, intakeFile } from "@tawd/core/schema";
import { actorFields, recordActivity } from "@tawd/core/activity";
import type { Database } from "@tawd/core/db";
import { readBrandGuideText, type BrandGuideColor } from "@tawd/core/intake/brand-guide";
import { loadIntake, saveIntakeSection } from "@tawd/core/intake/service";
import { getStorage } from "@tawd/core/intake/storage";
import { costOf, formatCost, getModelConfig } from "@tawd/core/mockups";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import type { ServiceContext } from "@/lib/users";

/*
  The brand guide PDF, read once when it is uploaded, in the background
  after the upload has answered: its colours, fonts and logo rules become
  "From the brand guide" suggestions in the intake's Brand section. The PM
  uses or dismisses each; nothing is written without them, and nothing the
  PM typed is ever replaced. No AI: a guide with no text (a scan) says so,
  with what reading it by AI would cost, and waits.
*/

type Db = ServiceContext["db"];

/* A first guess for reading a scanned page by AI: the page as a picture in, its notes out. */
const SCAN_PAGE_GUESS = { inputTokens: 1_600, outputTokens: 400 };

const pending = new Set<Promise<unknown>>();

/* After an upload is confirmed: read it if it is a brand guide PDF. Never throws. */
export function readBrandGuideLater(db: Database, fileId: string): void {
  const task = () => readBrandGuide(db, fileId).catch((error: unknown) => console.error(`Reading a brand guide failed: ${error instanceof Error ? error.message : "unknown"}`));
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
}

/** For tests: wait for readings started outside a request. */
export async function settleBrandGuideReadings(): Promise<void> {
  await Promise.all([...pending]);
}

export async function readBrandGuide(db: Database, fileId: string): Promise<void> {
  const [file] = await db.select().from(intakeFile).where(eq(intakeFile.id, fileId)).limit(1);
  if (!file || file.kind !== "brand_guide" || file.status !== "ready") return;
  if (file.contentType !== "application/pdf" && !/\.pdf$/i.test(file.fileName)) return;

  let status: "done" | "no_text" | "failed" = "done";
  let pages: number | null = null;
  let reading = { colors: [] as BrandGuideColor[], fonts: [] as string[], logoRules: [] as string[] };
  let failureReason: string | null = null;
  try {
    const body = await getStorage().get(file.storageKey);
    if (!body) throw new Error("The file is missing from storage.");
    const pdf = await getDocumentProxy(new Uint8Array(body));
    pages = pdf.numPages;
    const { text } = await extractText(pdf, { mergePages: true });
    if (text.replace(/\s+/g, "").length < 20) status = "no_text";
    else reading = readBrandGuideText(text);
  } catch (error) {
    status = "failed";
    failureReason = error instanceof Error ? error.message : "The PDF couldn't be read.";
  }

  await db.delete(brandGuideReading).where(eq(brandGuideReading.fileId, fileId));
  await db.insert(brandGuideReading).values({
    projectId: file.projectId,
    fileId,
    status,
    pages,
    colors: reading.colors,
    fonts: reading.fonts,
    logoRules: reading.logoRules,
    failureReason,
  });
  await recordActivity(db, {
    action: "intake.brand_guide_read",
    entityType: "project",
    entityId: file.projectId,
    actorEmail: "system:brand-guide",
    valueAfter: {
      fileName: file.fileName,
      status,
      colors: reading.colors.length,
      fonts: reading.fonts,
      logoRules: reading.logoRules.length,
    },
  });
}

/* ---------- what the Brand section shows ---------- */

export interface BrandGuideView {
  /** One line per guide read: what was found, or why nothing was. */
  readings: { fileName: string; line: string; tone: "done" | "missing" | "error" }[];
  colors: { readingId: string; key: string; hex: string; name: string | null }[];
  fonts: { readingId: string; key: string; name: string }[];
  logoRules: { readingId: string; key: string; index: number; text: string }[];
}

export async function loadBrandGuide(db: Db, projectId: string): Promise<BrandGuideView | null> {
  const rows = await db
    .select({ reading: brandGuideReading, fileName: intakeFile.fileName })
    .from(brandGuideReading)
    .innerJoin(intakeFile, eq(intakeFile.id, brandGuideReading.fileId))
    .where(eq(brandGuideReading.projectId, projectId))
    .orderBy(desc(brandGuideReading.readAt));
  if (rows.length === 0) return null;
  const config = getModelConfig();
  const view: BrandGuideView = { readings: [], colors: [], fonts: [], logoRules: [] };
  for (const { reading, fileName } of rows) {
    const handled = (reading.handled as Record<string, string>) ?? {};
    const colors = (reading.colors as BrandGuideColor[]) ?? [];
    const fonts = (reading.fonts as string[]) ?? [];
    const rules = (reading.logoRules as string[]) ?? [];
    if (reading.status === "no_text") {
      const cost = costOf(
        { inputTokens: SCAN_PAGE_GUESS.inputTokens * (reading.pages ?? 1), outputTokens: SCAN_PAGE_GUESS.outputTokens * (reading.pages ?? 1) },
        config,
      );
      view.readings.push({
        fileName,
        tone: "missing",
        line: `No text to read: it looks like a scan. Reading its ${reading.pages ?? 1} page${reading.pages === 1 ? "" : "s"} by AI would cost about ${formatCost(cost)}; not done.`,
      });
    } else if (reading.status === "failed") {
      view.readings.push({ fileName, tone: "error", line: `Couldn't be read: ${reading.failureReason ?? "unknown reason"}` });
    } else {
      const found = [
        colors.length ? `${colors.length} colour${colors.length === 1 ? "" : "s"}` : null,
        fonts.length ? `${fonts.length} font${fonts.length === 1 ? "" : "s"}` : null,
        rules.length ? `${rules.length} logo rule${rules.length === 1 ? "" : "s"}` : null,
      ].filter(Boolean);
      view.readings.push({ fileName, tone: "done", line: found.length ? `Found ${found.join(", ")}.` : "Read, but no colours, fonts or logo rules were found in its text." });
    }
    for (const c of colors) if (!handled[`color:${c.hex}`]) view.colors.push({ readingId: reading.id, key: `color:${c.hex}`, hex: c.hex, name: c.name });
    for (const f of fonts) if (!handled[`font:${f}`]) view.fonts.push({ readingId: reading.id, key: `font:${f}`, name: f });
    rules.forEach((text, index) => {
      if (!handled[`rule:${index}`]) view.logoRules.push({ readingId: reading.id, key: `rule:${index}`, index, text });
    });
  }
  return view;
}

/* ---------- the PM's answers ---------- */

export class BrandGuideError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrandGuideError";
  }
}

/*
  The PM used or dismissed one suggestion. A colour or font the PM uses is
  put into the Brand form by the page itself (so unsaved changes stay); a
  logo rule is added to "Notes for the designer" here, after what is there.
*/
export async function answerBrandGuideSuggestion(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  readingId: string,
  key: string,
  outcome: "used" | "dismissed",
): Promise<void> {
  assertCan(actor, "intake.edit");
  const [reading] = await ctx.db
    .select()
    .from(brandGuideReading)
    .where(and(eq(brandGuideReading.id, readingId), eq(brandGuideReading.projectId, projectId)))
    .limit(1);
  if (!reading) throw new BrandGuideError("That brand guide reading no longer exists.");
  const handled = { ...((reading.handled as Record<string, string>) ?? {}) };
  if (handled[key]) return;

  let what = key;
  const rule = /^rule:(\d+)$/.exec(key);
  if (rule) {
    const text = ((reading.logoRules as string[]) ?? [])[Number(rule[1])];
    if (!text) throw new BrandGuideError("That logo rule no longer exists.");
    what = `Logo rule: ${text}`;
    if (outcome === "used") {
      const intake = await loadIntake(ctx.db, actor, projectId);
      const notes = intake?.data.photos.notes.trim() ?? "";
      const line = `Logo rule (from the brand guide): ${text}`;
      if (!notes.includes(line)) {
        await saveIntakeSection(ctx, actor, projectId, "photos", { ...(intake?.data.photos ?? {}), notes: notes ? `${notes}\n${line}` : line });
      }
    }
  }
  handled[key] = outcome;
  await ctx.db.update(brandGuideReading).set({ handled }).where(eq(brandGuideReading.id, readingId));
  await recordActivity(ctx.db, {
    action: "intake.brand_guide_suggestion",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { suggestion: what, outcome },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
}
