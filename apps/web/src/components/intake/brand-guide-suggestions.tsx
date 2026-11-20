"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import { answerBrandGuideSuggestionAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { BrandGuideView } from "@/lib/brand-guide";

/*
  "From the brand guide": what the uploaded guide's text says about the
  brand's colours, fonts and logo, as suggestions. Use puts a colour or a
  font into the form above (filling an empty field or adding to a list,
  never replacing what the PM typed) and adds a logo rule to "Notes for the
  designer"; Dismiss hides it. Every answer is logged.
*/
export function BrandGuideSuggestions({
  projectId,
  view,
  canEdit,
  onUseColor,
  onUseFont,
}: {
  projectId: string;
  view: BrandGuideView;
  canEdit: boolean;
  onUseColor: (hex: string) => void;
  onUseFont: (name: string) => void;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const [busy, start] = useTransition();

  const answer = (readingId: string, key: string, outcome: "used" | "dismissed", then?: () => void) =>
    start(async () => {
      setError(null);
      const result = await answerBrandGuideSuggestionAction(projectId, readingId, key, outcome);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      then?.();
      setGone((g) => new Set(g).add(`${readingId}/${key}`));
      if (key.startsWith("rule:")) router.refresh();
    });
  const open = <T extends { readingId: string; key: string }>(list: T[]) => list.filter((s) => !gone.has(`${s.readingId}/${s.key}`));
  const colors = open(view.colors);
  const fonts = open(view.fonts);
  const rules = open(view.logoRules);

  return (
    <section className="brand-guide-box" aria-label="From the brand guide">
      <p className="field-label">
        <span>From the brand guide</span> <Badge kind="info">Suggestions</Badge>
      </p>
      {view.readings.map((r) => (
        <p key={r.fileName} className={r.tone === "done" ? "hint" : r.tone === "missing" ? "hint-missing" : "hint-error"}>
          {r.fileName}: {r.line}
        </p>
      ))}
      {colors.length > 0 ? (
        <div className="brand-guide-row">
          <span className="brand-guide-label">Colours</span>
          <div className="brand-guide-items">
            {colors.map((c) => (
              <span key={c.key} className="brand-guide-item">
                <span className="logo-swatch-chip" style={{ background: c.hex }} aria-hidden="true" />
                <span>
                  {c.name ? `${c.name} ` : ""}
                  <strong>{c.hex}</strong>
                </span>
                {canEdit ? (
                  <>
                    <Button small variant="secondary" disabled={busy} onClick={() => answer(c.readingId, c.key, "used", () => onUseColor(c.hex))}>
                      Use
                    </Button>
                    <button type="button" className="btn btn-text btn-inline" disabled={busy} onClick={() => answer(c.readingId, c.key, "dismissed")}>
                      Dismiss
                    </button>
                  </>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {fonts.length > 0 ? (
        <div className="brand-guide-row">
          <span className="brand-guide-label">Fonts</span>
          <div className="brand-guide-items">
            {fonts.map((f) => (
              <span key={f.key} className="brand-guide-item">
                <strong>{f.name}</strong>
                {canEdit ? (
                  <>
                    <Button small variant="secondary" disabled={busy} onClick={() => answer(f.readingId, f.key, "used", () => onUseFont(f.name))}>
                      Use
                    </Button>
                    <button type="button" className="btn btn-text btn-inline" disabled={busy} onClick={() => answer(f.readingId, f.key, "dismissed")}>
                      Dismiss
                    </button>
                  </>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {rules.length > 0 ? (
        <div className="brand-guide-row">
          <span className="brand-guide-label">Logo rules</span>
          <ul className="brand-guide-rules">
            {rules.map((r) => (
              <li key={r.key}>
                <span>{r.text}</span>
                {canEdit ? (
                  <span className="brand-guide-rule-actions">
                    <Button small variant="secondary" disabled={busy} onClick={() => answer(r.readingId, r.key, "used")}>
                      Add to notes for the designer
                    </Button>
                    <button type="button" className="btn btn-text btn-inline" disabled={busy} onClick={() => answer(r.readingId, r.key, "dismissed")}>
                      Dismiss
                    </button>
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {error ? <p className="hint-error">{error}</p> : null}
    </section>
  );
}
