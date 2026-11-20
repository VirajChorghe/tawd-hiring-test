import { REVIEW_QUESTIONS } from "@tawd/core/mockups";
import { Readable } from "node:stream";

import { multipartUpload, type FileStorage, type StoredObject } from "@tawd/core/intake/storage";
import { setFontFetchForTesting } from "../../../worker/src/site-speed";

/*
  Stand-ins for the worker's outside world, shared by the tests that run
  the worker's own code: R2, Chromium and Claude.
*/

// The speed pass never reaches the real Google Fonts from a test: unreachable, so the fonts stay as built.
setFontFetchForTesting(async () => new Response("", { status: 503 }));


export class FakeR2 implements FileStorage {
  objects = new Map<string, Buffer>();
  async signUpload(key: string) {
    return key;
  }
  async signDownload(key: string) {
    return key;
  }
  async head(key: string): Promise<StoredObject | null> {
    const body = this.objects.get(key);
    return body ? { sizeBytes: body.length, contentType: null } : null;
  }
  async remove(key: string) {
    this.objects.delete(key);
  }
  async put(key: string, body: Buffer) {
    this.objects.set(key, body);
  }
  async copy(from: string, to: string) {
    const body = this.objects.get(from);
    if (!body) throw new Error(`NoSuchKey: ${from}`);
    this.objects.set(to, Buffer.from(body));
  }
  /** Keys read whole with get(), and ranged reads, so a test can prove what was (not) downloaded. */
  gets: string[] = [];
  ranges: { key: string; start: number; end: number }[] = [];
  async get(key: string) {
    this.gets.push(key);
    return this.objects.get(key) ?? null;
  }
  async getRange(key: string, start: number, end: number) {
    this.ranges.push({ key, start, end });
    return this.objects.get(key)?.subarray(start, end + 1) ?? null;
  }
  async list(prefix: string) {
    return [...this.objects.keys()].filter((k) => k.startsWith(prefix));
  }
  /*
    Streams (20i backups): the same multipart code R2 runs (core's
    multipartUpload), in 64 KB parts so a backup is several parts. Tests
    can refuse a part (R2 failing mid-upload) or a read (a 5xx, not a 404).
  */
  refusePart: number | null = null;
  refuseRead: Error | null = null;
  uploads: { key: string; parts: number; aborted: boolean; completed: boolean }[] = [];
  async putStream(key: string, body: Readable) {
    const upload = { key, parts: 0, aborted: false, completed: false };
    this.uploads.push(upload);
    const held = new Map<number, Buffer>();
    return multipartUpload(
      {
        start: async () => `upload-${this.uploads.length}`,
        part: async (_id, n, part) => {
          if (this.refusePart === n) throw new Error("R2 refused the upload (500 InternalError)");
          held.set(n, Buffer.from(part));
          upload.parts = n;
          return `etag-${n}`;
        },
        complete: async (_id, parts) => {
          this.objects.set(key, Buffer.concat(parts.map((p) => held.get(p.PartNumber)!)));
          upload.completed = true;
        },
        abort: async () => void (upload.aborted = true),
      },
      body,
      65_536,
    );
  }
  async getStream(key: string) {
    if (this.refuseRead) throw this.refuseRead;
    const body = this.objects.get(key);
    return body ? Readable.from([body]) : null;
  }
}

