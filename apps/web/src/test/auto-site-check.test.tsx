import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  The Site check after each deploy (Jason, 29 September 2026): once per
  version, when the worker is on the same version; a failure (or a worker
  that never comes up) is announced to the admins by the strip, by email
  and in the team Slack channel. Nothing on success. The team channel can
  be copied from a project's webhook.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), redirect: (to: string) => { throw new Error(`redirect ${to}`); } }));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

import { and, desc, eq } from "drizzle-orm";
import { setDbForTesting, type Database } from "@tawd/core/db";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { decryptSecret, setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { setSlackFetchForTesting } from "@tawd/core/slack";
import { activityLog, appSetting, e2eCheck, projectSlack, serviceHeartbeat } from "@tawd/core/schema";
import { TeamSlackCard } from "@/components/admin/team-slack-card";
import { autoSiteCheckTick, WORKER_WAIT_MS } from "@/lib/auto-site-check";
import { setE2eCheckForTesting, settleE2eChecks } from "@/lib/e2e-check";
import { setMailSenderForTesting, settleMail, type OutgoingMail } from "@/lib/mail";
import { connectSlack, sendSlackTest } from "@/lib/slack-settings";
import { connectTeamSlack, copyProjectWebhook, loadTeamSlack, postTeamSlack } from "@/lib/team-slack";
import { createProject } from "@/lib/projects";
import type { ProjectInput } from "@/lib/validation";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

let h: Harness;
let mails: OutgoingMail[];
let posts: { url: string; text: string }[];
const WEBHOOK = "https://hooks.slack.com/services/T000/B000/abcdWXYZ";

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setStorageForTesting(new FakeR2());
  setEncryptionKeyForTesting(Buffer.alloc(32, 7));
  mails = [];
  posts = [];
  setMailSenderForTesting(async (mail) => void mails.push(mail));
  setSlackFetchForTesting((async (url: string, init?: RequestInit) => {
    posts.push({ url, text: (JSON.parse(String(init!.body)) as { text: string }).text });
    return new Response("ok");
  }) as never);
  // Every page the check opens answers 404, so the check fails at its "stages" step, quickly and for $0.
  setE2eCheckForTesting({ fetch: async () => new Response("", { status: 404 }), sleep: async () => {} });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  setE2eCheckForTesting(null);
  setMailSenderForTesting(null);
  setSlackFetchForTesting(null);
  setEncryptionKeyForTesting(null);
  setStorageForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const worker = (version: string) =>
  h.db.insert(serviceHeartbeat).values({ service: "worker", version, startedAt: new Date(), env: {} }).onConflictDoUpdate({ target: serviceHeartbeat.service, set: { version } });

describe("when it runs", () => {
  it("waits for the worker on the same version, then runs once for that version, as TAWD", async () => {
    await seedAdmin(h);
    const startedAt = new Date();
    await worker("0.64.0");
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt, ctx: h.ctx })).toBe("waiting");
    expect(await h.db.select().from(e2eCheck)).toHaveLength(0);

    await worker("0.65.0");
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt, ctx: h.ctx })).toBe("started");
    await settleE2eChecks();
    // Once per version: a second tick (or a restarted server) doesn't run it again.
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt, ctx: h.ctx })).toBe("done");
    const checks = await h.db.select().from(e2eCheck);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.startedByUserId).toBeNull();
    const [started] = await h.db.select().from(activityLog).where(eq(activityLog.action, "system.e2e_check")).orderBy(activityLog.seq).limit(1);
    expect(started!.valueAfter).toMatchObject({ automatic: true, version: "0.65.0" });
  });

  it("is off with TAWD_AUTO_SITE_CHECK=off", async () => {
    vi.stubEnv("TAWD_AUTO_SITE_CHECK", "off");
    await worker("0.65.0");
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt: new Date(), ctx: h.ctx })).toBe("off");
    expect(await h.db.select().from(e2eCheck)).toHaveLength(0);
  });
});

describe("what it says", () => {
  it("a failure: an email to each admin and a post to the team channel", async () => {
    const admin = await seedAdmin(h, "owner@velocitymedialab.com");
    await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await connectTeamSlack(h.ctx, admin.viewer, WEBHOOK);
    await worker("0.65.0");
    await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt: new Date(), ctx: h.ctx });
    await settleE2eChecks();
    await settleMail();

    const [check] = await h.db.select().from(e2eCheck);
    expect(check!.status).toBe("failed");
    expect(mails.map((m) => m.to)).toEqual(["owner@velocitymedialab.com"]);
    expect(mails[0]!.subject).toBe("TAWD: the Site check after 0.65.0 failed");
    expect(mails[0]!.text).toContain("/admin/system#site-check");
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(WEBHOOK);
    expect(posts[0]!.text).toContain("The automatic Site check after the 0.65.0 deploy failed");
  });

  it("a version already checked says nothing again (a passing run never calls the alerts: they sit only on the failure path)", async () => {
    const admin = await seedAdmin(h);
    await connectTeamSlack(h.ctx, admin.viewer, WEBHOOK);
    await h.db.insert(appSetting).values({ key: "auto_site_check", value: { version: "0.65.0" } });
    await worker("0.65.0");
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt: new Date(), ctx: h.ctx })).toBe("done");
    await settleMail();
    expect(mails).toEqual([]);
    expect(posts).toEqual([]);
  });

  it("a worker that never comes up on the new version is a failure of its own, after 30 minutes", async () => {
    await seedAdmin(h, "owner@velocitymedialab.com");
    await worker("0.64.0");
    const startedAt = new Date(Date.now() - WORKER_WAIT_MS - 1000);
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt, ctx: h.ctx })).toBe("worker_missing");
    await settleMail();
    const [check] = await h.db.select().from(e2eCheck).orderBy(desc(e2eCheck.createdAt));
    expect(check!.status).toBe("failed");
    expect((check!.steps as { detail: string }[])[0]!.detail).toContain("The worker is still on 0.64.0");
    expect(mails).toHaveLength(1);
    // No team channel set: no post, and nothing breaks.
    expect(posts).toEqual([]);
    expect(await autoSiteCheckTick({ db: h.db as Database, version: "0.65.0", startedAt, ctx: h.ctx })).toBe("done");
  });
});

