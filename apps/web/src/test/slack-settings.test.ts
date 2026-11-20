import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { activityLog, projectSlack } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import {
  SecretsError,
  decryptSecret,
  encryptSecret,
  hasEncryptionKey,
  setEncryptionKeyForTesting,
} from "@tawd/core/secrets";
import { postProjectSlack, sendToWebhook, setSlackFetchForTesting, slackMessage } from "@tawd/core/slack";
import { deleteProject } from "@/lib/project-deletion";
import { createProject } from "@/lib/projects";
import {
  SlackSettingsError,
  connectSlack,
  disconnectSlack,
  getSlackStatus,
  sendSlackTest,
  setSlackComments,
  slackWarningFor,
} from "@/lib/slack-settings";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

/*
  3d: a project's Slack webhook, encrypted and never shown again, and posts
  that never block anything when Slack fails.
*/

const WEBHOOK = "https://hooks.slack.com/services/T0AAA1/B0BBB2/abcdefGHIJKLmnop1234x9Kq";

let h: Harness;
let posts: { url: string; body: { text: string } }[];
let slackAnswer: () => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

beforeEach(async () => {
  h = await createHarness();
  setEncryptionKeyForTesting(randomBytes(32));
  posts = [];
  slackAnswer = async () => ({ ok: true, status: 200, text: async () => "ok" });
  setSlackFetchForTesting(async (url, init) => {
    posts.push({ url, body: JSON.parse(String(init.body)) });
    return slackAnswer();
  });
});

afterEach(async () => {
  setEncryptionKeyForTesting(null);
  setSlackFetchForTesting(null);
  setStorageForTesting(null);
  await h.close();
});

async function seed() {
  const admin = await seedAdmin(h);
  const projectId = await createProject(h.ctx, admin.viewer, {
    clientName: "Test Plumbing",
    trade: "plumbing",
    tier: "growth",
    lane: "lane_1",
    laneOption: null,
    conceptCount: 3,
    status: "intake",
    memberUserIds: [],
  });
  return { admin, projectId };
}

describe("encryption at rest", () => {
  it("round-trips, with a fresh nonce each time", () => {
    const a = encryptSecret(WEBHOOK);
    const b = encryptSecret(WEBHOOK);
    expect(a).not.toBe(b);
    expect(a).not.toContain("hooks.slack.com");
    expect(decryptSecret(a)).toBe(WEBHOOK);
  });

  it("refuses a tampered value or the wrong key, without saying more", () => {
    const stored = encryptSecret(WEBHOOK);
    const parts = stored.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => decryptSecret(parts.join("."))).toThrow(SecretsError);

    setEncryptionKeyForTesting(randomBytes(32));
    expect(() => decryptSecret(stored)).toThrow(/could not be decrypted/);

    // A shortened tag (Semgrep, 26 September 2026) is refused before decrypting.
    const short = stored.split(".");
    short[2] = Buffer.from(short[2]!, "base64").subarray(0, 4).toString("base64");
    expect(() => decryptSecret(short.join("."))).toThrow(/not in a format/);
  });

  it("says so when the server has no key", () => {
    setEncryptionKeyForTesting(null);
    const previous = process.env.TAWD_ENCRYPTION_KEY;
    delete process.env.TAWD_ENCRYPTION_KEY;
    expect(hasEncryptionKey()).toBe(false);
    expect(() => encryptSecret("x")).toThrow(/not set/);
    if (previous) process.env.TAWD_ENCRYPTION_KEY = previous;
  });
});

describe("connecting a project's Slack", () => {
  it("stores the webhook encrypted, shows only its last four characters, and logs without the URL", async () => {
    const { admin, projectId } = await seed();
    await connectSlack(h.ctx, admin.viewer, projectId, `  ${WEBHOOK}  `);

    const [row] = await h.db.select().from(projectSlack);
    expect(row!.webhookEncrypted).not.toContain("hooks.slack.com");
    expect(decryptSecret(row!.webhookEncrypted)).toBe(WEBHOOK);
    expect(row!.webhookHint).toBe("x9Kq");

    const status = await getSlackStatus(h.db, projectId);
    expect(JSON.stringify(status)).not.toContain("hooks.slack.com");
    expect(status).toMatchObject({ connected: true, hint: "x9Kq", postComments: false });

    const logs = await h.db.select().from(activityLog).where(eq(activityLog.action, "slack.connected"));
    expect(logs).toHaveLength(1);
    expect(JSON.stringify(logs[0])).not.toContain("hooks.slack.com");
  });

  it("refuses anything that isn't a Slack incoming webhook", async () => {
    const { admin, projectId } = await seed();
    for (const bad of ["", "https://example.com/hook", "http://hooks.slack.com/services/A/B/C", `${WEBHOOK}?x=1`]) {
      await expect(connectSlack(h.ctx, admin.viewer, projectId, bad)).rejects.toBeInstanceOf(SlackSettingsError);
    }
  });

  it("is for PMs and admins only", async () => {
    const { admin, projectId } = await seed();
    const seo = await seedUser(h, admin.viewer, { email: "seo@velocitymedialab.com", roles: ["seo"] });
    await expect(connectSlack(h.ctx, seo.viewer, projectId, WEBHOOK)).rejects.toBeInstanceOf(PermissionError);
    await expect(sendSlackTest(h.ctx, seo.viewer, projectId)).rejects.toBeInstanceOf(PermissionError);
  });

  it("replaces, switches comments on, and disconnects, logging each", async () => {
    const { admin, projectId } = await seed();
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK.replace("x9Kq", "Zz11"));
    await setSlackComments(h.ctx, admin.viewer, projectId, true);
    expect(await getSlackStatus(h.db, projectId)).toMatchObject({ hint: "Zz11", postComments: true });

    await disconnectSlack(h.ctx, admin.viewer, projectId);
    expect((await getSlackStatus(h.db, projectId)).connected).toBe(false);
    const actions = (await h.db.select().from(activityLog)).map((l) => l.action);
    expect(actions).toEqual(expect.arrayContaining(["slack.connected", "slack.replaced", "slack.disconnected"]));
  });

  it("says the server isn't set up when the key is missing", async () => {
    const { admin, projectId } = await seed();
    setEncryptionKeyForTesting(null);
    const previous = process.env.TAWD_ENCRYPTION_KEY;
    delete process.env.TAWD_ENCRYPTION_KEY;
    await expect(connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK)).rejects.toThrow(/isn't set up on the server/);
    if (previous) process.env.TAWD_ENCRYPTION_KEY = previous;
  });

  it("is removed with the project", async () => {
    const { admin, projectId } = await seed();
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);
    setStorageForTesting(new FakeR2());
    await deleteProject(h.ctx, admin.viewer, projectId, { confirmName: "Test Plumbing", reason: "Client cancelled the whole thing" });
    expect(await h.db.select().from(projectSlack)).toHaveLength(0);
  });
});

