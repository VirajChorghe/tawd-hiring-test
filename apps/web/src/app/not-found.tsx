import type { Metadata } from "next";

import { StatusPage } from "@/components/brand/status-page";

export const metadata: Metadata = { title: "Page not found - TAWD" };

export default function NotFound() {
  return (
    <StatusPage
      title="Page not found"
      line="That page doesn't exist, or the project it belonged to has been deleted."
    />
  );
}
