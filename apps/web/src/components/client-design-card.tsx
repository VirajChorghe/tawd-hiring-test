"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { makeClientDesignDocAction } from "@/app/actions";
import { Button, ButtonLink } from "@/components/ui/button";

/*
  The client's DESIGN.md on the project page (26 September 2026): which
  approved design it was written from, its sections, view and download,
  and "Write it again" for a PM after a newer approval.
*/
export function ClientDesignCard(props: {
  projectId: string;
  /** "Version 2, from Concept B v2, Sep 26, 2026, 4:12 PM", or null before the first. */
  doneLine: string | null;
  sections: string[];
  canWrite: boolean;
  /** The client has approved a mockup, so there is something to write it from. */
  approved: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="card content-card">
      <div className="content-card-head">
        <div>
          <h2 className="card-title">Client DESIGN.md</h2>
          <p className="hint">
            The approved design written down: colours and their roles, fonts, components, layout, depth, do&rsquo;s and
            don&rsquo;ts, phones, and a guide for the builder. Every page build and monthly edit follows it.
          </p>
        </div>
        {props.doneLine ? (
          <div className="money-row-actions">
            <ButtonLink href={`/projects/${props.projectId}/design-md`} variant="secondary" small>
              View
            </ButtonLink>
            <ButtonLink href={`/projects/${props.projectId}/design-md?download=1`} variant="secondary" small>
              Download
            </ButtonLink>
          </div>
        ) : null}
      </div>
      {props.doneLine ? <p className="content-done-line">{props.doneLine}</p> : <p className="hint">{props.approved ? "Not written yet." : "Written when the client approves a mockup."}</p>}
      {props.sections.length ? <p className="hint">{props.sections.join(" · ")}</p> : null}
      {error ? <p className="hint-error">{error}</p> : null}
      {props.canWrite && props.approved ? (
        <div>
          <Button
            variant={props.doneLine ? "text" : "primary"}
            small
            disabled={busy}
            onClick={() =>
              start(async () => {
                setError(null);
                const result = await makeClientDesignDocAction(props.projectId);
                if (!result.ok) setError(result.message);
                else router.refresh();
              })
            }
          >
            {busy ? "Writing..." : props.doneLine ? "Write it again from the approved design" : "Write it now"}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
