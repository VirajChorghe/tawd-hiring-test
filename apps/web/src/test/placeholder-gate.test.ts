import { describe, expect, it } from "vitest";

import { runChecklist } from "@tawd/core/site";

/* F-036: the placeholder gate reads every HTML file (404 included) and catches a labeled photo frame left in a page. */

const page = (body: string) => `<html><head><title>ACME Plumbing</title></head><body><a href="#main">Skip</a><h1>ACME</h1>${body}<a href="tel:+19165550142">Call</a></body></html>`;
const gate = (files: Record<string, string>) =>
  runChecklist({ files: new Map(Object.entries(files)), pagePaths: ["/"], domain: "acme.example", mobileOverflow: [], gbpUrl: "" }).find((i) => i.key === "placeholders")!;

describe("the placeholder gate", () => {
  it("passes a clean site", () => {
    expect(gate({ "index.html": page("<p>Hello</p>"), "404.html": page("<p>Lost</p>") }).ok).toBe(true);
  });

  it("blocks go-live for a placeholder in 404.html", () => {
    const item = gate({ "index.html": page("<p>Hello</p>"), "404.html": page('<p><mark class="tawd-placeholder">[PLACEHOLDER: phone number]</mark></p>') });
    expect(item.ok).toBe(false);
    expect(item.blocksGoLive).toBe(true);
    expect(item.detail).toContain("[PLACEHOLDER: phone number]");
  });

  it("blocks go-live for a labeled photo frame left in a page", () => {
    for (const frame of ['<div class="photo-frame">Photo: technician under a sink</div>', "<figure><span>Photo: our crew</span></figure>"]) {
      const item = gate({ "index.html": page(frame) });
      expect(item.ok, frame).toBe(false);
      expect(item.blocksGoLive).toBe(true);
      expect(item.detail).toContain("Photo:");
    }
  });

  it("does not block a frame that holds a picture, or a card that merely mentions a photo", () => {
    expect(gate({ "index.html": page('<div class="photo-frame"><img src="/images/photo-1.jpg" alt="Crew"></div><div class="card"><h3>Photo gallery</h3><p>See our work.</p></div>') }).ok).toBe(true);
  });
});
