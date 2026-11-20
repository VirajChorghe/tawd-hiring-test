import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse } from "@wordpress/block-serialization-default-parser";

/*
  F1, Website forms (1 October 2026, docs/plans/forms-email-domains.md):
  who gets the site's messages and what its forms ask, chosen in the
  intake; the forms written by code in the AI's own look; Netlify's emails
  following a change at once; Contact Form 7 taking the new field types.
*/

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
  notFound: () => {
    throw new Error("notFound");
  },
}));

import { setDbForTesting, type Database } from "@tawd/core/db";
import { netlifySite } from "@tawd/core/schema";
import { emptyIntake, intakeSectionKeys, parseIntake, type IntakeData } from "@tawd/core/intake";
import { saveIntakeSection } from "@tawd/core/intake/service";
import { setEncryptionKeyForTesting } from "@tawd/core/secrets";
import { applyForms, formDefinition, htmlToBlocks, netlifyForms, thankYouMain } from "@tawd/core/site";
import { createProject } from "@/lib/projects";
import { formRecipients, setNetlifyFetchForTesting, syncFormRecipients } from "@/lib/netlify";
import { SectionBody } from "@/components/intake/section-body";

import { createHarness, seedAdmin, type Harness } from "./harness";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
  setDbForTesting(h.db as Database);
  setEncryptionKeyForTesting(randomBytes(32));
});

afterEach(async () => {
  setNetlifyFetchForTesting(null);
  vi.unstubAllEnvs();
  setEncryptionKeyForTesting(null);
  setDbForTesting(null);
  await h.close();
});

const intake = (forms: Partial<IntakeData["forms"]> = {}, email = "owner@harbor.example"): IntakeData => {
  const data = emptyIntake();
  return parseIntake({
    ...data,
    business: { ...data.business, email },
    services: { items: [{ id: "s1", name: "Termite treatment" }, { id: "s2", name: "Rodent control" }] },
    forms: { ...data.forms, ...forms },
  });
};

/* A form as the AI writes one: its own classes, a line above the fields and one under the button. */
const AI_FORM = `<section class="contact"><h2>Get in touch</h2><form class="quote-card" id="c1"><p class="form-lead">We reply the same day.</p><div class="field"><label class="lbl" for="x">Your name</label><input class="box" id="x" name="name"></div><div class="field"><label class="lbl" for="y">Message</label><textarea class="box box-tall" id="y" name="message"></textarea></div><button class="btn btn-tan" type="submit">Send it</button><p class="small-print">No spam, ever.</p></form></section>`;

describe("the Website forms section", () => {
  it("is the tenth section, empty by default, and parses what's saved", () => {
    expect(intakeSectionKeys).toEqual(["business", "website", "services", "serviceAreas", "brand", "photos", "content", "forms", "process", "extras"]);
    expect(emptyIntake().forms).toEqual({ recipients: [], fields: [], quoteForm: null, thankYouLine: "" });
    expect(parseIntake({ forms: { recipients: [" a@b.co ", ""], fields: [{ key: "photos" }] } }).forms).toMatchObject({ recipients: ["a@b.co"], fields: [{ key: "photos", required: false }] });
  });

  it("sends to the addresses given, else the business email; the standard fields when none are chosen", () => {
    const standard = formDefinition(intake());
    expect(standard.recipients).toEqual(["owner@harbor.example"]);
    expect(standard.fields.map((f) => [f.key, f.required])).toEqual([
      ["name", true],
      ["phone", true],
      ["email", false],
      ["message", true],
    ]);
    const chosen = formDefinition(intake({ recipients: ["office@harbor.example", "not an email", "office@harbor.example"], fields: [{ key: "service", required: true }, { key: "photos", required: false }] }));
    expect(chosen.recipients).toEqual(["office@harbor.example"]);
    expect(chosen.fields.map((f) => f.key)).toEqual(["name", "service", "photos"]);
    expect(chosen.fields[1]!.options).toEqual(["Termite treatment", "Rodent control", "Something else"]);
    expect(formDefinition(intake({}, "")).recipients).toEqual([]);
  });
});

