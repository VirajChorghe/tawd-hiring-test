import path from "node:path";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { setDbForTesting, type Database } from "@tawd/core/db";
import { aiCall, concept, conceptVersion, mockupRun, project as projectTable } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";

import {
  checkEverything,
  conceptContext,
  loadProjectContext,
  runFixRounds,
} from "../../../worker/src/pipeline";
import type { WorkerConfig } from "../../../worker/src/config";

import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2, fakeBrowser, messageText } from "./worker-fakes";

/*
  Fix rounds cost money only when code cannot fix the problem. These run
  the worker's real fix loop with a scripted Claude that records every call.
*/

let h: Harness;

const config: WorkerConfig = {
  databaseUrl: "unused",
  redisUrl: "unused",
  anthropicApiKey: "unused",
  model: "claude-opus-5-5",
  skillsDir: path.resolve(__dirname, "../../../../skills"),
  effort: "high",
};

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
});

afterEach(async () => {
  setDbForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

export function recordingClaude(reply: (prompt: string) => string) {
  const prompts: { system: string; user: string; maxTokens: number }[] = [];
  const client = {
    messages: {
      stream: (params: { messages: { role: string; content: unknown }[]; system?: { text: string }[]; max_tokens?: number }) => {
        const last = params.messages.at(-1)!;
        const user = messageText(last.content);
        prompts.push({ system: (params.system ?? []).map((s) => s.text).join("\n"), user, maxTokens: params.max_tokens ?? 0 });
        const text = reply(user);
        return {
          finalMessage: async () => ({
            content: [{ type: "text", text }],
            stop_reason: "end_turn",
            usage: { input_tokens: 4_000, output_tokens: Math.ceil(text.length / 4), cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
          }),
          on: () => undefined,
        };
      },
    },
  };
  return { client: client as never, prompts };
}

export async function seedConcept(h: Harness) {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "ABC Plumbers",
    trade: "plumbing",
    tier: "starter",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 1,
    status: "intake",
    memberUserIds: [],
  });
  await h.db.update(projectTable).set({ status: "mockups" }).where(eq(projectTable.id, projectId));
  await saveIntakeSection(h.ctx, admin.viewer, projectId, "business", {
    name: "ABC Plumbers",
    phone: "(916) 555-0147",
    city: "Sacramento",
  });
  const [run] = await h.db
    .insert(mockupRun)
    .values({ projectId, conceptCount: 1, status: "running", model: "claude-opus-5-5", startedByUserId: admin.viewer.id })
    .returning();
  const [row] = await h.db
    .insert(concept)
    .values({ runId: run!.id, projectId, label: "A", direction: "modern_clean", skillId: "impeccable", status: "running" })
    .returning();

  const browser = fakeBrowser();
  const project = await loadProjectContext(h.db as never, new FakeR2() as never, browser, config, { projectId, runId: run!.id });
  const ctx = await conceptContext(project, config, {
    conceptId: row!.id,
    label: "A",
    direction: "modern_clean",
    skillId: "impeccable",
  });
  return { projectId, conceptId: row!.id, ctx, browser };
}

const PAGE = (title: string, extra = "") => `<!doctype html><html lang="en"><head><title>${title}</title>
<meta name="description" content="ABC Plumbers fixes leaks, drains and water heaters across Sacramento, day and night."></head>
<body><header><a href="tel:+19165550147">(916) 555-0147</a></header>
<section><h1>ABC Plumbers in Sacramento</h1><p>Burst pipe? Call now.</p><div class="photo-frame" data-tawd-photo="plumber fixing burst pipe">Photo: plumber fixing a burst pipe</div>${extra}</section>
<section><form><label for="n">Name</label><input id="n" type="text"><button type="submit">Call me back</button></form></section>
<footer><p>ABC Plumbers</p></footer></body></html>`;

describe("the fix loop", () => {
  it("fixes a long title by code and spends no AI at all", async () => {
    const { conceptId, ctx, browser } = await seedConcept(h);
    // No "24/7" in it: the intake here doesn't say so, and since batch B that claim is a failure of its own that a fix round would be spent on.
    const html = PAGE("ABC Plumbers | Emergency Plumbing Repairs | Sacramento, Elk Grove and Folsom");
    const outcome = await checkEverything(browser, html, ctx.project.facts, ctx.project.assets);
    expect(outcome.issues.map((i) => i.id)).toContain("seo.title.long");

    const { client, prompts } = recordingClaude(() => "unused");
    const result = await runFixRounds(h.db as never, new FakeR2() as never, ctx, config, client, browser, {
      conversation: [],
      html,
      outcome,
      version: 1,
      stepName: "checks",
    });

    expect(prompts).toHaveLength(0);
    expect(result.rounds).toBe(0);
    expect(result.codeFixed).toEqual(["title length"]);
    expect(result.outcome.issues.map((i) => i.id)).not.toContain("seo.title.long");

    const versions = await h.db.select().from(conceptVersion).where(eq(conceptVersion.conceptId, conceptId));
    expect((versions[0]!.checks as { codeFixes: string[] }).codeFixes).toEqual(["title length"]);
    expect(await h.db.select().from(aiCall)).toHaveLength(0);
  });

  it("sends only the band with the problem, gets only that band back, and never the whole page", async () => {
    const { ctx, browser } = await seedConcept(h);
    // An invented phone number in the services band.
    const html = PAGE("ABC Plumbers in Sacramento", "").replace(
      "<section><form>",
      "<section><h2>Services</h2><p>Or text (916) 555-9999 any time.</p></section><section><form>",
    );
    const outcome = await checkEverything(browser, html, ctx.project.facts, ctx.project.assets);
    expect(outcome.issues.map((i) => i.id)).toContain("house.phone.invented");

    const { client, prompts } = recordingClaude(
      () => '<tawd-section id="2"><section><h2>Services</h2><p>Call (916) 555-0147 any time.</p></section></tawd-section>',
    );
    const result = await runFixRounds(h.db as never, new FakeR2() as never, ctx, config, client, browser, {
      conversation: [],
      html,
      outcome,
      version: 1,
      stepName: "checks",
    });

    expect(prompts).toHaveLength(1);
    const sent = prompts[0]!.user;
    // Only the services band went out: not the header, hero, form or footer.
    expect(sent).toContain('<tawd-section id="2">');
    expect(sent).toContain("(916) 555-9999");
    expect(sent).not.toContain("<footer>");
    expect(sent).not.toContain("Call me back");
    expect(sent).not.toMatch(/<html|<body/i);
    // A small edit: a low ceiling, not the builder's 64,000.
    expect(prompts[0]!.maxTokens).toBe(16_000);

    expect(result.rounds).toBe(1);
    expect(result.html).toContain("Call (916) 555-0147 any time.");
    expect(result.html).not.toContain("555-9999");
    // Everything else is exactly as it was.
    expect(result.html.replace("Call (916) 555-0147 any time.", "")).toBe(
      html.replace("Or text (916) 555-9999 any time.", ""),
    );
    expect(result.outcome.issues.map((i) => i.id)).not.toContain("house.phone.invented");

    const calls = await h.db.select().from(aiCall);
    expect(calls.map((c) => c.step)).toEqual(["fix"]);
  });

  it("never spends a round on missing intake info", async () => {
    const { ctx, browser } = await seedConcept(h);
    const outcome = {
      passed: true,
      placeholderCount: 0,
      needsIntake: [],
      issues: [{ id: "conversion.tel.missing", severity: "fail" as const, message: "No phone", needsIntake: true }],
    };
    const { client, prompts } = recordingClaude(() => "unused");
    const result = await runFixRounds(h.db as never, new FakeR2() as never, ctx, config, client, browser, {
      conversation: [],
      html: PAGE("ABC Plumbers"),
      outcome: outcome as never,
      version: 1,
      stepName: "checks",
    });
    expect(prompts).toHaveLength(0);
    expect(result.rounds).toBe(0);
  });
});
