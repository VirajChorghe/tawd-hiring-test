"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { undoKitRepairAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/* An admin tool (Jason, 29 September 2026: "undo the kit repair"): the repaired and filled copies removed; the originals show again. Logged. */
export function UndoKitRepairButton({ projectId }: { projectId: string }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <p className="stop-line">
      <Button
        small
        disabled={busy}
        onClick={() =>
          start(async () => {
            const result = await undoKitRepairAction(projectId);
            setMessage(result.ok ? "Done: the repaired and filled copies are removed; the originals show again." : result.message);
            router.refresh();
          })
        }
      >
        Undo the kit repair and fill
      </Button>
      {message ? <span className="hint">{message}</span> : null}
    </p>
  );
}
