"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { PaidStepButton } from "@/components/mockups/paid-step";
import { Button } from "@/components/ui/button";
import { SelectField, TextField } from "@/components/ui/field";
import { buildDesignPageAction, correctReadBandAction, correctReadPictureAction, correctReadWordAction, preparePicturesAgainAction, startNewDesignReadAction } from "@/app/actions";
import type { NewReadView } from "@/lib/design-read-new";
import type { NewReadCorrections } from "@/lib/design-read-corrections";
import type { NewReadItems } from "@/lib/design-read-items";
import type { PageBuildView } from "@/lib/design-page";
import type { PictureChange, WordChange } from "@tawd/core/figma/read-item-corrections";
import type { PrepareStatus, SheetAsset } from "@tawd/core/figma/read-assets";
import type { BandChange, CorrectableRole } from "@tawd/core/figma/read-corrections";

/*
  The new design read (E4, Lane 2), admin only while the new route is built
  beside the current one. One paid button with its estimate, a Stop button
  while it runs, and what the last read found: its bands, how many words and
  pictures each has, and anything it couldn't do. It changes nothing else on
  the project.
*/

const CONFIRM =
  "TAWD looks at the whole page to list its bands (a second time if the list doesn't cover the page), then at each band, at full size where the AI model can read it, for its words, colours, fonts and pictures (a very tall band in parts). It reads the page picture the last design read saved. Nothing on the project changes: the result is kept for the new route, which is still being built.";

export function NewDesignRead({
  projectId,
  view,
  corrections,
  items,
  prepare,
  build,
}: {
  projectId: string;
  view: NewReadView;
  corrections?: NewReadCorrections | null;
  items?: NewReadItems | null;
  prepare?: { status: PrepareStatus; stalled: boolean } | null;
  build?: PageBuildView | null;
}) {
  const working = (view.status?.state === "working" || view.status?.state === "queued") && !view.stalled;
  return (
    <section className="card" aria-labelledby="new-design-read-title">
      <h2 className="card-title" id="new-design-read-title">
        New design read (admin, being built)
      </h2>
      {!view.version || !view.estimate ? (
        <p className="hint">Read the uploaded design first: the new read starts from the page picture that read saves.</p>
      ) : (
        <>
          <p className="hint">
            Reads page {view.page} of the last design read ({view.height}px tall) with the new route: the band list, then each band. Nothing else on the project
            changes.
          </p>
          <PaidStepButton
            id="new-design-read"
            variant="secondary"
            label={view.result ? "Run the new read again" : "Run the new read"}
            confirmTitle="Run the new design read?"
            confirmText={CONFIRM}
            estimateLine={view.estimate.label}
            working={working}
            run={() => startNewDesignReadAction(projectId)}
            stop={{ projectId, kind: "design_read", what: "the new design read" }}
          />
        </>
      )}
      {view.status ? (
        <p className={view.status.state === "failed" || view.stalled ? "hint-error" : "hint"} role={view.status.state === "failed" || view.stalled ? "alert" : undefined}>
          {statusLine(view.status, view.stalled)}
        </p>
      ) : null}
      {view.result ? (
        <>
          <BandTable projectId={projectId} result={view.result} corrections={corrections ?? null} />
          {[...view.result.notes, ...view.result.bands.flatMap((b) => b.notes)].length > 0 ? (
            <ul className="hint">
              {[...view.result.notes, ...view.result.bands.flatMap((b) => b.notes)].map((note, i) => (
                <li key={i}>{note}</li>
              ))}
            </ul>
          ) : null}
          {items ? <WordsPanel projectId={projectId} runId={view.result.runId} items={items} /> : null}
          {items ? <PicturesPanel projectId={projectId} runId={view.result.runId} items={items} /> : null}
          {items ? <ItemNotes items={items} /> : null}
          {view.assets ? <AssetSheetView assets={view.assets} preparing={view.status?.state === "working" && !view.stalled && view.status.runId === view.assets.runId} /> : null}
          {items && view.version && view.result.runId ? <PrepareAgain projectId={projectId} version={view.version} runId={view.result.runId} prepare={prepare ?? null} /> : null}
          {build && build.version && build.runId === view.result.runId ? <BuildPage projectId={projectId} build={build} /> : null}
        </>
      ) : null}
    </section>
  );
}