describe("the forms on the site", () => {
  it("are written from the client's choices, in the AI's own look, keeping what it put around the fields", () => {
    const def = formDefinition(intake({ fields: [{ key: "phone", required: true }, { key: "service", required: false }, { key: "emergency", required: false }] }));
    const html = applyForms(AI_FORM, def, { isContact: false });
    expect(html).toContain('<form name="contact" class="quote-card" id="c1"><p class="form-lead">We reply the same day.</p>');
    expect(html).toContain('<div class="field"><label class="lbl" for="contact-name">Name</label><input class="box" type="text" id="contact-name" name="name" autocomplete="name" required></div>');
    expect(html).toContain('<input class="box" type="tel" id="contact-phone" name="phone" autocomplete="tel" required>');
    expect(html).toContain('<label class="lbl" for="contact-service">Service needed (optional)</label><select class="box" id="contact-service" name="service"><option value="">Choose one</option><option>Termite treatment</option>');
    expect(html).toContain('<label class="lbl"><input type="checkbox" id="contact-emergency" name="emergency" value="Yes"> This is an emergency</label>');
    expect(html).toContain('<button type="submit" class="btn btn-tan">Send it</button><p class="small-print">No spam, ever.</p></form>');
    // The AI's own "Message" box went: it wasn't chosen.
    expect(html).not.toContain('name="message"');
    // Then Netlify's attributes, as before.
    const netlify = netlifyForms(html);
    expect(netlify).toContain('<form name="contact" method="POST" action="/thank-you/" data-netlify="true" netlify-honeypot="bot-field" class="quote-card" id="c1">');
  });

  it("asks everything on Contact as Request a quote, and stays short elsewhere; a photo makes the form send files", () => {
    const def = formDefinition(intake({ quoteForm: true, fields: [{ key: "phone", required: true }, { key: "address", required: false }, { key: "photos", required: false }, { key: "message", required: true }] }));
    const contact = applyForms(AI_FORM, def, { isContact: true });
    expect(contact).toContain('<form name="quote" class="quote-card" id="c1" enctype="multipart/form-data">');
    expect(contact).toContain('name="address"');
    expect(contact).toContain('<input class="box" type="file" id="quote-photos" name="photos" accept="image/*"><small>One photo, up to 8 MB.</small>');
    expect(contact).toContain(">Request a quote</button>");
    const home = applyForms(AI_FORM, def, { isContact: false });
    expect(home).not.toContain('name="address"');
    expect(home).not.toContain('name="photos"');
    expect(home).toContain('name="message"');
    expect(netlifyForms(contact)).toContain('enctype="multipart/form-data"');
  });

  it("leaves a page with no form alone, and puts the client's thank-you line on the thank-you page", () => {
    expect(applyForms("<section><h1>Hi</h1></section>", formDefinition(intake()), { isContact: false })).toBe("<section><h1>Hi</h1></section>");
    const facts = { name: "Harbor Pest", phone: "(916) 555-0100" } as Parameters<typeof thankYouMain>[0];
    expect(thankYouMain(facts, "We call back within the hour, 7 days a week.")).toContain("<p>We call back within the hour, 7 days a week.</p>");
    expect(thankYouMain(facts)).toContain("Harbor Pest will get back to you as soon as we can.");
  });

  it("become Contact Form 7 forms with photos, tickboxes and a 'Choose one' list on WordPress", () => {
    const def = formDefinition(intake({ fields: [{ key: "service", required: true }, { key: "photos", required: false }, { key: "textConsent", required: true }] }));
    const { markup, forms } = htmlToBlocks(applyForms(AI_FORM, def, { isContact: false }));
    expect(parse(markup).filter((b) => b.blockName).length).toBeGreaterThan(0);
    const t = forms[0]!.template;
    expect(t).toContain('[select* service id:contact-service class:box include_blank "Termite treatment" "Rodent control" "Something else"]');
    expect(t).toContain("[file photos id:contact-photos class:box limit:8mb filetypes:jpg|jpeg|png|gif|webp|heic]");
    expect(t).toContain("[acceptance textConsent id:contact-textConsent]");
    expect(forms[0]!.fields.map((f) => [f.name, f.label])).toEqual([
      ["name", "Name"],
      ["service", "Service needed"],
      ["photos", "Photos (optional)"],
      ["textConsent", "It's OK to text me about my request"],
    ]);
    expect(forms[0]!.notes).toEqual([]);
  });
});

