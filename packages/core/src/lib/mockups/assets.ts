import type { CheckIssue } from "./checks";

/*
  The client's own logo and photos, on the page.

  The first real concept showed the logo's file name ("download-4.webp") and
  a photo's caption inside gray frames, because the prompt told the model
  to use placeholder frames for every image. Now the model is given a short
  token for each uploaded image and writes it where the image belongs:

      <img src="tawd-asset:photo-2" alt="...">
      background-image: url('tawd-asset:photo-1')

  After the model replies, the worker swaps each token for the image itself,
  inlined as a data URI. Two reasons for the token rather than sending the
  image bytes to the model: a photo inlined in the prompt would cost tens of
  thousands of tokens every turn, and the page the model sees in the fix
  round stays small enough to edit. The stored HTML is self-contained, so
  "View HTML" shows the real images too.
*/

export type AssetKind = "logo" | "photo";

export interface PageAsset {
  token: string;
  kind: AssetKind;
  caption: string | null;
  fileName: string;
  width: number | null;
  height: number | null;
  /*
    Logos only: how the logo's own marks read, measured when it is
    prepared. "dark" marks disappear on a dark header and "light" ones on a
    light header; "solid" means the logo carries its own background.
  */
  tone?: "dark" | "light" | "mid" | "solid" | null;
}

export const ASSET_SCHEME = "tawd-asset:";

/* The caption of a photo TAWD took from the client's current website (5 November 2026), never the team's own words. */
export const SITE_PHOTO_CAPTION = "a photo from the client's current website";

export function isSitePhoto(asset: { caption: string | null }): boolean {
  return (asset.caption ?? "").startsWith(SITE_PHOTO_CAPTION);
}

/*
  Gap 14 (security): each site photo's old alt, read out of its caption and
  keyed by token, for applyPhotoAlt. The scraped alt is the old site's own
  text — data, never instructions — so it never enters a prompt; code carries
  it onto the rendered or built <img> instead. A photo with no old alt is left
  out, so the builder's own alt stays.
*/
export function sitePhotoAlts(assets: { token: string; caption: string | null }[]): Map<string, string> {
  const prefix = `${SITE_PHOTO_CAPTION}: `;
  const map = new Map<string, string>();
  for (const asset of assets) {
    const caption = asset.caption ?? "";
    const alt = caption.startsWith(prefix) ? caption.slice(prefix.length).trim() : "";
    if (alt) map.set(asset.token, alt);
  }
  return map;
}

const TOKEN_PATTERN = /tawd-asset:([a-z0-9-]+)/gi;

export function logoToken(): string {
  return `${ASSET_SCHEME}logo`;
}

/** Numbered from 1 in upload order, which is the order the team sees. */
export function photoToken(index: number): string {
  return `${ASSET_SCHEME}photo-${index + 1}`;
}