describe("the team Slack channel", () => {
  it("copies the projects' webhook in one click, never shows it, and is for admins", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const id = await createProject(h.ctx, admin.viewer, { clientName: "Valley Air", trade: "hvac", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] });
    await connectSlack(h.ctx, admin.viewer, id, WEBHOOK);

    let view = await loadTeamSlack(h.db as Database);
    expect(view).toEqual({ connected: false, hint: null, projectHint: "WXYZ" });
    const card = renderToStaticMarkup(<TeamSlackCard {...view} />);
    expect(card).toContain("Use the channel your projects post to (ending WXYZ)");
    expect(card).not.toContain("hooks.slack.com/services/T000");

    await expect(copyProjectWebhook(h.ctx, pm.viewer)).rejects.toThrow("Not allowed");
    await copyProjectWebhook(h.ctx, admin.viewer);
    view = await loadTeamSlack(h.db as Database);
    expect(view).toMatchObject({ connected: true, hint: "WXYZ" });
    expect(await postTeamSlack(h.db as Database, "hello")).toBeNull();
    expect(posts).toEqual([{ url: WEBHOOK, text: "hello" }]);
    const [logged] = await h.db.select().from(activityLog).where(eq(activityLog.action, "team_slack.connected"));
    expect(JSON.stringify(logged!.valueAfter)).not.toContain("hooks.slack.com");
  });
});

describe("a new project and the team channel (Jason, 3 November 2026)", () => {
  const input: ProjectInput = { clientName: "Valley Air", trade: "hvac", tier: "starter", lane: "lane_1", laneOption: null, conceptCount: 3, status: "intake", memberUserIds: [] };

  it("starts connected to the team channel, comments off, logged without the address", async () => {
    const admin = await seedAdmin(h);
    await connectTeamSlack(h.ctx, admin.viewer, WEBHOOK);
    const id = await createProject(h.ctx, admin.viewer, input);

    const [row] = await h.db.select().from(projectSlack).where(eq(projectSlack.projectId, id));
    expect(row).toMatchObject({ webhookHint: "WXYZ", postComments: false, connectedByUserId: admin.viewer.id });
    expect(decryptSecret(row!.webhookEncrypted)).toBe(WEBHOOK);
    const [logged] = await h.db.select().from(activityLog).where(and(eq(activityLog.action, "slack.connected"), eq(activityLog.entityId, id)));
    expect(logged!.valueAfter).toEqual({ webhook: "ending WXYZ", from: "team channel" });
    expect(JSON.stringify(logged)).not.toContain("hooks.slack.com");

    // The project's posts go to the team's webhook.
    expect(await sendSlackTest(h.ctx, admin.viewer, id)).toEqual({ ok: true });
    expect(posts.at(-1)!.url).toBe(WEBHOOK);
  });

  it("stays without Slack when no team channel is set", async () => {
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, input);
    expect(await h.db.select().from(projectSlack).where(eq(projectSlack.projectId, id))).toEqual([]);
    expect(await h.db.select().from(activityLog).where(eq(activityLog.action, "slack.connected"))).toEqual([]);
  });

  it("the Site check's test project never joins the team channel", async () => {
    const admin = await seedAdmin(h);
    await connectTeamSlack(h.ctx, admin.viewer, WEBHOOK);
    const id = await createProject(h.ctx, admin.viewer, input, { teamSlack: false });
    expect(await h.db.select().from(projectSlack).where(eq(projectSlack.projectId, id))).toEqual([]);
  });

  it("a team setting that can't be copied never stops the project being created", async () => {
    const admin = await seedAdmin(h);
    await h.db.insert(appSetting).values({ key: "team_slack", value: { hint: "WXYZ", connectedAt: new Date().toISOString() } });
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const id = await createProject(h.ctx, admin.viewer, input);
    expect(id).toBeTruthy();
    expect(await h.db.select().from(projectSlack).where(eq(projectSlack.projectId, id))).toEqual([]);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();
  });
});
