/*
  The end-to-end check (Jason, 29 September 2026): a test project's site
  built, deployed as a Netlify preview and its share link opened, for $0.
  Its "AI" answers are these stand-ins, written here, never sent to or
  paid for at Anthropic; the worker only uses them for the check's own
  project (its client name), never for a client's.
*/

export const E2E_CHECK_CLIENT = "TAWD end-to-end check";

const PARTS = `<header class="site-header"><style>.site-header{background:var(--kit-color-1,#0b1a4a);color:#fff;display:flex;flex-wrap:wrap;gap:24px;align-items:center;justify-content:space-between;padding:16px 5vw}.site-header a{color:#fff}.site-footer{background:var(--kit-color-1,#0b1a4a);color:#fff;padding:32px 5vw}.site-footer a{color:#fff}</style><a class="skip-link" href="#main">Skip to content</a><p class="site-brand">TAWD CHECK</p><nav aria-label="Main"><a href="/">Home</a> <a href="/about/">About</a></nav></header><footer class="site-footer"><p>© 2026 TAWD check</p><p><a href="/privacy/">Privacy Policy</a> · <a href="/cookies/">Cookie Policy</a></p><p>Website by Velocity Media Lab</p></footer>`;

const HOME = `<main id="main" class="page-home"><style>.page-home section{display:flex;flex-wrap:wrap;gap:32px;align-items:center;padding:64px 5vw}.page-home h1{font-size:48px;margin:0 0 16px}.page-home img{max-width:300px;width:100%;height:auto}.page-home .cta{display:inline-flex;min-height:44px;align-items:center;padding:0 24px;background:#e0662b;color:#fff;border-radius:8px;text-decoration:none}@media (max-width:767px){.page-home h1{font-size:32px}}</style><section><div><h1>Welcome to the check</h1><p>A test page built by TAWD's end-to-end check. No AI is used.</p><a class="cta" href="/about/">GET IN TOUCH</a></div><img src="tawd-asset:home-design-image-1" alt="A test photo" width="300" height="200"></section></main>`;

const ABOUT = `<main id="main" class="page-about"><style>.page-about section{padding:64px 5vw}.page-about h1{font-size:48px;margin:0 0 16px}@media (max-width:767px){.page-about h1{font-size:32px}}</style><section><h1>About the check</h1><p>A test page built by TAWD's end-to-end check. No AI is used.</p><a href="/">Back to the home page</a></section></main>`;

/** The saved answers the check's build is "replayed" from, by step, in the order the build asks. */
export function e2eStandInTurns(): Map<string, { stopReason: string; content: { type: "text"; text: string }[] }[]> {
  const turn = (text: string) => ({ stopReason: "end_turn", content: [{ type: "text" as const, text }] });
  return new Map([
    ["design_site_parts", [turn(PARTS)]],
    ["design_site_page", [turn(HOME), turn(ABOUT)]],
  ]);
}
