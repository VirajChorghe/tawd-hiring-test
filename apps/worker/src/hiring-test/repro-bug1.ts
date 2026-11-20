import fs from "node:fs/promises";
import path from "node:path";

import { buildPartsPrompt, readPartsReply, KEPT_MAIN_ATTR } from "@tawd/core/site";
import { createClient } from "../claude";
import { formatSitePhones, serve, sharedPartsNotes } from "../site-build";

/*
  HIRING TEST: Bug #1, on a page you can open.

  A homepage the team supplied is kept as the client approved it: its <main>
  keeps the client's phone format ("530-227-2479"). The shared header and
  footer round it are written by TAWD (here by the canned stand-in for Claude)
  and then go through TAWD's phone-layout rule, which rewrites every number
  outside the kept <main> as "(530) 227-2479". So one page shows two formats.

  This script runs the REAL pieces of that path in the real order:
    buildPartsPrompt -> (stub) Claude -> readPartsReply -> assemble the page
    -> formatSitePhones (the real phone rule) -> sharedPartsNotes (the real notice)
  and writes the page to out/bug1/dist/index.html. No database, no queue, no
  storage, no network and no AI are involved.
*/

const root = path.resolve(import.meta.dirname, "..", "..", "..") /* the bundle runs from apps/worker/dist-repro */;
const fixtures = path.join(root, "fixtures", "hiring-test");
const dist = path.join(root, "out", "bug1", "dist");

const project = JSON.parse(await fs.readFile(path.join(fixtures, "sample-project.json"), "utf8")) as {
  clientName: string;
  pagePlan: { name: string; kind: string; slug: string }[];
  suppliedHomepage: string;
};
const supplied = await fs.readFile(path.join(fixtures, project.suppliedHomepage), "utf8");

// The supplied page's own <main>, marked as kept (what suppliedHomeMain does in a real build).
const main = /<main\b[\s\S]*<\/main>/i.exec(supplied)![0].replace(/<main\b/i, `<main ${KEPT_MAIN_ATTR}`);

// The header and footer: asked of Claude in a real build; answered by the canned stand-in here.
const client = createClient({} as never);
const reply = await client.messages.stream({
  model: "stub",
  max_tokens: 1000,
  messages: [{ role: "user", content: buildPartsPrompt(project.pagePlan as never, project.clientName) }],
}).finalMessage();
const text = reply.content.map((b) => (b.type === "text" ? b.text : "")).join("");
const { header, footer } = readPartsReply(text);

await fs.rm(dist, { recursive: true, force: true });
await fs.mkdir(dist, { recursive: true });
await fs.writeFile(
  path.join(dist, "index.html"),
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${project.clientName}</title>
<style>body{font-family:system-ui,sans-serif;margin:0;color:#1a2330}header,footer{background:#12324a;color:#fff;padding:14px 24px;display:flex;gap:20px;align-items:center;flex-wrap:wrap}header a,footer a{color:#fff}main{max-width:860px;margin:0 auto;padding:32px 24px}.call-big{display:inline-block;background:#e8590c;color:#fff;padding:14px 22px;border-radius:8px;font-size:1.25rem;text-decoration:none}</style></head>
<body>${header}\n${main}\n${footer}</body></html>`,
  "utf8",
);

// TAWD's own passes over the finished site, as the build runs them.
const changed = await formatSitePhones(dist);
const notes = await sharedPartsNotes(dist);

console.log(`Page written: ${path.join(dist, "index.html")}`);
console.log(`Phone rule rewrote ${changed} file(s).`);
for (const note of notes) console.log(`TAWD's own notice: ${note}`);

if (process.argv.includes("--no-serve")) process.exit(0);
const { origin } = await serve(dist);
console.log(`\nOpen ${origin}/ in your browser (Ctrl+C to stop).`);
