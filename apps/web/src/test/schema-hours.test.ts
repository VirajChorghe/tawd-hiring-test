import { describe, expect, it } from "vitest";

import { localBusinessSchema, tawdDoesBetter, type BusinessFacts } from "@tawd/core/site";

/* F-044: the SEO sentence promised hours in the structured data, but the code never wrote them. */

const day = (d: string, open: string, close: string, closed = false) => ({ day: d as never, closed, open, close });
const facts = (hours?: BusinessFacts["hours"]): BusinessFacts => ({
  name: "ACME Plumbing", phone: "916-555-0142", email: "", streetAddress: "1 Main St", city: "Reno", state: "NV",
  isServiceAreaBusiness: false, domain: "acme.example", trade: "plumbing", areaServed: [], logoPath: null, ...(hours ? { hours } : {}),
});
const sentence = (lines: string[]) => lines.find((l) => l.startsWith("LocalBusiness structured data")) ?? "";

describe("opening hours in the structured data", () => {
  it("writes openingHoursSpecification from the intake's hours, skipping closed and unreadable days", () => {
    const schema = localBusinessSchema(
      facts([day("monday", "7:00 AM", "6:00 PM"), day("tuesday", "08:00", "17:00"), day("wednesday", "", "", true), day("thursday", "soon", "5pm"), day("friday", "9am", "1 PM")]),
    );
    expect(schema.openingHoursSpecification).toEqual([
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Monday", opens: "07:00", closes: "18:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Tuesday", opens: "08:00", closes: "17:00" },
      { "@type": "OpeningHoursSpecification", dayOfWeek: "Friday", opens: "09:00", closes: "13:00" },
    ]);
  });

  it("writes nothing when the intake has no usable hours", () => {
    expect(localBusinessSchema(facts()).openingHoursSpecification).toBeUndefined();
    expect(localBusinessSchema(facts([day("monday", "", "", true), day("tuesday", "", "")])).openingHoursSpecification).toBeUndefined();
  });

  it("the SEO sentence says hours only when they are written", () => {
    const withHours = localBusinessSchema(facts([day("monday", "7:00 AM", "6:00 PM")]));
    const without = localBusinessSchema(facts());
    expect(withHours.openingHoursSpecification).toBeDefined();
    expect(sentence(tawdDoesBetter([], { hasHours: true }))).toContain("hours");
    expect(without.openingHoursSpecification).toBeUndefined();
    expect(sentence(tawdDoesBetter([], { hasHours: false }))).not.toContain("hours");
    expect(sentence(tawdDoesBetter([]))).not.toContain("hours");
  });
});
