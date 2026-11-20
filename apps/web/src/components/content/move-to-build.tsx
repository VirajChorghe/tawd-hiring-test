"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { moveToBuildAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/* "Move to Build & preview", in Content's next-step bar once the client approved the copy (30 September 2026). */
export function MoveToBuildButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  return (
    <>
      {error ? <p className="hint-error">{error}</p> : null}
      <Button
        variant="primary"
        disabled={busy}
        onClick={() =>
          start(async () => {
            setError(null);
            const result = await moveToBuildAction(projectId);
            if (!result.ok) {
              setError(result.message);
              return;
            }
            router.push(`/projects/${projectId}/build`);
            router.refresh();
          })
        }
      >
        {busy ? "Moving..." : "Move to Build & preview"}
      </Button>
    </>
  );
}
