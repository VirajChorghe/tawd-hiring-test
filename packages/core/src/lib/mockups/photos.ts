import { orientation, type PageAsset } from "./assets";

/*
  The client's real photos come first (Jason, 27 September 2026, after the
  Finley mockups: real photos matter most; placeholder frames always look
  like a wireframe). No AI: a photo is read from its caption and file name.

  - "people": the team, the owner, a technician: the best hero, because it
    shows who turns up.
  - "work": a job, the van, the premises, a finished project.
  - "other": anything else, or no caption.
*/

export type PhotoKind = "people" | "work" | "other";

const PEOPLE = /\b(team|crew|staff|owners?|founders?|technicians?|techs?|employees?|family|portrait|headshot|people|us|our (?:team|crew|staff|family)|the (?:boss|owner)|with (?:a )?customer)\b/i;
const WORK = /\b(jobs?|work|project|install\w*|repair\w*|before|after|finished|site|truck|van|vehicle|fleet|shop|office|premises|building|equipment|tools?|inspection|treatment)\b/i;

export function photoKind(caption: string | null | undefined, fileName = ""): PhotoKind {
  const text = `${caption ?? ""} ${fileName.replace(/\.[a-z0-9]+$/i, "").replace(/[_-]+/g, " ")}`;
  if (PEOPLE.test(text)) return "people";
  if (WORK.test(text)) return "work";
  return "other";
}

export interface PhotoSummary {
  count: number;
  people: number;
  work: number;
}

export function summarizePhotos(photos: { caption: string | null; fileName: string }[]): PhotoSummary {
  const kinds = photos.map((p) => photoKind(p.caption, p.fileName));
  return { count: photos.length, people: kinds.filter((k) => k === "people").length, work: kinds.filter((k) => k === "work").length };
}

/*
  The hero photo: a real team photo first, then a job photo, landscape
  before portrait (a hero is wide), then upload order. Null when there are
  no photos: the hero then uses a stock scene or a designed placeholder.
*/
export function chooseHeroPhoto(assets: PageAsset[]): PageAsset | null {
  const photos = assets.filter((a) => a.kind === "photo");
  if (photos.length === 0) return null;
  const rank = (a: PageAsset) => {
    const kind = photoKind(a.caption, a.fileName);
    const kindRank = kind === "people" ? 0 : kind === "work" ? 1 : 2;
    const shapeRank = orientation(a).startsWith("landscape") ? 0 : orientation(a).includes("square") ? 1 : 2;
    return kindRank * 3 + shapeRank;
  };
  return [...photos].sort((a, b) => rank(a) - rank(b))[0] ?? null;
}

/* The photo plan for the builder: the hero, every photo's kind, and the richness rules. */
export function photoPlanSection(assets: PageAsset[], stockAvailable: boolean): string {
  const photos = assets.filter((a) => a.kind === "photo");
  const hero = chooseHeroPhoto(assets);
  const lines: string[] = ["# Photos and visual richness", ""];
  if (hero) {
    const kind = photoKind(hero.caption, hero.fileName);
    lines.push(
      `- Hero: use ${hero.token}${kind === "people" ? " (the client's own team: the strongest hero there is, so show the people clearly and keep text off their faces)" : kind === "work" ? " (the client's own work)" : ""}. Put the client's real photos in the most visible places first.`,
    );
  } else {
    lines.push("- The client sent no photos yet. The hero still needs a strong picture: a stock scene frame of the trade at work, never an empty box.");
  }
  if (photos.length > 1) {
    lines.push(
      `- Use every one of the client's ${photos.length} photos somewhere on the page where it fits, before any stock frame: ${photos.map((p) => `${p.token} (${photoKind(p.caption, p.fileName)})`).join(", ")}.`,
    );
  }
  lines.push(
    "- A page with few pictures reads flat and unfinished, but a picture must earn its place. The hero always has one. Services, service areas and bands about a problem or a job carry a real photo or a stock scene. \"Why us\", the process, FAQs, reviews, licences and guarantees, contact and call-to-action bands use the client's own photos or none: never a stock scene (TAWD removes one there).",
    `- ${stockAvailable ? "Stock scene frames fill the gaps in those bands: at most 8 on the page, at most one per band, each phrase naming the trade and that band's own subject (\"pest control technician spraying a yard\", not \"traps\"). Every general-scene frame gets its phrase, or it stays an empty box." : "Where a picture is needed and none of the client's fits, draw a labeled placeholder frame."}`,
    "- Never put text over a person's face. Text over a photo sits on the side or the lower part, away from the people in it.",
  );
  return lines.join("\n");
}
