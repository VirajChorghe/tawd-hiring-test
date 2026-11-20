"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { readHomepageAgainAction } from "@/app/actions";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import type { HomepageReadView } from "@/lib/html-mockup-import";
import { FileUploader, type UploadedFile } from "./uploader";

/*
  A finished homepage uploaded as one HTML file (the direct route: the page's
  own source, not a picture of it).

  What this screen says is only what the code does. Confirming the upload
  starts the reading by itself (confirmUploadAction, html-mockup-import.ts):
  free, no AI, no network. The worker cleans the file (scripts, inline
  handlers and javascript: links are taken out; a picture or font that fails
  a check is left out), stores it as concept "S" on the Mockups board and
  photographs it. TAWD's own page checks do NOT run on it. Build A then keeps
  it as the home page once the client has approved it there. Everything shown
  below comes from the stored result (loadHomepageRead), so it cannot say
  more than happened.
*/
export function HomepageHtmlSection({
  projectId,
  files,
  canEdit,
  read = null,
}: {
  projectId: string;
  files: UploadedFile[];
  canEdit: boolean;
  read?: HomepageReadView | null;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  // While it is being read the screen checks again by itself (a few seconds, no AI).
  const reading = read?.state === "reading";
  useEffect(() => {
    if (!reading) return;
    const timer = window.setInterval(() => router.refresh(), 4000);
    return () => window.clearInterval(timer);
  }, [reading, router]);

  const readAgain = (again: boolean) =>
    start(async () => {
      setError(null);
      const result = await readHomepageAgainAction(projectId, again);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      router.refresh();
    });

  const done = read?.state === "done" ? read.done : null;
  const notes = done ? [...done.removed, ...done.warnings] : [];

  return (
    <div className="field homepage-html-upload">
      <FileUploader
        projectId={projectId}
        kind="homepage_html"
        label="Finished homepage (HTML)"
        canEdit={canEdit}
        files={files}
        dropLabel="Drop the HTML file here, or choose a file"
      />
      <p className="hint">
        A homepage that was built as one HTML file. Uploading it costs nothing: TAWD reads the file by itself as soon as it is saved, with no
        AI and no charge, and puts the page on the Mockups board as concept S. When the client approves it there, the site build keeps this
        page as the home page and builds the other pages from its design.
      </p>
      <p className="hint">Only one homepage file is kept. To replace it, remove it first, then upload the new one.</p>
      {canEdit ? null : <p className="hint">Only a PM or an admin can change this file.</p>}

      {read?.state === "not_read" ? (
        <Banner
          tone="warning"
          title="Saved, but not read yet"
          action={
            canEdit ? (
              <Button variant="secondary" small onClick={() => readAgain(false)} disabled={busy}>
                Read it now
              </Button>
            ) : undefined
          }
        >
          The file is saved, but nothing has read it. This is free (no AI).
        </Banner>
      ) : null}

      {reading ? (
        <Banner tone="warning" title="Reading the homepage file">
          Cleaning the page, lifting out its pictures and fonts and taking its picture. This page checks again by itself.
        </Banner>
      ) : null}

      {read?.state === "failed" ? (
        <Banner
          tone="error"
          title="The homepage file could not be read"
          action={
            canEdit ? (
              <Button variant="secondary" small onClick={() => readAgain(true)} disabled={busy}>
                Read it again
              </Button>
            ) : undefined
          }
        >
          {read.failure ?? "No reason was recorded."} If the file itself is wrong, remove it and upload the right one.
        </Banner>
      ) : null}

      {error ? <p className="hint-error">{error}</p> : null}

      {done ? (
        <div className="quiet-box">
          <p className="card-title">Read: version {done.version} is on the Mockups board</p>
          <p className="hint">
            <Link href={`/projects/${projectId}/mockups/${done.conceptId}`}>Open the supplied homepage</Link>. TAWD&rsquo;s own page checks (fake
            reviews, invented phone numbers, placeholders) did not run on it: people made it, so it is not judged like a generated concept. The
            file was cleaned, not read as it came: scripts, inline handlers and javascript: links are taken out, and a picture or font that fails
            a check is left out. Anything on the page that ran on a script, such as a menu button or an open-and-close FAQ, will not work on the
            kept home page. At go-live, a rating, review, offer or other claim that the uploaded file&rsquo;s own words show is not counted as a problem by TAWD&rsquo;s
            invented-fact and unsupported-claim checks, and whoever supplied the page answers for it. Anything those words do not show is still reported.
          </p>
          {notes.length > 0 ? (
            <>
              <p className="card-title">
                {notes.length} note{notes.length === 1 ? "" : "s"} from reading the file
              </p>
              <ul>
                {done.removed.map((note) => (
                  <li key={`removed-${note}`} className="hint">
                    Taken out: {note}
                  </li>
                ))}
                {done.warnings.map((note) => (
                  <li key={`warning-${note}`} className="hint">
                    {note}
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="hint">Nothing had to be taken out or left out.</p>
          )}
          {done.approvedOlder ? (
            <Banner tone="warning" title={`The client approved version ${done.approvedOlder.approved}, not version ${done.approvedOlder.latest}`}>
              The site build still builds from the approved version {done.approvedOlder.approved}. This new file is version {done.approvedOlder.latest} and
              replaces nothing until the client approves it on the Mockups board.
            </Banner>
          ) : null}
          {done.planHasNoHome ? (
            <Banner tone="warning" title="The page plan has no Home page">
              The supplied page is kept as the home page, and the plan has none, so the site build will stop and ask for one. Add a Home page to the
              plan on Content.
            </Banner>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
