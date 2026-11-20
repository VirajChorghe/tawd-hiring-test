"use client";

import { useCallback, useRef, useState, useTransition } from "react";
import type { Dma } from "@tawd/core/intake";
import { useRouter } from "next/navigation";

import { saveIntakeSectionAction, savePhotoCaptionsAction } from "@/app/actions";
import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button } from "@/components/ui/button";
import type { CompletenessResult } from "@tawd/core/intake";
import type { IntakeData, IntakeSectionKey } from "@tawd/core/intake";
import { sectionLabels } from "@tawd/core/intake";
import type { SectionStatus } from "@tawd/core/intake";
import type { TierWarning } from "@tawd/core/intake";
import type { LogoDesignView } from "@/lib/logo-design";
import type { Trade } from "@tawd/core/enums";
import type { UploadedFile } from "./uploader";
import { SectionBody } from "./section-body";
import type { HomepageReadView } from "@/lib/html-mockup-import";
import { HomepageHtmlSection } from "./homepage-html-section";
import { FigmaSection, type DesignUploadView, type FigmaSectionView } from "./figma-section";
import { NewDesignRead } from "./new-design-read";
import type { NewReadItems } from "@/lib/design-read-items";
import type { PageBuildView } from "@/lib/design-page";
import type { PrepareStatus } from "@tawd/core/figma/read-assets";
import type { NewReadView } from "@/lib/design-read-new";
import type { NewReadCorrections } from "@/lib/design-read-corrections";
import { ContinueToMockups } from "@/components/project/continue-button";
import type { SiteReadPanelView } from "@/components/intake/site-read-panel";
import type { BrandGuideView } from "@/lib/brand-guide";
import type { LikedShotView } from "@/lib/liked-sites";
import type { PhotoTextView, ReferenceStudyView } from "@/lib/mockup-inputs";
import { useUnsavedChanges } from "@/lib/unsaved";
import type { TypeChangeWork } from "@/lib/project-type";

/*
  The intake workspace.

  One section is on screen at a time, the left rail shows where everything
  stands, and a single save bar at the bottom of the card handles the whole
  section. See DESIGN.md, "Intake page layout".

  Two rules this file exists to enforce:

  - Typed answers save when you press Save. Uploads save the moment they
    finish, and say so.
  - You cannot wander off a section and silently lose what you typed: moving
    away with unsaved changes asks first.
*/

export interface WorkspaceProps {
  projectId: string;
  /** For "unsaved changes in the Business section of Pat Rivera's intake". */
  projectName: string;
  data: IntakeData;
  files: UploadedFile[];
  completeness: CompletenessResult;
  tierWarning: TierWarning | null;
  /** The project's lane: Lane 2 has no project type (its words come from the design). */
  lane?: string;
  /** What exists that a change of project type would affect (0.100.0), for the note under the choice. */
  typeWork?: TypeChangeWork | null;
  /** The project's trade, for the suggested services. */
  trade?: Trade;
  sections: SectionStatus[];
  canEdit: boolean;
  /** The Design section (Lane 2): PMs, web designers and admins (intake.design). */
  canEditDesign: boolean;
  canChangeTier: boolean;
  initialSection: Section;
  /*
    Lane 2, Option B only: the Figma design section, after the nine intake
    sections. It is not part of the intake's answers and has no save bar;
    its buttons read Figma.
  */
  figma?: {
    view: FigmaSectionView | null;
    readsThisMonth: number;
    badge: { text: string; kind: "done" | "missing" | "warning" | "info" };
    /** The design uploaded as a PDF or images (28 September 2026). */
    upload?: DesignUploadView | null;
    /** The supplied homepage's reading: being read, done (with its notes) or failed. */
    homepageRead?: HomepageReadView | null;
  } | null;
  /*
    Lane 1 (16 November 2026): a homepage the team made by hand as one HTML
    file. It is a mockup, which is Lane 1's own artefact, so it gets its own
    item in the section list (Lane 1 has no Design item) and is not part of
    the intake's answers: no save bar.
  */
  homepage?: { read: HomepageReadView; badge: { text: string; kind: "done" | "missing" | "warning" | "info" } } | null;
  /** The newest TAWD fill when the page loaded, sent back with every save so a form that is out of date is refused (null: nothing filled yet; left out: no check). */
  prefillStamp?: string | null;
  /** The new design read (admin only, Lane 2), shown in the Design section. */
  newRead?: { view: NewReadView; corrections: NewReadCorrections | null; items?: NewReadItems | null; prepare?: { status: PrepareStatus; stalled: boolean } | null; build?: PageBuildView | null } | null;
  /** Intake fields filled from the Figma design, still to be confirmed or corrected. */
  prefills?: Record<string, { source: string; origin: "design" | "site" }>;
  /** "From the brand guide" suggestions, for the Brand section. */
  brandGuide?: BrandGuideView | null;
  /** "TAWD designs the logo": the design and its options, when the box is ticked. */
  logoDesign?: LogoDesignView | null;
  likedShots?: LikedShotView[];
  /** What TAWD read from the current website's home page (30 September 2026). */
  currentSite?: SiteReadPanelView | null;
  /** The reference study and the photo text check (27 September 2026). */
  referenceStudy?: ReferenceStudyView;
  photoText?: PhotoTextView;
  /** TV markets (DMAs) an admin loaded; none hides the DMA choice. */
  dmaOptions?: Dma[];
  /** Whether the project is still in Intake, so continuing moves it on. */
  stillInIntake: boolean;
  canMove: boolean;
  /** Only while the project is in Intake or Mockups; later stages move on elsewhere. */
  showContinue: boolean;
}