/* Just enough of Playwright for the checks, the renders and the review shots. */
export function fakeBrowser(options: { fixCheck?: (arg: { parts: string[]; width: string }) => unknown[] } = {}) {
  let content = "";
  const page = {
    route: async () => undefined,
    setContent: async (html: string) => void (content = html),
    // Visiting a site: nothing to load; the screenshot below stands in for it.
    goto: async () => null,
    waitForTimeout: async () => undefined,
    evaluate: async (fn: unknown, arg?: { src?: string; maxSide?: number; parts?: string[]; width?: string }) => {
      const source = String(fn);
      // TAWD's check after a page fix (3c): what the test says it found, or nothing.
      if (arg && Array.isArray(arg.parts) && typeof arg.width === "string") return options.fixCheck?.({ parts: arg.parts, width: arg.width }) ?? [];
      // Preparing an image for a page: handed back as it came, with a size.
      if (arg && typeof arg === "object" && typeof arg.src === "string" && "maxSide" in arg) {
        return { dataUri: arg.src, width: 120, height: 60, tone: null };
      }
      // A section of the render with the team's pins drawn on it.
      if (source.includes("pinMarks")) return "data:image/jpeg;base64,/9j/";
      // A strip of a picture, cut to size: one small JPEG.
      if (source.includes("sourceWidth") && source.includes("toDataURL")) return ["data:image/jpeg;base64,/9j/"];
      // The text of each section of the page, read from the markup it was given.
      if (source.includes("childNodes") && source.includes("data-figma-section")) {
        return [...content.matchAll(/<(header|section|nav|footer)\b[^>]*data-figma-section="(\d+)"[^>]*>([\s\S]*?)<\/\1>/g)].map((m) => ({
          number: Number(m[2]),
          texts: m[3]!
            .replace(/<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "")
            .split(/<[^>]+>/)
            .map((t) => t.replace(/&amp;/g, "&").replace(/\s+/g, " ").trim())
            .filter(Boolean),
        }));
      }
      // The fidelity check: a fixed comparison of the copy with the design.
      if (source.includes("frameWidth") && source.includes("naturalWidth")) {
        return {
          overall: 87,
          sections: [
            { name: "Hero", score: 91 },
            { name: "Our services", score: 78 },
          ],
          method: "sections",
          designHeight: 1300,
          copyHeight: 1280,
        };
      }
      // The bands as rendered, in pixels down a 3,000-pixel page (the same three).
      if (source.includes("bandLabels")) {
        return [
          { top: 0, bottom: 600, label: "Header" },
          { top: 600, bottom: 1500, label: "Well drilling in Grass Valley" },
          { top: 1500, bottom: 3000, label: "Footer" },
        ];
      }
      // Where the page's three bands sit, as a percentage down the page.
      if (source.includes("pageHeight")) {
        return [
          { top: 0, bottom: 20 },
          { top: 20, bottom: 50 },
          { top: 50, bottom: 100 },
        ];
      }
      if (source.includes("scrollHeight") && !source.includes("overPicture")) return 3000;
      // The rendered checks: nothing wrong, nothing over a picture.
      if (source.includes("overPicture")) {
        return { issues: [], probes: [], contrast: { count: 0, worst: 21, worstText: "", sections: [] } };
      }
      if (source.includes("lowContrast")) return [];
      return undefined;
    },
    // A JPEG by its first bytes, as a real screenshot is (pictures for the AI are labelled from their bytes, 0.124.0).
    screenshot: async () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg")]),
    // The page cap listens for close (locked-context.ts); a fake page is never really open, so it gives its slot back at once.
    once: (_event: string, give: () => void) => give(),
  };
  // A fresh context each time, as Chrome gives: the page cap wraps newPage on the context, and wrapping one object again and again would nest the wrappers (each holding a slot).
  const makeContext = () => ({ once: (_event: string, give: () => void) => give(), route: async () => undefined, newPage: async () => page, close: async () => undefined });
  return { newContext: async () => makeContext() } as never;
}

export const PAGE = `<!doctype html><html lang="en"><head><title>Well drilling in Grass Valley</title>
<meta name="description" content="Example Well and Pump drills and repairs wells across Grass Valley."></head>
<body><h1>Well drilling in Grass Valley</h1>
<a href="tel:+15305550199">(530) 555-0199</a>
<form><label for="n">Name</label><input id="n" type="text"><button type="submit">Call me back</button></form>
</body></html>`;

export type Scores = Partial<Record<number, number>>;

/*
  A scripted Claude. Builder calls get back a page; reviewer calls (the
  ones asking for JSON) get the next scripted review. Everything it was
  asked is kept, so the tests can count calls and read prompts.
*/
/* A scripted answer with its own stop reason ("max_tokens", "refusal"). */
export interface ScriptedTurn {
  scriptedText: string;
  stopReason: string;
}

export function turn(text: string, stopReason: string): ScriptedTurn {
  return { scriptedText: text, stopReason };
}

function isTurn(value: unknown): value is ScriptedTurn {
  return typeof value === "object" && value !== null && "scriptedText" in value;
}

