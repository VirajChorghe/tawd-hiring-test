import { and, eq } from "drizzle-orm";
import type Anthropic from "@anthropic-ai/sdk";

import { getDb } from "@tawd/core/db";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { loadIntakeForBuilding } from "@tawd/core/intake/unconfirmed";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import type { HomeWordsJobData } from "@tawd/core/queue";
import { homeWords, pagePlanPage, project } from "@tawd/core/schema";
import { siteReadHome } from "@tawd/core/site-read";
import {
  CACHE_1H,
  HomeWordsError,
  buildHomeWordsSystemPrompt,
  buildHomeWordsUserText,
  describeFactsForPrompt,
  listIntakeFacts,
  readHomeWordsReply,
  requestSettings,
  type HomeWordsSection,
  wireframeWordSections,
} from "@tawd/core/mockups";

import type { WorkerConfig } from "./config";
import { approvedWireframeFor, recordCall } from "./pipeline";
import { usageOf } from "./review";
import { stepModel } from "./step-model";

/*
  Content first, part 2 (1 October 2026): for a new site, one AI call
  writes the home page's words from the intake (and the current site's
  words, when TAWD read some), before any concept. One retry if the reply
  can't be used. The team then edits and uses them.
*/

export async function runHomeWordsJob(job: HomeWordsJobData, _config: WorkerConfig, client: Anthropic): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(homeWords).where(eq(homeWords.projectId, job.projectId)).limit(1);
  if (!row || row.writeStatus !== "queued") return;
  await db.update(homeWords).set({ writeStatus: "working" }).where(eq(homeWords.id, row.id));
  try {
    const [proj] = await db.select().from(project).where(eq(project.id, job.projectId)).limit(1);
    // B3: an unconfirmed claim from the old site is not given to the writer as a fact.
    const intake = await loadIntakeForBuilding(db, SYSTEM_ACTOR, job.projectId);
    if (!proj || !intake) throw new Error("The project or its intake is gone.");
    // The one read's home page (0.96.0); a host's bot check saved as words is never given to the AI.
    const read = await siteReadHome(db, job.projectId);
    const facts = describeFactsForPrompt(listIntakeFacts(intake.data, intake.files, { trade: proj.trade }));
    // The Home page's keywords, when keyword research has made a page plan (5 November 2026).
    const [homePlan] = await db
      .select({ main: pagePlanPage.mainKeyword, supporting: pagePlanPage.supportingKeywords })
      .from(pagePlanPage)
      .where(and(eq(pagePlanPage.projectId, job.projectId), eq(pagePlanPage.kind, "home")))
      .limit(1);
    const system: Anthropic.TextBlockParam[] = [{ type: "text", text: buildHomeWordsSystemPrompt(), cache_control: CACHE_1H }];
    const messages: Anthropic.MessageParam[] = [
      {
        role: "user",
        content: buildHomeWordsUserText({
          clientName: proj.clientName,
          tradeLabel: proj.trade.replace(/_/g, " "),
          factsKnown: facts.known,
          factsRequiredMissing: facts.required,
          currentSiteWords: read ? read.sections.map((s) => `${s.heading ? `${s.heading}: ` : ""}${s.words}`).join("\n\n") : null,
          tone: intake.data.content.toneOfVoice,
          sectionNames: wireframeWordSections(await approvedWireframeFor(db, { id: proj.id, lane: proj.lane, tier: proj.tier })),
          keywords: homePlan ? { main: homePlan.main, supporting: homePlan.supporting ?? [] } : null,
        }),
      },
    ];
    let sections: HomeWordsSection[] | null = null;
    for (let attempt = 1; attempt <= 2 && !sections; attempt += 1) {
      const model = await stepModel(db, "home_words");
      const response = await client.messages.stream({ model, max_tokens: 8_000, system, messages, ...requestSettings(model, { effort: "low" }) }).finalMessage();
      await recordCall(db, {
        projectId: job.projectId,
        runId: row.id,
        conceptId: null,
        startedByUserId: job.startedByUserId,
        model,
        step: "home_words",
        round: attempt,
        usage: usageOf(response.usage),
        turns: [{ stopReason: response.stop_reason, content: response.content }],
      });
      if (response.stop_reason === "refusal") throw new Error("The writing was declined.");
      const text = response.content
        .filter((block): block is Anthropic.TextBlock => block.type === "text")
        .map((block) => block.text)
        .join("");
      try {
        sections = readHomeWordsReply(text);
      } catch (error) {
        if (!(error instanceof HomeWordsError) || attempt === 2) throw new Error(`The words couldn't be used: ${error instanceof Error ? error.message : "unknown"}`, { cause: error });
        messages.push({ role: "assistant", content: response.content });
        messages.push({ role: "user", content: `That reply couldn't be used: ${error.message} Reply again with only the JSON object.` });
      }
    }
    // The menu, when the current site has one: the words are the client's.
    const menu = read?.menu.length ? [{ name: "Menu", words: read.menu.map((m) => m.label).join(" · ") }] : [];
    await db
      .update(homeWords)
      .set({ source: "tawd", sections: [...menu, ...sections!], testimonials: (read?.testimonials ?? []).map((text) => ({ text, confirmed: false })), writeStatus: "done", writeFailure: null, approvedAt: null, approvedByUserId: null, updatedAt: new Date() })
      .where(eq(homeWords.id, row.id));
    await recordActivity(db, {
      action: "mockups.home_words_written",
      entityType: "project",
      entityId: job.projectId,
      ...actorFields(SYSTEM_ACTOR),
      valueAfter: { sections: sections!.map((s) => s.name) },
      ipAddress: null,
      userAgent: null,
    });
  } catch (error) {
    await db
      .update(homeWords)
      .set({ writeStatus: "failed", writeFailure: error instanceof Error ? error.message.slice(0, 300) : "The writing didn't finish." })
      .where(eq(homeWords.id, row.id));
  }
}
