"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { approveHomeWordsAction, startHomeWordsAction, writeHomeWordsAction } from "@/app/actions";
import { Button } from "@/components/ui/button";

/*
  Content first, part 2 (1 October 2026, DESIGN.md "Content first, part 2"):
  the home page's words before the concepts. Start from the current site or
  the client's copy ($0), or have TAWD write them (estimate first); edit;
  then Use these words. Generate waits until they're used.
*/

export interface HomeWordsCardProps {
  projectId: string;
  canEdit: boolean;
  suggested: "current_site" | "client_copy" | "tawd" | null;
  estimateLine: string;
  words: {
    source: "current_site" | "client_copy" | "tawd";
    sections: { name: string; words: string; flag: string | null }[];
    testimonials: { text: string; confirmed: boolean }[];
    writing: boolean;
    writeFailure: string | null;
    approvedLine: string | null;
  } | null;
}

const SOURCE_BADGE = { current_site: "From the current site", client_copy: "From the client's copy", tawd: "Written by TAWD" } as const;

export function HomeWordsCard(props: HomeWordsCardProps) {
  const router = useRouter();
  const [sections, setSections] = useState(props.words?.sections ?? []);
  const [testimonials, setTestimonials] = useState(props.words?.testimonials ?? []);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const writing = props.words?.writing ?? false;

  useEffect(() => {
    if (!writing) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [writing, router]);

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) =>
    start(async () => {
      setError(null);
      const result = await action();
      if (!result.ok) setError(result.message);
      router.refresh();
    });

  const startButtons = props.canEdit ? (
    <div className="money-row-actions edit-actions">
      {props.suggested === "current_site" || props.suggested === "client_copy" ? (
        <Button variant="primary" disabled={busy} onClick={() => run(() => startHomeWordsAction(props.projectId, props.suggested as "current_site" | "client_copy"))}>
          {props.suggested === "current_site" ? "Start from the current site (free)" : "Start from the client's copy (free)"}
        </Button>
      ) : null}
      <Button variant={props.suggested === "tawd" || !props.suggested ? "primary" : "secondary"} disabled={busy || writing} onClick={() => run(() => writeHomeWordsAction(props.projectId))}>
        Write the Home words with TAWD
      </Button>
    </div>
  ) : null;

  return (
    <section className="card content-card home-words" aria-labelledby="home-words-title">
      <div className="content-card-head">
        <div>
          <h2 className="card-title" id="home-words-title">
            Home page words
          </h2>
          <p className="hint">The concepts use these words, section by section. Edit anything out of date, then use them.</p>
        </div>
        {props.words ? <span className="badge badge-info">{SOURCE_BADGE[props.words.source]}</span> : null}
      </div>

      {!props.words || (props.words.sections.length === 0 && !writing) ? (
        <>
          <p className="hint">
            {props.suggested === "current_site"
              ? "Start from the words on the client's current home page, as TAWD read it."
              : props.suggested === "client_copy"
                ? "Start from the copy the client gave (the intake's Content section)."
                : "A new site: TAWD writes the home page's words from the intake, and the team edits them."}{" "}
            TAWD writing them: {props.estimateLine}
          </p>
          {props.words?.writeFailure ? <p className="hint-error">The words couldn&rsquo;t be written: {props.words.writeFailure}</p> : null}
          {startButtons}
        </>
      ) : writing ? (
        <p className="hint content-warn">TAWD is writing the words. This page updates by itself.</p>
      ) : (
        <>
          <div className="home-words-sections">
            {sections.map((s, i) => (
              <div key={i} className="home-words-section">
                <div className="row" style={{ gap: 8 }}>
                  <label className="visually-hidden" htmlFor={`words-name-${i}`}>
                    Section {i + 1} name
                  </label>
                  <input id={`words-name-${i}`} className="input home-words-name" value={s.name} disabled={!props.canEdit} onChange={(e) => setSections((all) => all.map((x, n) => (n === i ? { ...x, name: e.target.value } : x)))} />
                  {props.canEdit ? (
                    <Button small variant="text" aria-label={`Remove the ${s.name} section`} onClick={() => setSections((all) => all.filter((_, n) => n !== i))}>
                      Remove
                    </Button>
                  ) : null}
                </div>
                <label className="visually-hidden" htmlFor={`words-${i}`}>
                  {s.name} words
                </label>
                <textarea id={`words-${i}`} className="textarea" rows={Math.min(8, Math.max(2, Math.ceil(s.words.length / 110)))} value={s.words} disabled={!props.canEdit} onChange={(e) => setSections((all) => all.map((x, n) => (n === i ? { ...x, words: e.target.value } : x)))} />
                {s.flag ? <p className="hint content-warn">{s.flag}</p> : null}
              </div>
            ))}
          </div>
          {testimonials.length ? (
            <fieldset className="field">
              <legend className="field-label">
                <span>Testimonials from the old site</span>
              </legend>
              <p className="hint">An unticked one shows on the concepts as a [PLACEHOLDER] until someone confirms with the client that it&rsquo;s real.</p>
              {testimonials.map((t, i) => (
                <label key={i} className="checkline">
                  <input type="checkbox" checked={t.confirmed} disabled={!props.canEdit} onChange={(e) => setTestimonials((all) => all.map((x, n) => (n === i ? { ...x, confirmed: e.target.checked } : x)))} />
                  &ldquo;{t.text}&rdquo; (confirmed with the client that it&rsquo;s real)
                </label>
              ))}
            </fieldset>
          ) : null}
          {props.words.approvedLine ? <p className="hint content-done">{props.words.approvedLine}</p> : <p className="hint">Not used yet: Generate waits for these words.</p>}
          {error ? <p className="hint-error">{error}</p> : null}
          {props.canEdit ? (
            <div className="money-row-actions edit-actions">
              <Button small onClick={() => setSections((all) => [...all, { name: "New section", words: "", flag: null }])}>
                Add a section
              </Button>
              <Button variant="primary" disabled={busy} onClick={() => run(() => approveHomeWordsAction(props.projectId, { sections: sections.map(({ name, words }) => ({ name, words })), testimonials }))}>
                {busy ? "Saving..." : "Use these words"}
              </Button>
            </div>
          ) : null}
          {props.canEdit ? (
            <details className="hint">
              <summary>Start again</summary>
              {startButtons}
            </details>
          ) : null}
        </>
      )}
      {error && (!props.words || props.words.sections.length === 0) ? <p className="hint-error">{error}</p> : null}
    </section>
  );
}