/* An intake section, or the Figma design section of a Lane 2, Option B project. */
export type Section = IntakeSectionKey | "figma" | "homepage";

type PendingMove =
  | { kind: "section"; to: Section; focusFieldId?: string }
  | null;

export function IntakeWorkspace(props: WorkspaceProps) {
  const router = useRouter();

  // The Figma section has no answers of its own; it keeps Business's untouched.
  const dataFor = useCallback(
    (to: Section) => props.data[to === "figma" || to === "homepage" ? "business" : to],
    [props.data],
  );
  const [section, setSection] = useState<Section>(props.initialSection);
  const [values, setValues] = useState<IntakeData[IntakeSectionKey]>(
    dataFor(props.initialSection),
  );
  const [captions, setCaptions] = useState<Record<string, string>>(() =>
    Object.fromEntries(props.files.map((f) => [f.id, f.caption ?? ""])),
  );

  const [baseline, setBaseline] = useState(() =>
    JSON.stringify({
      values: dataFor(props.initialSection),
      captions: Object.fromEntries(
        props.files.map((f) => [f.id, f.caption ?? ""]),
      ),
    }),
  );

  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Saved, but a follow-up (liked sites, the logo add-on...) didn't run: Try again runs it again.
  const [warning, setWarning] = useState<string | null>(null);
  // TAWD filled answers after this form loaded: the save was refused; Reload shows them.
  const [stale, setStale] = useState<string | null>(null);
  const [stamp, setStamp] = useState<string | null | undefined>(props.prefillStamp);
  const [pendingMove, setPendingMove] = useState<PendingMove>(null);
  const [isSaving, startSaving] = useTransition();

  const focusAfterRender = useRef<string | null>(null);

  const current = JSON.stringify({ values, captions });
  const dirty = current !== baseline;
  const label = section === "figma" ? "Design" : section === "homepage" ? "Homepage file" : sectionLabels[section];

  // So Sign out can warn before discarding what was typed.
  useUnsavedChanges(
    dirty ? `the ${label} section of ${props.projectName}'s intake` : null,
  );

  const focusField = useCallback((fieldId: string) => {
    // Runs after the section has rendered, so the input exists.
    window.requestAnimationFrame(() => {
      const element = document.getElementById(fieldId);
      if (element instanceof HTMLElement) {
        element.focus();
        element.scrollIntoView({ block: "center", behavior: "smooth" });
      }
    });
  }, []);

  const applyMove = useCallback(
    (to: Section, focusFieldId?: string) => {
      setSection(to);
      setValues(dataFor(to));
      setCaptions(
        Object.fromEntries(props.files.map((f) => [f.id, f.caption ?? ""])),
      );
      setBaseline(
        JSON.stringify({
          values: dataFor(to),
          captions: Object.fromEntries(
            props.files.map((f) => [f.id, f.caption ?? ""]),
          ),
        }),
      );
      setError(null);
      setStale(null);
      setStamp(props.prefillStamp);
      setWarning(null);
      setSavedAt(null);
      if (focusFieldId) focusAfterRender.current = focusFieldId;
      if (focusFieldId) focusField(focusFieldId);
    },
    [props.files, props.prefillStamp, focusField, dataFor],
  );

  const goToSection = useCallback(
    (to: Section, focusFieldId?: string) => {
      if (to === section) {
        if (focusFieldId) focusField(focusFieldId);
        return;
      }
      if (dirty) {
        setPendingMove({ kind: "section", to, focusFieldId });
        return;
      }
      applyMove(to, focusFieldId);
    },
    [section, dirty, applyMove, focusField],
  );

  const save = useCallback(
    (then?: (warning: string | null) => void) => {
      // A follow-up warning stays until a save comes back without one, so a failed Try again keeps its button.
      setError(null);
      setStale(null);
      // The Figma section saves through its own buttons.
      if (section === "figma" || section === "homepage") {
        then?.(null);
        return;
      }

      startSaving(async () => {
        const result = await saveIntakeSectionAction(
          props.projectId,
          section,
          values,
          stamp,
        );

        if (!result.ok) {
          if (result.stale) {
            setStale(result.message);
            // Close "unsaved changes" so the banner is seen. No refresh here: new pre-fill marks beside answers the form still shows empty would offer Confirm on a value nobody saw.
            setPendingMove(null);
          } else setError(result.message);
          return;
        }
        if (result.prefillStamp !== undefined) setStamp(result.prefillStamp);

        // Captions live on the file rows rather than in the section document,
        // so they are saved alongside it. DESIGN.md: captions save with the
        // section, uploads save instantly.
        if (section === "photos") {
          const changed = Object.entries(captions).filter(
            ([id, caption]) =>
              (props.files.find((f) => f.id === id)?.caption ?? "") !== caption,
          );

          if (changed.length > 0) {
            const captionResult = await savePhotoCaptionsAction(
              props.projectId,
              Object.fromEntries(changed),
            );
            if (!captionResult.ok) {
              setError(captionResult.message);
              return;
            }
          }
        }

        setBaseline(JSON.stringify({ values, captions }));
        setSavedAt(new Date());
        setWarning(result.warning ?? null);
        router.refresh();
        then?.(result.warning ?? null);
      });
    },
    [props.projectId, props.files, section, values, captions, stamp, router],
  );

  const discard = useCallback(() => {
    // After a refused save this page's answers are out of date: Discard reloads, like the banner's Reload.
    if (stale) {
      window.location.reload();
      return;
    }
    setValues(dataFor(section));
    setCaptions(
      Object.fromEntries(props.files.map((f) => [f.id, f.caption ?? ""])),
    );
    setError(null);
    setStale(null);
    setStamp(props.prefillStamp);
  }, [props.files, props.prefillStamp, section, dataFor, stale]);

  return (
    <div className="intake-grid">
      <aside className="intake-rail">
        <RequiredInfoCard
          projectId={props.projectId}
          stillInIntake={props.stillInIntake}
          canMove={props.canMove}
          showContinue={props.showContinue}
          completeness={props.completeness}
          onJump={(sectionKey, fieldId) =>
            goToSection(sectionKey as IntakeSectionKey, fieldId)
          }
        />

        <nav className="intake-nav" aria-label="Intake sections">
          {props.sections.map((item) => (
            <button
              key={item.key}
              type="button"
              className="intake-nav-item"
              aria-current={item.key === section ? "page" : undefined}
              onClick={() => goToSection(item.key)}
            >
              <span>{item.label}</span>
              <Badge kind={item.kind}>{item.badge}</Badge>
            </button>
          ))}
          {props.figma ? (
            <button
              type="button"
              className="intake-nav-item"
              aria-current={section === "figma" ? "page" : undefined}
              onClick={() => goToSection("figma")}
            >
              <span>Design</span>
              <Badge kind={props.figma.badge.kind}>{props.figma.badge.text}</Badge>
            </button>
          ) : null}
          {props.homepage ? (
            <button
              type="button"
              className="intake-nav-item"
              aria-current={section === "homepage" ? "page" : undefined}
              onClick={() => goToSection("homepage")}
            >
              <span>Homepage file</span>
              <Badge kind={props.homepage.badge.kind}>{props.homepage.badge.text}</Badge>
            </button>
          ) : null}
        </nav>
      </aside>

      {section === "homepage" && props.homepage ? (
        <main className="intake-card">
          <div className="intake-card-body">
            <header className="intake-section-head">
              <h2 className="section-title">Homepage file</h2>
              <p className="hint">
                A finished homepage that was built by hand as one HTML file. It is a mockup: it goes on the Mockups board as a concept, the
                client decides on it there, and the site build keeps it as the home page. Nothing here is required and nothing here blocks the
                project.
              </p>
            </header>
            <HomepageHtmlSection
              projectId={props.projectId}
              files={props.files.filter((f) => f.kind === "homepage_html")}
              canEdit={props.canEdit}
              read={props.homepage.read}
            />
          </div>
        </main>
      ) : section === "figma" && props.figma ? (
        <main className="intake-card">
          <div className="intake-card-body">
            <FigmaSection
              projectId={props.projectId}
              view={props.figma.view}
              readsThisMonth={props.figma.readsThisMonth}
              canEdit={props.canEditDesign}
              upload={props.figma.upload ?? null}
              homepageHtml={
                props.figma.homepageRead?.file
                  ? { files: props.files.filter((f) => f.kind === "homepage_html"), canEdit: props.canEdit, read: props.figma.homepageRead }
                  : null
              }
            />
            {/* The new design read (admin only), with the design it reads. It used to sit below the whole page, behind the Next step bar (Jason, 14 Nov). */}
            {props.newRead ? (
              <NewDesignRead
                projectId={props.projectId}
                view={props.newRead.view}
                corrections={props.newRead.corrections}
                items={props.newRead.items ?? null}
                prepare={props.newRead.prepare ?? null}
                build={props.newRead.build ?? null}
              />
            ) : null}
          </div>
        </main>
      ) : (
      <main className="intake-card">
        <div className="intake-card-body">
          <SectionBody
            section={section === "figma" || section === "homepage" ? "business" : section}
            projectId={props.projectId}
            values={values}
            hasCurrentWebsite={Boolean(props.data.website.currentWebsiteUrl) && props.data.website.noCurrentWebsite !== true}
            lane={props.lane}
            typeWork={props.typeWork ?? null}
            savedMode={props.data.content.mode}
            businessEmail={props.data.business.email}
            serviceCount={props.data.services.items.length}
            onChange={setValues}
            files={props.files}
            captions={captions}
            onCaptionChange={(id, caption) =>
              setCaptions((prev) => ({ ...prev, [id]: caption }))
            }
            completeness={props.completeness}
            tierWarning={props.tierWarning}
            trade={props.trade}
            canEdit={props.canEdit}
            canChangeTier={props.canChangeTier}
            prefills={props.prefills}
            brandGuide={props.brandGuide}
            logoDesign={props.logoDesign}
            savedClean={!dirty}
            likedShots={props.likedShots}
            currentSite={props.currentSite}
            referenceStudy={props.referenceStudy}
            photoText={props.photoText}
            dmaOptions={props.dmaOptions}
          />
        </div>

        {stale ? (
          <div style={{ padding: "0 var(--space-5, 20px) 12px" }}>
            <Banner
              title={stale}
              action={
                <Button variant="secondary" onClick={() => window.location.reload()}>
                  Reload
                </Button>
              }
            />
          </div>
        ) : null}

        <SaveBar
          label={label}
          dirty={dirty}
          saving={isSaving}
          savedAt={savedAt}
          error={error}
          warning={warning}
          canEdit={props.canEdit}
          onSave={() => save()}
          onDiscard={discard}
        />
      </main>
      )}

      {pendingMove ? (
        <UnsavedChangesDialog
          sectionLabel={label}
          saving={isSaving}
          onStay={() => setPendingMove(null)}
          onDiscard={() => {
            const move = pendingMove;
            setPendingMove(null);
            if (move?.kind === "section") applyMove(move.to, move.focusFieldId);
          }}
          onSave={() => {
            const move = pendingMove;
            save((warning) => {
              setPendingMove(null);
              // Saved with a follow-up warning: stay, so it and Try again are seen.
              if (warning) return;
              if (move?.kind === "section")
                applyMove(move.to, move.focusFieldId);
            });
          }}
        />
      ) : null}
    </div>
  );
}