/* A message's text, whether it was sent as a string or (with its cache marks) as blocks. */
export function messageText(content: unknown): string {
  return typeof content === "string"
    ? content
    : (content as { text?: string; content?: unknown }[]).map((b) => b.text ?? (typeof b.content === "string" ? b.content : "")).join("\n");
}

/* All the text of a request's messages, for tests that look for words in what was sent. */
export function messagesText(params: Record<string, unknown>): string {
  return (params.messages as { content: unknown }[]).map((m) => messageText(m.content)).join("\n");
}

/* The text of the user message a call ended with. */

export function lastUserText(params: Record<string, unknown>): string {
  const last = (params.messages as { content: unknown }[]).at(-1)!;
  return typeof last.content === "string"
    ? last.content
    : (last.content as { text?: string }[]).map((b) => b.text ?? "").join("");
}

/*
  What a builder call gets back, by what it asks for: a locate call gets
  the first band after the header ("1"); a section edit or fix gets each
  part back, marked data-edited, in its wrapper; anything else the page.
*/
function builderAnswer(prompt: string): string {
  if (prompt.includes("Which bands does the request change?")) return "1";
  if (prompt.includes("# The parts of the page")) {
    const parts = prompt.slice(prompt.indexOf("# The parts of the page"));
    return [...parts.matchAll(/<tawd-section id="(\w+)">\n([\s\S]*?)\n<\/tawd-section>/g)]
      .map(([, id, html]) => `<tawd-section id="${id}">${html!.replace(/^<([a-z0-9]+)/i, "<$1 data-edited")}</tawd-section>`)
      .join("\n");
  }
  return PAGE;
}

export function fakeClaude(
  reviews: (labels: string[]) => unknown[],
  options: { builder?: (params: Record<string, unknown>) => ScriptedTurn } = {},
) {
  const calls: { kind: "builder" | "review"; params: Record<string, unknown> }[] = [];
  let reviewIndex = 0;

  const client = {
    messages: {
      stream: (params: Record<string, unknown>) => {
        const isReview = Boolean(
          (params.output_config as { format?: unknown } | undefined)?.format,
        );
        calls.push({ kind: isReview ? "review" : "builder", params });

        let text = PAGE;
        let stopReason = "end_turn";
        if (isReview) {
          const scripted = reviews([]);
          const next = scripted[Math.min(reviewIndex, scripted.length - 1)];
          reviewIndex += 1;
          if (isTurn(next)) {
            text = next.scriptedText;
            stopReason = next.stopReason;
          } else {
            text = typeof next === "string" ? next : JSON.stringify(next);
          }
        } else if (options.builder) {
          const next = options.builder(params);
          text = next.scriptedText;
          stopReason = next.stopReason;
        } else {
          text = builderAnswer(lastUserText(params));
        }

        return {
          finalMessage: async () => ({
            content: [{ type: "text", text }],
            stop_reason: stopReason,
            usage: {
              input_tokens: isReview ? 30_000 : 10_000,
              output_tokens: isReview ? 4_000 : 30_000,
              cache_read_input_tokens: 0,
              cache_creation_input_tokens: 0,
            },
          }),
        };
      },
    },
  };

  return { client: client as never, calls };
}

export function review(
  labels: string[],
  scores: Record<string, Scores> = {},
  withNotes = true,
  extra: { safety?: boolean } = {},
) {
  return {
    concepts: labels.map((label) => ({
      label,
      summary: `Concept ${label} summary`,
      safetyAdvice: extra.safety
        ? [{ text: "The main shut-off valve is usually near the well head.", section: "Emergency" }]
        : [],
      earlierNotes: [],
      questions: REVIEW_QUESTIONS.map((q) => {
        // A review with notes defaults to 4 (under the 4.5 gate); a clean one with none to 5 (8 October 2026).
        const score = scores[label]?.[q.id] ?? (withNotes ? 4 : 5);
        return {
          question: q.id,
          score,
          reason: `Q${q.id} reason`,
          notes:
            withNotes && score < 5
              ? [{ section: "Hero", problem: `Q${q.id} problem`, change: `Q${q.id} change` }]
              : [],
        };
      }),
    })),
  };
}

