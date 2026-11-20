import { describe, expect, it } from "vitest";

import { svgProblem } from "../../../../packages/core/src/lib/intake/sniff";

/* CodeRabbit #81: an SVG is judged by its parsed elements and attributes, not by a pattern over its text. */

const NS = 'xmlns="http://www.w3.org/2000/svg"';

describe("svgProblem reads the SVG, not its text", () => {
  const bad: [string, string][] = [
    ["a handler after a '>' inside a quoted value", `<svg ${NS} data-x=">" onload="alert(1)"></svg>`],
    ["a handler on a child", `<svg ${NS}><rect onclick="alert(1)"/></svg>`],
    ["a handler with an upper-case name", `<svg ${NS} ONLOAD="alert(1)"></svg>`],
    ["a javascript: href", `<svg ${NS}><a href="javascript:alert(1)"><rect/></a></svg>`],
    ["a javascript: xlink:href with entities", `<svg ${NS}><a xlink:href="java&#115;cript:alert(1)"><rect/></a></svg>`],
    ["a remote data:text href", `<svg ${NS}><use href="data:text/html;base64,PHNjcmlwdD4="/></svg>`],
    ["a script", `<svg ${NS}><script>alert(1)</script></svg>`],
    ["a foreignObject", `<svg ${NS}><foreignObject><div/></foreignObject></svg>`],
  ];
  for (const [label, svg] of bad) {
    it(`refuses ${label}`, () => {
      expect(svgProblem(svg)).not.toBeNull();
    });
  }

  it("keeps an ordinary logo, even with 'on' in its words and a '>' in a value", () => {
    expect(svgProblem(`<?xml version="1.0"?><svg ${NS}><title data-x="a>b">one = 1 onward = 2</title><text>one = 1</text><a href="https://example.com/"><rect/></a><use href="#a"/></svg>`)).toBeNull();
  });
});

describe("svgProblem refuses an SVG that fetches from another server when shown (CodeRabbit #81, second review)", () => {
  const bad: [string, string][] = [
    ["an @import in a style block", `<svg ${NS}><style>@import url("https://tracker.example/s.css");</style><rect/></svg>`],
    ["an @import of a bare string", `<svg ${NS}><style>@import "//tracker.example/s.css";</style></svg>`],
    ["an @import hidden by a CSS escape", `<svg ${NS}><style>@` + "\\" + `69mport "https://tracker.example/s.css";</style></svg>`],
    ["an @import hidden by an XML entity", `<svg ${NS}><style>&#64;import "https://tracker.example/s.css";</style></svg>`],
    ["an @import inside CDATA", `<svg ${NS}><style><![CDATA[@import "https://tracker.example/s.css";]]></style></svg>`],
    ["a remote font in a style block", `<svg ${NS}><style>@font-face{font-family:x;src:url(https://tracker.example/f.woff)}</style></svg>`],
    ["a remote url() hidden by a comment", `<svg ${NS}><style>rect{fill:url(/**/https://tracker.example/p.svg#g)}</style></svg>`],
    ["a remote url() in a style attribute", `<svg ${NS}><rect style="fill:url('//tracker.example/p.svg#g')"/></svg>`],
    ["a remote picture", `<svg ${NS}><image href="https://tracker.example/p.png"/></svg>`],
    ["a remote symbol through xlink:href", `<svg ${NS}><use xlink:href="//tracker.example/s.svg#a"/></svg>`],
  ];
  for (const [label, svg] of bad) {
    it(`refuses ${label}`, () => {
      expect(svgProblem(svg)).toMatch(/another website|external style sheet/);
    });
  }

  it("keeps local references: a gradient by id, a clickable link, an embedded picture", () => {
    expect(
      svgProblem(
        `<svg ${NS}><style>.a{fill:url(#g)}</style><defs><linearGradient id="g"/></defs><rect class="a" style="fill:url('#g')"/><a href="https://example.com/"><rect/></a><image href="data:image/png;base64,iVBORw0KGgo="/></svg>`,
      ),
    ).toBeNull();
  });
});

