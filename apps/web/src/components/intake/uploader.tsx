"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";

import {
  confirmUploadAction,
  openFileAction,
  removeFileAction,
  requestUploadAction,
} from "@/app/actions";
import { Button } from "@/components/ui/button";
import { FieldLabel } from "@/components/ui/field";
import { fileRules, formatBytes, type FileKind } from "@tawd/core/intake";

/*
  Uploading.

  The file goes from this browser straight to Cloudflare. TAWD signs a
  short-lived permission slip and is told afterwards that the upload landed;
  the file never passes through the server. The container has a 1 GB memory
  limit on a droplet shared with a client-facing app, and a 25 MB brand guide
  streamed through it would sit in that budget on the way past.

  Uploads save immediately and say so, which is why they do not wait for the
  section's Save button. Captions do wait, because they are typed answers.
*/

export interface UploadedFile {
  id: string;
  kind: FileKind;
  fileName: string;
  sizeBytes: number | null;
  caption: string | null;
}

interface InFlight {
  name: string;
  percent: number;
}

interface Rejected {
  name: string;
  reason: string;
}

export function FileUploader({
  projectId,
  kind,
  label,
  canEdit,
  files,
  required = false,
  missingHint,
  dropLabel,
  hideList = false,
  anchorId,
}: {
  projectId: string;
  kind: FileKind;
  label: string;
  canEdit: boolean;
  files: UploadedFile[];
  required?: boolean;
  missingHint?: string;
  dropLabel?: string;
  /** Photos render their own cards, so the plain list is suppressed. */
  hideList?: boolean;
  anchorId?: string;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);

  const [inFlight, setInFlight] = useState<InFlight | null>(null);
  const [rejected, setRejected] = useState<Rejected | null>(null);
  const [dragging, setDragging] = useState(false);

  const rules = fileRules[kind];
  const atLimit = files.length >= rules.maxCount;

  const limitsLine = `${rules.accept
    .replace(/\./g, "")
    .replace(/,/g, ", ")
    .toUpperCase()}, up to ${formatBytes(rules.maxBytes)}${
    rules.maxCount > 1 ? ` each, ${rules.maxCount} at most` : ""
  }.`;

  async function upload(file: File) {
    setRejected(null);
    setInFlight({ name: file.name, percent: 0 });

    try {
      const ticket = await requestUploadAction(
        projectId,
        kind,
        file.name,
        file.type,
        file.size,
      );
      if (!ticket.ok) {
        setRejected({ name: file.name, reason: ticket.message });
        return;
      }

      setInFlight({ name: file.name, percent: 10 });

      const ok = await putWithProgress(ticket.uploadUrl, file, (percent) =>
        setInFlight({ name: file.name, percent }),
      );

      if (!ok) {
        setRejected({
          name: file.name,
          reason: "The upload did not go through. Check the connection and try again.",
        });
        return;
      }

      const confirmed = await confirmUploadAction(ticket.fileId);
      if (!confirmed.ok) {
        setRejected({ name: file.name, reason: confirmed.message });
        return;
      }

      router.refresh();
    } catch {
      setRejected({
        name: file.name,
        reason: "Something went wrong during the upload. Try again.",
      });
    } finally {
      setInFlight(null);
      if (inputRef.current) inputRef.current.value = "";
    }
  }

  async function handleChosen(list: FileList | null) {
    if (!list || list.length === 0) return;
    // One at a time, so a failure part-way through is easy to understand.
    for (const file of Array.from(list)) {
      await upload(file);
    }
  }

  return (
    <div className="uploader">
      <FieldLabel required={required}>{label}</FieldLabel>

      {!hideList && files.length > 0 ? (
        <div className="upload-rows">
          {files.map((file) => (
            <div key={file.id} className="upload-row">
              <div style={{ minWidth: 0, flex: 1 }}>
                <p className="upload-name">{file.fileName}</p>
                <p className="upload-saved">
                  Uploaded and saved
                  {file.sizeBytes ? `, ${formatBytes(file.sizeBytes)}` : ""}
                </p>
              </div>
              <div className="row" style={{ gap: 4, flex: "none" }}>
                <ViewButton fileId={file.id} />
                {canEdit ? (
                  <RemoveButton fileId={file.id} fileName={file.fileName} />
                ) : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}

      {inFlight ? (
        <div className="upload-row">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="upload-name">{inFlight.name}</p>
            <div className="upload-progress" aria-hidden="true">
              <span style={{ width: `${inFlight.percent}%` }} />
            </div>
            <p className="hint" role="status">
              Uploading, {inFlight.percent}%
            </p>
          </div>
        </div>
      ) : null}

      {rejected ? (
        <div className="upload-row is-rejected" role="alert">
          <div style={{ minWidth: 0, flex: 1 }}>
            <p className="upload-name">{rejected.name}</p>
            <p className="upload-rejected">{rejected.reason}</p>
          </div>
          <Button small onClick={() => setRejected(null)}>
            Dismiss
          </Button>
        </div>
      ) : null}

      {canEdit && !atLimit ? (
        <>
          <button
            type="button"
            id={anchorId}
            className={dragging ? "dropzone is-dragging" : "dropzone"}
            onClick={() => inputRef.current?.click()}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              void handleChosen(event.dataTransfer.files);
            }}
          >
            <UploadIcon />
            <span>{dropLabel ?? "Drop files or choose"}</span>
          </button>
          <p className="hint">{limitsLine}</p>
          <input
            ref={inputRef}
            type="file"
            className="visually-hidden"
            accept={rules.accept}
            multiple={rules.maxCount > 1}
            aria-label={`Upload ${label.toLowerCase()}`}
            onChange={(event) => handleChosen(event.target.files)}
          />
        </>
      ) : null}

      {canEdit && atLimit ? (
        <p className="hint">
          {rules.maxCount === 1
            ? "Remove the current one to upload a different file."
            : "That is the maximum number of files here."}
        </p>
      ) : null}

      {missingHint ? <p className="hint-missing">{missingHint}</p> : null}
    </div>
  );
}

function ViewButton({ fileId }: { fileId: string }) {
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="text"
      small
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        const result = await openFileAction(fileId);
        setBusy(false);
        if (!result.ok) {
          window.alert(result.message);
          return;
        }
        // A link that stops working after five minutes.
        window.open(result.url, "_blank", "noopener,noreferrer");
      }}
    >
      View
    </Button>
  );
}

