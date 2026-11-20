/*
  Videos from the client's social links (Jason, 29 September 2026): TikTok
  and Instagram videos shown as click-to-play thumbnails, on a Videos page
  and in the home page's featured videos. Nothing from TikTok or Instagram
  loads until the visitor clicks one (then only that video's player), so a
  visitor who never clicks sends nothing to them, inside the consent rules.
*/

export interface SiteVideo {
  platform: "tiktok" | "instagram";
  /** The link as the team pasted it. */
  url: string;
  /** The player address, loaded only on a click. */
  embed: string;
  title: string | null;
}

/* A TikTok or Instagram video link read into its player address; null for anything else. */
/*
  The profile addresses a project's saved video links give away (29
  September 2026): a TikTok video link names its account (/@handle/video/).
  Social icons on the site link only to these; the rest are removed.
*/
export function socialProfiles(videos: SiteVideo[] | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const v of videos ?? []) {
    const handle = v.platform === "tiktok" ? /tiktok\.com\/(@[A-Za-z0-9_.]{2,40})\//.exec(v.url)?.[1] : null;
    if (handle && !out.tiktok) out.tiktok = `https://www.tiktok.com/${handle}`;
  }
  return out;
}

export function parseVideoLink(raw: string, title: string | null = null): SiteVideo | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^www\./, "").replace(/^m\./, "");
  if (host === "tiktok.com") {
    const id = /\/video\/(\d{8,25})/.exec(u.pathname)?.[1];
    return id ? { platform: "tiktok", url: u.toString(), embed: `https://www.tiktok.com/player/v1/${id}`, title } : null;
  }
  if (host === "instagram.com") {
    const m = /^\/(reel|reels|p|tv)\/([A-Za-z0-9_-]{5,40})/.exec(u.pathname);
    if (!m) return null;
    const kind = m[1] === "p" ? "p" : "reel";
    return { platform: "instagram", url: u.toString(), embed: `https://www.instagram.com/${kind}/${m[2]}/embed`, title };
  }
  return null;
}

/* The pasted text, one link per line with an optional title after " | ", read into videos and the lines that aren't one. */
/*
  Links as people paste them (Jason, 29 September 2026: seven links
  separated by commas were read as one): every web address is a link of
  its own, whether they are on lines, or separated by commas or spaces; a
  title may follow one after " | "; stray "%20" and punctuation around a
  link are cleaned off. Whatever can't be read is handed back to be named.
*/
export function readVideoLinks(text: string): { videos: SiteVideo[]; rejected: string[] } {
  const videos: SiteVideo[] = [];
  const rejected: string[] = [];
  const add = (raw: string, title: string | null) => {
    let link = raw.trim();
    try {
      link = decodeURIComponent(link);
    } catch {
      // A lone "%" stays as it is.
    }
    link = link.replace(/%20/gi, " ").trim().replace(/^[\s,;"'<(]+|[\s,;"'>).]+$/g, "");
    if (!/^https?:\/\//i.test(link) && /^(www\.|m\.)?(tiktok|instagram)\.com\//i.test(link)) link = `https://${link}`;
    const video = parseVideoLink(link, title);
    if (video) {
      if (!videos.some((v) => v.embed === video.embed)) videos.push(video);
    } else rejected.push(raw.trim());
  };
  for (const line of text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)) {
    // Each address starts a piece; the words after "|" in a piece are its title.
    const starts = [...line.matchAll(/(?:https?:\/\/|(?<![\w/.])(?:www\.|m\.)?(?:tiktok|instagram)\.com\/)/gi)].map((m) => m.index!);
    if (starts.length === 0) {
      rejected.push(line);
      continue;
    }
    if (starts[0]! > 0 && line.slice(0, starts[0]).replace(/[\s,;|]+/g, "")) rejected.push(line.slice(0, starts[0]).trim());
    for (const [i, start] of starts.entries()) {
      const piece = line.slice(start, starts[i + 1] ?? line.length);
      const [link, ...rest] = piece.split("|");
      const title = rest.join("|").replace(/[\s,;]+$/, "").trim() || null;
      // A link and its separators: "a.com/x, " or "a.com/x b.com/y".
      const [address, ...more] = link!.trim().split(/[\s,;]+/);
      add(address!, title);
      const extra = more.join(" ").trim();
      if (extra && !title) rejected.push(extra);
    }
  }
  return { videos, rejected };
}

const esc = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/* One click-to-play thumbnail: the picture (or the platform's name), the title, a play mark. */
export function videoButton(v: SiteVideo, thumb: string | null, index: number): string {
  const name = v.platform === "tiktok" ? "TikTok" : "Instagram";
  const title = v.title ?? `${name} video ${index + 1}`;
  const picture = thumb ? `<img src="${esc(thumb)}" alt="" loading="lazy">` : `<span class="tawd-video-blank">${name}</span>`;
  return `<button type="button" class="tawd-video" data-src="${esc(v.embed)}" data-title="${esc(title)}" aria-label="Play ${esc(title)} (plays from ${name})">${picture}<span class="tawd-video-play" aria-hidden="true"></span></button>`;
}

/* The Videos page's main part: a heading, a line on how the videos load, and the grid. */
/** A caption cut at a word, never mid-word, with "…" (29 September 2026). */
export function shortCaption(text: string, max = 70): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max + 1).replace(/\s+\S*$/, "").replace(/[\s,;:.!?-]+$/, "");
  return `${cut || t.slice(0, max)}…`;
}

