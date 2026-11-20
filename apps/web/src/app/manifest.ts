import type { MetadataRoute } from "next";

import { APP_NAME, APP_TITLE, BRAND_NAVY } from "@/lib/brand";

/* The web manifest: TAWD's name and icons when saved to a home screen. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_TITLE,
    short_name: APP_NAME,
    description: "Velocity Media Lab's website builder for local service businesses.",
    start_url: "/projects",
    display: "standalone",
    background_color: "#F4F5F2",
    theme_color: BRAND_NAVY,
    icons: [
      { src: "/brand/tawd-icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/brand/tawd-icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/brand/tawd-icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
