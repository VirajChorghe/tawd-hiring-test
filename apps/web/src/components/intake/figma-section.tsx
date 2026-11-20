"use client";

import { StopButton } from "@/components/ui/stop-button";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";

import {
  chooseFigmaPageAction,
  importFigmaAction,
  prefillIntakeAction,
  recheckFigmaAction,
  saveFigmaLinkAction,
} from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import type { ReadinessItem } from "@tawd/core/figma";
import { startDesignUploadAction } from "@/app/actions";
import { PaidStepButton } from "@/components/mockups/paid-step";
import type { HomepageReadView } from "@/lib/html-mockup-import";
import { HomepageHtmlSection } from "./homepage-html-section";
import { FileUploader, type UploadedFile } from "./uploader";

/* The uploaded design (28 September 2026): the files, and what reading them costs. */
export interface DesignUploadView {
  files: UploadedFile[];
  pages: number;
  visionPages: number;
  estimateLine: string;
  /** Pages read from the picture before and kept, and the estimate for reading every page again (27 September 2026). */
  keptPages?: number[];
  estimateAllLine?: string;
  /** Every page read from the picture, for the boxes, and one slice's cost (27 September 2026). */
  pageList?: { number: number; slices: number; kept: boolean }[];
  perSlice?: { cost: number; model: string; measured: boolean };
  /** A Figma link can be saved too (Option B); Option A takes an upload or, from Part 3, a link. */
  figmaLinkAllowed: boolean;
}

/*
  Lane 2, Option B: the designer's Figma file, as its own intake section.
  The PM pastes the link; saving it reads the file (free, no AI) and lists
  what TAWD found, each problem a warning in plain words that never blocks
  the project. Then the import renders the final frames for the Mockups
  page. Every Figma read counts toward the key's limit, so nothing reads
  the file unless someone presses a button.
*/

export interface DesignReadProgress {
  page: number;
  pages: number;
  part: number;
  parts: number;
  done: number;
  total: number;
}

export interface FigmaSectionView {
  url: string;
  /** "figma" or "upload". */
  source?: string;
  fileName: string | null;
  checkStatus: "ok" | "warnings" | "failed" | null;
  checkedAt: string | null;
  failureMessage: string | null;
  items: ReadinessItem[];
  pages: { id: string; name: string; frames: number }[];
  finalPage: { id: string; name: string; chosen: boolean } | null;
  frameCount: number;
  importStatus: "queued" | "working" | "done" | "failed" | null;
  importFailure: string | null;
  /** While an uploaded design is read: which page and part, and how far overall. */
  importProgress?: DesignReadProgress | null;
  importedLine: string | null;
  importOutOfDate: boolean;
  importWarnings: string[];
  /** The last pre-fill of the intake from the design. */
  prefill: {
    when: string;
    by: string | null;
    filled: { key: string; label: string; value: string }[];
    alreadyFilled: string[];
    notFound: string[];
  } | null;
}