/* The Videos page's main part, in the site's own lettering and colours: a heading, a short line, the grid centred. */
export function videosPageMain(videos: SiteVideo[], thumbs: (string | null)[], heading = "Videos"): string {
  const items = videos
    .map((v, i) => `<figure class="tawd-video-item">${videoButton(v, thumbs[i] ?? null, i)}${v.title ? `<figcaption title="${esc(v.title)}">${esc(shortCaption(v.title))}</figcaption>` : ""}</figure>`)
    .join("");
  return `<section class="tawd-videos" data-tawd-generated="videos"><h1>${esc(heading)}</h1><p class="tawd-videos-note">Tap a video to play it.</p><div class="tawd-video-grid">${items}</div></section>`;
}

/* The styles and the one small script: a click swaps the thumbnail for the video's player. */
export const VIDEO_CSS = `
.tawd-videos{max-width:1200px;margin:0 auto;padding:56px 24px;text-align:center}
.tawd-videos h1{font-family:var(--kit-font-display,var(--kit-font-sans,inherit));color:var(--kit-color-2,inherit);font-size:clamp(2rem,5vw,3.25rem);letter-spacing:.03em;margin:0 0 8px}
.tawd-videos-note{color:var(--kit-color-6,inherit);margin:0 0 32px;font-size:1rem}
.tawd-video-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,260px));justify-content:center;gap:24px}
.tawd-video-item{margin:0;text-align:left}
.tawd-video-item figcaption{margin-top:10px;font-weight:600;font-size:15px;line-height:1.35;color:var(--kit-color-2,inherit)}
@media (max-width:767px){.tawd-videos{padding:40px 16px}.tawd-video-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}}
.tawd-video{position:relative;display:block;width:100%;aspect-ratio:9/16;max-height:520px;border:0;padding:0;border-radius:12px;overflow:hidden;background:#101828;cursor:pointer}
.tawd-video img{width:100%;height:100%;object-fit:cover;display:block}
.tawd-video-blank{display:flex;align-items:center;justify-content:center;width:100%;height:100%;color:#fff;font-size:20px;font-weight:700}
.tawd-video-play{position:absolute;left:50%;top:50%;width:56px;height:56px;margin:-28px 0 0 -28px;border-radius:50%;background:rgba(1,21,59,.62)}
.tawd-video-play::after{content:"";position:absolute;left:22px;top:17px;border-left:17px solid #fff;border-top:11px solid transparent;border-bottom:11px solid transparent}
.tawd-video-frame{width:100%;aspect-ratio:9/16;max-height:720px;border:0;border-radius:12px;display:block}
[data-tawd-video-card]{cursor:pointer}
@media (max-width:767px){.tawd-video-grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.tawd-videos{padding:28px 16px}}
`;

export const VIDEO_SCRIPT = `<script>document.addEventListener("click",function(e){var b=e.target.closest(".tawd-video,[data-tawd-video-card]");if(!b)return;e.preventDefault();var f=document.createElement("iframe");f.src=b.getAttribute("data-src");f.title=b.getAttribute("data-title")||"Video";f.className="tawd-video-frame";f.setAttribute("allow","autoplay; encrypted-media; fullscreen; picture-in-picture");f.setAttribute("allowfullscreen","");b.replaceWith(f);});</script>`;
