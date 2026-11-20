import { describe, expect, it } from "vitest";

import { emptyIntake } from "@tawd/core/intake";
import { planSitePrefill } from "@tawd/core/site";
import type { ImportedPageSummary } from "@tawd/core/site";

/*
  Batch B review, M3: the save refuses a phone nobody could dial (B5), and
  the site read's prefill saves every section in one go, so a home page
  whose call link was "tel:9165550142,123" took the address, the services
  and everything else down with it. Such a number is now never proposed;
  the read says why instead.
*/

const home = (tel: string) =>
  ({ path: "/", url: "https://acme.example/", kind: "home", name: "Home", title: "Acme", phones: [], contact: { tels: [tel], emails: [], addresses: [] } }) as unknown as ImportedPageSummary;

describe("the site read's phone prefill", () => {
  it("proposes a number a person can dial", () => {
    const plan = planSitePrefill(emptyIntake(), [home("9165550142")]);
    expect(plan.fill.find((p) => p.key === "business.phone")?.value).toBe("(916) 555-0142");
  });

  it("never proposes one nobody could dial, and says why", () => {
    const plan = planSitePrefill(emptyIntake(), [home("9165550142123")]);
    expect(plan.fill.some((p) => p.key === "business.phone")).toBe(false);
    expect(plan.notes.join(" ")).toMatch(/isn't a US number TAWD can dial/);
  });
});