describe("posting", () => {
  it("sends the test message to the saved webhook", async () => {
    const { admin, projectId } = await seed();
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);
    expect(await sendSlackTest(h.ctx, admin.viewer, projectId)).toEqual({ ok: true });
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(WEBHOOK);
    expect(posts[0]!.body.text).toContain("*Test Plumbing*: test message from TAWD");
    expect((await getSlackStatus(h.db, projectId)).lastPostAt).not.toBeNull();
  });

  it("posts nothing without a webhook, and no comments unless switched on", async () => {
    const { admin, projectId } = await seed();
    expect(await postProjectSlack(h.db, projectId, { kind: "concepts_ready", count: 3 })).toEqual({ ok: false, reason: "not_connected" });
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);
    expect(await postProjectSlack(h.db, projectId, { kind: "comment", by: "Priya", conceptId: "c", label: "B" })).toEqual({ ok: false, reason: "comments_off" });
    expect(posts).toHaveLength(0);
  });

  it("never throws when Slack fails: it keeps the reason, shows a warning, and clears it on the next success", async () => {
    const { admin, projectId } = await seed();
    await connectSlack(h.ctx, admin.viewer, projectId, WEBHOOK);

    slackAnswer = async () => ({ ok: false, status: 404, text: async () => "no_service" });
    const result = await postProjectSlack(h.db, projectId, { kind: "concepts_ready", count: 2 });
    expect(result).toMatchObject({ ok: false, reason: "failed" });
    expect(await slackWarningFor(h.db, projectId)).toMatch(/didn't go through .*Slack refused the webhook \(no_service\)/);

    slackAnswer = async () => ({ ok: true, status: 200, text: async () => "ok" });
    await postProjectSlack(h.db, projectId, { kind: "concepts_ready", count: 2 });
    expect(await slackWarningFor(h.db, projectId)).toBeNull();
  });

  it("describes timeouts and unreachable Slack in plain words", async () => {
    slackAnswer = async () => {
      throw Object.assign(new Error("t"), { name: "TimeoutError" });
    };
    expect(await sendToWebhook(WEBHOOK, "x")).toBe("Slack didn't answer within 5 seconds.");
    slackAnswer = async () => {
      throw new Error("ECONNREFUSED");
    };
    expect(await sendToWebhook(WEBHOOK, "x")).toBe("TAWD couldn't reach Slack.");
  });
});

describe("what a post says", () => {
  const url = "https://tawd.example";
  const say = (event: Parameters<typeof slackMessage>[2]) => slackMessage("Tulemark <Plumbing> & Rooter", "p1", event, url);

  it("links back to the right page and escapes Slack's special characters", () => {
    expect(say({ kind: "concepts_ready", count: 3 })).toBe(
      "*Tulemark &lt;Plumbing&gt; &amp; Rooter*: 3 concepts ready for team review. <https://tawd.example/projects/p1/mockups|Open Design>",
    );
    expect(say({ kind: "changes_ready", conceptId: "c9", label: "B", version: 3 })).toContain("/projects/p1/mockups/c9|Open Concept B>");
  });

  it("covers every event, going live included", () => {
    expect(say({ kind: "needs_pm_review", labels: ["B"] })).toContain("Concept B still scored under 3 after a rebuild and needs a PM's look");
    expect(say({ kind: "client_decision", by: "Jason", label: "B", version: 2, approved: true })).toContain("Jason recorded the client's decision: Concept B v2 approved. Moved to Content.");
    expect(say({ kind: "client_decision", by: "Jason", label: "B", version: 2, approved: false })).toContain("changes requested on Concept B, v3 being made");
    expect(say({ kind: "stage_changed", from: "intake", to: "mockups" })).toContain("moved from Intake to Design");
    expect(say({ kind: "stage_changed", from: "qa", to: "live" })).toMatch(/^\*Tulemark .*\* is live\./);
    expect(say({ kind: "comment", by: "Priya", conceptId: "c1", label: "A" })).toContain("Priya commented on Concept A.");
  });

  it("has no field for what the client said, comment text or money", () => {
    // The event types carry none of these, so no caller can pass them in.
    const all = [
      say({ kind: "client_decision", by: "Jason", label: "B", version: 2, approved: true }),
      say({ kind: "comment", by: "Priya", conceptId: "c1", label: "A" }),
    ].join(" ");
    expect(all).not.toMatch(/\$|said|@|\d{3}[-) ]\d{3}/);
  });
});