describe("Fable's review of #81: more ways an SVG can fetch or run something", () => {
  const bad: [string, string][] = [
    ["a script in an internal entity", `<!DOCTYPE svg [<!ENTITY x "&#60;script&#62;alert(1)&#60;/script&#62;">]><svg ${NS}>&x;</svg>`],
    ["a linked style sheet instruction", `<?xml version="1.0"?><?xml-stylesheet href="https://evil.example/s.css"?><svg ${NS}/>`],
    ["a '/\\' address", String.raw`<svg ${NS}><image href="/\evil.example/p.png"/></svg>`],
    ["a '\\\\' address", String.raw`<svg ${NS}><image href="\\evil.example/p.png"/></svg>`],
    // In CSS "\\" is an escaped backslash, so this reads "/\evil.example".
    ["a '/\\' address in CSS", String.raw`<svg ${NS}><style>.a{fill:url(/\\evil.example/p.svg#a)}</style></svg>`],
    ["an image-set() string", `<svg ${NS}><style>.a{background:image-set("https://evil.example/p.png" 1x)}</style></svg>`],
    ["a control-character escape before the address", String.raw`<svg ${NS}><style>.a{fill:url("\1 https://evil.example/p.png")}</style></svg>`],
    ["an unclosed url(", `<svg ${NS}><style>.a{fill:url(https://evil.example/p.png</style></svg>`],
    ["a remote paint attribute written with entities", `<svg ${NS}><rect fill="url(&#104;ttps://evil.example/p.svg#a)"/></svg>`],
    ["an XHTML img", `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:img src="https://evil.example/p.png"/></svg>`],
    ["an XHTML iframe", `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:iframe src="data:text/html,hi"/></svg>`],
    ["an XHTML meta refresh", `<svg ${NS} xmlns:h="http://www.w3.org/1999/xhtml"><h:meta http-equiv="refresh" content="0;url=https://evil.example/"/></svg>`],
    ["an animated href", `<svg ${NS}><image><set attributeName="href" to="https://evil.example/p.png"/></image></svg>`],
    ["an animated value that leaves the file", `<svg ${NS}><rect><animate attributeName="fill" values="red;https://evil.example/x"/></rect></svg>`],
  ];
  for (const [label, svg] of bad) {
    it(`refuses ${label}`, () => {
      expect(svgProblem(svg)).not.toBeNull();
    });
  }

  it("still keeps an ordinary Inkscape-style logo", () => {
    const logo = `<?xml version="1.0" encoding="UTF-8"?><svg ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" xmlns:sodipodi="http://sodipodi.sourceforge.net/DTD/sodipodi-0.dtd"><sodipodi:namedview inkscape:zoom="1"/><defs><linearGradient id="g"><stop offset="0"/></linearGradient></defs><rect fill="url(#g)" style="fill:url(#g)"/><use xlink:href="#g"/><a href="https://example.com/"><text>One</text></a><rect><animate attributeName="opacity" values="0;1" dur="1s"/></rect></svg>`;
    expect(svgProblem(logo)).toBeNull();
  });

  it("keeps an Illustrator export with the standard DOCTYPE line (no definitions in it)", () => {
    const logo = `<?xml version="1.0" encoding="utf-8"?><!-- Generator: Adobe Illustrator 28.0.0 --><!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd"><svg version="1.1" ${NS} xmlns:xlink="http://www.w3.org/1999/xlink" x="0px" y="0px" viewBox="0 0 100 100" xml:space="preserve"><style type="text/css">.st0{fill:#1A3C6E;}</style><path class="st0" d="M0,0h100v100H0z"/><g><animateTransform attributeName="transform" type="rotate" values="0 50 50;360 50 50" dur="2s"/></g></svg>`;
    expect(svgProblem(logo)).toBeNull();
  });

  it("refuses xml:base pointing plain links at another server", () => {
    expect(svgProblem(`<svg ${NS} xml:base="https://evil.example/"><image href="p.png"/></svg>`)).not.toBeNull();
  });
});

describe("Fable's re-review of #81", () => {
  it("isn't fooled by '/*' and '*/' inside quoted strings", () => {
    for (const svg of [
      `<svg ${NS}><style>a{content:"/*"} rect{background:url("https://evil.example/p.png")} b{content:"*/"}</style></svg>`,
      `<svg ${NS}><rect style='content:"/*";background:url(https://evil.example/p.png);quotes:"*/"'/></svg>`,
      `<svg ${NS}><style>@charset "/*"; @import "https://evil.example/s.css"; b{content:"*/"}</style></svg>`,
    ]) {
      expect(svgProblem(svg), svg).not.toBeNull();
    }
  });

  it("refuses an encoding other than UTF-8, and hidden control characters", () => {
    const esc = String.fromCharCode(27);
    expect(svgProblem(`<?xml version="1.0" encoding="ISO-2022-JP"?><svg ${NS}><scr${esc}(Bipt>alert(1)</scr${esc}(Bipt></svg>`)).toMatch(/encoding/);
    expect(svgProblem(`<svg ${NS}><scr${esc}(Bipt>alert(1)</scr${esc}(Bipt></svg>`)).toMatch(/control/);
  });

  it("keeps UTF-8, ASCII and the single-byte Latin and Windows declarations older Illustrator writes", () => {
    for (const enc of ["UTF-8", "utf-8", "utf8", "us-ascii", "iso-8859-1", "ISO-8859-15", "windows-1252", "latin1"]) {
      expect(svgProblem(`<?xml version="1.0" encoding="${enc}"?><svg ${NS}><rect/></svg>`), enc).toBeNull();
    }
    for (const enc of ["UTF-16", "ISO-2022-JP", "UTF-7", "Shift_JIS"]) {
      expect(svgProblem(`<?xml version="1.0" encoding="${enc}"?><svg ${NS}><rect/></svg>`), enc).toMatch(/encoding/);
    }
  });

  it("names a rule that may only be commented out for what it is", () => {
    expect(svgProblem(`<svg ${NS}><style>/* @import url('https://fonts.googleapis.com/css?family=X'); */ .a{fill:red}</style></svg>`)).toMatch(/inside a comment/);
  });

  it("keeps Inkscape metadata (dc:source, dc:format) but refuses an XHTML-prefixed page element", () => {
    const meta = `<svg ${NS} xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:cc="http://creativecommons.org/ns#"><metadata><rdf:RDF><cc:Work><dc:format>image/svg+xml</dc:format><dc:source>logo.ai</dc:source></cc:Work></rdf:RDF></metadata><rect/></svg>`;
    expect(svgProblem(meta)).toBeNull();
    expect(svgProblem(`<svg ${NS} xmlns:x="http://www.w3.org/1999/xhtml"><x:source/></svg>`)).not.toBeNull();
  });
});
