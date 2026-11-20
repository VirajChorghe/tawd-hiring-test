import { describe, expect, it } from "vitest";

/*
  F-048 (audit, November 2026): the viewer's file key let a segment with an
  encoded slash through (a storage key outside the page's own folder) and a
  malformed % threw a 500. Anything odd is refused (null, which the route
  answers as 404).
*/

import { siteFileKey } from "@/lib/site-builds";

const prefix = "projects/p/";

describe("siteFileKey", () => {
  it("still gives the keys of ordinary paths", () => {
    expect(siteFileKey(prefix, 2, [])).toBe("projects/p/site/v2/index.html");
    expect(siteFileKey(prefix, 2, ["drain-cleaning"])).toBe("projects/p/site/v2/drain-cleaning/index.html");
    expect(siteFileKey(prefix, 2, ["assets", "site.css"])).toBe("projects/p/site/v2/assets/site.css");
    expect(siteFileKey(prefix, 2, ["caf%C3%A9"])).toBe("projects/p/site/v2/café/index.html");
    expect(siteFileKey(prefix, 2, ["a%20b"])).toBe("projects/p/site/v2/a b/index.html");
  });

  it("refuses a segment that decodes to a slash, a backslash, dots or a NUL", () => {
    for (const segments of [["..%2F..%2Fintake%2Flogo.png"], ["a%2Fb"], ["a%2fb"], ["a%5Cb"], ["%2E%2E"], ["..", "x"], [".", "x"], ["a%00b"], ["a\0b"], ["%2e%2e%2fsecret"]]) {
      expect(siteFileKey(prefix, 2, segments), segments.join("/")).toBeNull();
    }
  });

  it("refuses a malformed % instead of throwing", () => {
    for (const segments of [["%E0%A4%A"], ["%"], ["100%"], ["%ZZ"], ["ok", "%E0%A4%A"]]) {
      expect(() => siteFileKey(prefix, 2, segments), segments.join("/")).not.toThrow();
      expect(siteFileKey(prefix, 2, segments), segments.join("/")).toBeNull();
    }
  });
});
