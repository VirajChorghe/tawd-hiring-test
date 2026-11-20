import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { Suspense, type ReactNode } from "react";

import { TopProgress } from "@/components/ui/top-progress";
import { APP_NAME, APP_TITLE, BRAND_NAVY, brandIcons } from "@/lib/brand";
import "./globals.css";
import "./intake.css";
import "./team.css";
import "./spend.css";
import "./projects.css";
import "./mockups.css";
import "./content.css";

/*
  Hanken Grotesk, the typeface named in DESIGN.md, served from our own
  origin so no visitor's browser ever calls Google.

  Since 28 September 2026 the file is in the repo (fonts/, the variable
  font's Latin subset, weights 400 to 700, with its SIL Open Font License),
  so the build never reaches Google's font servers: the 0.54.0 web deploy
  failed once when it couldn't.
*/
const hankenGrotesk = localFont({
  src: "./fonts/hanken-grotesk-latin.woff2",
  weight: "400 700",
  style: "normal",
  display: "swap",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

export const metadata: Metadata = {
  title: APP_TITLE,
  applicationName: APP_NAME,
  description:
    "Total Agentic Web Developer: Velocity Media Lab's website builder for local service businesses.",
  // TAWD is an internal tool. It should never appear in search results.
  robots: { index: false, follow: false },
  // From the approved logo package in public/brand (see DESIGN.md, Brand).
  icons: brandIcons,
};

export const viewport: Viewport = {
  themeColor: BRAND_NAVY,
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={hankenGrotesk.className}>
      <body>
        {/* The top progress bar, on every screen (Sign in and Sign out too). Suspense: it reads the query. */}
        <Suspense fallback={null}>
          <TopProgress />
        </Suspense>
        {children}
      </body>
    </html>
  );
}