/*
  Makeovers (Keep all content as is, 6 October 2026): no boxes and no Use
  these words. The concepts use the Home page's words on Content, as they
  are; edits happen there. Since 0.96.0 the page plan makes itself when the
  read finishes: Generate waits only while reading, after a failed read
  (with its date in PT, the reason, the ways forward and the intake link),
  or for the one decision on Content. The card reads the live row each
  time, so a new good read replaces an old failure.
*/
export interface KeptHomeWordsCardProps {
  state: "reading" | "failed" | "needs_decision" | "ready";
  failure: string | null;
  /** "Read Oct 7, 2026, 3:20 PM PT." */
  readAtLine?: string | null;
  waysForward?: string[];
  /** The intake's Website section. */
  intakeHref: string;
  contentHref: string;
  /** "Home page, version 2 on Content." */
  versionLine: string | null;
  /** needs_decision: "This deletes 4 approved pages." */
  decisionLine?: string | null;
  sections: { name: string; words: string; flag: string | null }[];
  quotes: string[];
}

export function KeptHomeWordsCard(props: KeptHomeWordsCardProps) {
  const router = useRouter();
  useEffect(() => {
    if (props.state !== "reading") return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [props.state, router]);

  return (
    <section className="card content-card home-words" aria-labelledby="home-words-title">
      <div className="content-card-head">
        <div>
          <h2 className="card-title" id="home-words-title">
            Home page words
          </h2>
          <p className="hint">
            The concepts use the current site&rsquo;s home page words, as they are. To change them, edit the Home page on{" "}
            <a className="plain-link" href={props.contentHref}>
              Content
            </a>
            .
          </p>
        </div>
        <span className="badge badge-info">Kept from the current site</span>
      </div>
      {props.state === "ready" ? (
        <>
          {props.versionLine ? <p className="hint content-done">{props.versionLine}</p> : null}
          {props.sections.some((s) => s.flag) ? props.sections.filter((s) => s.flag).map((s) => <p key={s.name} className="hint content-warn">{s.name}: {s.flag}</p>) : null}
          <details className="hint">
            <summary>See the words</summary>
            <div className="home-words-sections">
              {props.sections.map((s, i) => (
                <div key={i} className="home-words-section">
                  <p className="field-label">{s.name}</p>
                  <p className="home-words-kept">{s.words}</p>
                </div>
              ))}
            </div>
          </details>
          {props.quotes.length ? (
            <div className="field">
              <p className="field-label">Quotes to confirm with the client</p>
              <p className="hint">They show on the concepts as a [PLACEHOLDER] until someone confirms with the client that they&rsquo;re real.</p>
              <ul className="hint">
                {props.quotes.map((q) => (
                  <li key={q}>&ldquo;{q}&rdquo;</li>
                ))}
              </ul>
            </div>
          ) : null}
        </>
      ) : props.state === "reading" ? (
        <p className="hint content-warn">TAWD is reading the current site (free, no AI). The words appear here when it&rsquo;s done; this page refreshes itself.</p>
      ) : props.state === "needs_decision" ? (
        <p className="hint content-warn">
          The page plan on Content has work that isn&rsquo;t from the current site, so TAWD didn&rsquo;t replace it.{props.decisionLine ? ` ${props.decisionLine}` : ""}{" "}
          <a className="plain-link" href={`${props.contentHref}#kept-pages`}>
            Decide on Content
          </a>
        </p>
      ) : (
        <>
          <p className="hint-error">
            {props.failure ?? "The current site couldn't be read."}
            {props.readAtLine ? ` ${props.readAtLine}` : ""}
          </p>
          {props.waysForward?.length ? (
            <ol className="hint content-ways">
              {props.waysForward.map((way) => (
                <li key={way}>{way}</li>
              ))}
            </ol>
          ) : null}
          <p className="hint">
            <a className="plain-link" href={props.intakeHref}>
              Open the intake&rsquo;s Website section
            </a>
          </p>
        </>
      )}
    </section>
  );
}
