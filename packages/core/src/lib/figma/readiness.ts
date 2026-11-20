import type { FigmaFile, FigmaNode } from "./api";
import { GOOGLE_FONT_FAMILIES } from "./google-fonts";
import { visibleTree } from "./visible";

/*
  Is the designer's file ready for TAWD? Worked out from the one read of the
  file, with no AI and no further calls. Every problem is a warning in plain
  words; nothing here ever blocks the project.

  - The final frames: the frames on a page whose name says "final" (the
    Pat Rivera file has "Final_Design"), or on the page the PM chose.
  - The homepage: the final frame named Home (or Homepage, Landing, Index),
    otherwise the first one.
  - Fonts: free web fonts (Google Fonts) and the common system fonts are
    fine; anything else is named, because the site cannot use it without a
    web license (TAWD-PROFILE: swapped for the closest free font, with the
    designer's approval).
  - Text: a frame with no text layers had its text turned into shapes or a
    picture, which TAWD cannot read or improve.
  - Images: a frame that is mostly one picture is a flattened design.
*/

export interface ReadinessItem {
  id: string;
  status: "ok" | "warning";
  title: string;
  detail: string;
}

export interface DesignFrame {
  id: string;
  name: string;
  width: number;
  height: number;
  isHome: boolean;
  textLayers: number;
  images: number;
}

export interface Readiness {
  fileName: string;
  lastModified: string;
  version: string;
  pages: { id: string; name: string; frames: number }[];
  /** The page the final frames come from; null when none could be told. */
  finalPage: { id: string; name: string; chosen: boolean } | null;
  frames: DesignFrame[];
  fonts: { family: string; usable: boolean; kind: "google" | "system" | "other" }[];
  /** Image references used in the final frames, for the import. */
  imageRefs: string[];
  items: ReadinessItem[];
  warnings: number;
}

const SYSTEM_FONTS = new Set(
  ["Arial", "Helvetica", "Helvetica Neue", "Georgia", "Times New Roman", "Verdana", "Tahoma", "Trebuchet MS", "Courier New"].map(
    (f) => f.toLowerCase(),
  ),
);
const GOOGLE = new Set(GOOGLE_FONT_FAMILIES.map((f) => f.toLowerCase()));

const FRAME_TYPES = new Set(["FRAME", "COMPONENT", "INSTANCE", "GROUP"]);

/* A page name that says it holds the final design: "Final", "Final_Design", "final - v3", "✅ Final". */
export function isFinalPageName(name: string): boolean {
  return /(^|[^a-z])final([^a-z]|$)/i.test(name.replace(/[_-]/g, " "));
}

function visible<T extends { visible?: boolean }>(node: T): boolean {
  return node.visible !== false;
}

/*
  The page-sized things on a page: frames, and also groups and sections, as
  designers use all three, so nobody has to rework a file for TAWD. A
  section holding page-sized frames or groups gives those; a section of
  loose layers is itself the page. Small ones (icons, notes) are not pages.
  Figma renders any of them by its id.
*/
const pageSized = (node: FigmaNode) => (node.absoluteBoundingBox?.width ?? 0) >= 320;

function pageFrames(page: FigmaNode): FigmaNode[] {
  return (page.children ?? []).filter(visible).flatMap((node) => {
    if (node.type === "SECTION") {
      const inside = (node.children ?? []).filter((c) => visible(c) && FRAME_TYPES.has(c.type) && pageSized(c));
      return inside.length > 0 ? inside : pageSized(node) ? [node] : [];
    }
    return FRAME_TYPES.has(node.type) && pageSized(node) ? [node] : [];
  });
}