const ROLE_LABEL: Record<CorrectableRole, string> = { header: "Header", band: "Band", footer: "Footer" };
const ROLE_OPTIONS = (Object.keys(ROLE_LABEL) as CorrectableRole[]).map((value) => ({ value, label: ROLE_LABEL[value] }));

/*
  The band list, with a Correct button on each band (E4b-2; admins only, as is this whole panel). A
  correction is saved against the band as the read found it, so it is kept when the design is read
  again (Jason, 14 November) and applied to whichever band of the new read is in the same place.
*/
function BandTable({ projectId, result, corrections }: { projectId: string; result: NonNullable<NewReadView["result"]>; corrections: NewReadCorrections | null }) {
  const bands = corrections?.bands ?? result.bands.map((b) => ({ ...b, asRead: { top: b.top, bottom: b.bottom }, corrected: null }));
  // The form belongs to one band of one read: after a re-read its key no longer exists and the form closes (Fable's review).
  const keyOf = (b: { asRead: { top: number; bottom: number } }) => `${result.runId ?? "none"}:${b.asRead.top}-${b.asRead.bottom}`;
  const [editing, setEditing] = useState<string | null>(null);
  const open = bands.find((b) => keyOf(b) === editing);
  return (
    <>
      <div className="table-scroll">
      <table className="spend-table">
        <caption className="hint">
          What the last new read found: {bands.length} bands, {result.colours} colours measured.
          {bands.some((b) => b.corrected) ? " Bands marked corrected show a person's correction, kept if the design is read again; words and pictures are counted as read." : ""}
        </caption>
        <thead>
          <tr>
            <th scope="col">Band</th>
            <th scope="col">Kind</th>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Words</th>
            <th scope="col">Pictures</th>
            <th scope="col">
              <span className="visually-hidden">Correct</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {bands.map((band, i) => (
            <tr key={`${band.asRead.top}-${i}`}>
              <td>
                {band.name}
                {band.corrected ? (
                  <span className="hint">
                    {" "}
                    (corrected{band.corrected.by ? ` by ${band.corrected.by}` : ""}, {new Date(band.corrected.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})
                  </span>
                ) : null}
              </td>
              <td>{ROLE_LABEL[band.role] ?? band.role}</td>
              <td>{band.top}px</td>
              <td>{band.bottom}px</td>
              <td>{band.words}</td>
              <td>{band.pictures}</td>
              <td>
                <Button variant="text" onClick={() => setEditing(editing === keyOf(band) ? null : keyOf(band))}>
                  {editing === keyOf(band) ? "Close" : "Correct"}
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>
      {open && result.runId ? <BandCorrectionForm key={keyOf(open)} projectId={projectId} runId={result.runId} band={open} onDone={() => setEditing(null)} /> : null}
      {corrections && corrections.unmatched.length > 0 ? (
        <div className="hint-error" role="status">
          <p>These corrections don&rsquo;t match one band of this read (the band list changed when the design was read again). They are kept, not applied:</p>
          <ul>
            {corrections.unmatched.map((u, i) => (
              <li key={i}>
                The band at {u.anchor.top} to {u.anchor.bottom}px: {describeChange(u.change)}
                {u.why === "tied" ? " (two bands of this read are in its place equally)" : " (no band of this read is in its place)"}
                {u.by ? ` (by ${u.by})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {corrections && corrections.problems.length > 0 ? (
        <ul className="hint-error">
          {corrections.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/* A change in plain words: what a correction sets. */
export function describeChange(change: BandChange): string {
  const parts: string[] = [];
  if (change.name !== undefined) parts.push(`named "${change.name}"`);
  if (change.role !== undefined) parts.push(`made a ${ROLE_LABEL[change.role].toLowerCase()}`);
  if (change.top !== undefined) parts.push(`top at ${change.top}px`);
  if (change.bottom !== undefined) parts.push(`bottom at ${change.bottom}px`);
  return parts.length > 0 ? parts.join(", ") : "no change";
}

function BandCorrectionForm({ projectId, runId, band, onDone }: { projectId: string; runId: string; band: NonNullable<NewReadCorrections>["bands"][number]; onDone: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(band.name);
  const [role, setRole] = useState<CorrectableRole>(band.role);
  const [top, setTop] = useState(String(band.top));
  const [bottom, setBottom] = useState(String(band.bottom));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = () => {
    // An emptied field would read as 0, a real position: whole numbers only.
    if (!/^\d+$/.test(top.trim()) || !/^\d+$/.test(bottom.trim())) {
      setError("From and To must be whole numbers of pixels.");
      return;
    }
    // Only what was changed is sent; the server checks it against the band list as it is now.
    const change: BandChange = {};
    if (name.trim() !== band.name) change.name = name;
    if (role !== band.role) change.role = role;
    if (top.trim() !== String(band.top)) change.top = Number(top);
    if (bottom.trim() !== String(band.bottom)) change.bottom = Number(bottom);
    setError(null);
    startSaving(async () => {
      const result = await correctReadBandAction(projectId, band.asRead, change, runId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="card" aria-label={`Correct the band ${band.name}`}>
      <p className="hint">
        Correct &ldquo;{band.name}&rdquo;. Moving an edge moves the neighbouring band&rsquo;s edge with it, so the bands still cover the page. The correction is
        kept if the design is read again.
      </p>
      <TextField label="Name" value={name} onChange={setName} />
      <SelectField label="Kind" value={role} onChange={(v) => setRole(v ?? band.role)} options={ROLE_OPTIONS} />
      <TextField label="From (px)" value={top} onChange={setTop} hint="A whole number of pixels from the top of the design." />
      <TextField label="To (px)" value={bottom} onChange={setBottom} hint="A whole number of pixels from the top of the design." />
      {error ? (
        <p className="hint-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="primary" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save correction"}
      </Button>{" "}
      <Button variant="secondary" onClick={onDone} disabled={saving}>
        Cancel
      </Button>
    </div>
  );
}

/* What the last start is doing or did. `phase: "pictures"` means the read itself was saved and only its pictures were being prepared (E4b-1). */
function statusLine(status: NonNullable<NewReadView["status"]>, stalled: boolean): string {
  const calls = `${status.calls} call${status.calls === 1 ? "" : "s"}`;
  const pictures = status.phase === "pictures";
  if (stalled && status.state === "queued") return "The last new read never started: the worker no longer has it waiting. Nothing was spent. It can be run again.";
  if (stalled && pictures) return `The last new read finished (${calls}), but preparing its pictures stopped without finishing (no news for over 30 minutes).`;
  if (stalled) return `The last new read stopped without finishing (no news for over 30 minutes; ${calls} made). It can be run again.`;
  if (status.state === "queued") return "Waiting for its turn: the worker does one thing at a time, so this can take a while behind other work.";
  if (status.state === "working" && pictures) return `Read (${calls}); now preparing its pictures from the design, with no AI.`;
  if (status.state === "working") return `Reading: ${calls} so far${status.bands ? `, ${status.bands} bands found` : ""}.`;
  // The worker's own sentence for a restart in the picture step already says the read is complete.
  if (status.state === "failed" && pictures) return status.error ?? "Preparing the read's pictures stopped.";
  if (status.state === "failed") return `The last new read stopped: ${status.error ?? "no reason given"}. Calls made: ${status.calls}.`;
  return `Last new read: ${status.calls} calls, ${status.inputTokens.toLocaleString("en-US")} tokens in and ${status.outputTokens.toLocaleString("en-US")} out.`;
}

const KIND_LABEL: Record<SheetAsset["kind"], string> = {
  photo: "Photo",
  background: "Background",
  cutout: "Cut-out",
  logo: "Logo",
  silhouette: "Silhouette",
  icon: "Icon",
};

type Box = { x: number; y: number; w: number; h: number };
type WordItem = NewReadItems["words"][number];
type PictureItem = NewReadItems["pictures"][number];

const WORD_ROLE_LABEL: Record<WordItem["role"], string> = {
  heading: "Heading",
  paragraph: "Paragraph",
  button: "Button",
  link: "Link",
  label: "Label",
  other: "Other",
};
const WORD_ROLE_OPTIONS = (Object.keys(WORD_ROLE_LABEL) as WordItem["role"][]).map((value) => ({ value, label: WORD_ROLE_LABEL[value] }));
const PICTURE_KIND_OPTIONS = (Object.keys(KIND_LABEL) as PictureItem["kind"][]).map((value) => ({ value, label: KIND_LABEL[value] }));

const boxKey = (b: Box) => `${b.x},${b.y},${b.w},${b.h}`;
const boxText = (b: Box) => `${b.w} × ${b.h}px at ${b.x}, ${b.y}`;
const correctedNote = (c: NonNullable<WordItem["corrected"]>) => (
  <span className="hint">
    {" "}
    (corrected{c.by ? ` by ${c.by}` : ""}, {new Date(c.at).toLocaleDateString("en-US", { month: "short", day: "numeric" })})
  </span>
);

/*
  The words of the read, with a Correct button on each (E4b-2b; admins only). Like a band's, a
  correction is saved against the word as the read found it and kept if the design is read again.
*/
function WordsPanel({ projectId, runId, items }: { projectId: string; runId: string | null; items: NewReadItems }) {
  const keyOf = (w: WordItem) => `${runId ?? "none"}:${boxKey(w.asRead)}`;
  const [editing, setEditing] = useState<string | null>(null);
  const open = items.words.find((w) => keyOf(w) === editing);
  if (items.words.length === 0) return <p className="hint">The read found no words on this page.</p>;
  return (
    <div>
      <h3 className="section-title">Words from the design</h3>
      <div className="table-scroll">
        <table className="spend-table">
          <caption className="hint">
            What the read made of the words: {items.words.length} in all.
            {items.words.some((w) => w.unsure) ? " A word marked unsure is one TAWD could not make every letter out of: check it against the design." : ""}
            {items.words.some((w) => w.corrected) ? " Words marked corrected show a person's correction, kept if the design is read again." : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Words</th>
              <th scope="col">Kind</th>
              <th scope="col">Band</th>
              <th scope="col">
                <span className="visually-hidden">Correct</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.words.map((word, i) => (
              <tr key={`${boxKey(word.asRead)}-${i}`}>
                <td>
                  {word.text}
                  {word.unsure ? <span className="hint-error"> (unsure: not every letter could be made out)</span> : null}
                  {word.corrected ? correctedNote(word.corrected) : null}
                </td>
                <td>{WORD_ROLE_LABEL[word.role] ?? word.role}</td>
                <td>{word.band}</td>
                <td>
                  <Button variant="text" onClick={() => setEditing(editing === keyOf(word) ? null : keyOf(word))}>
                    {editing === keyOf(word) ? "Close" : "Correct"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && runId ? <WordCorrectionForm key={keyOf(open)} projectId={projectId} runId={runId} word={open} onDone={() => setEditing(null)} /> : null}
    </div>
  );
}

function WordCorrectionForm({ projectId, runId, word, onDone }: { projectId: string; runId: string; word: WordItem; onDone: () => void }) {
  const router = useRouter();
  const [text, setText] = useState(word.text);
  const [role, setRole] = useState<WordItem["role"]>(word.role);
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = () => {
    // Only what was changed is sent; the server checks it against the read as it is now.
    const change: WordChange = {};
    if (text.trim() !== word.text) change.text = text;
    if (role !== word.role) change.role = role;
    if (Object.keys(change).length === 0) {
      setError("Nothing was changed.");
      return;
    }
    setError(null);
    startSaving(async () => {
      const result = await correctReadWordAction(projectId, word.asRead, change, runId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="card" aria-label={`Correct the words ${word.text}`}>
      <p className="hint">Correct what the read made of these words. The correction is kept if the design is read again.</p>
      <TextField label="Words" value={text} onChange={setText} />
      <SelectField label="Kind" value={role} onChange={(v) => setRole(v ?? word.role)} options={WORD_ROLE_OPTIONS} />
      {error ? (
        <p className="hint-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="primary" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save correction"}
      </Button>{" "}
      <Button variant="secondary" onClick={onDone} disabled={saving}>
        Cancel
      </Button>
    </div>
  );
}

/* The pictures of the read, with a Correct button on each. The prepared pictures themselves are shown further down. */
function PicturesPanel({ projectId, runId, items }: { projectId: string; runId: string | null; items: NewReadItems }) {
  const keyOf = (p: PictureItem) => `${runId ?? "none"}:${boxKey(p.asRead)}`;
  const [editing, setEditing] = useState<string | null>(null);
  const open = items.pictures.find((p) => keyOf(p) === editing);
  if (items.pictures.length === 0) return null;
  return (
    <div>
      <h3 className="section-title">Where the read put the pictures</h3>
      <div className="table-scroll">
        <table className="spend-table">
          <caption className="hint">
            What the read made of the pictures: {items.pictures.length} in all.
            {items.pictures.some((p) => p.corrected) ? " Pictures marked corrected show a person's correction, kept if the design is read again; use Prepare the pictures again to apply them." : ""}
          </caption>
          <thead>
            <tr>
              <th scope="col">Kind</th>
              <th scope="col">Where it sits</th>
              <th scope="col">Band</th>
              <th scope="col">
                <span className="visually-hidden">Correct</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.pictures.map((picture, i) => (
              <tr key={`${boxKey(picture.asRead)}-${i}`}>
                <td>
                  {KIND_LABEL[picture.kind] ?? picture.kind}
                  {picture.corrected ? correctedNote(picture.corrected) : null}
                </td>
                <td>{boxText(picture.box)}</td>
                <td>{picture.band}</td>
                <td>
                  <Button variant="text" onClick={() => setEditing(editing === keyOf(picture) ? null : keyOf(picture))}>
                    {editing === keyOf(picture) ? "Close" : "Correct"}
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && runId ? <PictureCorrectionForm key={keyOf(open)} projectId={projectId} runId={runId} picture={open} onDone={() => setEditing(null)} /> : null}
    </div>
  );
}

function PictureCorrectionForm({ projectId, runId, picture, onDone }: { projectId: string; runId: string; picture: PictureItem; onDone: () => void }) {
  const router = useRouter();
  const [kind, setKind] = useState<PictureItem["kind"]>(picture.kind);
  const [x, setX] = useState(String(picture.box.x));
  const [y, setY] = useState(String(picture.box.y));
  const [w, setW] = useState(String(picture.box.w));
  const [h, setH] = useState(String(picture.box.h));
  const [error, setError] = useState<string | null>(null);
  const [saving, startSaving] = useTransition();

  const save = () => {
    // An emptied field would read as 0, a real position: whole numbers only.
    if (![x, y, w, h].every((v) => /^\d+$/.test(v.trim()))) {
      setError("x, y, width and height must be whole numbers of pixels.");
      return;
    }
    const box: Box = { x: Number(x), y: Number(y), w: Number(w), h: Number(h) };
    // Only what was changed is sent; the server checks it against the read as it is now.
    const change: PictureChange = {};
    if (kind !== picture.kind) change.kind = kind;
    if (boxKey(box) !== boxKey(picture.box)) change.box = box;
    if (Object.keys(change).length === 0) {
      setError("Nothing was changed.");
      return;
    }
    setError(null);
    startSaving(async () => {
      const result = await correctReadPictureAction(projectId, picture.asRead, change, runId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onDone();
      router.refresh();
    });
  };

  return (
    <div className="card" aria-label={`Correct the ${KIND_LABEL[picture.kind].toLowerCase()} at ${picture.box.x}, ${picture.box.y}`}>
      <p className="hint">
        Correct what kind of picture this is or where it sits on the design. The correction is kept if the design is read again; the pictures are cut again when you
        choose Prepare the pictures again.
      </p>
      <SelectField label="Kind" value={kind} onChange={(v) => setKind(v ?? picture.kind)} options={PICTURE_KIND_OPTIONS} />
      <TextField label="x (px)" value={x} onChange={setX} hint="A whole number of pixels from the left of the design." />
      <TextField label="y (px)" value={y} onChange={setY} hint="A whole number of pixels from the top of the design." />
      <TextField label="Width (px)" value={w} onChange={setW} hint="A whole number of pixels." />
      <TextField label="Height (px)" value={h} onChange={setH} hint="A whole number of pixels." />
      {error ? (
        <p className="hint-error" role="alert">
          {error}
        </p>
      ) : null}
      <Button variant="primary" onClick={save} disabled={saving}>
        {saving ? "Saving..." : "Save correction"}
      </Button>{" "}
      <Button variant="secondary" onClick={onDone} disabled={saving}>
        Cancel
      </Button>
    </div>
  );
}

/* Corrections no word or picture of this read matches any more, and corrections that could not be applied in full: said, never dropped quietly. */
function ItemNotes({ items }: { items: NewReadItems }) {
  return (
    <>
      {items.unmatched.length > 0 ? (
        <div className="hint-error" role="status">
          <p>These corrections don&rsquo;t match one word or picture of this read (it changed when the design was read again). They are kept, not applied:</p>
          <ul>
            {items.unmatched.map((u, i) => (
              <li key={i}>
                The {u.what} {boxText(u.anchor)}
                {u.why === "tied" ? " (two of this read are in its place equally)" : " (none of this read is in its place)"}
                {u.by ? ` (by ${u.by})` : ""}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {items.problems.length > 0 ? (
        <ul className="hint-error">
          {items.problems.map((p, i) => (
            <li key={i}>{p}</li>
          ))}
        </ul>
      ) : null}
    </>
  );
}

/*
  Prepare the pictures again (E4b-2b): free. It cuts the read's pictures again from the design,
  with the picture corrections applied, and makes no AI call, so it has no estimate and is not a
  paid step.
*/
function PrepareAgain({ projectId, version, runId, prepare }: { projectId: string; version: string; runId: string; prepare: { status: PrepareStatus; stalled: boolean } | null }) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [starting, startStarting] = useTransition();
  const status = prepare?.status ?? null;
  const stalled = prepare?.stalled ?? false;
  const busy = (status?.state === "queued" || status?.state === "working") && !stalled;
  const start = () => {
    setError(null);
    startStarting(async () => {
      const result = await preparePicturesAgainAction(projectId, version, runId);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });
  };
  return (
    <div>
      <h3 className="section-title">Prepare the pictures again</h3>
      <p className="hint">
        This is free: it does not read the design again and uses no AI. It cuts the read&rsquo;s pictures from the design again, with the picture corrections above applied.
      </p>
      <Button variant="secondary" onClick={start} disabled={busy || starting}>
        {starting ? "Starting..." : "Prepare the pictures again"}
      </Button>
      {error ? (
        <p className="hint-error" role="alert">
          {error}
        </p>
      ) : null}
      {status?.state === "failed" ? (
        <p className="hint-error" role="alert">
          {status.error ?? "Preparing the pictures stopped, and no reason was given."}
        </p>
      ) : null}
      {stalled ? (
        <p className="hint-error" role="alert">
          {status?.state === "queued"
            ? "The last try at preparing the pictures is still waiting its turn after 10 minutes. It can be started again."
            : "The last try at preparing the pictures stopped without finishing. It can be started again."}
        </p>
      ) : null}
      {status?.state === "queued" && !stalled ? <p className="hint">Waiting for its turn: the worker does one thing at a time.</p> : null}
      {status?.state === "working" && !stalled ? (
        <p className="hint">{`Preparing the pictures: ${status.done}${status.total !== null ? ` of ${status.total}` : ""}.`}</p>
      ) : null}
    </div>
  );
}

/*
  Build the page from this read (E5a): one paid call. The estimate and the
  model are shown before it starts (standing rules 2 and 9), and it can be
  stopped like any other paid step.

  What comes back is kept whatever code found wrong with it, and the
  problems are listed: a build that came back wrong is what the correction
  rounds (E5b) start from, and it is more use to look at than to throw
  away. The flags are a separate list on purpose -- they are what the
  design itself could not give us (a picture that would not cut, a menu
  item with no page), not something the build did wrong.
*/
function BuildPage({ projectId, build }: { projectId: string; build: PageBuildView }) {
  const status = build.status;
  const busy = (status?.state === "queued" || status?.state === "working") && !build.stalled;
  // index.html, so the page's own `<img src="p3.png">` resolves beside it (see the route).
  const pageUrl = `/projects/${projectId}/design-page/${build.version}/${build.page}/index.html`;
  return (
    <div>
      <h3 className="section-title">Build the page from this read</h3>
      <p className="hint">
        One call: the whole design, the band list, the measurements and the pictures go in, and one page with one stylesheet comes out. It is built at the
        design&rsquo;s own width and flows below it. Only the home page is built for now.
      </p>
      {build.estimate ? (
        <PaidStepButton
          id="design-page-build"
          variant="secondary"
          label={build.built ? "Build the page again" : "Build the page"}
          confirmTitle="Build the page from this read?"
          confirmText="This makes one paid AI call. It builds the home page from the read as it stands now, with every correction applied."
          estimateLine={build.estimate.label}
          working={busy}
          run={() => buildDesignPageAction(projectId, build.page)}
          stop={{ projectId, kind: "design_page", what: "building a page from the design" }}
        />
      ) : null}
      {status?.state === "queued" && !build.stalled ? <p className="hint">Waiting for its turn: the worker does one thing at a time.</p> : null}
      {status?.state === "working" && !build.stalled ? <p className="hint">Building the page.</p> : null}
      {build.stalled ? (
        <p className="hint-error" role="alert">
          {status?.state === "queued"
            ? "The last build is still waiting its turn after 15 minutes. It can be started again."
            : "The last build stopped without finishing. It can be started again."}
        </p>
      ) : null}
      {status?.state === "failed" ? (
        <p className="hint-error" role="alert">
          {status.error ?? "The build stopped, and no reason was given."}
        </p>
      ) : null}
      {build.built ? (
        <p className="hint">
          <a href={pageUrl} target="_blank" rel="noreferrer">
            Open the built page
          </a>{" "}
          (it opens in a new tab, inside TAWD).
          {status?.state === "failed" || build.stalled
            ? " This is the page of an earlier build: the last one did not finish, so nothing about it has changed."
            : status?.state === "queued" || status?.state === "working"
              ? " This is the page of the last finished build; the one running now has not replaced it yet."
              : ""}
        </p>
      ) : null}
      {status?.state === "done" && status.problems.length > 0 ? (
        <>
          <p className="hint-error" role="alert">
            Code found {status.problems.length === 1 ? "something" : `${status.problems.length} things`} wrong with the page that was built. It is kept so it can
            be looked at and corrected.
          </p>
          <ul className="hint-error">
            {status.problems.map((p, i) => (
              <li key={i}>{p}</li>
            ))}
          </ul>
        </>
      ) : null}
      {status?.state === "done" && status.problems.length === 0 ? (
        <p className="hint">Nothing code can check from the page&rsquo;s text is wrong with it. How closely it matches the design is measured in a browser, which is not built yet.</p>
      ) : null}
      {status && status.flags.length > 0 ? (
        <>
          <p className="hint">Could not be copied from the design ({status.flags.length}):</p>
          <ul className="hint">
            {status.flags.map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}

/* How iconChoice (core mockups/icons.ts) found the icon, said plainly. */
const ICON_BY: Record<string, string> = {
  name: "the word beside it is the icon's own name",
  alias: "the word beside it is a known word for this icon",
  word: "TAWD's word rules matched the word beside it",
  context: "the word beside it told nothing, so the card's heading was matched",
  unknown: "no match: TAWD's plain dot",
};

/*
  The pictures of the read shown above, as the worker prepared them (E4b-1): each on a checked ground,
  its kind and size, what was made see-through or faded, every patch with what it hid, and every flag.
  The read's own pictures only (loaded for its runId), so a read in progress never shows another's.
*/
function AssetSheetView({ assets, preparing }: { assets: NonNullable<NewReadView["assets"]>; preparing: boolean }) {
  const { sheet, base } = assets;
  // Storage trouble reading the sheet: the pictures may well be there, so no paid re-run is suggested.
  if (!sheet && assets.loadFailed) return <p className="hint-error">This read&rsquo;s pictures couldn&rsquo;t be loaded just now. Reload the page to try again.</p>;
  // The read is saved before its pictures: while its own run is still working, they are on their way.
  if (!sheet && preparing) return <p className="hint">This read&rsquo;s pictures are being prepared (no AI). Open the page again in a minute to see them.</p>;
  if (!sheet)
    return (
      <p className="hint">
        This read&rsquo;s pictures were not prepared (the worker stopped before it finished them). Preparing them means running the new read again, which is a paid read.
      </p>
    );
  if (sheet.error) return <p className="hint-error">{sheet.error}</p>;
  if (sheet.assets.length === 0) return <p className="hint">The read found no pictures on this page.</p>;
  const flagged = sheet.assets.filter((a) => a.flags.length > 0).length;
  // Counted by what really happened: icons are matched, never cut, and some boxes can't be cut.
  const cut = sheet.assets.filter((a) => a.file).length;
  const icons = sheet.assets.filter((a) => a.kind === "icon").length;
  const notCut = sheet.assets.length - cut - icons;
  return (
    <div>
      <h3 className="section-title">Pictures from the design</h3>
      <p className="hint">
        The read named {sheet.assets.length} picture{sheet.assets.length === 1 ? "" : "s"}: {cut} cut from the design and prepared by kind
        {icons > 0 ? `, ${icons} icon${icons === 1 ? "" : "s"} (never cut: icons come from TAWD's own set)` : ""}
        {notCut > 0 ? `, ${notCut} that could not be cut` : ""}
        {flagged > 0 ? `; ${flagged} need${flagged === 1 ? "s" : ""} a look (see the notes on each)` : ""}. The checked ground shows what is see-through.
      </p>
      <div className="photo-grid">
        {sheet.assets.map((asset) => (
          <div className="asset-card" key={asset.id}>
            {asset.file ? (
              // eslint-disable-next-line @next/next/no-img-element -- a picture TAWD itself prepared, served from TAWD's own address
              <img className="asset-thumb" src={`${base}${asset.file}`} alt={`${KIND_LABEL[asset.kind]} ${asset.id}, as prepared`} width={asset.width ?? undefined} height={asset.height ?? undefined} />
            ) : null}
            <strong>
              {KIND_LABEL[asset.kind]} <span className="hint">{asset.id}</span>
            </strong>
            <span className="hint">
              {asset.width && asset.height ? `${asset.width} × ${asset.height}px` : asset.kind === "icon" ? (asset.icon && asset.icon.by !== "unknown" ? "No picture: matched to TAWD's icons" : "No picture, and no icon matched (see the note)") : "Not cut"}
              {` · at ${asset.box.x}, ${asset.box.y} on the design`}
            </span>
            {asset.icon ? <span className="hint">Icon: {asset.icon.name} ({ICON_BY[asset.icon.by] ?? asset.icon.by})</span> : null}
            {asset.transparentOn ? <span className="hint">Made see-through where it was {asset.transparentOn}.</span> : null}
            {asset.fadedEdges.length > 0 ? <span className="hint">Faded into the band on its {asset.fadedEdges.join(", ")} edge{asset.fadedEdges.length === 1 ? "" : "s"}.</span> : null}
            {asset.patches.length > 0 ? (
              <ul className="hint">
                {asset.patches.map((patch, i) => (
                  <li key={i}>
                    Patch {i + 1}: {patch.method === "blend" ? "blended from the colours around it" : "smoothed over (a guess)"}, {patch.box.w} × {patch.box.h}px at {patch.box.x}, {patch.box.y} on the picture
                    {patch.hid ? (
                      <>
                        {" "}
                        (<a href={`${base}${patch.hid}`} target="_blank" rel="noreferrer">what it hid</a>)
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {asset.flags.length > 0 ? (
              <ul className="hint-error">
                {asset.flags.map((flag, i) => (
                  <li key={i}>{flag}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
