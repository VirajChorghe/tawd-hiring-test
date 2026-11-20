# Builds packages/core/src/lib/style-kit/icon-set.ts from the two pinned icon packages.
# Usage (from the repo root, after "npm pack @tabler/icons@3.48.0 simple-icons@16.33.0" and unpacking each):
#   python scripts/style-kit-icons.py <tabler package folder> <simple-icons package folder>
import re, os, json, sys
T=os.path.join(sys.argv[1],"icons")
S=os.path.join(sys.argv[2],"icons")
names = """paw heart heart-handshake player-play player-play-circle message-circle message-circle-2 message-2 messages arrow-right arrow-left arrow-up-right chevron-down chevron-right chevron-left chevron-up
phone phone-call mail map-pin map-2 clock calendar calendar-event star check circle-check shield shield-check sparkles bulb home home-2 tool tools truck user users
search menu-2 x plus minus quote award leaf flame droplet bolt snowflake scale briefcase bug building camera video book book-2 info-circle external-link download
thumb-up certificate currency-dollar wrench hammer paint bath air-conditioning plug dog cat bone ball-tennis trees mountain sun moon cloud umbrella gift tag
news article notebook school stethoscope first-aid-kit pill apple salad tool home-cog building-store car key lock door window-maximize ruler-2 bucket spray
settings adjustments filter list list-check clipboard-check file-text photo movie microphone headphones music share send link world globe language
heart-plus mood-smile mood-heart confetti trophy medal flag target rocket chart-bar trending-up receipt credit-card wallet discount percentage
hand-click hand-finger-right point hourglass alarm bell bell-ringing eye lifebuoy help-circle alert-circle alert-triangle circle-x lock-check
leaf-2 plant plant-2 seedling flower recycle wind temperature flame-off droplet-filled ripple waves anchor fish mushroom feather
spider bat virus pipeline home-shield home-check shield-check window glass gavel fence lawn-mower shovel ladder wall solar-panel fire-extinguisher vacuum-cleaner brush car-garage droplets snowflake toilet-paper building-warehouse""".split()
out=[]
missing=[]
def body(svg):
    svg=re.sub(r'<path stroke="none" d="M0 0h24v24H0z" fill="none"\s*/>','',svg)
    inner=re.search(r'<svg[^>]*>(.*)</svg>',svg,re.S).group(1)
    inner=re.sub(r'<title>.*?</title>','',inner)
    return re.sub(r'\s+',' ',inner).strip()
for n in dict.fromkeys(names):
    found=False
    for style in ("outline","filled"):
        f=f"{T}/{style}/{n}.svg"
        if os.path.exists(f):
            out.append({"name":n,"style":style,"body":body(open(f,encoding="utf8").read())}); found=True
    if not found: missing.append(n)
# Tabler's plain brand glyphs too (the "f" alone, for a design that draws it inside its own ring).
for n in "facebook tiktok youtube instagram x linkedin pinterest yelp google whatsapp threads snapchat vimeo spotify tripadvisor reddit twitch discord etsy bluesky".split():
    f=f"{T}/outline/brand-{n}.svg"
    if os.path.exists(f): out.append({"name":"brand-"+n,"style":"outline","body":body(open(f,encoding="utf8").read())})
brands="tiktok youtube instagram facebook x linkedin pinterest yelp google nextdoor whatsapp threads snapchat vimeo spotify tripadvisor houzz angi thumbtack bluesky reddit twitch discord etsy".split()
for n in brands:
    f=f"{S}/{n}.svg"
    if os.path.exists(f): out.append({"name":"brand-"+n,"style":"brand","body":body(open(f,encoding="utf8").read())})
    else: missing.append("brand-"+n)
print("icons",len(out),"missing",missing)
ts='''/*
  The style kit's vector icons (Jason, 28 September 2026: "vector icons in
  place of icons cut from designs; official brand icons for social links").

  Generated from pinned packages, never fetched at run time:
  - Tabler Icons 3.48.0 (MIT, Copyright (c) 2020-2026 Pawel Kuna), outline
    (drawn with a 2px stroke) and filled;
  - Simple Icons 16.33.0 (CC0 1.0) for brand marks, which remain the
    trademarks of their owners and are used only to link to those services.

  Each icon is the inside of a 24x24 SVG. Regenerate with
  scripts/style-kit-icons.py from the two packages; don't edit by hand.
*/

export type IconStyle = "outline" | "filled" | "brand";

export interface KitIcon {
  name: string;
  style: IconStyle;
  body: string;
}

export const KIT_ICONS: KitIcon[] = '''+json.dumps(out,indent=0,ensure_ascii=False)+''';

/* The icon as a whole SVG, drawn in currentColor. */
export function iconSvg(icon: KitIcon, attrs = ""): string {
  const paint = icon.style === "outline" ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"' : 'fill="currentColor"';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" ${paint}${attrs ? " " + attrs : ""}>${icon.body}</svg>`;
}

export function findIcon(name: string, style?: IconStyle): KitIcon | undefined {
  return KIT_ICONS.find((i) => i.name === name && (!style || i.style === style)) ?? KIT_ICONS.find((i) => i.name === name);
}
'''
open(os.path.join(os.path.dirname(__file__),"..","packages","core","src","lib","style-kit","icon-set.ts"),"w",encoding="utf8",newline="\n").write(ts)
