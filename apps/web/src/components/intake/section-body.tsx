"use client";

import { Badge } from "@/components/ui/badge";
import { Banner } from "@/components/ui/banner";
import { Button, ButtonLink } from "@/components/ui/button";
import { ChipsField } from "@/components/ui/chips-field";
import {
  FieldLabel,
  TextAreaField,
  TextField,
  YesNoField,
} from "@/components/ui/field";
import { formatUsPhone, phoneProblem, requirementIds, type CompletenessResult } from "@tawd/core/intake";

/* What the phone field says under it: the problem, or what will be dialled. */
function phoneHint(value: string): { error?: string; hint?: string } {
  const problem = phoneProblem(value);
  if (problem) return { error: problem };
  return value.trim() ? { hint: `Will be shown and dialled as ${formatUsPhone(value.trim())}` } : {};
}
import { SiteReadPanel, type SiteReadPanelView } from "@/components/intake/site-read-panel";
import { describeTierWarning, suggestedServices, type TierWarning } from "@tawd/core/intake";
import { checkTawdFit, describeFitWarning, emptyIntake, specialFeatureKeys, specialFeatureLabels } from "@tawd/core/intake";
import { canEmbed, integrationKindLabels, integrationKinds, integrationProviders, type IntegrationKind } from "@tawd/core/intake";
import type { Trade } from "@tawd/core/enums";
import type { Dma } from "@tawd/core/intake";
import {
  dayNames,
  typeSizes,
  type DayName,
  type IntakeData,
  type IntakeSectionKey,
} from "@tawd/core/intake";
import {
  SERVICE_AREA_SCOPE_LABELS,
  US_STATES,
  describeServiceArea,
  scopeOf,
} from "@tawd/core/intake";
import { ColorPicker } from "@/components/ui/color-picker";
import { BODY_FONTS, FontPicker, HEADING_FONTS } from "@/components/ui/font-picker";
import { LogoDesignPanel } from "@/components/intake/logo-design-panel";
import type { LogoDesignView } from "@/lib/logo-design";
import { LogoColors } from "./logo-colors";
import { WANTED_REFERENCES, photoKind } from "@tawd/core/mockups";
import { BrandGuideSuggestions } from "./brand-guide-suggestions";
import type { BrandGuideView } from "@/lib/brand-guide";
import type { LikedShotView } from "@/lib/liked-sites";
import type { PhotoTextView, ReferenceStudyView } from "@/lib/mockup-inputs";
import { PhotoTextPanel, ReferenceStudyPanel } from "./reference-study";
import { FileUploader, type UploadedFile } from "./uploader";
import { FromSource } from "./from-source";
import { typeChangeLine, type TypeChangeWork } from "@/lib/project-type-words";

/*
  The ten sections, one on screen at a time.

  Every required field carries the word "Required" and, when it is empty,
  turns amber with a line saying where that answer ends up on the finished
  site. That line is the point: a field that only says "Missing" invites
  somebody to type anything to make the color go away.
*/

const dayLabels: Record<string, string> = {
  monday: "Monday",
  tuesday: "Tuesday",
  wednesday: "Wednesday",
  thursday: "Thursday",
  friday: "Friday",
  saturday: "Saturday",
  sunday: "Sunday",
};

export interface SectionBodyProps {
  section: IntakeSectionKey;
  projectId: string;
  values: IntakeData[IntakeSectionKey];
  onChange: (values: IntakeData[IntakeSectionKey]) => void;
  files: UploadedFile[];
  captions: Record<string, string>;
  onCaptionChange: (fileId: string, caption: string) => void;
  completeness: CompletenessResult;
  tierWarning: TierWarning | null;
  /** The project's trade, for the suggested services (no AI). */
  trade?: Trade;
  canEdit: boolean;
  canChangeTier: boolean;
  /** Fields filled from the designer's Figma design and not yet confirmed or corrected, with the text they came from. */
  prefills?: Record<string, { source: string; origin: "design" | "site" }>;
  /** "From the brand guide" suggestions, for the Brand section. */
  brandGuide?: BrandGuideView | null;
  /** "TAWD designs the logo": the design and its options, when the box is ticked and saved. */
  logoDesign?: LogoDesignView | null;
  /** The DMAs an admin loaded from DataForSEO; none hides the DMA choice. */
  dmaOptions?: Dma[];
  /** No unsaved changes in this section. */
  savedClean?: boolean;
  /** Screenshots of "Websites they like", for the Website section. */
  likedShots?: LikedShotView[];
  /** What TAWD read from the reference sites, and their briefs. */
  referenceStudy?: ReferenceStudyView;
  /** The text in the client's photos, checked against the intake. */
  photoText?: PhotoTextView;
  /** A current website is saved: "Keep all content as is" needs one (1 October 2026). */
  hasCurrentWebsite?: boolean;
  /** The project's lane: Lane 2 has no project type. */
  lane?: string;
  /** What a change of project type would affect, and the saved choice (0.100.0). */
  typeWork?: TypeChangeWork | null;
  savedMode?: string | null;
  /** What TAWD read from the current website's home page. */
  currentSite?: SiteReadPanelView | null;
  /** F1: the business email, where form messages go when Website forms lists none. */
  businessEmail?: string;
  serviceCount?: number;
}

function SectionHeading({
  title,
  purpose,
}: {
  title: string;
  purpose: string;
}) {
  return (
    <header className="intake-section-head">
      <h2 className="section-title">{title}</h2>
      <p className="hint">{purpose}</p>
    </header>
  );
}

