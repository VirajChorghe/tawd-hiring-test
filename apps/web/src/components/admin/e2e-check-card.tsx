"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { startE2eCheckAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { CheckStep } from "@/lib/e2e-check";

/* The end-to-end check's button and its steps; refreshes itself while the check runs. */
export function E2eCheckCard({
  status,
  steps,
  previewUrl,
  projectId,
  doneLine,
}: {
  status: "running" | "passed" | "failed" | "stopped" | null;
  steps: CheckStep[];
  previewUrl: string | null;
  projectId: string | null;
  doneLine: string | null;
}) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const running = status === "running";

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [running, router]);

  return (
    <div className="card content-card">
      <h2 className="card-title">End-to-end check</h2>
      <p className="hint">
        On this server, for $0: a test project from a small made-up design, its site built with stand-in answers (the real build, no AI, nothing in Spend),
        deployed as a Netlify preview, and the share link opened page by page and picture by picture. It takes about 5 minutes. The test project stays until
        the next check, so its link can be opened.
      </p>
      {error ? <p className="hint-error">{error}</p> : null}
      {status === "passed" ? <p className="hint">Passed. {doneLine}</p> : null}
      {status === "failed" ? <p className="hint-error">Failed at the step marked below. {doneLine}</p> : null}
      {status === "stopped" ? <p className="hint-error">The last check stopped without finishing (the server restarted?). Run it again.</p> : null}
      {running ? <p className="hint content-warn">Running... This page refreshes itself.</p> : null}
      {steps.length ? (
        <ol className="check-steps">
          {steps.map((s) => (
            <li key={s.key}>
              <span className={`badge ${s.status === "passed" ? "badge-done" : s.status === "failed" ? "badge-missing" : s.status === "running" ? "badge-warning" : "badge-info"}`}>
                {s.status === "passed" ? "Passed" : s.status === "failed" ? "Failed" : s.status === "running" ? "Running" : "Waiting"}
              </span>{" "}
              {s.label}
              {s.detail ? <p className={s.status === "failed" ? "hint-error" : "hint"}>{s.detail}</p> : null}
            </li>
          ))}
        </ol>
      ) : null}
      {previewUrl ? (
        <p className="hint">
          The test preview:{" "}
          <a className="plain-link" href={previewUrl} target="_blank" rel="noreferrer">
            {previewUrl}
          </a>
          {projectId ? (
            <>
              {" "}
              ·{" "}
              <a className="plain-link" href={`/projects/${projectId}/mockups`}>
                the test project
              </a>
            </>
          ) : null}
        </p>
      ) : null}
      {!running ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              const result = await startE2eCheckAction();
              if (!result.ok) setError(result.message);
              router.refresh();
            })
          }
        >
          {steps.length ? "Run the check again ($0)" : "Run the end-to-end check ($0)"}
        </Button>
      ) : null}
    </div>
  );
}
