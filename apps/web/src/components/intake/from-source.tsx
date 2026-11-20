"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { confirmPrefillAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

/*
  The mark on an intake field TAWD filled by itself: from the designer's
  design (Lane 2), or from the current website (0.96.0, only what the site
  proves). It says where it was read from and stays until someone confirms
  it, or saves a different value (a correction, which takes the mark off).
*/
export function FromSource({
  projectId,
  fieldKey,
  source,
  origin,
  canEdit,
}: {
  projectId: string;
  fieldKey: string;
  source: string;
  origin: "design" | "site";
  canEdit: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const shown = source.length > 90 ? `${source.slice(0, 87)}...` : source;

  return (
    <div className="from-design">
      <Badge kind="info">{origin === "site" ? "From the current site" : "From the design"}</Badge>
      <span className="from-design-source">
        {origin === "site" ? <>Read from {shown.replace(/^https?:\/\/(www\.)?/i, "")}.</> : <>Read from &ldquo;{shown}&rdquo;.</>} Check it, then confirm or correct it.
      </span>
      {canEdit ? (
        <Button
          variant="text"
          small
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              const result = await confirmPrefillAction(projectId, fieldKey);
              if (!result.ok) {
                setError(result.message);
                return;
              }
              router.refresh();
            })
          }
        >
          Confirm
        </Button>
      ) : null}
      {error ? <span className="hint-error">{error}</span> : null}
    </div>
  );
}
