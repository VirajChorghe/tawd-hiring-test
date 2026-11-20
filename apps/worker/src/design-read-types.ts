import type { Box } from "./design-pixels";
import type { PictureKind } from "./design-assets";

/*
  The shapes of the new design read (E4, Lane 2, 14 November 2026; spec 15
  section 6 stage 2). The read is two kinds of AI look plus code:
  - one look at the whole page, small, for the BAND LIST (header, each band,
    footer, with their tops and bottoms);
  - one look at each band at full size for its WORDS, the POINTS whose
    colours code should measure, the FONTS, and its PICTURES with their kinds.
  Code then checks the band list covers the page, snaps each band edge to
  the design's own colour change, measures the colours, tidies the words
  (spaced capitals, doubled text) and turns the result into what the checks
  (E2, design-checks.ts) and the pictures step (E3, design-assets.ts) take.

  Every position is in the design picture's own pixels, from its top left.
*/

export type BandRole = "header" | "band" | "footer";

/** One band as the whole-page look names it. */
export interface ReadBand {
  name: string;
  role: BandRole;
  top: number;
  bottom: number;
}

export type WordRole = "heading" | "paragraph" | "button" | "link" | "label" | "other";

/** One run of words as drawn (a heading line, a paragraph, a button label). */
export interface ReadWords {
  text: string;
  role: WordRole;
  box: Box;
  /** The read could not make every letter out (blurred or tiny text): kept, flagged, never corrected by guess. */
  unsure?: boolean;
}

/** A place whose colour code measures from the picture (the AI names it; it never gives the colour). */
export interface ColourPoint {
  name: string;
  x: number;
  y: number;
}

export interface MeasuredColour extends ColourPoint {
  hex: string;
}

/** A font as the read guesses it: a guess until line widths are measured (spec section 2 step 6). */
export interface FontGuess {
  role: "heading" | "body" | "button" | "other";
  family: string;
}

/** A picture in a band, as the read sees it: what E3 takes, plus where it sits. */
export interface ReadPicture {
  id: string;
  kind: PictureKind;
  box: Box;
  /** Background only: the boxes drawn over it (text, cards, a form). */
  drawnOver?: Box[];
  /** Icon only: the words beside it, and the card's heading. */
  label?: string;
  context?: string;
}

/** Everything the read found in one band. */
export interface BandRead {
  band: ReadBand;
  words: ReadWords[];
  points: ColourPoint[];
  fonts: FontGuess[];
  pictures: ReadPicture[];
  /** Plain sentences for a person: what the read was unsure of or could not do. */
  notes: string[];
}

/** The whole read of one design page. */
export interface DesignRead {
  /** The start that made this read (its pictures are saved under it). Missing on reads saved before E4b-1. */
  runId?: string;
  width: number;
  height: number;
  bands: BandRead[];
  colours: MeasuredColour[];
  notes: string[];
}