/*
  F8 (9 November 2026): the same photograph in several bands.

  Nothing stopped the builder putting one photo token in three places, and
  nothing noticed: the page looked to the checks like a page with pictures,
  and the Creative Director marked the repetition down as a design fault.
  This counts how often each of the client's photos is used, so code can
  swap a repeat for a photo nobody used and say that it did.
*/
export function photoTokenUses(html: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const match of html.matchAll(TOKEN_PATTERN)) {
    const token = `${ASSET_SCHEME}${match[1]!.toLowerCase()}`;
    /*
      Every photograph of the client's, uploaded or read from their current
      site (photo-1, photo-site-2, photo-home-3). Not the logo, which
      belongs in the header and the footer both.
    */
    if (!/^tawd-asset:photo-/.test(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return counts;
}

/*
  The page with each repeated photograph after its first use swapped for one
  nobody used, in the order those photos were uploaded. A page with nothing
  spare is left exactly as it is: a repeat is better than an empty frame.
*/
export function spreadRepeatedPhotos(html: string, available: string[]): { html: string; swapped: { from: string; to: string }[] } {
  const used = photoTokenUses(html);
  /*
    A spare is a photo nothing on the page uses - judged against EVERY token
    the page refers to, not only the ones counted as repeats (CodeRabbit, PR
    #65). The designer flows upload their pictures as photos named
    design-image-N, which photoTokenUses does not count, so filtering on the
    counts alone could hand back a picture already on the page and make a new
    repeat that nothing would notice.
  */
  const onThePage = new Set(assetTokensUsed(html));
  const spare = available.filter((token) => !onThePage.has(token));
  if (spare.length === 0) return { html, swapped: [] };
  const swapped: { from: string; to: string }[] = [];
  const seen = new Map<string, number>();
  const out = html.replace(TOKEN_PATTERN, (whole, name: string) => {
    const token = `${ASSET_SCHEME}${name.toLowerCase()}`;
    if (!used.has(token) || (used.get(token) ?? 0) < 2) return whole;
    const nth = (seen.get(token) ?? 0) + 1;
    seen.set(token, nth);
    if (nth === 1) return whole; // The first use stays where the builder put it.
    const next = spare.shift();
    if (!next) return whole;
    swapped.push({ from: token, to: next });
    return next;
  });
  return { html: out, swapped };
}

/*
  A photograph in more than one band, and why it stayed there (11 November
  2026). spreadRepeatedPhotos leaves a repeat alone when the client has
  nothing unused to put in its place - Jason's call on 9 November, because a
  repeat beats an empty frame - and then the Creative Director saw the same
  cover in two bands and marked the concept down for it (New Dawn, Concept
  A: "Pictures fit 2 ... the same photo appears in both the styles gallery
  and the founding-year band"). It was nobody's choice: there were 7
  photographs for 12 bands.

  So the reviewer is told, in the same breath as the rest of what TAWD
  measured. Null when nothing repeats, or when something was spare - in
  which case the repeat was swapped and there is nothing to explain.
*/
export function describeRepeatedPhotos(html: string, available: string[]): string | null {
  const repeats = [...photoTokenUses(html)].filter(([, times]) => times > 1);
  if (repeats.length === 0) return null;
  const onThePage = new Set(assetTokensUsed(html));
  if (available.some((token) => !onThePage.has(token))) return null;
  const named = repeats
    .map(([token, times]) => `${token.replace(ASSET_SCHEME, "")} ${times} times`)
    .join(", ");
  return `the same photograph is used more than once (${named}); the client's ${available.length} uploaded photograph${available.length === 1 ? " is" : "s are all"} already on the page, so none was left to swap in`;
}

/** Every token the page refers to, once each. */
export function assetTokensUsed(html: string): string[] {
  const out = new Set<string>();
  for (const match of html.matchAll(TOKEN_PATTERN)) {
    out.add(`${ASSET_SCHEME}${match[1]!.toLowerCase()}`);
  }
  return [...out];
}

/**
 * Swaps each token for its image. A token with no image is left alone; the
 * checks have already failed it.
 */
export function embedAssets(
  html: string,
  dataUris: Record<string, string>,
): string {
  // Mark each <img> showing the logo, so the rendered checks can find it
  // and test that it is visible against what sits behind it.
  const marked = html.replace(
    /<img\b(?![^>]*data-tawd-logo)([^>]*?)\ssrc=(["'])tawd-asset:logo\2/gi,
    (_whole, attrs: string, quote: string) => `<img data-tawd-logo${attrs} src=${quote}tawd-asset:logo${quote}`,
  );
  return marked.replace(TOKEN_PATTERN, (whole, name: string) => {
    return dataUris[`${ASSET_SCHEME}${name.toLowerCase()}`] ?? whole;
  });
}

export function orientation(asset: PageAsset): string {
  if (!asset.width || !asset.height) return "unknown shape";
  const ratio = asset.width / asset.height;
  if (ratio > 1.2) return "landscape";
  if (ratio < 0.85) return "portrait";
  return "roughly square";
}

/*
  The image checks.

  An uploaded logo that is not on the page, or a set of uploaded photos of
  which none is used, is exactly the defect the team saw, so both fail and
  send the concept round the fix loop. A token that matches no upload would
  render as a broken image, so that fails too.
*/
export function checkAssets(html: string, assets: PageAsset[]): CheckIssue[] {
  const issues: CheckIssue[] = [];
  const known = new Set(assets.map((a) => a.token));
  const used = assetTokensUsed(html);

  const unknown = used.filter((token) => !known.has(token));
  if (unknown.length > 0) {
    issues.push({
      id: "images.unknownAsset",
      severity: "fail",
      message: `The page refers to ${unknown.join(", ")}, which ${
        unknown.length === 1 ? "is not an uploaded image" : "are not uploaded images"
      }. Use only the tokens in the images list.`,
    });
  }

  const logo = assets.find((a) => a.kind === "logo");
  if (logo && !used.includes(logo.token)) {
    issues.push({
      id: "images.logo.unused",
      severity: "fail",
      message: `The client's logo was uploaded but is not on the page. Use <img src="${logo.token}"> in the header, not the file name or a placeholder.`,
    });
  }

  const photos = assets.filter((a) => a.kind === "photo");
  if (photos.length > 0 && !photos.some((p) => used.includes(p.token))) {
    issues.push({
      id: "images.photos.unused",
      severity: "fail",
      message: `${photos.length} photo${photos.length === 1 ? " was" : "s were"} uploaded but none is on the page. Put them where the design has photo frames, using their tokens; keep a labeled frame only where no uploaded photo fits.`,
    });
  }

  /*
    F8: the same photograph in several bands. It fails only when there is a
    photo nobody used, because then code can swap the repeat for it; with
    nothing spare, a repeat is better than an empty frame and the team is
    told rather than the concept being sent round the fix loop for nothing.
  */
  const repeats = [...photoTokenUses(html)].filter(([, n]) => n > 1).map(([token]) => token);
  if (repeats.length > 0) {
    const spare = photos.filter((p) => !used.includes(p.token)).length;
    issues.push({
      id: "images.repeatedPhoto",
      severity: spare > 0 ? "fail" : "warn",
      message:
        spare > 0
          ? `${repeats.join(", ")} ${repeats.length === 1 ? "is" : "are"} used in more than one band while ${spare} uploaded photo${spare === 1 ? " is" : "s are"} unused. Each band gets its own photo; TAWD swaps the repeats for the unused ones.`
          : `${repeats.join(", ")} ${repeats.length === 1 ? "is" : "are"} used in more than one band, and there is no unused photo to put in its place. Ask the client for more photos, or leave the band without one.`,
    });
  }

  return issues;
}
