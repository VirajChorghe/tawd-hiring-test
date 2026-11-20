import { describe, expect, it } from "vitest";

import { goLiveSteps } from "@/lib/next-step";

/*
  The whole-code review (13 October 2026): the Next step card's go-live
  steps follow the way the site goes live, as the gate does, so the last
  one done hands Go live to the founders on every path.
*/

const at = new Date("2026-10-13T10:00:00Z");
const row = (done: string[], connectPath: string | null) => Object.fromEntries([["connectPath", connectPath], ...done.map((k) => [k, at])]) as never;
const titles = (steps: { title: string }[]) => steps.map((s) => s.title);

describe("the go-live steps on the Next step card", () => {
  it("two records at the client's DNS provider: no Cloudflare or email steps", () => {
    const steps = goLiveSteps(row([], "records"), { wordpress: false, path: "records" });
    expect(titles(steps)).toEqual(["Confirm the domain is in the client's name", "Connect the domain (the two records)", "Put the domain on the Netlify site", "Confirm HTTPS"]);
    const all = goLiveSteps(row(["domainConfirmedAt", "recordsOkAt", "netlifyDomainAt", "httpsConfirmedAt"], "records"), { wordpress: false, path: "records" });
    expect(all.every((s) => s.done)).toBe(true);
  });

  it("VML runs the DNS (Cloudflare): the email records and the nameserver switch", () => {
    const steps = goLiveSteps(row(["domainConfirmedAt"], "vml_dns"), { wordpress: false, path: "vml_dns" });
    expect(titles(steps)).toContain("Switch the nameservers at the registrar");
    expect(titles(steps)).toContain("Check the email records on Cloudflare");
    expect(steps.find((s) => !s.done)!.title).toBe("Read the client's email records");
  });

  it("WordPress: the preview on the latest build and the domain on 20i, never Netlify", () => {
    const steps = goLiveSteps(row(["domainConfirmedAt"], "records"), { wordpress: true, path: "records", wp: { previewCurrent: true, onHost: false } });
    expect(titles(steps)).toEqual(["Confirm the domain is in the client's name", "Deploy the WordPress preview on the latest build", "Put the domain on 20i", "Connect the domain (the two records)", "Confirm HTTPS"]);
    expect(steps.find((s) => !s.done)!.title).toBe("Put the domain on 20i");
    const all = goLiveSteps(row(["domainConfirmedAt", "recordsOkAt", "httpsConfirmedAt"], "records"), { wordpress: true, path: "records", wp: { previewCurrent: true, onHost: true } });
    expect(all.every((s) => s.done)).toBe(true);
  });
});