function walk(node: FigmaNode, visit: (node: FigmaNode) => void): void {
  if (!visible(node)) return;
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

function fontKind(family: string): "google" | "system" | "other" {
  const key = family.trim().toLowerCase();
  if (GOOGLE.has(key)) return "google";
  if (SYSTEM_FONTS.has(key)) return "system";
  return "other";
}

const list = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

/* The page the site is built from: the PM's choice, else the first named as final, else none yet. */
export function finalPageOf(file: FigmaFile, chosenPageId?: string | null): FigmaNode | null {
  const pages = (file.document.children ?? []).filter((p) => p.type === "CANVAS");
  const chosen = chosenPageId ? pages.find((p) => p.id === chosenPageId) : undefined;
  return chosen ?? pages.find((p) => isFinalPageName(p.name)) ?? null;
}

export function checkReadiness(file: FigmaFile, options: { chosenPageId?: string | null } = {}): Readiness {
  const pages = (file.document.children ?? []).filter((p) => p.type === "CANVAS");
  const items: ReadinessItem[] = [];

  items.push({ id: "file", status: "ok", title: "The file opens", detail: `"${file.name}", last changed ${file.lastModified.slice(0, 10)}.` });

  /* ---------- which page holds the final frames ---------- */
  const chosen = options.chosenPageId ? pages.find((p) => p.id === options.chosenPageId) : undefined;
  const named = pages.filter((p) => isFinalPageName(p.name));
  const page = finalPageOf(file, options.chosenPageId);

  if (chosen) {
    items.push({ id: "final", status: "ok", title: "Final frames", detail: `Using the page "${chosen.name}", chosen by the PM.` });
  } else if (named.length > 0) {
    items.push({
      id: "final",
      status: "ok",
      title: "Final frames",
      detail: `The page "${named[0]!.name}" is named as the final design.${
        named.length > 1 ? ` Other pages also say final (${list(named.slice(1).map((p) => `"${p.name}"`))}); choose one if this is the wrong one.` : ""
      }`,
    });
  } else {
    items.push({
      id: "final",
      status: "warning",
      title: "No page is named as the final design",
      detail: `None of the ${pages.length} pages says "final" in its name. Choose the page that holds the final design, or ask the designer to rename it (for example "Final_Design").`,
    });
  }

  const frameNodes = page ? pageFrames(page) : [];
  if (page && frameNodes.length === 0) {
    items.push({
      id: "frames",
      status: "warning",
      title: "Nothing page-sized on the final page",
      detail: `"${page.name}" has nothing page-sized on it (a frame, group or section 320px wide or more). The design needs to be in one for TAWD to import it.`,
    });
  }

  /* ---------- the frames, their text, fonts and images ---------- */
  const homeIndex = Math.max(
    0,
    frameNodes.findIndex((f) => /\b(home|homepage|home page|landing|index)\b/i.test(f.name.replace(/[_-]/g, " "))),
  );
  const families = new Map<string, number>();
  const imageRefs = new Set<string>();
  const frames: DesignFrame[] = frameNodes.map((node, index) => {
    const box = node.absoluteBoundingBox!;
    let textLayers = 0;
    let images = 0;
    let largestImage = 0;
    // Only what a visitor would see: nothing hidden or parked outside the frame.
    walk(visibleTree(node), (n) => {
      if (n.type === "TEXT" && (n.characters ?? "").trim()) {
        textLayers += 1;
        const styles = [n.style, ...Object.values(n.styleOverrideTable ?? {})];
        for (const style of styles) {
          if (style?.fontFamily) families.set(style.fontFamily, (families.get(style.fontFamily) ?? 0) + 1);
        }
      }
      for (const fill of (n.fills ?? []).filter(visible)) {
        if (fill.type !== "IMAGE" || !fill.imageRef) continue;
        images += 1;
        imageRefs.add(fill.imageRef);
        const b = n.absoluteBoundingBox;
        if (b) largestImage = Math.max(largestImage, (b.width * b.height) / Math.max(1, box.width * box.height));
      }
    });
    if (textLayers === 0) {
      items.push({
        id: `text:${node.id}`,
        status: "warning",
        title: `"${node.name}" has no text layers`,
        detail: "Its text may have been turned into shapes or a picture. TAWD can't read, check or improve text it can't see; ask the designer for live text.",
      });
    } else if (largestImage >= 0.9 && textLayers < 3) {
      items.push({
        id: `flat:${node.id}`,
        status: "warning",
        title: `"${node.name}" looks like one flat picture`,
        detail: "Almost all of it is a single image. TAWD needs the design's layers (text, buttons, photos) to review and rebuild it.",
      });
    }
    return {
      id: node.id,
      name: node.name,
      width: Math.round(box.width),
      height: Math.round(box.height),
      isHome: index === homeIndex,
      textLayers,
      images,
    };
  });

  if (frames.length > 0) {
    const home = frames.find((f) => f.isHome)!;
    const named = /\b(home|homepage|home page|landing|index)\b/i.test(home.name.replace(/[_-]/g, " "));
    items.push({
      id: "home",
      status: "ok",
      title: `${frames.length} final frame${frames.length === 1 ? "" : "s"}`,
      detail: `${list(frames.map((f) => `"${f.name}"`))}. The homepage is "${home.name}"${named ? "" : " (the first frame, since none is named Home)"}; it is the page TAWD reviews and improves.`,
    });

    const textTotal = frames.reduce((n, f) => n + f.textLayers, 0);
    if (textTotal > 0 && !items.some((i) => i.id.startsWith("text:"))) {
      items.push({ id: "text", status: "ok", title: "Text layers are usable", detail: `${textTotal} text layers TAWD can read.` });
    }
    const imageTotal = frames.reduce((n, f) => n + f.images, 0);
    if (!items.some((i) => i.id.startsWith("flat:"))) {
      items.push({
        id: "images",
        status: "ok",
        title: "Images",
        detail:
          imageTotal === 0
            ? "No photos or pictures in the final frames."
            : `${imageRefs.size} different image${imageRefs.size === 1 ? "" : "s"} in the final frames; each is checked when the design is imported.`,
      });
    }
  }

  const fonts = [...families.keys()].sort((a, b) => a.localeCompare(b)).map((family) => {
    const kind = fontKind(family);
    return { family, kind, usable: kind !== "other" };
  });
  const unusable = fonts.filter((f) => !f.usable).map((f) => f.family);
  if (fonts.length > 0) {
    items.push(
      unusable.length === 0
        ? { id: "fonts", status: "ok", title: "Fonts are usable", detail: `${list(fonts.map((f) => f.family))}: free web fonts or common system fonts.` }
        : {
            id: "fonts",
            status: "warning",
            title: `${list(unusable)} ${unusable.length === 1 ? "isn't a free web font" : "aren't free web fonts"}`,
            detail: `The website can't use ${unusable.length === 1 ? "it" : "them"} without a web license. TAWD will suggest the closest free font, for the designer to approve.${
              fonts.some((f) => f.usable) ? ` ${list(fonts.filter((f) => f.usable).map((f) => f.family))} ${fonts.filter((f) => f.usable).length === 1 ? "is" : "are"} fine.` : ""
            }`,
          },
    );
  }

  return {
    fileName: file.name,
    lastModified: file.lastModified,
    version: file.version,
    pages: pages.map((p) => ({ id: p.id, name: p.name, frames: pageFrames(p).length })),
    finalPage: page ? { id: page.id, name: page.name, chosen: Boolean(chosen) } : null,
    frames,
    fonts,
    imageRefs: [...imageRefs].sort(),
    items,
    warnings: items.filter((i) => i.status === "warning").length,
  };
}