function RequiredInfoCard({
  projectId,
  stillInIntake,
  canMove,
  showContinue,
  completeness,
  onJump,
}: {
  projectId: string;
  stillInIntake: boolean;
  canMove: boolean;
  showContinue: boolean;
  completeness: CompletenessResult;
  onJump: (section: string, fieldId: string) => void;
}) {
  const { satisfiedCount, totalCount, percent, missing } = completeness;

  return (
    <div className="card intake-required">
      <div className="intake-required-head">
        <h2 className="card-title">Required info</h2>
        <span className="intake-required-count">
          {satisfiedCount} of {totalCount}
        </span>
      </div>

      <div
        className="progress"
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Required intake answers complete"
      >
        <span style={{ width: `${percent}%` }} />
      </div>

      {missing.length === 0 ? (
        <>
          <p className="intake-required-done">Everything required is answered.</p>
          {showContinue ? (
            <ContinueToMockups
              projectId={projectId}
              stillInIntake={stillInIntake}
              canMove={canMove}
              fullWidth
              withArrow={false}
            />
          ) : null}
          <p className="hint">
            You can still edit the intake later. Changes show up in the next
            mockup run.
          </p>
        </>
      ) : (
        <>
          <p className="hint">Still missing:</p>
          <ul className="intake-missing">
            {missing.map((item) => (
              <li key={item.key}>
                <button
                  type="button"
                  className="intake-missing-item"
                  onClick={() => onJump(item.section, item.fieldId)}
                >
                  <span>{item.label}</span>
                  <span className="intake-missing-where">
                    {sectionLabels[item.section as IntakeSectionKey] ??
                      item.section}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function SaveBar({
  label,
  dirty,
  saving,
  savedAt,
  error,
  warning,
  canEdit,
  onSave,
  onDiscard,
}: {
  label: string;
  dirty: boolean;
  saving: boolean;
  savedAt: Date | null;
  error: string | null;
  warning: string | null;
  canEdit: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  if (!canEdit) {
    return (
      <div className="save-bar">
        <span className="save-bar-status">
          You can read this intake but not change it.
        </span>
      </div>
    );
  }

  return (
    <div className={dirty ? "save-bar is-dirty" : "save-bar"}>
      <span
        className={dirty ? "save-bar-status is-dirty" : "save-bar-status"}
        role="status"
      >
        {error ? (
          <span style={{ color: "var(--red)" }}>{error}</span>
        ) : dirty ? (
          `Unsaved changes in ${label}`
        ) : warning ? (
          <span style={{ color: "var(--amber-text)" }}>{warning}</span>
        ) : savedAt ? (
          <>
            <span className="save-dot" aria-hidden="true" />
            Saved just now
          </>
        ) : (
          <>
            <span className="save-dot" aria-hidden="true" />
            No unsaved changes
          </>
        )}
      </span>

      <div className="row" style={{ gap: 8 }}>
        {dirty ? (
          <Button variant="secondary" onClick={onDiscard} disabled={saving}>
            Discard changes
          </Button>
        ) : null}
        <Button variant="primary" onClick={onSave} disabled={(!dirty && !warning) || saving}>
          {/* Nothing to save reads as a state, not as a grayed-out action. */}
          {saving ? "Saving..." : dirty ? `Save ${label}` : warning ? "Try again" : "Saved"}
        </Button>
      </div>
    </div>
  );
}

export function UnsavedChangesDialog({
  sectionLabel,
  saving,
  onSave,
  onDiscard,
  onStay,
}: {
  sectionLabel: string;
  saving: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onStay: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onClick={onStay}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="unsaved-title"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 id="unsaved-title" className="section-title">
          Save your changes to {sectionLabel}?
        </h2>
        <p className="hint">
          You have changes in {sectionLabel} that have not been saved. Leaving
          now without saving discards them.
        </p>

        <div className="modal-actions">
          <Button variant="text" onClick={onStay} disabled={saving}>
            Stay here
          </Button>
          <Button variant="secondary" onClick={onDiscard} disabled={saving}>
            Discard them
          </Button>
          <Button variant="primary" onClick={onSave} disabled={saving}>
            {saving ? "Saving..." : `Save ${sectionLabel}`}
          </Button>
        </div>
      </div>
    </div>
  );
}
