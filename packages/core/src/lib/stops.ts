import {
  CHANGES_JOB,
  CONCEPT_JOB,
  CONTENT_DRAFT_JOB,
  DESIGN_DECISIONS_JOB,
  DESIGN_MOBILE_JOB,
  DESIGN_IMPROVE_JOB,
  DESIGN_REVIEW_JOB,
  DESIGN_UPLOAD_JOB,
  DESIGN_READ_JOB,
  DESIGN_PAGE_JOB,
  FAITHFUL_COPY_JOB,
  LOGO_JOB,
  PHOTO_TEXT_JOB,
  POLISH_JOB,
  REFERENCE_STUDY_JOB,
  REVIEW_JOB,
  SEO_AUDIT_JOB,
  SEO_GOLIVE_JOB,
  SITE_BUILD_JOB,
  SITE_EDIT_JOB,
} from "./mockups/queue";

/*
  Stopping running work (Jason, 28 September 2026): a Stop button on every
  running job. Pressing it records a stop for that kind of work on the
  project (or for one copy); the worker checks before every AI call and
  ends the job there, keeping what was finished. A stop only reaches jobs
  queued before it was pressed, so starting again later needs no clearing.
*/

export const STOP_KINDS = {
  design_read: { label: "the design read", jobs: [DESIGN_UPLOAD_JOB, DESIGN_READ_JOB] },
  design_page: { label: "building a page from the design", jobs: [DESIGN_PAGE_JOB] },
  copies: { label: "the copies", jobs: [FAITHFUL_COPY_JOB] },
  phone_versions: { label: "the phone versions", jobs: [DESIGN_MOBILE_JOB] },
  drafts: { label: "the page drafts", jobs: [CONTENT_DRAFT_JOB] },
  site_build: { label: "the site build", jobs: [SITE_BUILD_JOB] },
  site_edit: { label: "the edits", jobs: [SITE_EDIT_JOB] },
  logo: { label: "the logo design", jobs: [LOGO_JOB] },
  seo_audit: { label: "the SEO audit", jobs: [SEO_AUDIT_JOB] },
  seo_golive: { label: "the SEO check", jobs: [SEO_GOLIVE_JOB] },
  reference_study: { label: "the reference study", jobs: [REFERENCE_STUDY_JOB] },
  photo_text: { label: "the photo text check", jobs: [PHOTO_TEXT_JOB] },
  polish: { label: "critique and polish", jobs: [POLISH_JOB] },
  design_review: { label: "the design review", jobs: [DESIGN_REVIEW_JOB] },
  design_improve: { label: "the improvement", jobs: [DESIGN_IMPROVE_JOB, DESIGN_DECISIONS_JOB] },
  mockups: { label: "the mockups", jobs: [CONCEPT_JOB, REVIEW_JOB] },
  changes: { label: "the requested changes", jobs: [CHANGES_JOB] },
} as const;

export type StopKind = keyof typeof STOP_KINDS;

export function isStopKind(value: string): value is StopKind {
  return value in STOP_KINDS;
}

/* The project-wide key for a kind of work, and one copy's own key. */
export const stopKey = (kind: StopKind, projectId: string) => `${kind}:${projectId}`;
export const copyStopKey = (copyId: string) => `copy:${copyId}`;

/* The keys a job answers to: its kind on its project, and for a copy its own. */
export function stopKeysFor(jobName: string, data: Record<string, unknown>): string[] {
  const projectId = typeof data.projectId === "string" ? data.projectId : null;
  if (!projectId) return [];
  const kind = (Object.keys(STOP_KINDS) as StopKind[]).find((k) => (STOP_KINDS[k].jobs as readonly string[]).includes(jobName));
  if (!kind) return [];
  const keys = [stopKey(kind, projectId)];
  if (jobName === FAITHFUL_COPY_JOB && typeof data.copyId === "string") keys.push(copyStopKey(data.copyId));
  return keys;
}

export class StoppedError extends Error {
  constructor(by: string | null) {
    super(`Stopped by ${by ?? "a team member"} before the next AI call; what was finished is kept.`);
    this.name = "StoppedError";
  }
}
