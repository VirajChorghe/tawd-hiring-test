import type { FontRole } from "./elements";

/*
  The fonts the style kit can choose from (28 September 2026): open-licence
  Google Fonts (SIL Open Font License or Apache 2.0), so the chosen ones can
  be self-hosted with the client's site. For a design with no font names
  (a PDF of pictures, like the sample client's), each line of text is drawn in the
  candidates of its kind and the closest shape wins; the team can change
  the choice.
*/

export const FONT_CANDIDATES: Record<FontRole, string[]> = {
  script: [
    "Pacifico", "Dancing Script", "Kaushan Script", "Satisfy", "Great Vibes", "Yellowtail", "Sacramento", "Allura",
    "Lobster", "Caveat", "Caveat Brush", "Cookie", "Courgette", "Damion", "Mr Dafoe", "Parisienne", "Rochester",
    "Marck Script", "Alex Brush", "Leckerli One", "Grand Hotel", "Norican", "Playball", "Oleo Script", "Merienda",
    "Homemade Apple", "Permanent Marker", "Shadows Into Light", "Kalam", "Handlee", "Style Script", "Bad Script",
    "Lobster Two", "Pinyon Script", "Tangerine", "Italianno", "Birthstone", "Ms Madi", "Meow Script", "Niconne",
    "Arizonia", "Qwigley", "Herr Von Muellerhoff", "Mrs Saint Delafield", "Cedarville Cursive", "La Belle Aurore",
  ],
  display: [
    "Playfair Display", "Abril Fatface", "Alfa Slab One", "Bree Serif", "Roboto Slab", "Arvo", "DM Serif Display",
    "Libre Baskerville", "Cinzel", "Merriweather", "Rye", "Ultra", "Zilla Slab", "Patua One", "Rokkitt", "Bitter",
    "Domine", "Prata", "Yeseva One", "Bodoni Moda", "Old Standard TT", "Rozha One", "Gloock", "Fraunces",
    "Young Serif", "Holtwood One SC", "Graduate", "Crete Round", "Slabo 27px", "Josefin Slab",
    "Noticia Text", "Aleo", "Enriqueta", "Podkova", "Sanchez", "Vidaloka", "Coustard", "Ranchers", "Chela One",
  ],
  serif: [
    "Playfair Display", "Libre Baskerville", "Merriweather", "Lora", "Crimson Text", "EB Garamond", "Cormorant Garamond",
    "Cinzel", "Roboto Slab", "Bree Serif", "Noto Serif", "Source Serif 4", "Spectral", "Alegreya", "Cardo", "Vollkorn",
    "PT Serif", "DM Serif Display", "Domine", "Bitter", "Zilla Slab", "Arvo", "Prata", "Old Standard TT", "Fraunces",
    "Young Serif", "Libre Caslon Text", "Gelasio", "Newsreader", "Literata",
  ],
  sans: [
    "Lato", "Montserrat", "Open Sans", "Poppins", "Raleway", "Nunito", "Nunito Sans", "Source Sans 3", "Roboto",
    "Inter", "Work Sans", "Oswald", "PT Sans", "Mulish", "Karla", "Rubik", "Quicksand", "Josefin Sans", "Barlow",
    "Fira Sans", "Manrope", "DM Sans", "Outfit", "Figtree", "Cabin", "Hind", "Archivo", "Libre Franklin", "Noto Sans",
    "Ubuntu", "Arimo", "Heebo", "Assistant", "Varela Round", "Comfortaa", "Exo 2", "Titillium Web", "Bebas Neue",
    "Anton", "League Spartan", "Kanit", "Jost", "Lexend", "Plus Jakarta Sans", "Red Hat Display", "Sora", "Urbanist",
    "Albert Sans", "Public Sans", "Hanken Grotesk", "Mukta", "Catamaran", "Maven Pro", "Questrial", "Signika",
  ],
};

/* The generic family to fall back on for each kind. */
export const ROLE_FALLBACK: Record<FontRole, string> = {
  script: "cursive",
  display: "serif",
  serif: "serif",
  sans: "sans-serif",
};

/* The Google Fonts stylesheet address for families at the given weights (used by the worker to fetch the files once). */
export function googleFontsCss(families: { family: string; weights: number[] }[]): string {
  const parts = families.map(({ family, weights }) => {
    const ws = [...new Set(weights)].sort((a, b) => a - b);
    return `family=${encodeURIComponent(family).replace(/%20/g, "+")}${ws.length ? `:wght@${ws.join(";")}` : ""}`;
  });
  return `https://fonts.googleapis.com/css2?${parts.join("&")}&display=swap`;
}
