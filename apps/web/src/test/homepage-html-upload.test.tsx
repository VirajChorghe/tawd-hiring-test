import { eq } from "drizzle-orm";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileKinds, fileRules, checkUpload, type FileKind } from "@tawd/core/intake";
import { looksLikeHtml, matchesDeclaredDocument } from "../../../../packages/core/src/lib/intake/sniff";
import { intakeFile } from "@tawd/core/schema";
import { setStorageForTesting } from "@tawd/core/intake/storage";
import { confirmUpload, requestUpload } from "@tawd/core/intake/service";
import { createProject } from "@/lib/projects";
import { HomepageHtmlSection } from "@/components/intake/homepage-html-section";
import { createHarness, seedAdmin, type Harness } from "./harness";
import { FakeR2 } from "./worker-fakes";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push() {}, refresh() {} }),
  usePathname: () => "/projects",
}));
vi.mock("@/app/actions", () => {
  const f = async () => ({ ok: true });
  return new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : f), has: () => true });
});

/*
  The finished-homepage upload (an HTML file, the direct route). HTML is
  accepted for that one kind and refused for every other, whatever its
  name or declared type says (F-041: the bytes are the fact).
*/

const PAGE = "<!doctype html>\n<html lang=\"en\"><head><title>Homepage</title></head><body><h1>Hi</h1></body></html>";
const HTML = Buffer.from(PAGE);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40, 1)]);
const MB = 1024 * 1024;

describe("homepage_html upload rules", () => {
  it("is a kind with the agreed limits", () => {
    expect(fileKinds).toContain("homepage_html");
    expect(fileRules.homepage_html).toMatchObject({
      label: "Finished homepage (HTML)",
      contentTypes: ["text/html"],
      maxBytes: 10 * MB,
      maxCount: 1,
      accept: ".html,.htm",
    });
  });

  it("takes text/html, and takes a file whose browser gave no type when the name says html", () => {
    expect(checkUpload("homepage_html", "text/html", 500_000, 0, "home.html")).toEqual({ ok: true });
    expect(checkUpload("homepage_html", "", 500_000, 0, "home.html")).toEqual({ ok: true });
    expect(checkUpload("homepage_html", "application/octet-stream", 500_000, 0, "Home.HTM")).toEqual({ ok: true });
  });

  it("never lets a name overrule a type the browser did give", () => {
    expect(checkUpload("homepage_html", "image/png", 1000, 0, "home.html")).toMatchObject({ ok: false });
    expect(checkUpload("homepage_html", "application/pdf", 1000, 0, "home.html")).toMatchObject({ ok: false });
  });

  it("refuses an empty file, one over 10 MB, and a second one", () => {
    expect(checkUpload("homepage_html", "text/html", 0, 0, "a.html")).toMatchObject({ ok: false, message: "That file appears to be empty." });
    expect(checkUpload("homepage_html", "text/html", 10 * MB + 1, 0, "a.html")).toMatchObject({ ok: false, message: expect.stringMatching(/10 MB or smaller/) });
    expect(checkUpload("homepage_html", "text/html", 1000, 1, "a.html")).toMatchObject({
      ok: false,
      message: "There is already a finished homepage (html). Remove it first.",
    });
  });

  it("refuses HTML (by type, or by an .html name with no type) for every other kind", () => {
    const others = fileKinds.filter((k): k is Exclude<FileKind, "homepage_html"> => k !== "homepage_html");
    expect(others.length).toBeGreaterThan(0);
    for (const kind of others) {
      expect(checkUpload(kind, "text/html", 1000, 0, "home.html"), `${kind} by type`).toMatchObject({ ok: false });
      expect(checkUpload(kind, "", 1000, 0, "home.html"), `${kind} by name`).toMatchObject({ ok: false });
      expect(checkUpload(kind, "application/octet-stream", 1000, 0, "home.htm"), `${kind} by .htm name`).toMatchObject({ ok: false });
      expect(fileRules[kind].contentTypes, `${kind} rules`).not.toContain("text/html");
    }
  });
});

