import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/*
  F4 (1 October 2026): proving form messages keep arriving. The monthly
  test to VML's inboxes at the common providers (whoever checks the inbox
  says where it landed), and the weekly check of each live site's form
  (TAWD fills it in, marked, and waits for it; the client isn't emailed).
  Postmark and the live sites are stand-ins.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/admin/system",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));
vi.mock("@/app/actions", () => new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : async () => ({ ok: true })), has: () => true }));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { activityLog, deliveryTest, formHeartbeat, formMessage, goLive, netlifySite, project, wpPreview } from "@tawd/core/schema";
import { PermissionError } from "@tawd/core/permissions";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { signLikeNetlify } from "@tawd/core/forms-relay";
import { createProject } from "@/lib/projects";
import { channelSecret, receiveNetlify, receiveWordpress, setPostmarkFetchForTesting } from "@/lib/forms-relay";
import { answerLabTest, checkAllSites, checkPreviewForm, deliveryTick, loadPreviewCheck, loadDelivery, readInboxes, recordLabEvent, saveInboxes, sendLabTest, setHeartbeatFetchForTesting, sweepHeartbeats } from "@/lib/delivery-checks";
import { DeliveryCard } from "@/components/admin/delivery-card";
import { WpPreviewSection } from "@/components/build/wp-preview-section";
import { createHmac } from "node:crypto";

import { createHarness, seedAdmin, seedUser, type Harness } from "./harness";

let h: Harness;
let sent: Record<string, unknown>[];
let posted: { url: string; body: string }[];

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
  sent = [];
  posted = [];
  setPostmarkFetchForTesting(async (_u, init) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ErrorCode: 0, MessageID: `pm-${sent.length}` });
  });
  setHeartbeatFetchForTesting(async (url, init) => {
    posted.push({ url: String(url), body: String(init?.body) });
    return new Response("thanks", { status: 200 });
  });
  vi.stubEnv("POSTMARK_SERVER_TOKEN", "pm-token");
  vi.stubEnv("FORMS_FROM_EMAIL", "forms@velocitymedialab.com");
  vi.stubEnv("BETTER_AUTH_URL", "https://tawd.velocitymedialab.com");
});

afterEach(async () => {
  setPostmarkFetchForTesting(null);
  setHeartbeatFetchForTesting(null);
  vi.unstubAllEnvs();
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const INBOXES = "vml.test@gmail.com, Gmail\nvml.test@outlook.com, Outlook.com\n\nvml@zohomail.com, Zoho";

describe("the test inboxes", () => {
  it("are read one per line, address then provider, and anything else is named", () => {
    expect(readInboxes(INBOXES)).toEqual({
      inboxes: [
        { address: "vml.test@gmail.com", provider: "Gmail" },
        { address: "vml.test@outlook.com", provider: "Outlook.com" },
        { address: "vml@zohomail.com", provider: "Zoho" },
      ],
      problems: [],
    });
    expect(readInboxes("not an address, Gmail").problems).toEqual(['"not an address, Gmail" isn\'t "address, provider".']);
    expect(readInboxes("a@b.co").inboxes[0]!.provider).toBe("b.co");
  });

  it("are saved by admins; the test goes to each, and whoever checks the inbox says where it landed", async () => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    await expect(saveInboxes(h.ctx, pm.viewer, INBOXES)).rejects.toBeInstanceOf(PermissionError);
    await expect(sendLabTest(h.ctx, admin.viewer)).rejects.toThrow("Add the test inboxes first");
    await saveInboxes(h.ctx, admin.viewer, INBOXES);
    expect(await sendLabTest(h.ctx, admin.viewer)).toBe(3);
    expect(sent.map((e) => e.To)).toEqual(["vml.test@gmail.com", "vml.test@outlook.com", "vml@zohomail.com"]);
    expect(sent[0]).toMatchObject({ From: '"TAWD delivery check website" <forms@velocitymedialab.com>', Subject: "New website message from TAWD delivery check (Gmail)" });

    const tokenOf = (i: number) => /\/forms\/lab\/([A-Za-z0-9_-]+)/.exec(String(sent[i]!.TextBody))![1]!;
    expect(await answerLabTest(h.ctx, tokenOf(0), "inbox")).toEqual({ provider: "Gmail" });
    expect(await answerLabTest(h.ctx, tokenOf(1), "spam")).toEqual({ provider: "Outlook.com" });
    await recordLabEvent(h.db, "pm-3", "bounced", "vml@zohomail.com bounced: unknown user");
    expect(await answerLabTest(h.ctx, "not-a-real-token-at-all-xx", "inbox")).toBeNull();

    const view = await loadDelivery(h.db);
    expect(view.inboxes.map((i) => [i.provider, i.status])).toEqual([
      ["Gmail", "inbox"],
      ["Outlook.com", "spam"],
      ["Zoho", "bounced"],
    ]);
    const tests = await h.db.select().from(deliveryTest);
    expect(tests.every((t) => !t.tokenHash.includes(tokenOf(0)))).toBe(true);
  });
});

async function liveSite() {
  const admin = await seedAdmin(h);
  const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "live", memberUserIds: [], tier: "growth", clientName: "Harbor Pest" });
  await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-harbor", url: "https://tawd-harbor.netlify.app", formEmails: [] });
  await h.db.insert(goLive).values({ projectId: id, domain: "harborpest.com", wentLiveAt: new Date() } as never);
  return { admin, id };
}

describe("each live site's form, every week", () => {
  it("is filled in, marked, and recorded when it reaches TAWD, without emailing the client", async () => {
    const { admin, id } = await liveSite();
    expect(await checkAllSites(h.ctx, admin.viewer)).toBe(1);
    expect(posted[0]!.url).toBe("https://harborpest.com/");
    const body = new URLSearchParams(posted[0]!.body);
    expect(body.get("form-name")).toBe("contact");
    const token = /TAWD-HEARTBEAT ([A-Za-z0-9_-]+)/.exec(body.get("message")!)![1]!;

    // Netlify sends it on to TAWD, as it does every message.
    const raw = JSON.stringify({ id: "sub-hb", form_name: "contact", data: { name: "TAWD weekly check", message: body.get("message") } });
    expect(await receiveNetlify(h.ctx, "site-1", raw, signLikeNetlify(raw, await channelSecret(h.db, id)))).toBe("ok");
    expect(sent).toHaveLength(0);
    expect(await h.db.select().from(formMessage)).toHaveLength(0);
    const [beat] = await h.db.select().from(formHeartbeat).where(eq(formHeartbeat.projectId, id));
    expect(beat).toMatchObject({ token, status: "received" });
    expect((await loadDelivery(h.db)).sites[0]).toMatchObject({ clientName: "Harbor Pest", domain: "harborpest.com", status: "received" });
  });

  it("not arriving within an hour is logged and posted", async () => {
    const { admin, id } = await liveSite();
    await checkAllSites(h.ctx, admin.viewer);
    expect(await sweepHeartbeats(h.db, new Date(Date.now() + 61 * 60_000))).toBe(1);
    const [beat] = await h.db.select().from(formHeartbeat).where(eq(formHeartbeat.projectId, id));
    expect(beat).toMatchObject({ status: "missing", detail: "Nothing came back within an hour." });
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "delivery.site_form_missing"))).length).toBe(1);
  });

  it("runs by itself on Mondays (weekly) and the inbox test on the 1st (monthly), once each", async () => {
    const { admin } = await liveSite();
    await saveInboxes(h.ctx, admin.viewer, "vml.test@gmail.com, Gmail");
    const monday1st = new Date("2026-06-01T09:00:00Z");
    await deliveryTick(h.db, monday1st);
    expect(posted).toHaveLength(1);
    expect(sent).toHaveLength(1);
    await deliveryTick(h.db, new Date(monday1st.getTime() + 60 * 60_000));
    expect(posted).toHaveLength(1);
    expect(sent).toHaveLength(1);
    await deliveryTick(h.db, new Date("2026-06-02T09:00:00Z"));
    expect(posted).toHaveLength(1);
  });

  it("still runs on Monday when a preview's form was checked by hand that week (13 October 2026)", async () => {
    const { id } = await liveSite();
    await h.db.insert(formHeartbeat).values({ projectId: id, token: "by-hand", status: "preview", sentAt: new Date("2026-06-01T08:00:00Z") });
    // A preview check by hand that failed reads "failed" like a live one (CodeRabbit, PR #14): it mustn't stand in for the weekly run either.
    await h.db.insert(formHeartbeat).values({ projectId: id, token: "by-hand-2", status: "failed", sentAt: new Date("2026-06-01T08:30:00Z") });
    await deliveryTick(h.db, new Date("2026-06-01T09:00:00Z"));
    expect(posted).toHaveLength(1);
  });
});

describe("the card", () => {
  it("shows the inboxes with where the test landed, and each live site's form", () => {
    const html = renderToStaticMarkup(
      <DeliveryCard
        configured
        inboxesText="vml.test@gmail.com, Gmail"
        inboxes={[
          { address: "vml.test@gmail.com", provider: "Gmail", status: "inbox", line: "today" },
          { address: "vml.test@outlook.com", provider: "Outlook.com", status: "spam", line: null },
        ]}
        lastRunLine="Last sent today."
        sites={[{ projectId: "p1", clientName: "Harbor Pest", domain: "harborpest.com", status: "missing", line: "Nothing came back within an hour." }]}
      />,
    );
    expect(html).toContain("Test inboxes");
    expect(html).toContain(">Inbox<");
    expect(html).toContain(">Spam<");
    expect(html).toContain("Send the delivery test now");
    expect(html).toContain("Not arriving");
    expect(html).toContain("Check all now");
  });
});

describe("Gravity Forms sites (1 October 2026)", () => {
  let seen: { url: string; headers: Record<string, string>; body: string }[];
  const wpSite = async (state: "live" | null) => {
    const admin = await seedAdmin(h);
    const pm = await seedUser(h, admin.viewer, { email: "pm@velocitymedialab.com", roles: ["pm"] });
    const content = await seedUser(h, admin.viewer, { email: "content@velocitymedialab.com", roles: ["content"] });
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "pro", clientName: "Nora Beagle Site" });
    await h.db.update(project).set({ hosting: "wordpress", formPlugin: "gravityforms" }).where(eq(project.id, id));
    await h.db.insert(wpPreview).values({ projectId: id, name: "nora-beagle-site", host: "nora-beagle-site.fba.ici.mybluehost.me", dir: "tawd-sites/nora-beagle-site", dbName: "x", dbUser: "x", dbPasswordEncrypted: "x", adminUser: "tawd-vml", adminPasswordEncrypted: "x", state: "ready", liveState: state, liveDomain: state ? "norabeagle.com" : null } as never);
    await channelSecret(h.db, id);
    seen = [];
    setHeartbeatFetchForTesting(async (url, init) => {
      seen.push({ url: String(url), headers: init?.headers as Record<string, string>, body: String(init?.body) });
      return Response.json({ ok: true, relayed: true });
    });
    return { admin, pm, content, id };
  };
  const signedRight = async (id: string, sent: { headers: Record<string, string>; body: string }) => {
    const [at, mac] = sent.headers["X-Tawd-Signature"]!.split(".");
    return mac === createHmac("sha256", await channelSecret(h.db, id)).update(`${at}.${sent.body}`).digest("hex");
  };
  // What the theme sends on once Gravity Forms has the entry (gform_entry_created), signed the same way.
  const relayed = async (id: string, message: string) => {
    const raw = JSON.stringify({ form: "contact", id: "gf-41", fields: { name: "TAWD weekly check", message }, labels: { name: "Name", message: "Message" }, files: [] });
    const at = Math.floor(Date.now() / 1000);
    return receiveWordpress(h.ctx, id, raw, `${at}.${createHmac("sha256", await channelSecret(h.db, id)).update(`${at}.${raw}`).digest("hex")}`);
  };

  it("are in the weekly check: signed with the site's key, through the theme's check, recorded when it arrives, never emailed", async () => {
    const { admin, id } = await wpSite("live");
    expect(await checkAllSites(h.ctx, admin.viewer)).toBe(1);
    expect(seen[0]!.url).toBe("https://norabeagle.com/wp-json/tawd/v1/check");
    expect(await signedRight(id, seen[0]!)).toBe(true);
    const message = (JSON.parse(seen[0]!.body) as { message: string }).message;
    expect(message).toMatch(/^TAWD-HEARTBEAT [A-Za-z0-9_-]{16,64} /);
    expect(await relayed(id, message)).toBe("ok");
    expect(sent).toHaveLength(0);
    expect(await h.db.select().from(formMessage)).toHaveLength(0);
    expect((await loadDelivery(h.db)).sites[0]).toMatchObject({ clientName: "Nora Beagle Site", domain: "norabeagle.com", status: "received" });
  });

  it("say why when the site refuses the check", async () => {
    const { admin, id } = await wpSite("live");
    setHeartbeatFetchForTesting(async () => Response.json({ code: "tawd_gf", message: "Gravity Forms refused it: Phone is required." }, { status: 422 }));
    await checkAllSites(h.ctx, admin.viewer);
    const [beat] = await h.db.select().from(formHeartbeat).where(eq(formHeartbeat.projectId, id));
    expect(beat).toMatchObject({ status: "failed", detail: "The site answered 422: Gravity Forms refused it: Phone is required." });
  });

  it("can have the preview's form checked by hand (PMs and admins), which the hourly sweep leaves alone", async () => {
    const { pm, content, id } = await wpSite(null);
    await expect(checkPreviewForm(h.ctx, content.viewer, id)).rejects.toBeInstanceOf(PermissionError);
    await checkPreviewForm(h.ctx, pm.viewer, id);
    expect(seen[0]!.url).toBe("https://nora-beagle-site.fba.ici.mybluehost.me/wp-json/tawd/v1/check");
    expect((await loadPreviewCheck(h.db, id))!.status).toBe("preview");
    expect(await sweepHeartbeats(h.db, new Date(Date.now() + 61 * 60_000))).toBe(0);
    expect(await relayed(id, (JSON.parse(seen[0]!.body) as { message: string }).message)).toBe("ok");
    expect((await loadPreviewCheck(h.db, id))!.status).toBe("received");
    expect((await h.db.select().from(activityLog).where(eq(activityLog.action, "delivery.preview_form_checked"))).length).toBe(1);

    const card = (formCheck: { status: string; at: string; detail: string | null } | null) =>
      renderToStaticMarkup(<WpPreviewSection projectId={id} state="ready" host="nora-beagle-site.fba.ici.mybluehost.me" version={1} deployedVersion={1} latestBuild={1} https steps={[]} removing={false} blockers={[]} canDeploy isAdmin={false} statusLine={null} gravityForms formCheck={formCheck} />);
    expect(card(null)).toContain("Check the form");
    expect(card({ status: "received", at: "1 Oct, 3:04 pm", detail: null })).toContain("Form check: arrived in TAWD, 1 Oct, 3:04 pm.");
    expect(card({ status: "failed", at: "1 Oct, 3:04 pm", detail: "The site answered 404." })).toContain("didn&#x27;t go through");
  });

  it("aren't checked by hand once live, or with Contact Form 7", async () => {
    const live = await wpSite("live");
    await expect(checkPreviewForm(h.ctx, live.admin.viewer, live.id)).rejects.toThrow("The site is live");
    await h.db.update(wpPreview).set({ liveState: null }).where(eq(wpPreview.projectId, live.id));
    await h.db.update(project).set({ formPlugin: "cf7" }).where(eq(project.id, live.id));
    await expect(checkPreviewForm(h.ctx, live.admin.viewer, live.id)).rejects.toThrow("This check is for Gravity Forms sites");
  });
});