describe("who Netlify emails", () => {
  it("follows the intake at once: old addresses off, new ones on, VML's copy kept", async () => {
    vi.stubEnv("NETLIFY_AUTH_TOKEN", "test-token");
    vi.stubEnv("NETLIFY_FORM_COPY_EMAIL", "sites@vml.example");
    const admin = await seedAdmin(h);
    const id = await createProject(h.ctx, admin.viewer, { trade: "pest_control", lane: "lane_1", laneOption: null, conceptCount: 1, status: "build", memberUserIds: [], tier: "growth", clientName: "Harbor Pest" });
    await saveIntakeSection(h.ctx, admin.viewer, id, "business", { ...emptyIntake().business, email: "owner@harbor.example" });
    expect(await formRecipients(h.db, admin.viewer, id)).toEqual(["owner@harbor.example", "sites@vml.example"]);
    // Before the first deploy there's nothing on Netlify to change.
    expect(await syncFormRecipients(h.db, admin.viewer, id)).toEqual({ changed: false, emails: [] });

    await h.db.insert(netlifySite).values({ projectId: id, siteId: "site-1", name: "tawd-harbor", url: "https://tawd-harbor.netlify.app", formEmails: ["owner@harbor.example", "sites@vml.example"] });
    const calls: string[] = [];
    let hooks = [
      { id: "h1", type: "email", event: "submission_created", data: { email: "owner@harbor.example" } },
      { id: "h2", type: "email", event: "submission_created", data: { email: "sites@vml.example" } },
      { id: "h3", type: "url", event: "submission_created", data: {} },
    ];
    setNetlifyFetchForTesting(async (url, init) => {
      const path = String(url).replace("https://api.netlify.com/api/v1", "");
      calls.push(`${init?.method} ${path}`);
      if (init?.method === "DELETE") {
        hooks = hooks.filter((hk) => !path.endsWith(hk.id));
        return new Response(null, { status: 204 });
      }
      if (init?.method === "POST") return Response.json({ id: "h4" });
      return Response.json(hooks);
    });
    await saveIntakeSection(h.ctx, admin.viewer, id, "forms", { recipients: ["office@harbor.example", "jobs@harbor.example"], fields: [] });
    const result = await syncFormRecipients(h.db, admin.viewer, id);
    expect(result).toEqual({ changed: true, emails: ["office@harbor.example", "jobs@harbor.example", "sites@vml.example"] });
    expect(calls).toEqual(["GET /hooks?site_id=site-1", "DELETE /hooks/h1", "POST /hooks", "POST /hooks"]);
    const [site] = await h.db.select().from(netlifySite).where(eq(netlifySite.projectId, id));
    expect(site!.formEmails).toEqual(["office@harbor.example", "jobs@harbor.example", "sites@vml.example"]);
  });
});

describe("the intake screen", () => {
  it("shows where messages go, the field list with Required, the quote form and the thank-you line", () => {
    const html = renderToStaticMarkup(
      <SectionBody
        section="forms"
        projectId="p1"
        values={{ recipients: [], fields: [], quoteForm: null, thankYouLine: "" }}
        onChange={() => {}}
        files={[]}
        captions={{}}
        onCaptionChange={() => {}}
        completeness={{ missing: [], requirements: [] } as never}
        tierWarning={null}
        canEdit
        canChangeTier={false}
        businessEmail="owner@harbor.example"
        serviceCount={0}
      />,
    );
    expect(html).toContain("Website forms");
    expect(html).toContain("Send website messages to");
    expect(html).toContain("Blank: the business email (owner@harbor.example).");
    expect(html).toContain("Add another address");
    expect(html).toContain("Always");
    expect(html).toContain("Add the services under Services first.");
    expect(html).toContain("Request a quote form");
    expect(html).toContain("Thank-you line");
    // The standard fields show ticked, each with its Required box.
    expect(html.match(/> Required/g)).toHaveLength(3);

    const none = renderToStaticMarkup(
      <SectionBody
        section="forms"
        projectId="p1"
        values={{ recipients: ["oops"], fields: [], quoteForm: null, thankYouLine: "" }}
        onChange={() => {}}
        files={[]}
        captions={{}}
        onCaptionChange={() => {}}
        completeness={{ missing: [], requirements: [] } as never}
        tierWarning={null}
        canEdit
        canChangeTier={false}
        businessEmail=""
      />,
    );
    expect(none).toContain("t an email address.");
  });
});