function RemoveButton({
  fileId,
  fileName,
}: {
  fileId: string;
  fileName: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  return (
    <Button
      variant="text"
      small
      disabled={busy}
      aria-label={`Remove ${fileName}`}
      onClick={async () => {
        if (!window.confirm(`Remove ${fileName}? This cannot be undone.`)) return;
        setBusy(true);
        const result = await removeFileAction(fileId);
        setBusy(false);
        if (!result.ok) {
          window.alert(result.message);
          return;
        }
        router.refresh();
      }}
    >
      Remove
    </Button>
  );
}

FileUploader.ViewButton = ViewButton;
FileUploader.RemoveButton = RemoveButton;

/*
  XMLHttpRequest rather than fetch, purely because it reports upload progress
  and fetch does not. A 15 MB photo on a slow connection needs to show that
  something is happening.
*/
function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    const request = new XMLHttpRequest();
    request.open("PUT", url);
    // Must match what was signed, or Cloudflare rejects the upload.
    request.setRequestHeader("content-type", file.type);

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };

    request.onload = () =>
      resolve(request.status >= 200 && request.status < 300);
    request.onerror = () => resolve(false);
    request.onabort = () => resolve(false);

    request.send(file);
  });
}

function UploadIcon() {
  return (
    <svg
      width="22"
      height="22"
      viewBox="0 0 24 24"
      fill="none"
      stroke="var(--blue)"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 16V4" />
      <path d="M7 9l5-5 5 5" />
      <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
    </svg>
  );
}