export function SectionBody(props: SectionBodyProps) {
  // Licensed trades only; legal, med spa, the creative trades and "other" are never asked.
  const licenseApplies = props.completeness.requirements.some((r) => r.key === "business.licenseNumber");
  const isMissing = (key: string) =>
    props.completeness.missing.some((m) => m.key === key);
  const why = (key: string) =>
    props.completeness.requirements.find((r) => r.key === key)?.whyItMatters;

  const filesOfKind = (kind: string) =>
    props.files.filter((file) => file.kind === kind);

  // The "From the design" or "From the current site" mark, on a field TAWD filled until someone confirms or corrects it.
  const fromDesign = (key: string) => {
    const prefill = props.prefills?.[key];
    return prefill ? (
      <FromSource projectId={props.projectId} fieldKey={key} source={prefill.source} origin={prefill.origin} canEdit={props.canEdit} />
    ) : undefined;
  };

  switch (props.section) {
    case "business": {
      const values = props.values as IntakeData["business"];
      const set = (next: Partial<IntakeData["business"]>) =>
        props.onChange({ ...values, ...next });

      const hours =
        values.hours.length === 7
          ? values.hours
          : dayNames.map((day) => ({ day, closed: false, open: "", close: "" }));

      return (
        <>
          <SectionHeading
            title="Business"
            purpose="The facts the website is built on. Anything missing shows as a placeholder on the mockups."
          />

          <div className="field-grid">
            <TextField
              id={requirementIds.businessName}
              label="Business name"
              required
              value={values.name}
              onChange={(name) => set({ name })}
              note={fromDesign("business.name")}
              missing={isMissing("business.name")}
              whyItMatters={why("business.name")}
            />
            <TextField
              id={requirementIds.businessPhone}
              label="Phone"
              type="tel"
              required
              value={values.phone}
              onChange={(phone) => set({ phone })}
              note={fromDesign("business.phone")}
              missing={isMissing("business.phone")}
              whyItMatters={why("business.phone")}
              error={phoneHint(values.phone).error}
              hint={phoneHint(values.phone).hint ?? "A US number. This becomes the tap-to-call link."}
            />
            <TextField
              label="Email"
              type="email"
              value={values.email}
              onChange={(email) => set({ email })}
              note={fromDesign("business.email")}
            />
            <TextField
              label="Legal name"
              value={values.legalName}
              onChange={(legalName) => set({ legalName })}
              hint="As registered (for example Finley Pest Control LLC). For the privacy and cookie policies; the business name is used when blank."
            />
            <TextField
              label="Privacy email"
              type="email"
              value={values.privacyEmail}
              onChange={(privacyEmail) => set({ privacyEmail })}
              hint="Where privacy requests go, named in the policies. The business email is used when blank."
            />
            <TextField
              id={requirementIds.googleBusinessProfile}
              label="Google Business Profile link"
              type="url"
              markerText={values.noGoogleBusinessProfile ? "Not needed" : "Required"}
              required={!values.noGoogleBusinessProfile}
              value={values.googleBusinessProfileUrl}
              onChange={(googleBusinessProfileUrl) =>
                set({ googleBusinessProfileUrl })
              }
              placeholder="https://maps.google.com/..."
              missing={isMissing("business.googleBusinessProfileUrl")}
              whyItMatters={why("business.googleBusinessProfileUrl")}
            />
            <TextField
              id={requirementIds.licenseNumber}
              label="License number"
              markerText={
                !licenseApplies
                  ? "Not needed for this trade"
                  : values.licenseInProgress
                    ? "In progress"
                    : "Required"
              }
              required={licenseApplies && !values.licenseInProgress}
              value={values.licenseNumbers[0] ?? ""}
              onChange={(first) =>
                set({ licenseNumbers: [first, ...values.licenseNumbers.slice(1)] })
              }
              placeholder="CA license number"
              note={fromDesign("business.licenseNumbers")}
              missing={isMissing("business.licenseNumber")}
              whyItMatters={why("business.licenseNumber")}
            />
            <TextField
              id={requirementIds.yearFounded}
              label="Year founded"
              required
              value={values.yearFounded === null ? "" : String(values.yearFounded)}
              onChange={(raw) =>
                set({
                  yearFounded: raw.trim() === "" ? null : Number(raw),
                })
              }
              placeholder="e.g. 2009"
              note={fromDesign("business.yearFounded")}
              missing={isMissing("business.yearFounded")}
              whyItMatters={why("business.yearFounded")}
            />
          </div>

          <div className="checkline-group">
            <label className="checkline">
              <input
                type="checkbox"
                checked={values.noGoogleBusinessProfile}
                onChange={(event) => set({ noGoogleBusinessProfile: event.target.checked })}
              />
              New business, no Google Business Profile yet. The concepts leave the reviews section
              out instead of showing placeholders.
            </label>
            {licenseApplies ? (
              <label className="checkline">
                <input
                  type="checkbox"
                  checked={values.licenseInProgress}
                  onChange={(event) => set({ licenseInProgress: event.target.checked })}
                />
                License in progress: applied for, not issued yet. Design work goes ahead; the
                founders see it at the go-live check.
              </label>
            ) : null}
          </div>

          {values.licenseNumbers.length > 1 ? (
            <div className="field">
              <FieldLabel>Other license numbers</FieldLabel>
              {values.licenseNumbers.slice(1).map((number, index) => (
                <div key={index} className="inline-row">
                  <input
                    className="input"
                    aria-label={`License number ${index + 2}`}
                    value={number}
                    onChange={(event) => {
                      const next = [...values.licenseNumbers];
                      next[index + 1] = event.target.value;
                      set({ licenseNumbers: next });
                    }}
                  />
                  <Button
                    small
                    aria-label={`Remove license number ${index + 2}`}
                    onClick={() =>
                      set({
                        licenseNumbers: values.licenseNumbers.filter(
                          (_, i) => i !== index + 1,
                        ),
                      })
                    }
                  >
                    Remove
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <Button
            small
            onClick={() =>
              set({ licenseNumbers: [...values.licenseNumbers, ""] })
            }
          >
            Add another license number
          </Button>

          <fieldset>
            <legend>
              Address{" "}
              <span className="field-required">
                Required unless service-area business
              </span>
            </legend>

            <label className="checkline" style={{ marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={values.isServiceAreaBusiness}
                onChange={(event) =>
                  set({ isServiceAreaBusiness: event.target.checked })
                }
              />
              Service-area business: hide the street address on the website
            </label>

            <div className="field-grid">
              <TextField
                id={requirementIds.address}
                label="Street address"
                markerText={values.isServiceAreaBusiness ? "Not needed" : "Required"}
                required={!values.isServiceAreaBusiness}
                value={values.streetAddress}
                onChange={(streetAddress) => set({ streetAddress })}
                note={fromDesign("business.streetAddress")}
                missing={isMissing("business.address")}
                whyItMatters={why("business.address")}
              />
              <TextField
                label="City"
                value={values.city}
                onChange={(city) => set({ city })}
                note={fromDesign("business.city")}
              />
              <TextField
                label="State"
                value={values.state}
                onChange={(state) => set({ state })}
                note={fromDesign("business.state")}
              />
            </div>
          </fieldset>

          <fieldset>
            <legend>
              Other locations <span className="field-optional">Optional</span>
            </legend>
            <p className="hint" style={{ marginBottom: 16 }}>
              For a business with more than one office. Each location keeps its own phone number and address,
              so the checks accept them on the site.
            </p>
            {fromDesign("business.locations")}
            {values.locations.map((location, index) => {
              const setLocation = (next: Partial<IntakeData["business"]["locations"][number]>) => {
                const rows = [...values.locations];
                rows[index] = { ...location, ...next };
                set({ locations: rows });
              };
              return (
                <div key={index} className="location-row">
                  <div className="field-grid">
                    <TextField
                      label={`Location ${index + 2} name`}
                      value={location.name}
                      onChange={(name) => setLocation({ name })}
                      placeholder="e.g. Bishop office"
                    />
                    <TextField
                      label="Phone"
                      type="tel"
                      value={location.phone}
                      onChange={(phone) => setLocation({ phone })}
                      error={phoneHint(location.phone).error}
                      hint={phoneHint(location.phone).hint}
                    />
                    <TextField
                      label="Street address"
                      value={location.streetAddress}
                      onChange={(streetAddress) => setLocation({ streetAddress })}
                    />
                    <TextField label="City" value={location.city} onChange={(city) => setLocation({ city })} />
                    <TextField label="State" value={location.state} onChange={(state) => setLocation({ state })} />
                  </div>
                  <Button
                    small
                    aria-label={`Remove location ${index + 2}`}
                    onClick={() => set({ locations: values.locations.filter((_, i) => i !== index) })}
                  >
                    Remove this location
                  </Button>
                </div>
              );
            })}
            <Button
              small
              onClick={() =>
                set({ locations: [...values.locations, { name: "", phone: "", streetAddress: "", city: "", state: "" }] })
              }
            >
              Add another location
            </Button>
          </fieldset>

          <fieldset>
            <legend>
              Business hours <span className="field-optional">Optional</span>
            </legend>

            <label className="checkline" style={{ marginBottom: 16 }}>
              <input
                type="checkbox"
                checked={values.emergency247 === true}
                onChange={(event) =>
                  set({ emergency247: event.target.checked ? true : null })
                }
              />
              24/7 emergency service available
            </label>

            <div className="hours-grid">
              <span className="hours-head">Day</span>
              <span className="hours-head">Opens</span>
              <span className="hours-head">Closes</span>
              <span className="hours-head">Closed</span>

              {hours.map((row, index) => (
                <HoursRow
                  key={row.day}
                  row={row}
                  label={dayLabels[row.day] ?? row.day}
                  onChange={(next) => {
                    const updated = [...hours];
                    updated[index] = next;
                    set({ hours: updated });
                  }}
                />
              ))}
            </div>
          </fieldset>

          <TextField
            label="Certifications and memberships"
            value={values.certifications.join(", ")}
            onChange={(raw) =>
              set({
                certifications: raw
                  .split(",")
                  .map((item) => item.trim())
                  .filter(Boolean),
              })
            }
            placeholder="e.g. BBB accredited, licensed and insured"
            hint="Separate with commas. Only what the client can prove."
          />
        </>
      );
    }

    case "website": {
      const values = props.values as IntakeData["website"];
      const set = (next: Partial<IntakeData["website"]>) =>
        props.onChange({ ...values, ...next });

      const liked = [0, 1, 2].map((i) => values.likedWebsites[i] ?? "");

      return (
        <>
          <SectionHeading
            title="Website"
            purpose="The domain, the current site, and sites the client likes."
          />

          <div className="field">
            <FieldLabel>Does the client have a domain?</FieldLabel>
            <div className="row" style={{ gap: 20 }}>
              <label className="checkline">
                <input
                  type="radio"
                  name="domainStatus"
                  checked={values.domainStatus === "client_has"}
                  onChange={() => set({ domainStatus: "client_has" })}
                />
                Yes, they have one
              </label>
              <label className="checkline">
                <input
                  type="radio"
                  name="domainStatus"
                  checked={values.domainStatus === "vml_buys"}
                  onChange={() => set({ domainStatus: "vml_buys" })}
                />
                No, VML buys it (add-on)
              </label>
            </div>
          </div>

          <div className="field-grid">
            <TextField
              label="Domain"
              value={values.domainName}
              onChange={(domainName) => set({ domainName })}
              placeholder="example.com"
              hint="Check for existing email on this domain before switching DNS."
            />
            {/* Required, or "No current website available" (Jason, 30 September 2026): the one item that blocks Design and Generate. */}
            <TextField
              id={requirementIds.currentWebsite}
              label="Current website"
              type="url"
              required
              disabled={values.noCurrentWebsite === true}
              value={values.currentWebsiteUrl}
              onChange={(currentWebsiteUrl) => set({ currentWebsiteUrl })}
              placeholder="https://"
              missing={isMissing("website.current")}
              whyItMatters={why("website.current")}
              note={
                <label className="checkline">
                  <input type="checkbox" checked={values.noCurrentWebsite === true} disabled={!props.canEdit} onChange={(e) => set({ noCurrentWebsite: e.target.checked })} />
                  No current website available
                </label>
              }
            />
          </div>

          {props.currentSite && values.noCurrentWebsite !== true && props.currentSite.url === values.currentWebsiteUrl.trim() ? (
            <SiteReadPanel projectId={props.projectId} view={props.currentSite} canEdit={props.canEdit} />
          ) : null}
          {props.lane !== "lane_2" && values.noCurrentWebsite !== true && values.currentWebsiteUrl.trim() ? (
            <p className="hint">Next: choose the project type (Design only, Design + content, Everything new) in the Content section.</p>
          ) : null}

          {liked.filter((u) => u.trim()).length < WANTED_REFERENCES ? (
            <div style={{ marginBottom: 16 }}>
              <Banner tone="warning" title="Ask for 2 to 3 reference sites">
                {liked.filter((u) => u.trim()).length === 0 ? "None yet" : "Only 1 so far"}. Without them the mockups will be weaker: the sites the client likes set the bar and give a proven structure. TAWD studies each one&rsquo;s structure and craft, never its name, words, logo or photos.
              </Banner>
            </div>
          ) : null}

          <div className="field">
            <FieldLabel markerText="2 to 3">Reference sites (websites they like)</FieldLabel>
            {liked.map((value, index) => (
              <div key={index} className="liked-site-entry">
                <input
                  className="input"
                  aria-label={`Website they like ${index + 1}`}
                  placeholder="https://"
                  value={value}
                  onChange={(event) => {
                    const next = [...liked];
                    next[index] = event.target.value;
                    // The note follows its site when the address is edited.
                    const notes = { ...(values.likedWebsiteNotes ?? {}) };
                    const note = notes[value.trim()];
                    delete notes[value.trim()];
                    if (note && event.target.value.trim()) notes[event.target.value.trim()] = note;
                    set({ likedWebsites: next.filter(Boolean), likedWebsiteNotes: notes });
                  }}
                />
                {value.trim() ? (
                  <textarea
                    className="textarea"
                    rows={2}
                    aria-label={`What they like about website ${index + 1}`}
                    placeholder="What do they like about it? For example: the big photo at the top, the clean service cards, how calm it feels."
                    value={values.likedWebsiteNotes?.[value.trim()] ?? ""}
                    maxLength={600}
                    onChange={(event) => set({ likedWebsiteNotes: { ...(values.likedWebsiteNotes ?? {}), [value.trim()]: event.target.value } })}
                  />
                ) : null}
              </div>
            ))}
            <p className="hint">
              Ask what they like about each one and write it under the site: the concepts follow it first, ahead of
              the direction&rsquo;s own choices (the house rules, the brand and an approved wireframe still come first).
              Once saved, TAWD takes desktop screenshots of each and reads its structure (the order of its sections,
              the hero, the trust signals, how services are laid out). The mockups follow that structure and craft,
              never another company&rsquo;s identity.
            </p>
            {props.likedShots && props.likedShots.length > 0 ? (
              <div className="liked-shots">
                {props.likedShots.map((shot) => (
                  <figure key={shot.url} className="liked-shot">
                    {shot.status === "done" && shot.imageUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
                      <img src={shot.imageUrl} alt={`First screen of ${shot.url}`} />
                    ) : (
                      <div className={shot.status === "failed" ? "liked-shot-empty is-failed" : "liked-shot-empty"}>
                        {shot.status === "failed" ? shot.failureReason ?? "Couldn’t be opened." : "Taking the screenshot..."}
                      </div>
                    )}
                    <figcaption>{shot.url.replace(/^https?:\/\//, "")}</figcaption>
                  </figure>
                ))}
              </div>
            ) : null}
            {props.referenceStudy ? <ReferenceStudyPanel projectId={props.projectId} view={props.referenceStudy} canEdit={props.canEdit} /> : null}
          </div>
        </>
      );
    }

    case "services": {
      const values = props.values as IntakeData["services"];
      const set = (next: Partial<IntakeData["services"]>) =>
        props.onChange({ ...values, ...next });

      return (
        <>
          <SectionHeading
            title="Services"
            purpose="One row per service. Mark the one the business wants most calls for."
          />
          {fromDesign("services.items")}

          {props.tierWarning ? (
            <Banner
              title="This project needs the Growth tier"
              action={
                props.canChangeTier ? (
                  <ButtonLink
                    href={`/projects/${props.projectId}/edit`}
                    variant="secondary"
                    small
                  >
                    Change tier
                  </ButtonLink>
                ) : undefined
              }
            >
              {describeTierWarning(props.tierWarning)}
            </Banner>
          ) : null}

          {isMissing("services.atLeastOne") ? (
            <p className="hint-missing">{why("services.atLeastOne")}</p>
          ) : null}

          {values.items.length > 0 ? (
            <div className="services-grid">
              <span className="hours-head">Main</span>
              <span className="hours-head">Service</span>
              <span className="hours-head">Short description</span>
              <span />

              {values.items.map((item, index) => (
                <ServiceRow
                  key={item.id}
                  item={item}
                  isMain={values.mainServiceId === item.id}
                  isFirst={index === 0}
                  onMain={() => set({ mainServiceId: item.id })}
                  onChange={(next) => {
                    const items = [...values.items];
                    items[index] = next;
                    set({ items });
                  }}
                  onRemove={() =>
                    set({
                      items: values.items.filter((_, i) => i !== index),
                      mainServiceId:
                        values.mainServiceId === item.id
                          ? null
                          : values.mainServiceId,
                    })
                  }
                />
              ))}
            </div>
          ) : (
            <p className="empty" style={{ padding: "16px 0" }}>
              No services yet.
            </p>
          )}

          {props.trade && props.canEdit && suggestedServices(props.trade, values.items.map((i) => i.name)).length > 0 ? (
            <div className="service-suggestions">
              <p className="hint">Common for this trade, one click to add (only what the client offers):</p>
              <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
                {suggestedServices(props.trade, values.items.map((i) => i.name)).map((name) => (
                  <button
                    key={name}
                    type="button"
                    className="chip chip-add"
                    onClick={() =>
                      set({
                        // An empty row left by "Add a service" is filled first.
                        items: values.items.some((i) => !i.name.trim())
                          ? values.items.map((i, n) => (n === values.items.findIndex((x) => !x.name.trim()) ? { ...i, name } : i))
                          : [...values.items, { id: `s-${Date.now()}-${values.items.length}`, name, description: "" }],
                      })
                    }
                  >
                    <span aria-hidden="true">+</span> {name}
                  </button>
                ))}
              </div>
            </div>
          ) : null}

          <div>
            <Button
              variant="secondary"
              onClick={() =>
                set({
                  items: [
                    ...values.items,
                    {
                      id: `s-${Date.now()}-${values.items.length}`,
                      name: "",
                      description: "",
                    },
                  ],
                })
              }
            >
              Add a service
            </Button>
          </div>
        </>
      );
    }

    case "serviceAreas": {
      const values = props.values as IntakeData["serviceAreas"];
      const set = (next: Partial<IntakeData["serviceAreas"]>) =>
        props.onChange({ ...values, ...next });
      const scope = scopeOf(values);
      const summary = describeServiceArea(values);

      return (
        <>
          <SectionHeading
            title="Service areas"
            purpose="Where the business works. It becomes the service-area section and the local SEO."
          />
          {fromDesign("serviceAreas.cities")}

          {isMissing("serviceAreas.atLeastOne") ? (
            <p className="hint-missing">{why("serviceAreas.atLeastOne")}</p>
          ) : null}

          <div className="choice-cards" role="radiogroup" aria-label="How far the business works">
            <ChoiceCard
              selected={scope === "cities"}
              title={SERVICE_AREA_SCOPE_LABELS.cities}
              description="A list of the cities or towns, each named on the site."
              onSelect={() => set({ scope: "cities" })}
            />
            <ChoiceCard
              selected={scope === "counties"}
              title={SERVICE_AREA_SCOPE_LABELS.counties}
              description={'A list of counties, each named on the site: "Washoe County, NV".'}
              onSelect={() => set({ scope: "counties" })}
            />
            <ChoiceCard
              selected={scope === "states"}
              title={SERVICE_AREA_SCOPE_LABELS.states}
              description={'Every town in one or more states: "Serving all of Nevada".'}
              onSelect={() => set({ scope: "states" })}
            />
            {(props.dmaOptions?.length ?? 0) > 0 || scope === "dmas" ? (
            <ChoiceCard
              selected={scope === "dmas"}
              title={SERVICE_AREA_SCOPE_LABELS.dmas}
              description="One or more TV and ad markets, for example the Reno market."
              onSelect={() => set({ scope: "dmas" })}
            />
            ) : null}
            <ChoiceCard
              selected={scope === "nationwide"}
              title={SERVICE_AREA_SCOPE_LABELS.nationwide}
              description="Customers anywhere in the country."
              onSelect={() => set({ scope: "nationwide" })}
            />
            <ChoiceCard
              selected={scope === "radius"}
              title={SERVICE_AREA_SCOPE_LABELS.radius}
              description="Everywhere within so many miles of the office, for example 50 miles."
              onSelect={() => set({ scope: "radius" })}
            />
          </div>

          {scope === "cities" ? (
            <>
              {values.cities.length > 0 ? (
                <div className="row" style={{ gap: 8 }}>
                  {values.cities.map((city, index) => (
                    <span key={`${city}-${index}`} className="chip">
                      {city}
                      <button
                        type="button"
                        className="chip-remove"
                        aria-label={`Remove ${city}`}
                        onClick={() =>
                          set({ cities: values.cities.filter((_, i) => i !== index) })
                        }
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}

              <CityAdder
                onAdd={(city) => set({ cities: [...values.cities, city] })}
              />

              <label className="checkline intake-choice">
                <input
                  type="checkbox"
                  checked={values.wantsIndividualCityPages === true}
                  onChange={(event) =>
                    set({
                      wantsIndividualCityPages: event.target.checked ? true : false,
                    })
                  }
                />
                <span>
                  <span style={{ fontWeight: 600 }}>Wants individual city pages</span>
                  <br />
                  <span className="hint">
                    Each city page needs genuinely local content. This moves the
                    project to at least the Growth tier.
                  </span>
                </span>
              </label>
            </>
          ) : null}

          {scope === "counties" ? (
            <>
              {values.counties.length > 0 ? (
                <div className="row" style={{ gap: 8 }}>
                  {values.counties.map((county, index) => (
                    <span key={`${county}-${index}`} className="chip">
                      {county}
                      <button
                        type="button"
                        className="chip-remove"
                        aria-label={`Remove ${county}`}
                        onClick={() => set({ counties: values.counties.filter((_, i) => i !== index) })}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <CityAdder label="county" placeholder="Add a county with its state, e.g. Washoe County, NV, then press Enter" onAdd={(county) => set({ counties: [...values.counties, county] })} />
              <label className="checkline intake-choice">
                <input
                  type="checkbox"
                  checked={values.wantsIndividualCityPages === true}
                  onChange={(event) => set({ wantsIndividualCityPages: event.target.checked ? true : false })}
                />
                <span>
                  <span style={{ fontWeight: 600 }}>Wants individual county pages</span>
                  <br />
                  <span className="hint">Each county page needs genuinely local content. Like city pages, this moves the project to at least the Growth tier.</span>
                </span>
              </label>
            </>
          ) : null}

          {scope === "dmas" ? (
            <div className="field">
              <FieldLabel htmlFor={requirementIds.serviceAreas} required>
                TV and ad markets (DMAs)
              </FieldLabel>
              {values.dmas.length > 0 ? (
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  {values.dmas.map((dma) => (
                    <span key={dma.id} className="chip">
                      {dma.name}
                      <button type="button" className="chip-remove" aria-label={`Remove ${dma.name}`} onClick={() => set({ dmas: values.dmas.filter((d) => d.id !== dma.id) })}>
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              {props.dmaOptions?.length ? (
                <select
                  id={requirementIds.serviceAreas}
                  className="input"
                  value=""
                  onChange={(event) => {
                    const dma = props.dmaOptions?.find((d) => d.id === event.target.value);
                    if (dma && !values.dmas.some((d) => d.id === dma.id)) set({ dmas: [...values.dmas, dma] });
                  }}
                >
                  <option value="">Add a market...</option>
                  {props.dmaOptions.filter((d) => !values.dmas.some((v) => v.id === d.id)).map((d) => (
                    <option key={d.id} value={d.id}>
                      {d.name}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="hint-missing">The list of markets isn&rsquo;t loaded in TAWD any more. Choose counties or cities instead.</p>
              )}
            </div>
          ) : null}

          {scope === "states" ? (
            <div className="field">
              <FieldLabel htmlFor={requirementIds.serviceAreas} required>
                States
              </FieldLabel>
              {values.states.length > 0 ? (
                <div className="row" style={{ gap: 8, marginBottom: 8 }}>
                  {values.states.map((code) => (
                    <span key={code} className="chip">
                      {US_STATES.find(([c]) => c === code)?.[1] ?? code}
                      <button
                        type="button"
                        className="chip-remove"
                        aria-label={`Remove ${US_STATES.find(([c]) => c === code)?.[1] ?? code}`}
                        onClick={() => set({ states: values.states.filter((c) => c !== code) })}
                      >
                        &times;
                      </button>
                    </span>
                  ))}
                </div>
              ) : null}
              <select
                id={requirementIds.serviceAreas}
                className="input"
                value=""
                onChange={(event) => {
                  const code = event.target.value as (typeof values.states)[number];
                  if (code && !values.states.includes(code)) set({ states: [...values.states, code] });
                }}
              >
                <option value="">Add a state...</option>
                {US_STATES.filter(([code]) => !values.states.includes(code)).map(([code, name]) => (
                  <option key={code} value={code}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          ) : null}

          {scope === "radius" ? (
            <div className="field-grid">
              <TextField
                id={requirementIds.serviceAreas}
                label="Miles around the address"
                required
                value={values.radius.miles === null ? "" : String(values.radius.miles)}
                onChange={(raw) => {
                  const digits = raw.replace(/\D/g, "");
                  set({ radius: { ...values.radius, miles: digits === "" ? null : Number(digits) } });
                }}
                placeholder="e.g. 50"
              />
              <TextField
                label="From this address"
                required
                value={values.radius.address}
                onChange={(address) => set({ radius: { ...values.radius, address } })}
                placeholder="Usually the office, e.g. 4105 Kietzke Ln, Reno, NV"
              />
            </div>
          ) : null}

          {summary ? (
            <p className="hint">
              The site will say: <strong>{scope === "nationwide" ? "Serving customers nationwide" : scope === "cities" || scope === "counties" ? `Serving ${summary}` : `Serving ${summary.charAt(0).toLowerCase()}${summary.slice(1)}`}</strong>
              {scope !== "cities" && scope !== "counties" ? ". No city pages: only a list of cities or counties can have a page each." : null}
            </p>
          ) : null}
        </>
      );
    }

    case "brand": {
      const values = props.values as IntakeData["brand"];
      const set = (next: Partial<IntakeData["brand"]>) =>
        props.onChange({ ...values, ...next });

      const setColorAt = (index: number, color: string) => {
        const colors = [...values.colors];
        while (colors.length <= index) colors.push("");
        colors[index] = color;
        // A colour the PM sets by hand is theirs, not the logo's.
        set({ colors, colorsFromLogo: false });
      };

      const otherColors = values.colors.slice(2).filter(Boolean);

      return (
        <>
          <SectionHeading
            title="Brand"
            purpose="If the client has brand colors and fonts, every concept uses them. Uploads save the moment they finish."
          />

          <FileUploader
            projectId={props.projectId}
            kind="logo"
            label="Logo"
            required
            canEdit={props.canEdit}
            files={filesOfKind("logo")}
            missingHint={
              isMissing("brand.logo") ? why("brand.logo") : undefined
            }
            dropLabel="Drop a logo or choose a file"
            anchorId={requirementIds.logo}
          />

          <label className="checkline">
            <input
              type="checkbox"
              checked={values.tawdDesignsLogo}
              disabled={!props.canEdit}
              onChange={(event) => set({ tawdDesignsLogo: event.target.checked })}
            />
            Client has no logo: TAWD designs one
          </label>
          {values.tawdDesignsLogo ? (
            props.logoDesign ? (
              <LogoDesignPanel projectId={props.projectId} canEdit={props.canEdit} view={props.logoDesign} saved={Boolean(props.savedClean)} />
            ) : (
              <p className="hint">A paid add-on, added to the project&rsquo;s price when you save. Then design the logo here.</p>
            )
          ) : null}

          <FileUploader
            projectId={props.projectId}
            kind="brand_guide"
            label="Brand guide"
            canEdit={props.canEdit}
            files={filesOfKind("brand_guide")}
            dropLabel="Drop a PDF or choose a file"
          />

          <div className="field-grid">
            <ColorPicker
              label="Primary color"
              value={values.colors[0] ?? ""}
              onChange={(color) => setColorAt(0, color)}
            />
            <ColorPicker
              label="Accent color"
              value={values.colors[1] ?? ""}
              onChange={(color) => setColorAt(1, color)}
              placeholder="#C8551B"
            />
          </div>

          {props.brandGuide ? (
            <BrandGuideSuggestions
              projectId={props.projectId}
              view={props.brandGuide}
              canEdit={props.canEdit}
              onUseColor={(hex) => {
                // Never replaces a colour the PM typed: Primary if empty, then Accent, then with the others.
                if (values.colors.some((c) => c.toUpperCase() === hex)) return;
                if (!values.colors[0]) setColorAt(0, hex);
                else if (!values.colors[1]) setColorAt(1, hex);
                else set({ colors: [...values.colors, hex] });
              }}
              onUseFont={(name) => {
                // Headings first, then body text; never in place of a font the PM chose.
                if ([values.headingFont, values.bodyFont].some((f) => f.toLowerCase() === name.toLowerCase())) return;
                if (!values.headingFont) set({ headingFont: name });
                else if (!values.bodyFont) set({ bodyFont: name });
              }}
            />
          ) : null}

          <LogoColors
            projectId={props.projectId}
            logoIds={filesOfKind("logo").map((file) => file.id)}
            used={values.colors}
            canEdit={props.canEdit}
            fromLogo={values.colorsFromLogo}
            onAutoFill={(hexes) => set({ colors: hexes, colorsFromLogo: true })}
            onPick={(hex) => {
              // Primary first, then Accent, then with the others.
              if (!values.colors[0]) setColorAt(0, hex);
              else if (!values.colors[1]) setColorAt(1, hex);
              else set({ colors: [...values.colors, hex] });
            }}
          />

          {otherColors.length > 0 ? (
            <div className="field">
              <FieldLabel>Other brand colors</FieldLabel>
              <p className="hint">
                Already on file for this client. Kept so nothing is lost.
              </p>
              <div className="row" style={{ gap: 8 }}>
                {otherColors.map((color, index) => (
                  <span key={`${color}-${index}`} className="chip">
                    <span
                      className="color-dot"
                      style={{ background: color }}
                      aria-hidden="true"
                    />
                    {color}
                    <button
                      type="button"
                      className="chip-remove"
                      aria-label={`Remove ${color}`}
                      onClick={() =>
                        set({
                          colors: values.colors.filter(
                            (_, i) => i !== index + 2,
                          ),
                        })
                      }
                    >
                      &times;
                    </button>
                  </span>
                ))}
              </div>
            </div>
          ) : null}

          <div className="field-grid">
            <FontPicker label="Headings font" value={values.headingFont} fonts={HEADING_FONTS} onChange={(headingFont) => set({ headingFont })} disabled={!props.canEdit} />
            <FontPicker label="Body text font" value={values.bodyFont} fonts={BODY_FONTS} onChange={(bodyFont) => set({ bodyFont })} disabled={!props.canEdit} />
          </div>
          {values.fonts ? (
            // An older note of the fonts, from before the two pickers: kept so nothing is lost.
            <TextField label="Fonts (earlier note)" value={values.fonts} onChange={(fonts) => set({ fonts })} />
          ) : null}

          <div className="field-grid">
            <div className="field">
              <FieldLabel>Type size</FieldLabel>
              <div className="segmented">
                {typeSizes.map((size) => (
                  <button
                    key={size}
                    type="button"
                    className="segment"
                    aria-pressed={values.typeSize === size}
                    onClick={() =>
                      set({ typeSize: values.typeSize === size ? null : size })
                    }
                  >
                    {size.charAt(0).toUpperCase() + size.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="field-grid">
            <ChipsField
              label="Mood words"
              values={values.moodWords}
              onChange={(moodWords) => set({ moodWords })}
              placeholder="honest, fast, local"
              hint="Three or four words the client uses about themselves."
              max={8}
            />
            <ChipsField
              label="Competitors to avoid looking like"
              values={values.competitorsToAvoid}
              onChange={(competitorsToAvoid) => set({ competitorsToAvoid })}
              placeholder="Names or websites"
              hint="Business names or web addresses."
            />
          </div>
        </>
      );
    }

    case "photos": {
      const values = props.values as IntakeData["photos"];
      const photos = filesOfKind("photo");

      return (
        <>
          <SectionHeading
            title="Photos"
            purpose="Real photos of the team, vehicles and finished jobs. Never stock images of the client's staff. Uploads save the moment they finish; captions save with the section."
          />

          <p className="hint-missing" style={{ marginBottom: 16 }}>
            <strong>
              Only upload photos of this client&apos;s own team, vehicles and
              work.
            </strong>{" "}
            Every uploaded photo can appear on the mockup, and the site must not
            pass off anyone else&apos;s work as theirs.
          </p>

          {photos.length === 0 ? (
            <div style={{ marginBottom: 16 }}>
              <Banner tone="warning" title="Real photos matter most">
                No photos yet, so the mockups will be weaker: placeholder frames always look like a wireframe. Ask for a photo of the team (or the owner at a job) and 3 to 5 photos of real jobs, vans or premises.
              </Banner>
            </div>
          ) : !photos.some((photo) => photoKind(props.captions[photo.id] ?? photo.caption, photo.fileName) === "people") ? (
            <p className="hint hint-amber" style={{ marginBottom: 16 }}>
              No team photo yet. A real photo of the team makes the strongest hero; caption it &ldquo;team&rdquo; when it arrives.
            </p>
          ) : null}

          <FileUploader
            projectId={props.projectId}
            kind="photo"
            label="Photos"
            canEdit={props.canEdit}
            files={[]}
            dropLabel="Drop photos here or choose files"
            hideList
          />

          {photos.length > 0 ? (
            <div className="photo-grid">
              {photos.map((photo) => (
                <PhotoCard
                  key={photo.id}
                  photo={photo}
                  caption={props.captions[photo.id] ?? ""}
                  canEdit={props.canEdit}
                  projectId={props.projectId}
                  onCaption={(caption) => props.onCaptionChange(photo.id, caption)}
                />
              ))}
            </div>
          ) : null}

          {props.photoText ? <PhotoTextPanel projectId={props.projectId} view={props.photoText} photoCount={photos.length} canEdit={props.canEdit} /> : null}

          <TextAreaField
            label="Notes for the designer"
            value={values.notes}
            onChange={(notes) => props.onChange({ ...values, notes })}
            placeholder="For example, which photos the client is proudest of."
          />

          <div className="checkline-group">
            <label className="checkline">
              <input
                type="checkbox"
                checked={values.beforeAfterPermission}
                onChange={(event) => props.onChange({ ...values, beforeAfterPermission: event.target.checked })}
              />
              The client gave permission to show before-and-after photos. Without it, photos captioned
              &ldquo;before&rdquo; or &ldquo;after&rdquo; never reach a mockup or the site. Saved with your name and the time.
            </label>
          </div>
          {values.beforeAfterPermission ? (
            <TextAreaField
              label="How the client gave permission"
              value={values.beforeAfterPermissionNote}
              onChange={(beforeAfterPermissionNote) => props.onChange({ ...values, beforeAfterPermissionNote })}
              placeholder="For example: email from the owner, 26 September, covering the photos of the kitchen job."
            />
          ) : null}
        </>
      );
    }

    case "content": {
      const values = props.values as IntakeData["content"];
      const set = (next: Partial<IntakeData["content"]>) =>
        props.onChange({ ...values, ...next });

      return (
        <>
          <SectionHeading
            title="Content"
            purpose="Where the words come from. The content team reviews everything before the build, whichever is chosen."
          />

          {props.lane === "lane_2" ? (
            <p className="hint">Lane 2: the words come from the client&rsquo;s design.</p>
          ) : props.hasCurrentWebsite ? (
            <>
              {/* The project type (Jason, 6 October 2026, locked names; 0.100.0): one choice when there's a current website. */}
              <div className="field">
              <FieldLabel required>Project type</FieldLabel>
              <div id={requirementIds.projectType} className="choice-cards">
                <ChoiceCard
                  selected={values.mode === "keep"}
                  title="Design only"
                  description="The current site's pages and words, kept exactly, in a new design. No Content step: the words are the client's own, checked word for word after the build. TAWD suggests SEO fixes for the team. The cheapest: no writing."
                  onSelect={() => set({ mode: "keep" })}
                />
                <ChoiceCard
                  selected={values.mode === "improve"}
                  title="Design + content"
                  description="The same pages, in a new design, with their words improved by TAWD from the current site's (Home page first, the cost shown first). The concepts are designed from the current words (or the improved Home page, once it's approved)."
                  onSelect={() => set({ mode: "improve" })}
                />
                <ChoiceCard
                  selected={values.mode === "auto"}
                  title="Everything new"
                  description="New structure and words: TAWD writes every page from the intake, starting from the current site's words. Full on-page SEO."
                  onSelect={() => set({ mode: "auto" })}
                />
                <ChoiceCard
                  selected={values.mode === "manual"}
                  title="The client is sending their own words"
                  description="Their documents or pasted copy (below). TAWD only suggests SEO fixes."
                  onSelect={() => set({ mode: "manual" })}
                />
              </div>
              {isMissing("content.projectType") ? <p className="hint-missing">{why("content.projectType")}</p> : null}
              {props.savedMode && values.mode !== props.savedMode && props.typeWork ? (
                <p className="hint hint-amber">{typeChangeLine(props.typeWork, values.mode)}</p>
              ) : null}
              </div>
              {values.mode === "keep" || values.mode === "improve" ? (
                <p className="hint">
                  TAWD reads every page of the current site by code (free, up to the tier&rsquo;s page limit, blog articles on top)
                  and keeps each page&rsquo;s own words. The page plan makes itself from them, at the same addresses, as soon as the
                  read is done, and the SEO team gets TAWD&rsquo;s suggestions.
                  {values.mode === "keep"
                    ? " The new site keeps the words exactly, in a new design."
                    : " On Content, TAWD improves the words page by page (Home first); the team compares and approves each page."}
                </p>
              ) : null}
            </>
          ) : (
            <div className="choice-cards">
              <ChoiceCard
                selected={values.mode === "auto" || values.mode === null || values.mode === "keep" || values.mode === "improve"}
                title="Everything new"
                description="TAWD writes every page from the intake. Full on-page SEO."
                onSelect={() => set({ mode: "auto" })}
              />
              <ChoiceCard
                selected={values.mode === "manual"}
                title="The client is sending their own words"
                description="Their documents or pasted copy (below). TAWD only suggests SEO fixes."
                onSelect={() => set({ mode: "manual" })}
              />
            </div>
          )}

          <TextAreaField
            label="Tone of voice"
            value={values.toneOfVoice}
            onChange={(toneOfVoice) => set({ toneOfVoice })}
            rows={2}
            placeholder="Straight-talking, friendly, premium..."
          />

          {values.mode === "manual" ? (
            <>
              <TextAreaField
                label="Copy supplied by the client"
                value={values.suppliedCopy}
                onChange={(suppliedCopy) => set({ suppliedCopy })}
                rows={10}
                placeholder="Paste it here, or upload it as a document below."
              />

              <FileUploader
                projectId={props.projectId}
                kind="content_document"
                label="Content documents"
                canEdit={props.canEdit}
                files={filesOfKind("content_document")}
                dropLabel="Drop documents here or choose files"
              />
            </>
          ) : null}
        </>
      );
    }

    case "forms": {
      const values = props.values as IntakeData["forms"];
      const set = (next: Partial<IntakeData["forms"]>) => props.onChange({ ...values, ...next });
      return (
        <>
          <SectionHeading
            title="Website forms"
            purpose="What the site's forms ask, and who gets the messages. Nothing set: Name, Phone, Email and Message, sent to the business email."
          />
          <FormRecipientsField values={values} onChange={set} businessEmail={props.businessEmail ?? ""} />
          <FormFieldsField values={values} onChange={set} serviceCount={props.serviceCount ?? 0} />
          <YesNoField
            label="Request a quote form"
            value={values.quoteForm}
            onChange={(quoteForm) => set({ quoteForm })}
            hint="Yes: the Contact page's form becomes Request a quote, with every field above; the forms on other pages stay short (Name, Phone, Email if ticked, Message)."
          />
          <TextAreaField
            label="Thank-you line"
            markerText="Optional"
            value={values.thankYouLine}
            onChange={(thankYouLine) => set({ thankYouLine })}
            hint='The line under "Thanks, we got your message" on the thank-you page.'
          />
          <p className="hint">Booking links (Calendly, Housecall Pro, Jobber…) are under Extras, Online tools.</p>
        </>
      );
    }

    case "process": {
      const values = props.values as IntakeData["process"];
      const set = (next: Partial<IntakeData["process"]>) =>
        props.onChange({ ...values, ...next });

      return (
        <>
          <SectionHeading
            title="Process"
            purpose="Only what the client actually does. These answers feed the 'what happens when you call' section."
          />

          <TextAreaField
            label="How are visits scheduled?"
            value={values.scheduling}
            onChange={(scheduling) => set({ scheduling })}
          />
          <TextAreaField
            label="How do quotes and pricing work?"
            value={values.quotingAndPricing}
            onChange={(quotingAndPricing) => set({ quotingAndPricing })}
          />
          <TextAreaField
            label="Guarantees or warranties"
            markerText="Only if offered"
            value={values.guarantees}
            onChange={(guarantees) => set({ guarantees })}
            hint="A guarantee invented here would end up on a live website."
          />
          {fromDesign("process.guarantees")}
        </>
      );
    }

    case "extras": {
      const values = props.values as IntakeData["extras"];
      const set = (next: Partial<IntakeData["extras"]>) =>
        props.onChange({ ...values, ...next });

      return (
        <>
          <SectionHeading
            title="Extras"
            purpose="Offers and financing, the client's online tools (booking, shop, portal, reviews), and anything special they asked for."
          />

          <TextAreaField
            label="Current offers or specials"
            value={values.currentOffers}
            onChange={(currentOffers) => set({ currentOffers })}
          />
          {fromDesign("extras.currentOffers")}
          <YesNoField
            label="Financing available"
            value={values.financingAvailable}
            onChange={(financingAvailable) => set({ financingAvailable })}
          />
          {fromDesign("extras.financingAvailable")}

          <IntegrationsField values={values} onChange={set} />

          <SpecialFeaturesField values={values} onChange={set} />
        </>
      );
    }
  }
}

interface HoursValue {
  day: DayName;
  closed: boolean;
  open: string;
  close: string;
}

function HoursRow({
  row,
  label,
  onChange,
}: {
  row: HoursValue;
  label: string;
  onChange: (next: HoursValue) => void;
}) {
  return (
    <>
      <span className="hours-day">{label}</span>
      <input
        className="input"
        aria-label={`${label} opens`}
        placeholder="7:00 AM"
        disabled={row.closed}
        value={row.open}
        onChange={(event) => onChange({ ...row, open: event.target.value })}
      />
      <input
        className="input"
        aria-label={`${label} closes`}
        placeholder="6:00 PM"
        disabled={row.closed}
        value={row.close}
        onChange={(event) => onChange({ ...row, close: event.target.value })}
      />
      <input
        type="checkbox"
        aria-label={`${label} closed`}
        checked={row.closed}
        onChange={(event) => onChange({ ...row, closed: event.target.checked })}
        style={{ width: 18, height: 18, accentColor: "var(--blue)" }}
      />
    </>
  );
}

function ServiceRow({
  item,
  isMain,
  isFirst,
  onMain,
  onChange,
  onRemove,
}: {
  item: { id: string; name: string; description: string };
  isMain: boolean;
  isFirst: boolean;
  onMain: () => void;
  onChange: (next: { id: string; name: string; description: string }) => void;
  onRemove: () => void;
}) {
  const describedName = item.name || "this service";

  return (
    <>
      <input
        type="radio"
        name="mainService"
        aria-label={`Make ${describedName} the main service`}
        checked={isMain}
        onChange={onMain}
        style={{ width: 18, height: 18, accentColor: "var(--blue)" }}
      />
      <input
        className="input"
        aria-label={isFirst ? "Service name" : `Service name for ${describedName}`}
        id={isFirst ? requirementIds.services : undefined}
        value={item.name}
        onChange={(event) => onChange({ ...item, name: event.target.value })}
      />
      <input
        className="input"
        aria-label={`Description for ${describedName}`}
        value={item.description}
        onChange={(event) =>
          onChange({ ...item, description: event.target.value })
        }
      />
      <button
        type="button"
        className="icon-button"
        aria-label={`Remove ${describedName}`}
        onClick={onRemove}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          aria-hidden="true"
        >
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </>
  );
}

function CityAdder({ onAdd, label = "city", placeholder = "Add a city, then press Enter" }: { onAdd: (city: string) => void; label?: string; placeholder?: string }) {
  return (
    <form
      className="inline-row"
      onSubmit={(event) => {
        event.preventDefault();
        const input = event.currentTarget.elements.namedItem(
          "city",
        ) as HTMLInputElement | null;
        const value = input?.value.trim();
        if (!value) return;
        onAdd(value);
        if (input) input.value = "";
      }}
    >
      <input
        className="input"
        name="city"
        id={requirementIds.serviceAreas}
        aria-label={`Add a ${label}`}
        placeholder={placeholder}
      />
      <Button type="submit" variant="secondary">
        Add
      </Button>
    </form>
  );
}

function ChoiceCard({
  selected,
  title,
  description,
  onSelect,
  disabled = false,
}: {
  selected: boolean;
  title: string;
  description: string;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      className={selected ? "choice-card is-selected" : "choice-card"}
      aria-pressed={selected}
      disabled={disabled}
      onClick={onSelect}
    >
      <span className="choice-card-title">
        {title}
        {selected ? <Badge kind="done">Chosen</Badge> : null}
      </span>
      <span className="hint">{description}</span>
    </button>
  );
}

function PhotoCard({
  photo,
  caption,
  canEdit,
  onCaption,
}: {
  photo: UploadedFile;
  caption: string;
  canEdit: boolean;
  projectId: string;
  onCaption: (caption: string) => void;
}) {
  return (
    <div className="photo-card">
      <div className="photo-thumb" aria-hidden="true">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="var(--muted)"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="4" width="18" height="16" rx="2" />
          <circle cx="9" cy="10" r="1.5" />
          <path d="M21 16l-5-5-6 6" />
        </svg>
      </div>

      <div className="photo-body">
        <p className="photo-name">{photo.fileName}</p>
        <label className="field-label" htmlFor={`caption-${photo.id}`}>
          <span>Caption</span>
        </label>
        <input
          id={`caption-${photo.id}`}
          className="input"
          value={caption}
          disabled={!canEdit}
          placeholder="What is in this photo?"
          onChange={(event) => onCaption(event.target.value)}
        />
        <PhotoActions photo={photo} canEdit={canEdit} />
      </div>
    </div>
  );
}

function PhotoActions({
  photo,
  canEdit,
}: {
  photo: UploadedFile;
  canEdit: boolean;
}) {
  return (
    <div className="row" style={{ gap: 8, marginTop: 8 }}>
      <FileUploader.ViewButton fileId={photo.id} />
      {canEdit ? (
        <FileUploader.RemoveButton
          fileId={photo.id}
          fileName={photo.fileName}
        />
      ) : null}
    </div>
  );
}

/*
  The "TAWD fit" check's own question: things a TAWD site doesn't do. The
  project page reads the whole saved intake; here the warning follows what
  is ticked and typed, before saving.
*/
function SpecialFeaturesField({
  values,
  onChange,
}: {
  values: IntakeData["extras"];
  onChange: (next: Partial<IntakeData["extras"]>) => void;
}) {
  const fit = checkTawdFit({ ...emptyIntake(), extras: values });
  return (
    <fieldset className="choice-group">
      <legend className="field-label">
        <span>Does the client want any of these?</span>
      </legend>
      <p className="hint">TAWD doesn&rsquo;t build these. Ticking one never stops the project; it flags it for a custom VML build.</p>
      <div className="checkline-group">
        {specialFeatureKeys.map((key) => (
          <label key={key} className="checkline">
            <input
              type="checkbox"
              checked={values.specialFeatures.includes(key)}
              onChange={(event) =>
                onChange({
                  specialFeatures: event.target.checked
                    ? [...values.specialFeatures, key]
                    : values.specialFeatures.filter((k) => k !== key),
                })
              }
            />
            {specialFeatureLabels[key]}
          </label>
        ))}
      </div>
      <TextAreaField
        label="Anything else special they asked for"
        value={values.specialFeaturesNote}
        onChange={(specialFeaturesNote) => onChange({ specialFeaturesNote })}
      />
      {fit ? <Banner title={fit.title}>{describeFitWarning(fit)}</Banner> : null}
    </fieldset>
  );
}

type IntegrationRow = IntakeData["extras"]["integrations"][number];

/*
  The client's online tools: booking, a shop, a patient or client portal,
  reviews. A link each, never a code snippet. The builder places them and
  the build's checklist confirms each link answers.
*/
function IntegrationsField({
  values,
  onChange,
}: {
  values: IntakeData["extras"];
  onChange: (next: Partial<IntakeData["extras"]>) => void;
}) {
  const rows = values.integrations;
  const update = (index: number, next: IntegrationRow) => onChange({ integrations: rows.map((row, i) => (i === index ? next : row)) });

  return (
    <fieldset className="choice-group">
      <legend className="field-label">
        <span>Online tools the site links to</span>
      </legend>
      <p className="hint">
        Booking (Boulevard, Vagaro, Calendly and similar), a shop, a patient or client portal, or a reviews page. Paste the client&rsquo;s own link; TAWD places it and checks it works before go-live.
      </p>
      {rows.length > 0 ? (
        <div className="integrations-grid">
          <span className="hours-head">Kind</span>
          <span className="hours-head">Provider</span>
          <span className="hours-head">Link</span>
          <span />
          {rows.map((row, index) => (
            <IntegrationRowFields
              key={row.id}
              row={row}
              onChange={(next) => update(index, next)}
              onRemove={() => onChange({ integrations: rows.filter((_, i) => i !== index) })}
            />
          ))}
        </div>
      ) : (
        <p className="empty" style={{ padding: "8px 0" }}>
          No online tools yet.
        </p>
      )}
      <div>
        <Button
          variant="secondary"
          onClick={() =>
            onChange({ integrations: [...rows, { id: `i-${Date.now()}-${rows.length}`, kind: "booking", provider: "", url: "", embed: false }] })
          }
        >
          Add a link
        </Button>
      </div>
    </fieldset>
  );
}

function IntegrationRowFields({ row, onChange, onRemove }: { row: IntegrationRow; onChange: (next: IntegrationRow) => void; onRemove: () => void }) {
  const listId = `providers-${row.id}`;
  const name = row.provider || integrationKindLabels[row.kind].toLowerCase();
  const badUrl = row.url !== "" && !/^https?:\/\/\S+$/i.test(row.url);
  const embeddable = canEmbed(row.kind, row.url);
  return (
    <>
      <select
        className="select"
        aria-label={`Kind of link for ${name}`}
        value={row.kind}
        onChange={(event) => onChange({ ...row, kind: event.target.value as IntegrationKind, embed: false })}
      >
        {integrationKinds.map((kind) => (
          <option key={kind} value={kind}>
            {integrationKindLabels[kind]}
          </option>
        ))}
      </select>
      <div>
        <input className="input" list={listId} aria-label={`Provider for ${name}`} placeholder="For example Vagaro" value={row.provider} onChange={(event) => onChange({ ...row, provider: event.target.value })} />
        <datalist id={listId}>
          {integrationProviders[row.kind].map((p) => (
            <option key={p} value={p} />
          ))}
        </datalist>
      </div>
      <div>
        <input className="input" type="url" aria-label={`Link for ${name}`} placeholder="https://" value={row.url} onChange={(event) => onChange({ ...row, url: event.target.value.trim() })} />
        {badUrl ? <p className="hint-error">Enter a full web address starting with https://</p> : null}
        {embeddable ? (
          <label className="checkline" style={{ marginTop: 6 }}>
            <input type="checkbox" checked={row.embed} onChange={(event) => onChange({ ...row, embed: event.target.checked })} />
            Show the booking calendar on the Contact page (as well as the button)
          </label>
        ) : null}
      </div>
      <button type="button" className="icon-button" aria-label={`Remove ${name}`} onClick={onRemove}>
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
          <line x1="6" y1="6" x2="18" y2="18" />
          <line x1="18" y1="6" x2="6" y2="18" />
        </svg>
      </button>
    </>
  );
}

/* ---------- F1, Website forms ---------- */

const looksLikeEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

function FormRecipientsField({ values, onChange, businessEmail }: { values: IntakeData["forms"]; onChange: (next: Partial<IntakeData["forms"]>) => void; businessEmail: string }) {
  const rows = values.recipients.length ? values.recipients : [""];
  const setRow = (i: number, value: string) => onChange({ recipients: rows.map((r, j) => (j === i ? value : r)) });
  const listed = rows.filter((r) => r.trim()).length > 0;
  return (
    <div className="field">
      <FieldLabel>Send website messages to</FieldLabel>
      {rows.map((row, i) => (
        <div className="row form-recipient-row" key={i}>
          <input
            className={row.trim() && !looksLikeEmail(row) ? "input is-missing" : "input"}
            type="email"
            aria-label={`Address ${i + 1}`}
            placeholder="name@example.com"
            value={row}
            onChange={(event) => setRow(i, event.target.value)}
          />
          {i > 0 ? (
            <button type="button" className="btn btn-text" onClick={() => onChange({ recipients: rows.filter((_, j) => j !== i) })}>
              Remove
            </button>
          ) : null}
          {row.trim() && !looksLikeEmail(row) ? <p className="hint-amber">That isn&rsquo;t an email address.</p> : null}
        </div>
      ))}
      {rows.length < 5 ? (
        <button type="button" className="btn btn-text" onClick={() => onChange({ recipients: [...rows, ""] })}>
          Add another address
        </button>
      ) : null}
      {listed ? null : looksLikeEmail(businessEmail) ? (
        <p className="hint">Blank: the business email ({businessEmail}).</p>
      ) : (
        <p className="hint-amber">No address yet: add one here or the business email (Business), or the messages go nowhere.</p>
      )}
    </div>
  );
}

const FORM_FIELD_ROWS: { key: IntakeData["forms"]["fields"][number]["key"]; label: string; line?: string }[] = [
  { key: "phone", label: "Phone" },
  { key: "email", label: "Email" },
  { key: "message", label: "Message" },
  { key: "service", label: "Service needed", line: "A list of the services from Services." },
  { key: "address", label: "Address or ZIP code" },
  { key: "bestTime", label: "Best time to call" },
  { key: "heardAbout", label: "How did you hear about us" },
  { key: "photos", label: "Photos", line: "One upload, up to 8 MB." },
  { key: "emergency", label: "This is an emergency" },
  { key: "textConsent", label: "OK to text me", line: "Texting consent: tick only if the client texts leads, and keep the wording." },
];

/* The standard form, shown ticked while the section has never been changed. */
const STANDARD = [
  { key: "phone" as const, required: true },
  { key: "email" as const, required: false },
  { key: "message" as const, required: true },
];

function FormFieldsField({ values, onChange, serviceCount }: { values: IntakeData["forms"]; onChange: (next: Partial<IntakeData["forms"]>) => void; serviceCount: number }) {
  const fields = values.fields.length ? values.fields : STANDARD;
  const on = (key: string) => fields.find((f) => f.key === key);
  const toggle = (key: (typeof FORM_FIELD_ROWS)[number]["key"], ticked: boolean) =>
    onChange({ fields: ticked ? [...fields, { key, required: false }] : fields.filter((f) => f.key !== key) });
  const require = (key: string, required: boolean) => onChange({ fields: fields.map((f) => (f.key === key ? { ...f, required } : f)) });
  return (
    <fieldset className="field form-fields">
      <legend className="field-label">
        <span>What the form asks</span>
      </legend>
      <div className="form-field-row">
        <label className="radio-line">
          <input type="checkbox" checked disabled /> Name
        </label>
        <span className="hint">Always</span>
      </div>
      {FORM_FIELD_ROWS.map((row) => {
        const chosen = on(row.key);
        return (
          <div className="form-field-row" key={row.key}>
            <div>
              <label className="radio-line">
                <input type="checkbox" checked={Boolean(chosen)} onChange={(event) => toggle(row.key, event.target.checked)} /> {row.label}
              </label>
              {row.line ? <p className="hint">{row.key === "service" && serviceCount === 0 ? "Add the services under Services first." : row.line}</p> : null}
            </div>
            {chosen ? (
              <label className="radio-line form-field-required">
                <input type="checkbox" checked={chosen.required} onChange={(event) => require(row.key, event.target.checked)} /> Required
              </label>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}
