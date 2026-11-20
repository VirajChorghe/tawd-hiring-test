import type { Metadata } from "next";

/*
  TAWD's name and the icons from the approved logo package in public/brand.
  See DESIGN.md, Brand. Kept apart from the root layout so tests can check
  every file it points at exists.
*/

export const APP_NAME = "TAWD";
export const APP_FULL_NAME = "Total Agentic Web Developer";
export const APP_TITLE = `${APP_NAME} - ${APP_FULL_NAME}`;
export const BRAND_NAVY = "#0E1B3D";

export const brandIcons: NonNullable<Metadata["icons"]> = {
  icon: [
    { url: "/brand/favicon.ico", sizes: "16x16 32x32 48x48" },
    { url: "/brand/favicon-32.png", type: "image/png", sizes: "32x32" },
    { url: "/brand/favicon-16.png", type: "image/png", sizes: "16x16" },
    { url: "/brand/tawd-favicon.svg", type: "image/svg+xml" },
  ],
  apple: { url: "/brand/apple-touch-icon.png", sizes: "180x180" },
};