describe("the byte check for HTML", () => {
  it("accepts real documents: doctype, html tag, BOM, white space, leading comments, any case", () => {
    expect(looksLikeHtml(HTML)).toBe(true);
    expect(looksLikeHtml(Buffer.from("<html><body></body></html>"))).toBe(true);
    expect(looksLikeHtml(Buffer.from("﻿\n  <!DOCTYPE HTML PUBLIC \"-//W3C//DTD HTML 4.01//EN\">\n<HTML>"))).toBe(true);
    expect(looksLikeHtml(Buffer.from("<!-- saved from a browser -->\n<!-- v2 -->\n<!doctype html><html>"))).toBe(true);
  });

  it("refuses what is not a document", () => {
    for (const bad of [
      "<script>alert(1)</script>",
      "<div>just a fragment</div>",
      "hello, this mentions <html> later",
      "%PDF-1.7\n<html>",
      "<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>",
      "<!doctype svg><html>",
      "",
    ]) {
      expect(looksLikeHtml(Buffer.from(bad)), bad).toBe(false);
    }
    expect(looksLikeHtml(PNG)).toBe(false);
    expect(looksLikeHtml(Buffer.concat([Buffer.from("<html>"), Buffer.from([0]), Buffer.from("x")]))).toBe(false);
  });

  it("is what a declared text/html is judged by, and by nothing else", () => {
    expect(matchesDeclaredDocument("text/html", HTML)).toBe(true);
    expect(matchesDeclaredDocument("text/html", PNG)).toBe(false);
    expect(matchesDeclaredDocument("text/html", Buffer.from("plain words"))).toBe(false);
  });
});

