import { FigmaError, type FigmaApi, type FigmaFile, type FigmaNode } from "@tawd/core/figma";

/*
  Saved sample answers from Figma's REST API, in its exact shape, for a
  stand-in of the Dale Rowan design (file OmgnFoGUEGbEbVWiehrjB2). The
  real file is read after 4a is deployed; this one has what the checks look
  for: a "Final_Design" page with Home and About frames, a small component
  that is not a page, a font without a web license, and two photos.
*/

export const FILE_KEY = "OmgnFoGUEGbEbVWiehrjB2";
export const FILE_LINK = `https://www.figma.com/design/${FILE_KEY}/Dale-Rowan-Well-%26-Pump?node-id=0-1&t=abc`;

const box = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });

const text = (id: string, characters: string, fontFamily: string, y: number): FigmaNode => ({
  id,
  name: characters.slice(0, 20),
  type: "TEXT",
  characters,
  style: { fontFamily, fontWeight: 400, fontSize: 18 },
  absoluteBoundingBox: box(120, y, 600, 40),
});

const photo = (id: string, imageRef: string, y: number, height: number): FigmaNode => ({
  id,
  name: "Photo",
  type: "RECTANGLE",
  fills: [{ type: "IMAGE", imageRef }],
  absoluteBoundingBox: box(0, y, 1440, height),
});

export function daleRowanFile(version = "2213456789"): FigmaFile {
  return {
    name: "Dale Rowan - Well & Pump",
    lastModified: "2026-09-22T18:04:11Z",
    version,
    document: {
      id: "0:0",
      name: "Document",
      type: "DOCUMENT",
      children: [
        { id: "0:1", name: "Cover", type: "CANVAS", children: [] },
        {
          id: "1:1",
          name: "Drafts",
          type: "CANVAS",
          children: [{ id: "1:2", name: "Old home", type: "FRAME", absoluteBoundingBox: box(0, 0, 1440, 3000), children: [] }],
        },
        {
          id: "2:1",
          name: "Final_Design",
          type: "CANVAS",
          children: [
            {
              id: "2:10",
              name: "Home",
              type: "FRAME",
              absoluteBoundingBox: box(0, 0, 1440, 5200),
              children: [
                {
                  id: "2:11",
                  name: "Hero",
                  type: "FRAME",
                  absoluteBoundingBox: box(0, 0, 1440, 900),
                  children: [
                    photo("2:12", "heroRef0001", 0, 900),
                    {
                      ...text("2:13", "Well drilling and pump repair in Grass Valley", "Brandon Grotesque", 300),
                      styleOverrideTable: { "1": { fontFamily: "Montserrat" } },
                    },
                    text("2:14", "Call (530) 555-0199", "Montserrat", 420),
                  ],
                },
                text("2:15", "Our services", "Montserrat", 1000),
                photo("2:16", "teamRef0002", 2000, 600),
                text("2:17", "Serving Nevada County since [year]", "Arial", 3000),
                { ...text("2:18", "Hidden note", "Comic Sans MS", 3100), visible: false },
              ],
            },
            {
              id: "2:20",
              name: "About",
              type: "FRAME",
              absoluteBoundingBox: box(1600, 0, 1440, 3000),
              children: [{ ...text("2:21", "About Pat", "Montserrat", 200), absoluteBoundingBox: box(1720, 200, 600, 40) }],
            },
            // A component on the page, too small to be a page of the site.
            { id: "2:30", name: "Button", type: "COMPONENT", absoluteBoundingBox: box(0, 6000, 200, 60), children: [] },
          ],
        },
      ],
    },
  };
}

/* The first bytes of a PNG and a JPEG, as Figma's links would serve them. */
export const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png")]);
export const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.from("jpeg")]);

/*
  A stand-in for Figma's API: answers from the saved samples, counts what
  was asked, and can be told to fail a call.
*/
export function fakeFigma(options: {
  file?: () => FigmaFile;
  fail?: Partial<Record<"getFile" | "renderFrames" | "imageFills", Error>>;
  renders?: Record<string, string | null>;
  fills?: Record<string, string | null>;
  /** The file is over the size TAWD reads whole; "page" when even its final page is, "outline" when even its outline is. */
  tooLarge?: boolean | "page" | "outline";
} = {}) {
  const tooLarge = () => new FigmaError("too_large", "The Figma file is too large to read whole.");
  // Figma's depth=3: pages, what's on them, and one layer inside.
  const trim = (node: FigmaNode, depth: number): FigmaNode =>
    depth <= 1 ? { ...node, children: node.children ? [] : undefined } : { ...node, children: node.children?.map((c) => trim(c, depth - 1)) };
  const calls: { method: string; args: unknown[] }[] = [];
  const api: FigmaApi = {
    async getFile(fileKey) {
      calls.push({ method: "getFile", args: [fileKey] });
      if (options.fail?.getFile) throw options.fail.getFile;
      if (options.tooLarge) throw tooLarge();
      const file = (options.file ?? daleRowanFile)();
      return { file, raw: JSON.stringify(file) };
    },
    async getOutline(fileKey) {
      calls.push({ method: "getOutline", args: [fileKey] });
      if (options.tooLarge === "outline") throw tooLarge();
      const file = (options.file ?? daleRowanFile)();
      return { ...file, document: { ...file.document, children: file.document.children?.map((page) => trim(page, 3)) } };
    },
    async getPage(fileKey, pageId) {
      calls.push({ method: "getPage", args: [fileKey, pageId] });
      if (options.tooLarge === "page") throw tooLarge();
      const page = (options.file ?? daleRowanFile)().document.children?.find((p) => p.id === pageId);
      if (!page) throw new FigmaError("bad_answer", "Figma did not send that page.");
      return page;
    },
    async renderFrames(fileKey, ids, scale) {
      calls.push({ method: "renderFrames", args: [fileKey, ids, scale] });
      if (options.fail?.renderFrames) throw options.fail.renderFrames;
      return options.renders ?? Object.fromEntries(ids.map((id) => [id, `https://figma-renders.example/${id}.png`]));
    },
    async imageFills(fileKey) {
      calls.push({ method: "imageFills", args: [fileKey] });
      if (options.fail?.imageFills) throw options.fail.imageFills;
      return (
        options.fills ?? {
          heroRef0001: "https://figma-images.example/hero",
          teamRef0002: "https://figma-images.example/team",
        }
      );
    },
    async download(url) {
      calls.push({ method: "download", args: [url] });
      return url.includes("figma-images") && url.endsWith("team") ? JPEG : PNG;
    },
  };
  const reads = () => calls.filter((c) => c.method !== "download").length;
  return { api, calls, reads };
}