export function FigmaSection({
  projectId,
  view,
  readsThisMonth,
  canEdit,
  upload = null,
  homepageHtml = null,
}: {
  projectId: string;
  view: FigmaSectionView | null;
  readsThisMonth: number;
  canEdit: boolean;
  upload?: DesignUploadView | null;
  /** The finished-homepage HTML file (one at most), and whether this person may change it. */
  homepageHtml?: { files: UploadedFile[]; canEdit: boolean; read?: HomepageReadView | null } | null;
}) {
  const router = useRouter();
  const [link, setLink] = useState(view?.url ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();
  const [picking, setPicking] = useState(false);
  // Start on the final page, or else the page with the most frames (never an empty cover page).
  const [page, setPage] = useState(
    view?.finalPage?.id ?? [...(view?.pages ?? [])].sort((a, b) => b.frames - a.frames)[0]?.id ?? "",
  );

  const importing = view?.importStatus === "queued" || view?.importStatus === "working";

  // The import runs in the worker; look again every few seconds until it is done.
  useEffect(() => {
    if (!importing) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [importing, router]);

  const act = (run: () => Promise<{ ok: true } | { ok: false; message: string }>, then?: () => void) => {
    setError(null);
    start(async () => {
      const result = await run();
      if (!result.ok) {
        setError(result.message);
        return;
      }
      then?.();
      router.refresh();
    });
  };

  const unchanged = view !== null && link.trim() === view.url;
  const warnings = view?.items.filter((i) => i.status === "warning") ?? [];

  return (
    <>
      <header className="intake-section-head">
        <h2 className="section-title">Design</h2>
        <p className="hint">
          The designer&rsquo;s design, from a Figma link or uploaded as a PDF or images. TAWD checks it and says what&rsquo;s missing; nothing
          here blocks the project.
        </p>
        {canEdit ? null : <p className="hint">Only a PM, a web designer or an admin can change the design.</p>}
      </header>

      {upload ? (
        <div className="field design-upload">
          <FileUploader projectId={projectId} kind="design_file" label="Upload the design (PDF, or one image per page)" canEdit={canEdit} files={upload.files} dropLabel="Drop the PDF or images here, or choose files" />
          {upload.pages > 0 ? (
            <div className="design-upload-read">
              <p className="hint">
                {upload.pages} page{upload.pages === 1 ? "" : "s"}.{" "}
                {upload.visionPages === 0
                  ? "Every page has a text layer: reading them is free."
                  : `${upload.pages - upload.visionPages} with a text layer (free), ${upload.visionPages} read from the picture by AI.`}{" "}
                {upload.keptPages?.length ? `${pageList(upload.keptPages)} ${upload.keptPages.length === 1 ? "was" : "were"} read before and ${upload.keptPages.length === 1 ? "is" : "are"} kept. ` : ""}
                The first page is the home page; each page becomes a frame, like a Figma import.
              </p>
              {canEdit ? (
                (upload.pageList?.length ?? 0) > 0 ? (
                  <DesignReadButton
                    projectId={projectId}
                    upload={upload}
                    working={importing}
                    label={(upload.keptPages?.length ?? 0) > 0 || (view?.source === "upload" && view.importStatus === "done") ? "Read the design again" : "Read the design"}
                  />
                ) : (
                  <PaidStepButton
                    id="design-upload"
                    variant="primary"
                    label={view?.source === "upload" && view.importStatus === "done" ? "Read the design again" : "Read the design"}
                    confirmTitle="Read the uploaded design?"
                    confirmText={READ_TEXT}
                    estimateLine={upload.estimateLine}
                    working={importing}
                    run={() => startDesignUploadAction(projectId)}
                  />
                )
              ) : null}
            </div>
          ) : null}
          {view?.source === "upload" && importing ? <DesignReadStatus status={view.importStatus} progress={view.importProgress ?? null} projectId={canEdit ? projectId : undefined} /> : null}
          {view?.source === "upload" && view.importStatus === "failed" ? (
            <p className="hint-error" role="alert">
              The design couldn&rsquo;t be read: {view.importFailure ?? "the worker stopped without a reason."} Nothing more is spent until someone reads the
              design again; pages already read are kept.
            </p>
          ) : null}
        </div>
      ) : null}

      {homepageHtml ? <HomepageHtmlSection projectId={projectId} files={homepageHtml.files} canEdit={homepageHtml.canEdit} read={homepageHtml.read ?? null} /> : null}

      {upload && !upload.figmaLinkAllowed ? null : (
      <div className="field">
        <FieldLabel htmlFor="figma-link" markerText="Lane 2, Option B">
          Figma link
        </FieldLabel>
        <div className="figma-link-row">
          <input
            id="figma-link"
            className="input"
            type="url"
            inputMode="url"
            placeholder="https://www.figma.com/design/…"
            value={link}
            disabled={!canEdit || busy}
            onChange={(event) => setLink(event.target.value)}
          />
          {canEdit ? (
            <Button
              variant="primary"
              disabled={busy || !link.trim() || (unchanged && view?.checkStatus !== null)}
              onClick={() => act(() => saveFigmaLinkAction(projectId, link))}
            >
              {busy && !unchanged ? "Checking…" : "Save and check"}
            </Button>
          ) : null}
        </div>
        <p className="hint">
          Copy it from Figma&rsquo;s Share button. Reading the file is free, but each check uses one of the Figma
          key&rsquo;s reads ({readsThisMonth} this month; a View or Collab seat allows about 20).
        </p>
      </div>
      )}

      {error ? <p className="hint-error">{error}</p> : null}

      {view?.checkStatus === "failed" ? (
        <Banner
          tone="error"
          title="The file couldn't be read"
          action={
            canEdit ? (
              <Button disabled={busy} onClick={() => act(() => recheckFigmaAction(projectId))}>
                Check again
              </Button>
            ) : undefined
          }
        >
          {view.failureMessage}
        </Banner>
      ) : null}

      {view && view.checkStatus && view.checkStatus !== "failed" ? (
        <section className="figma-check" aria-label="What TAWD found">
          <div className="figma-check-head">
            <div>
              <p className="card-title">{view.fileName}</p>
              <p className="hint">
                Checked {view.checkedAt}.{" "}
                {warnings.length === 0
                  ? "Nothing missing."
                  : `${warnings.length} warning${warnings.length === 1 ? "" : "s"}; none of them blocks the project.`}
              </p>
            </div>
            {canEdit ? (
              <Button disabled={busy || importing} onClick={() => act(() => recheckFigmaAction(projectId))}>
                Check again
              </Button>
            ) : null}
          </div>

          <ul className="figma-items">
            {view.items.map((item) => (
              <li key={item.id} className={item.status === "warning" ? "figma-item is-warning" : "figma-item"}>
                <Badge kind={item.status === "warning" ? "warning" : "done"}>
                  {item.status === "warning" ? "Warning" : "OK"}
                </Badge>
                <div>
                  <p className="figma-item-title">{item.title}</p>
                  <p className="hint">{item.detail}</p>
                </div>
              </li>
            ))}
          </ul>

          {canEdit && view.pages.length > 0 ? (
            !view.finalPage || picking ? (
              <div className="field figma-page-pick">
                <FieldLabel htmlFor="figma-page" markerText="From the saved file, no Figma read">
                  The page with the final design
                </FieldLabel>
                <div className="figma-link-row">
                  <select id="figma-page" className="input" value={page} onChange={(e) => setPage(e.target.value)}>
                    {view.pages.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} ({p.frames} frame{p.frames === 1 ? "" : "s"})
                      </option>
                    ))}
                  </select>
                  <Button
                    variant="primary"
                    disabled={busy || !page}
                    onClick={() => act(() => chooseFigmaPageAction(projectId, page), () => setPicking(false))}
                  >
                    Use this page
                  </Button>
                </div>
              </div>
            ) : (
              <p className="hint">
                Final frames from the page &ldquo;{view.finalPage.name}&rdquo;
                {view.finalPage.chosen ? ", chosen by the PM" : ""}.{" "}
                <Button variant="text" small onClick={() => setPicking(true)}>
                  Choose a different page
                </Button>
              </p>
            )
          ) : null}

          <div className="figma-import">
            {view.importStatus === "done" ? (
              <>
                <div>
                  <p className="figma-item-title">
                    <Badge kind="done">Imported</Badge> {view.importedLine}
                  </p>
                  {view.importOutOfDate ? (
                    <p className="hint-missing">The file has changed in Figma since it was imported. Import again to see the latest.</p>
                  ) : null}
                  {view.importWarnings.map((warning) => (
                    <p key={warning} className="hint-missing">
                      {warning}
                    </p>
                  ))}
                </div>
                <div className="figma-import-actions">
                  <ButtonLink href={`/projects/${projectId}/mockups`}>See it on Design</ButtonLink>
                  {canEdit ? (
                    <Button disabled={busy || view.frameCount === 0} onClick={() => act(() => importFigmaAction(projectId))}>
                      Import again
                    </Button>
                  ) : null}
                </div>
              </>
            ) : importing ? (
              <p className="concept-working" role="status">
                Importing the design from Figma. It waits its turn behind any concepts being built.
              </p>
            ) : (
              <>
                <div>
                  {view.importStatus === "failed" ? (
                    <p className="hint-error">The import didn&rsquo;t finish: {view.importFailure}</p>
                  ) : null}
                  <p className="hint">
                    {view.frameCount === 0
                      ? "There are no final frames to import yet. Choose the page that holds the final design first."
                      : `Import renders the ${view.frameCount} final frame${view.frameCount === 1 ? "" : "s"} to images and keeps the design’s photos, for the Design page. Free and no AI; it uses up to 2 of the Figma key’s reads.`}
                  </p>
                </div>
                {canEdit ? (
                  <Button
                    variant="primary"
                    disabled={busy || view.frameCount === 0}
                    onClick={() => act(() => importFigmaAction(projectId))}
                  >
                    {view.importStatus === "failed" ? "Import again" : "Import the design"}
                  </Button>
                ) : null}
              </>
            )}
          </div>

          {view.importStatus === "done" ? (
            <div className="figma-prefill">
              <div className="figma-prefill-head">
                <div>
                  <p className="figma-item-title">Pre-fill the intake from the design</p>
                  <p className="hint">
                    Reads the design&rsquo;s text (business name, phone, email, address, services, service areas, license,
                    year founded) and fills only the intake fields that are empty. Each is marked &ldquo;From the
                    design&rdquo; until you confirm or correct it. Free: no AI and no Figma read.
                  </p>
                </div>
                {canEdit ? (
                  <Button disabled={busy} onClick={() => act(() => prefillIntakeAction(projectId))}>
                    {view.prefill ? "Pre-fill again" : "Pre-fill the intake"}
                  </Button>
                ) : null}
              </div>
              {view.prefill ? (
                <div className="figma-prefill-result">
                  <p className="hint">
                    Pre-filled {view.prefill.when}
                    {view.prefill.by ? `, by ${view.prefill.by}` : ""}:{" "}
                    {view.prefill.filled.length === 0
                      ? "nothing new was filled."
                      : `filled ${view.prefill.filled.length} field${view.prefill.filled.length === 1 ? "" : "s"}.`}
                  </p>
                  {view.prefill.filled.length > 0 ? (
                    <ul className="figma-prefill-list">
                      {view.prefill.filled.map((f) => (
                        <li key={f.key}>
                          <strong>{f.label}:</strong> {f.value}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                  {view.prefill.alreadyFilled.length > 0 ? (
                    <p className="hint">Left alone, already filled in: {view.prefill.alreadyFilled.join(", ")}.</p>
                  ) : null}
                  {view.prefill.notFound.length > 0 ? (
                    <p className="hint">Not found in the design: {view.prefill.notFound.join(", ")}.</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}

/*
  An uploaded design being read (27 September 2026): the bar fills slice
  by slice, with the page and part in words.
*/
function DesignReadStatus({ status, progress, projectId }: { status: FigmaSectionView["importStatus"]; progress: DesignReadProgress | null; projectId?: string }) {
  const line = progress
    ? `Reading page ${progress.page} of ${progress.pages}${progress.parts > 1 ? `, part ${progress.part} of ${progress.parts}` : ""}…`
    : status === "queued"
      ? "Waiting its turn behind any concepts being built…"
      : "Drawing the pages…";
  const percent = progress && progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0;
  return (
    <div className="design-read-status" role="status">
      {projectId ? (
        <span className="stop-row">
          <StopButton projectId={projectId} kind="design_read" what="reading the design" />
        </span>
      ) : null}
      <span className="progress" role="progressbar" aria-label="Reading the design" aria-valuemin={0} aria-valuemax={100} aria-valuenow={percent}>
        <span style={{ width: `${Math.max(percent, 2)}%` }} />
      </span>
      <p className="concept-working">{line}</p>
    </div>
  );
}

const READ_TEXT =
  "TAWD draws each page 1440px wide and reads its sections, text, colours, fonts and pictures into the design, the same way a Figma import does. Then the review, the faithful copy and the rest work as for Figma. It replaces any design read before.";

/* "Page 3", "Pages 1 to 8", "Pages 1, 2 and 5". */
function pageList(pages: number[]): string {
  if (pages.length === 1) return `Page ${pages[0]}`;
  const run = pages.every((n, i) => i === 0 || n === pages[i - 1]! + 1);
  return run ? `Pages ${pages[0]} to ${pages[pages.length - 1]}` : `Pages ${pages.slice(0, -1).join(", ")} and ${pages[pages.length - 1]}`;
}

/* The same wording as the server's formatCost, for the live estimate. */
function dollars(value: number): string {
  if (value === 0) return "$0";
  if (value < 0.01) return "under $0.01";
  if (value < 10) return `$${value.toFixed(2)}`;
  return `$${Math.round(value)}`;
}

/*
  Read the design (27 September 2026): a box per page read from the
  picture, so a PM can read the home page first and the rest later. Pages
  read before (from these same files) are kept and not ticked unless
  someone wants them read again; the estimate follows the boxes. Pages
  with a text layer are always read, free.
*/
export function DesignReadButton({
  projectId,
  upload,
  working,
  label,
  startOpen = false,
}: {
  projectId: string;
  upload: DesignUploadView;
  working: boolean;
  label: string;
  startOpen?: boolean;
}) {
  const router = useRouter();
  const pages = upload.pageList ?? [];
  const notKept = pages.filter((p) => !p.kept).map((p) => p.number);
  const [open, setOpen] = useState(startOpen);
  const [chosen, setChosen] = useState<number[]>(notKept);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  useEffect(() => {
    if (!working) return;
    const timer = window.setInterval(() => router.refresh(), 5000);
    return () => window.clearInterval(timer);
  }, [working, router]);

  const kept = pages.filter((p) => p.kept).map((p) => p.number);
  const picked = pages.filter((p) => chosen.includes(p.number));
  const slices = picked.reduce((n, p) => n + p.slices, 0);
  const textPages = upload.pages - upload.visionPages;
  const skipped = pages.filter((p) => !p.kept && !chosen.includes(p.number)).map((p) => p.number);
  const per = upload.perSlice;
  const estimate =
    picked.length === 0
      ? kept.length || textPages
        ? "Free: nothing new is read from the picture; the design is put together from the pages already read."
        : "Choose at least one page."
      : per
        ? `About ${dollars(per.cost * slices)} of AI on ${per.model} for ${picked.length} page${picked.length === 1 ? "" : "s"} read from the picture${slices > picked.length ? ` in about ${slices} slices` : ""}${per.measured ? ", from the slices read so far" : " (a first guess until real pages have been read)"}.`
        : upload.estimateLine;
  const nothing = picked.length === 0 && kept.length === 0 && textPages === 0;
  const set = (numbers: number[]) => setChosen([...new Set(numbers)].sort((a, b) => a - b));

  return (
    <>
      <Button
        small
        variant="primary"
        disabled={busy || working}
        onClick={() => {
          set(notKept);
          setError(null);
          setOpen(true);
        }}
      >
        {working ? "Working..." : label}
      </Button>
      {error && !open ? <p className="hint-error">{error}</p> : null}
      {open ? (
        <div className="modal-backdrop">
          <div className="modal" role="dialog" aria-modal="true" aria-labelledby="design-read-title">
            <h2 className="section-title" id="design-read-title">
              {kept.length ? "Read the uploaded design again?" : "Read the uploaded design?"}
            </h2>
            <p className="hint">{READ_TEXT}</p>
            <fieldset className="field design-read-pages">
              <legend className="field-label">
                <span>Pages to read from the picture</span>
              </legend>
              <div className="design-read-quick">
                {pages.some((p) => p.number === 1) ? (
                  <Button small variant="text" onClick={() => set([1])}>
                    Only the home page
                  </Button>
                ) : null}
                {kept.length ? (
                  <Button small variant="text" onClick={() => set(notKept)}>
                    The pages not read yet
                  </Button>
                ) : null}
                <Button small variant="text" onClick={() => set(pages.map((p) => p.number))}>
                  Every page
                </Button>
              </div>
              {pages.map((p) => (
                <label className="checkline" key={p.number}>
                  <input
                    type="checkbox"
                    checked={chosen.includes(p.number)}
                    onChange={(e) => set(e.target.checked ? [...chosen, p.number] : chosen.filter((n) => n !== p.number))}
                  />
                  <span>
                    Page {p.number}
                    {p.number === 1 ? " (home)" : ""}{" "}
                    <span className="hint">
                      {p.slices} slice{p.slices === 1 ? "" : "s"}
                      {p.kept ? (chosen.includes(p.number) ? ", read before: reads it again" : ", read before and kept") : ""}
                    </span>
                  </span>
                </label>
              ))}
            </fieldset>
            {textPages > 0 ? (
              <p className="hint">
                {textPages} page{textPages === 1 ? " has" : "s have"} a text layer: read every time, free.
              </p>
            ) : null}
            {skipped.length ? <p className="hint">{pageList(skipped)} {skipped.length === 1 ? "isn't" : "aren't"} read this time: the design has the pages read so far, and the rest can be read later.</p> : null}
            <p className={nothing ? "hint-amber" : "hint"}>{estimate}</p>
            {error ? <p className="hint-error">{error}</p> : null}
            <div className="modal-actions">
              <Button onClick={() => setOpen(false)} disabled={busy}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={busy || nothing}
                onClick={() =>
                  start(async () => {
                    setError(null);
                    const result = await startDesignUploadAction(projectId, false, chosen);
                    if (!result.ok) {
                      setError(result.message);
                      return;
                    }
                    setOpen(false);
                    router.refresh();
                  })
                }
              >
                {busy ? "Starting..." : picked.length === 0 ? "Put the design together" : `Read ${picked.length} page${picked.length === 1 ? "" : "s"}`}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