describe("confirming an HTML upload", () => {
  let h: Harness;
  let r2: FakeR2;
  let seeded: Awaited<ReturnType<typeof seedProject>> | null = null;

  beforeEach(async () => {
    h = await createHarness();
    r2 = new FakeR2();
    seeded = null;
    setStorageForTesting(r2);
  });
  afterEach(async () => {
    setStorageForTesting(null);
    await h.close();
  });

  async function seedProject() {
    const admin = await seedAdmin(h);
    const projectId = await createProject(h.ctx, admin.viewer, {
      clientName: "Sacramento Drain Pros",
      trade: "plumbing",
      tier: "starter",
      lane: "lane_2",
      laneOption: "a",
      conceptCount: 1,
      status: "intake",
      memberUserIds: [],
    });
    return { admin, projectId };
  }
  async function arrive(kind: FileKind, name: string, type: string, body: Buffer) {
    seeded ??= await seedProject();
    const { admin, projectId } = seeded;
    const ticket = await requestUpload(h.ctx, admin.viewer, projectId, kind, name, type, body.length);
    r2.objects.set(ticket.uploadUrl, body);
    return { admin, ticket, key: ticket.uploadUrl };
  }
  const rowOf = async (id: string) => (await h.db.select().from(intakeFile).where(eq(intakeFile.id, id)))[0];

  it("keeps a real HTML homepage as text/html, reading only its first bytes", async () => {
    const { admin, ticket } = await arrive("homepage_html", "home.html", "text/html", HTML);
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    expect(await rowOf(ticket.fileId)).toMatchObject({ status: "ready", kind: "homepage_html", contentType: "text/html", fileName: "home.html" });
    expect(r2.gets).toEqual([]);
  });

  it("keeps it when the browser gave no type but the name says .html", async () => {
    const { admin, ticket } = await arrive("homepage_html", "home.html", "", HTML);
    await confirmUpload(h.ctx, admin.viewer, ticket.fileId);
    expect(await rowOf(ticket.fileId)).toMatchObject({ status: "ready", contentType: "text/html" });
  });

  it("refuses a .html name whose bytes are not HTML, and removes the object and the record", async () => {
    for (const body of [PNG, Buffer.from("<script>alert(1)</script>"), Buffer.from("just some words")]) {
      r2.objects.clear();
      const { admin, ticket, key } = await arrive("homepage_html", "home.html", "text/html", body);
      await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId)).rejects.toThrow(/isn't the kind of file its name says/);
      expect(r2.objects.has(key)).toBe(false);
      expect(await rowOf(ticket.fileId)).toBeUndefined();
    }
  });

  it("will not take a second homepage while one is saved", async () => {
    const first = await arrive("homepage_html", "home.html", "text/html", HTML);
    await confirmUpload(h.ctx, first.admin.viewer, first.ticket.fileId);
    await expect(requestUpload(h.ctx, first.admin.viewer, seeded!.projectId, "homepage_html", "again.html", "text/html", HTML.length)).rejects.toThrow(/Remove it first/);
  });

  it("refuses HTML for every other kind: the request is refused outright", async () => {
    seeded ??= await seedProject();
    for (const kind of fileKinds.filter((k) => k !== "homepage_html")) {
      await expect(
        requestUpload(h.ctx, seeded.admin.viewer, seeded.projectId, kind, "home.html", "text/html", HTML.length),
        `${kind} as text/html`,
      ).rejects.toThrow(/must be one of/);
      await expect(
        requestUpload(h.ctx, seeded.admin.viewer, seeded.projectId, kind, "home.html", "", HTML.length),
        `${kind} with an .html name and no type`,
      ).rejects.toThrow(/must be one of/);
    }
  });

  it("refuses HTML bytes dressed as any other kind's own type: logo, photo, design and PDF kinds", async () => {
    const cases: [FileKind, string, string, RegExp][] = [
      ["logo", "logo.png", "image/png", /isn't the image its name says/],
      ["logo", "logo.svg", "image/svg+xml", /isn't the image its name says/],
      ["photo", "van.jpg", "image/jpeg", /isn't the image its name says/],
      ["design_file", "page.png", "image/png", /isn't the image its name says/],
      ["design_file", "design.pdf", "application/pdf", /isn't the kind of file its name says/],
      ["brand_guide", "guide.pdf", "application/pdf", /isn't the kind of file its name says/],
    ];
    for (const [kind, name, type, error] of cases) {
      r2.objects.clear();
      const { admin, ticket, key } = await arrive(kind, name, type, HTML);
      await expect(confirmUpload(h.ctx, admin.viewer, ticket.fileId), `${kind} ${name}`).rejects.toThrow(error);
      expect(r2.objects.has(key), `${kind} ${name} object removed`).toBe(false);
      expect(await rowOf(ticket.fileId)).toBeUndefined();
    }
  });
});

describe("the screen", () => {
  it("says only what is true today, and shows a saved file's name, size and a way to remove it", () => {
    const html = renderToStaticMarkup(
      <HomepageHtmlSection
        projectId="p1"
        canEdit
        files={[{ id: "f1", kind: "homepage_html", fileName: "sb-marketing-homepage-option-3.html", sizeBytes: 512 * 1024, caption: null }]}
      />,
    );
    expect(html).toContain("Finished homepage (HTML)");
    expect(html).toContain("sb-marketing-homepage-option-3.html");
    expect(html).toContain("Uploaded and saved, 512 KB");
    expect(html).toContain("Remove");
    expect(html).toContain("Uploading it costs nothing: TAWD reads the file by itself as soon as it is saved, with no AI and no charge");
    expect(html).toContain("puts the page on the Mockups board as concept S");
    expect(html).toContain("the site build keeps this page as the home page and builds the other pages from its design");
    // The old "not used yet" wording is gone: it was untrue once the reading existed.
    expect(html).not.toContain("TAWD does not use this file yet.");
    expect(html).toContain("To replace it, remove it first, then upload the new one.");
  });

  it("offers the upload when empty, and no upload to someone who may not change it", () => {
    const empty = renderToStaticMarkup(<HomepageHtmlSection projectId="p1" canEdit files={[]} />);
    expect(empty).toContain("Drop the HTML file here, or choose a file");
    expect(empty).toContain("HTML, HTM, up to 10 MB.");
    const locked = renderToStaticMarkup(<HomepageHtmlSection projectId="p1" canEdit={false} files={[]} />);
    expect(locked).not.toContain("Drop the HTML file here");
    expect(locked).toContain("Only a PM or an admin can change this file.");
  });
});
