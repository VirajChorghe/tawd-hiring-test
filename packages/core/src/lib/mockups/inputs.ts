import type { ProposalInputs } from "./directions";
import { summarizePhotos, type PhotoSummary } from "./photos";

/*
  Intake-first inputs (Jason, 27 September 2026): the logo, the client's
  real photos and 2 to 3 reference sites are the main inputs to a mockup.
  Each missing one gets a clear "missing, results will be weaker" note, on
  the intake and on the Mockups setup screen. A note, never a block.
*/

export interface MockupInputsSource {
  logos: number;
  colors: string[];
  colorsFromLogo: boolean;
  photos: { caption: string | null; fileName: string }[];
  references: { url: string; status: string; briefStatus: string | null; closestDirection?: string | null }[];
}

export interface InputNote {
  input: "logo" | "photos" | "references";
  text: string;
}

export interface MockupInputs {
  logo: boolean;
  colors: string[];
  colorsFrom: ProposalInputs["colorsFrom"];
  photos: PhotoSummary;
  references: { url: string; shot: boolean; studied: boolean }[];
  /** "Missing, results will be weaker" notes; empty when every main input is there. */
  notes: InputNote[];
}

export const WANTED_REFERENCES = 2;

export function describeMockupInputs(source: MockupInputsSource): MockupInputs {
  const photos = summarizePhotos(source.photos);
  const colorsFrom: ProposalInputs["colorsFrom"] = source.colors.length === 0 ? "none" : source.colorsFromLogo ? "logo" : "entered";
  const notes: InputNote[] = [];

  if (source.logos === 0) {
    notes.push({ input: "logo", text: "No logo yet, so the brand can't come from the client. Results will be weaker: every guessed palette so far was wrong." });
  } else if (source.colors.length === 0) {
    notes.push({ input: "logo", text: "No brand colours entered: they will be taken from the logo. Check them on the Brand section." });
  }

  if (photos.count === 0) {
    notes.push({ input: "photos", text: "No real photos yet. Results will be weaker: placeholder frames look like a wireframe. Ask for a team photo and 3 to 5 photos of real jobs." });
  } else if (photos.people === 0) {
    notes.push({ input: "photos", text: "No team photo yet. A real photo of the team (or the owner at a job) makes the strongest hero; caption it \"team\" when it arrives." });
  }

  const references = source.references.map((r) => ({ url: r.url, shot: r.status === "done", studied: r.briefStatus === "done" }));
  if (references.length < WANTED_REFERENCES) {
    notes.push({
      input: "references",
      text: `${references.length === 0 ? "No reference sites yet" : "Only 1 reference site"}. Results will be weaker: 2 to 3 sites the client likes set the bar and give a proven structure. Add them under Website.`,
    });
  }

  return { logo: source.logos > 0, colors: source.colors, colorsFrom, photos, references, notes };
}

export function proposalInputsOf(inputs: MockupInputs, closest: Record<string, string | null | undefined>): ProposalInputs {
  return {
    colors: inputs.colors,
    colorsFrom: inputs.colorsFrom,
    photos: inputs.photos,
    references: inputs.references.map((r) => ({ url: r.url, studied: r.studied, closestDirection: (closest[r.url] ?? null) as ProposalInputs["references"][number]["closestDirection"] })),
  };
}
