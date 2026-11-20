import type { LaneOption, ProjectStatus, Tier, Trade } from "@tawd/core/enums";
import { PREFILL_LABELS, sectionLabels, type IntakeSectionKey, type PrefillKey } from "@tawd/core/intake";
import { directions, type DirectionId } from "@tawd/core/mockups";
import {
  laneLabels,
  laneOptionLabels,
  statusLabels,
  tierLabels,
  tradeLabels,
} from "@/lib/labels";

/*
  The project History, in plain words.

  The activity log keeps exact before-and-after values, which is right for
  the log and unreadable on a project page ("memberUserIds:
  ["K5aMn5fj..."]"). This turns each entry into a line or two a person
  would write: "Added Dee Morgan", "Starter to Growth", "Business: phone".
*/

type Values = Record<string, unknown>;

const asValues = (value: unknown): Values =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Values) : {};

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// Field names that read badly when split mechanically.
const WORD_OVERRIDES: Record<string, string> = {
  mainServiceId: "main service",
  googleBusinessProfileUrl: "Google Business Profile link",
  websiteUrl: "website",
  noGoogleBusinessProfile: "no Google Business Profile yet",
  licenseInProgress: "license in progress",
  items: "list",
};

function words(key: string): string {
  const last = key.split(".").pop() ?? key;
  if (WORD_OVERRIDES[last]) return WORD_OVERRIDES[last]!;
  const spaced = last.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function short(value: unknown): string {
  if (value === null || value === undefined || value === "") return "nothing";
  if (Array.isArray(value)) {
    return value.length === 0 ? "nothing" : value.map((v) => short(v)).join(", ");
  }
  if (typeof value === "object") return "updated";
  const text = String(value);
  return text.length > 60 ? `${text.slice(0, 57)}...` : text;
}

const PROJECT_FIELDS: Record<string, (v: unknown) => string> = {
  clientName: (v) => short(v),
  trade: (v) => tradeLabels[v as Trade] ?? short(v),
  tier: (v) => tierLabels[v as Tier]?.split(" (")[0] ?? short(v),
  lane: (v) => (v === "lane_1" ? "Lane 1" : v === "lane_2" ? "Lane 2" : short(v)),
  laneOption: (v) => (v ? (laneOptionLabels[v as LaneOption] ?? short(v)) : "none"),
  conceptCount: (v) => (v === null ? "none" : String(v)),
  status: (v) => statusLabels[v as ProjectStatus] ?? short(v),
};

const PROJECT_FIELD_NAMES: Record<string, string> = {
  clientName: "Name",
  trade: "Trade",
  tier: "Tier",
  lane: "Lane",
  laneOption: "Lane 2 option",
  conceptCount: "Concepts",
  status: "Stage",
};

function memberChange(before: unknown, after: unknown, people: Map<string, string>): string[] {
  const b = new Set(Array.isArray(before) ? (before as string[]) : []);
  const a = new Set(Array.isArray(after) ? (after as string[]) : []);
  const name = (id: string) => people.get(id) ?? "a former team member";
  const added = [...a].filter((id) => !b.has(id)).map(name);
  const removed = [...b].filter((id) => !a.has(id)).map(name);
  return [
    ...(added.length ? [`Added ${added.join(", ")}`] : []),
    ...(removed.length ? [`Removed ${removed.join(", ")}`] : []),
  ];
}

export function describeChanges(
  action: string,
  valueBefore: unknown,
  valueAfter: unknown,
  people: Map<string, string>,
): string[] {
  const before = asValues(valueBefore);
  const after = asValues(valueAfter);

  switch (action) {
    case "project.created": {
      const parts = [
        after.trade ? PROJECT_FIELDS.trade!(after.trade) : null,
        after.tier ? `${PROJECT_FIELDS.tier!(after.tier)} tier` : null,
        after.lane ? laneLabels[after.lane as "lane_1" | "lane_2"]?.replace(" - ", ": ") : null,
        typeof after.conceptCount === "number"
          ? `${after.conceptCount} concept${after.conceptCount === 1 ? "" : "s"}`
          : null,
      ].filter(Boolean);
      const team = memberChange([], after.memberUserIds, people);
      return [parts.join(", "), ...team].filter((line) => line.length > 0);
    }

    case "project.updated":
      // Team changes have their own entry; the stage, its own too.
      return Object.keys(PROJECT_FIELDS)
        .filter((key) => key !== "status" && !same(before[key], after[key]))
        .map(
          (key) =>
            `${PROJECT_FIELD_NAMES[key]}: ${PROJECT_FIELDS[key]!(before[key])} to ${PROJECT_FIELDS[key]!(after[key])}`,
        );

    case "project.members_changed":
      return memberChange(before.memberUserIds, after.memberUserIds, people);

    case "project.status_changed":
      return [
        `${after.resumed ? "Resumed: " : ""}${PROJECT_FIELDS.status!(before.status)} to ${PROJECT_FIELDS.status!(after.status)}${after.unknownStage ? " (where it was paused wasn't recorded)" : ""}`,
        ...(after.note ? [`Note: ${short(after.note)}`] : []),
        ...(after.reason ? [`Reason: ${short(after.reason)}`] : []),
      ];

    case "project.gate_overridden": {
      const missing = Array.isArray(before.missing) ? (before.missing as string[]) : [];
      return [
        ...(after.reason ? [`Reason: ${short(after.reason)}`] : []),
        ...(missing.length ? [`Still missing: ${missing.join(", ")}`] : []),
      ];
    }

    case "project.deleted":
      return after.reason ? [`Reason: ${short(after.reason)}`] : [];

    case "intake.updated": {
      const section = sectionLabels[after.section as IntakeSectionKey] ?? words(String(after.section ?? ""));
      const fields = Object.keys(after)
        .filter((key) => key !== "section" && !same(before[key], after[key]))
        .map((key) => (WORD_OVERRIDES[key] ?? words(key).toLowerCase()));
      return fields.length ? [`${section}: ${[...new Set(fields)].join(", ")}`] : [section];
    }

    case "intake.file_added":
    case "intake.file_removed":
    case "intake.file_captioned": {
      const file = after.fileName ?? before.fileName;
      return file ? [short(file)] : [];
    }

    case "mockups.run_started": {
      const concepts = Array.isArray(after.concepts)
        ? (after.concepts as { label?: string; direction?: string }[])
        : [];
      return concepts.length
        ? [
            concepts
              .map((c) => `${c.label}: ${directions[c.direction as DirectionId]?.label ?? c.direction}`)
              .join(", "),
          ]
        : [];
    }

    case "mockups.directions_overridden": {
      // A list per concept that changed; newer entries also say which
      // advice was overruled.
      const shaped = !Array.isArray(valueAfter) && valueAfter && typeof valueAfter === "object"
        ? (valueAfter as { concepts?: unknown; rulesWaived?: unknown })
        : null;
      const list = (Array.isArray(valueAfter) ? valueAfter : Array.isArray(shaped?.concepts) ? shaped!.concepts : []) as {
        concept?: string;
        direction?: string;
      }[];
      const lines = list.map(
        (c) => `Concept ${c.concept}: ${directions[c.direction as DirectionId]?.label ?? c.direction}`,
      );
      if (Array.isArray(shaped?.rulesWaived) && shaped!.rulesWaived.length > 0) {
        lines.push("Went ahead without Bold Emergency for an emergency trade");
      }
      return lines;
    }

    case "mockups.concept_built":
    case "mockups.concept_failed":
      return after.reason ? [`Concept ${after.concept}: ${short(after.reason)}`] : [];

    case "mockups.changes_requested": {
      const from = after.source === "client" ? "from the client" : "from the team";
      const pins = typeof after.comments === "number" && after.comments > 0
        ? ` and ${after.comments} pinned comment${after.comments === 1 ? "" : "s"}`
        : "";
      return [`Concept ${after.concept} v${after.baseVersion}, ${from}${pins}`, ...(after.notes ? [short(after.notes)] : [])];
    }

    case "mockups.changes_finished":
      return [`Concept ${after.concept}: v${after.version}${after.average != null ? `, review ${Number(after.average).toFixed(1)}` : ""}`];

    case "mockups.changes_failed":
      return [`Concept ${after.concept}: ${short(after.reason)}`];

    case "design_md.created":
      return [`Version ${after.version}, from ${after.from}`];

    case "design_md.failed":
      return [short(after.reason)];

    case "mockups.logo_swap_started":
      return [`Concept ${after.concept} v${after.version}: free, no AI`];

    case "mockups.logo_swapped":
      return [`Concept ${after.concept}: v${after.to} made from v${after.from} with the new logo`];

    case "mockups.logo_approved":
      return [`Concept ${after.concept} v${after.version}, by ${after.channel}`, ...(after.clientSaid ? [short(after.clientSaid)] : [])];

    case "seo.dma_list_loaded":
      return [Number(after.count) > 0 ? `${after.count} markets, from ${after.locations} US locations` : `No DMAs among ${after.locations} US locations: the DMA choice stays hidden`];

    case "seo.connection_tested":
      return [`${after.ok ? "Connected" : "Refused or no answer"}: HTTP ${after.httpStatus ?? "none"}, ${String(after.endpoint)}`];

    case "tracking.saved": {
      const names: Record<string, string> = { ga4: "GA4", gtm: "Tag Manager", metaPixel: "Meta Pixel", googleAds: "Google Ads" };
      const set = Object.keys(names).filter((k) => after[k]).map((k) => `${names[k]} ${String(after[k])}`);
      return [set.length ? set.join(", ") : "No tracking codes", after.consentMode === "opt_out" ? "Consent: on unless the visitor opts out" : "Consent: ask first"];
    }

    case "health.flag_confirmed":
      return [`${after.rule}: "${after.found}" (version ${after.version})`, ...(after.note ? [short(after.note)] : [])];

    case "mockups.client_decision":
      return [
        `Concept ${after.concept} v${after.version}, by ${after.channel}: ${after.changesRequested ? "changes requested" : "approved as is"}`,
        ...(after.logoApproved === true ? ["Logo approved by the client"] : after.logoApproved === false ? ["Logo not approved yet"] : []),
        ...(after.clientSaid ? [short(after.clientSaid)] : []),
      ];

    case "mockups.client_pack_downloaded":
      return Array.isArray(after.concepts) ? [`Concepts ${(after.concepts as string[]).join(", ")}`] : [];

    case "mockups.review_rerun":
      return Array.isArray(after.concepts) ? [`Concept ${(after.concepts as string[]).join(" and ")}`] : [];

    case "figma.linked":
      return [
        typeof before.fileName === "string" ? `Replaced "${before.fileName}"` : null,
        typeof after.url === "string" ? String(after.url) : null,
      ].filter((line): line is string => Boolean(line));

    case "figma.checked": {
      if (after.status === "failed") return [`Couldn't be read: ${String(after.reason ?? "")}`];
      const warnings = Array.isArray(after.warnings) ? (after.warnings as string[]) : [];
      const frames = Array.isArray(after.frames) ? (after.frames as string[]) : [];
      return [
        `"${String(after.fileName ?? "")}": ${frames.length} final frame${frames.length === 1 ? "" : "s"}${
          warnings.length === 0 ? ", nothing missing" : `, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`
        }`,
        ...warnings,
      ];
    }

    case "figma.page_chosen":
      return [`Page "${String(after.page ?? "")}"`];

    case "figma.import_queued":
      return Array.isArray(after.frames) ? [(after.frames as string[]).join(", ")] : [];

    case "figma.imported": {
      const frames = Array.isArray(after.frames) ? (after.frames as string[]) : [];
      const warnings = Array.isArray(after.warnings) ? (after.warnings as string[]) : [];
      return [
        `${frames.length} frame${frames.length === 1 ? "" : "s"} (${frames.join(", ")}) and ${Number(after.images ?? 0)} image${Number(after.images ?? 0) === 1 ? "" : "s"}`,
        ...(after.icons !== undefined || after.logos !== undefined
          ? [`${Number(after.logos ?? 0) > 0 ? "The logo" : "No logo"} and ${Number(after.icons ?? 0)} icon${Number(after.icons ?? 0) === 1 ? "" : "s"} kept for the faithful copy`]
          : []),
        ...warnings,
      ];
    }

    case "figma.import_failed":
    case "design.review_failed":
      return [String(after.reason ?? "")];

    case "email.sent":
    case "email.not_sent": {
      const via = after.via && after.via !== "test" ? ` through ${String(after.via)}` : "";
      return [
        `${String(after.purpose ?? "Email").replace(/^./, (c) => c.toUpperCase())} to ${String(after.to ?? "")}${via}`,
        ...(after.reason ? [String(after.reason)] : []),
      ];
    }

    case "user.password_reset_requested": {
      const outcome = String(after.outcome ?? "");
      if (!outcome || outcome === "handled") return [];
      return [outcome === "sent" ? "Email sent" : outcome === "sending" ? "Sending the email" : outcome.charAt(0).toUpperCase() + outcome.slice(1)];
    }

    case "design.copy_started":
      return [`"${String(after.frame ?? "")}"`, String(after.estimate ?? "")].filter((line) => line !== '""' && line);

    case "design.copy_built": {
      const notes = Array.isArray(after.notes) ? (after.notes as string[]) : [];
      return [`"${String(after.frame ?? "")}": matches the design ${Number(after.match ?? 0)}%`, ...notes];
    }

    case "design.copy_failed":
      return [String(after.reason ?? "")];

    case "design.improve_started":
      return [String(after.fixes ?? ""), String(after.estimate ?? "")].filter(Boolean);

    case "design.improved": {
      const scored =
        after.before !== null && after.before !== undefined && after.after !== null && after.after !== undefined
          ? `The Creative Director's score: ${Number(after.before).toFixed(1)} to ${Number(after.after).toFixed(1)} of 5`
          : null;
      const skipped = Number(after.notApplied ?? 0);
      return [
        `${Number(after.changes ?? 0)} tracked change${Number(after.changes ?? 0) === 1 ? "" : "s"}${skipped > 0 ? `; ${skipped} fix${skipped === 1 ? "" : "es"} not made` : ""}`,
        ...(scored ? [scored] : []),
      ];
    }

    case "design.change_decided":
      return [
        `Change ${Number(after.number ?? 0)} (${String(after.section ?? "")}): ${after.decision === "accepted" ? "accepted" : after.decision === "pushed_back" ? "pushed back" : "no decision"}`,
        ...(after.note ? [`Note: ${String(after.note)}`] : []),
      ];

    case "design.decisions_version_started":
      return [String(after.plan ?? ""), String(after.estimate ?? "")].filter(Boolean);

    case "design.decisions_version_built":
      return [
        `${Number(after.accepted ?? 0)} accepted, ${Number(after.pushedBack ?? 0)} pushed back`,
        `${Number(after.sectionsPutBack ?? 0)} section${Number(after.sectionsPutBack ?? 0) === 1 ? "" : "s"} put back as designed, ${Number(after.sectionsEdited ?? 0)} edited`,
      ];

    case "seo.research_started":
      return [
        `${String(after.keywords ?? 0)} keywords in ${Array.isArray(after.places) ? after.places.length : 0} place${Array.isArray(after.places) && after.places.length === 1 ? "" : "s"}`,
        after.sandbox ? "DataForSEO sandbox: test data, free" : `Estimate ${moneyText(Math.round(Number(after.estimateUsd ?? 0) * 100))}`,
      ];

    case "seo.research_finished":
      return [
        `${String(after.keywords ?? 0)} keywords, ${String(after.cached ?? 0)} from earlier lookups`,
        after.sandbox ? "DataForSEO sandbox: test data, free" : `Cost ${moneyText(Math.round(Number(after.costUsd ?? 0) * 100))}`,
      ];

    case "content.drafts_started":
      return [`${Array.isArray(after.pages) ? after.pages.join(", ") : ""}`, String(after.estimate ?? "")].filter(Boolean);

    case "content.page_drafted":
      return [`${String(after.page ?? "")}, version ${String(after.version ?? "")}${after.source === "improved" ? " (improved from the current site)" : ""}`];

    case "content.improve_started":
      return [`${Array.isArray(after.pages) ? after.pages.join(", ") : ""}`, String(after.estimate ?? ""), after.note ? `Note: ${String(after.note)}` : ""].filter(Boolean);

    case "content.prepare_started":
      return [...(Array.isArray(after.steps) ? after.steps.map(String) : []), String(after.estimate ?? "")].filter(Boolean);

    case "content.prepare_stopped":
      return [String(after.reason ?? "")];

    case "content.page_reverted_to_kept":
      return [`${String(after.page ?? "")}, version ${String(after.version ?? "")}`];

    case "content.redraft_requested":
      return [`${String(after.page ?? "")}, version ${String(after.version ?? "")}`, `Note: ${String(after.note ?? "")}`];

    case "content.page_edited":
      return [`${String(after.page ?? "")}, version ${String(after.version ?? "")}`];

    case "content.site_import_started":
      return [`${String(after.url ?? "")}, up to ${String(after.pageLimit ?? "")} pages${after.auto ? " (by itself, after the intake was saved)" : ""}`];

    case "content.site_import_used":
      return [
        `${Array.isArray(after.pages) ? after.pages.length : 0} pages kept from ${String(after.url ?? "the current site")}: ${Array.isArray(after.pages) ? after.pages.slice(0, 12).join(", ") : ""}${Array.isArray(after.pages) && after.pages.length > 12 ? ", ..." : ""}`,
        "Each page's words: version 1, From the current site (kept as is)",
        ...(after.auto ? ["Made by TAWD by itself when the read finished"] : []),
      ];

    case "content.page_approved":
      return [
        `${String(after.page ?? "")}, version ${String(after.version ?? "")}${after.kept ? " (kept from the current site)" : ""}${after.all ? ", with Approve all kept pages" : ""}`,
        ...(Number(after.placeholders ?? 0) > 0 ? [`${String(after.placeholders)} placeholders still open`] : []),
      ];

    case "content.comment_added":
      return [`${String(after.page ?? "")} (v${String(after.version ?? "")}): ${String(after.comment ?? "")}`];

    case "content.ai_checked":
      return [`${String(after.page ?? "")}, version ${String(after.version ?? "")}: ${String(after.aiPercent ?? "")}% likely AI-written${after.flagged ? " (flagged)" : ""}`];

    case "content.client_decision":
      return [
        `${after.outcome === "approved" ? "Approved the copy" : "Asked for changes"} (${String(after.channel ?? "")})`,
        `The client said: ${String(after.clientSaid ?? "")}`,
      ];

    case "content.plan_made":
      return [`${Array.isArray(after.pages) ? after.pages.length : 0} pages: ${Array.isArray(after.pages) ? after.pages.join(", ") : ""}`];

    case "content.plan_page_added":
      return [String(after.name ?? "")];

    case "content.plan_page_removed":
      return [String(before.name ?? "")];

    case "content.plan_page_changed":
      return [
        `${String(after.name ?? "")}: ${Object.keys(after)
          .filter((key) => key !== "name" || before.name !== after.name)
          .map((key) => PLAN_FIELDS[key] ?? key)
          .join(", ")} changed`,
      ];

    case "content.plan_reordered":
      return [Array.isArray(after.order) ? after.order.join(", ") : ""];

    case "pricing.package_saved":
      return [`${String(after.name ?? "")}: build fee ${moneyText(after.buildFeeCents)}, monthly ${moneyText(after.monthlyFeeCents)}`];

    case "project.price_changed":
      return [
        `${String(after.packageName ?? after.packageKey ?? "")}: build fee ${moneyText(after.buildFeeCents)}, monthly ${moneyText(after.monthlyFeeCents)}`,
        `Why: ${String(after.reason ?? "")}`,
      ];

    case "project.cancelled":
      return [`Cancelled on ${String(after.cancelledOn ?? "")}`, `Why: ${String(after.reason ?? "")}`];

    case "project.cancellation_undone":
      return ["The monthly fee counts again"];

    case "intake.brand_guide_read": {
      const fonts = Array.isArray(after.fonts) ? (after.fonts as string[]) : [];
      return [
        `"${String(after.fileName ?? "")}": ${after.status === "no_text" ? "no text to read (a scan)" : after.status === "failed" ? "couldn't be read" : `${Number(after.colors ?? 0)} colours, ${fonts.length ? fonts.join(", ") : "no fonts"}, ${Number(after.logoRules ?? 0)} logo rules`}`,
      ];
    }

    case "intake.brand_guide_suggestion":
      return [`${after.outcome === "used" ? "Used" : "Dismissed"}: ${String(after.suggestion ?? "")}`];

    case "design.put_on_board":
      return [`Concept 1, v${Number(after.version ?? 1)}, from ${String(after.from ?? "the improved design")}`];

    case "design.decisions_version_failed":
      return [String(after.reason ?? "")];

    case "design.improve_failed":
      return [String(after.reason ?? "")];

    case "design.review_started":
      return [`"${String(after.frame ?? "")}"`, String(after.estimate ?? "")].filter((line) => line !== '""' && line);

    case "design.reviewed":
      return [
        `"${String(after.frame ?? "")}": ${Number(after.average ?? 0).toFixed(1)} of 5 on average`,
        `${Number(after.mustFix ?? 0)} must-fix, ${Number(after.shouldFix ?? 0)} should-fix, ${Number(after.recommendations ?? 0)} recommendation${Number(after.recommendations ?? 0) === 1 ? "" : "s"}${after.confirmFacts ? `, ${Number(after.confirmFacts)} fact${Number(after.confirmFacts) === 1 ? "" : "s"} to confirm` : ""}`,
      ];

    case "intake.prefilled": {
      const filled = Array.isArray(after.filled) ? (after.filled as string[]) : [];
      const left = Array.isArray(after.alreadyFilled) ? (after.alreadyFilled as string[]) : [];
      return [
        ...(filled.length > 0 ? filled : ["Nothing new was filled"]),
        ...(left.length > 0 ? [`Left alone, already filled in: ${left.join(", ")}`] : []),
      ];
    }

    case "intake.prefilled_from_site": {
      const filled = Array.isArray(after.filled) ? (after.filled as string[]) : [];
      return [`From ${String(after.url ?? "the current site")}`, ...filled];
    }

    case "content.blocked_site_read": {
      const routes = Array.isArray(after.routes) ? (after.routes as { route: string; calls: number; costUsd: number }[]) : [];
      return [`${String(after.url ?? "")}: ${Number(after.pages ?? 0)} pages read${Number(after.gaps ?? 0) ? `, ${Number(after.gaps)} couldn't be` : ""}`, ...routes.map((r) => `${r.route}: ${r.calls} call${r.calls === 1 ? "" : "s"}, $${Number(r.costUsd).toFixed(4)}`)];
    }

    case "content.blocked_route_capped":
      return [`${String(after.route ?? "")} reached this month's cap of $${Number(after.capUsd ?? 0).toFixed(2)}: not called`];

    case "content.blocked_route_stopped":
      return [`${String(after.route ?? "")}: ${String(after.reason ?? "")}`];

    case "content.blocked_read_approved":
      return [`${String(after.url ?? "")} through ${String(after.route ?? "")}, about $${Number(after.estimateUsd ?? 0).toFixed(2)}`];

    case "settings.blocked_route_cap_changed":
      return [`${String(after.route ?? "")}: $${Number(after.dollars ?? 0).toFixed(2)} a month`];

    case "content.kept_plan_updated": {
      const list = (key: string) => (Array.isArray(after[key]) ? (after[key] as string[]) : []);
      return [
        ...(list("added").length ? [`Added: ${list("added").join(", ")}`] : []),
        ...(list("updated").length ? [`Updated to the site's new words: ${list("updated").join(", ")}`] : []),
        ...(list("changed").length ? [`Changed on the site, left as the team has them: ${list("changed").join(", ")}`] : []),
        ...(list("gone").length ? [`No longer on the site: ${list("gone").join(", ")}`] : []),
      ];
    }

    case "intake.prefill_confirmed":
      return [`${String(after.field ?? "")}: ${String(after.value ?? "")}`];

    case "intake.prefill_corrected": {
      const fields = Array.isArray(after.fields) ? (after.fields as string[]) : [];
      return [fields.map((key) => PREFILL_LABELS[key as PrefillKey] ?? key).join(", ")];
    }

    case "design.fix_ticked": {
      const group =
        after.grade === "must_fix" ? "must-fix" : after.grade === "should_fix" ? "should-fix" : "fact to confirm";
      if (after.all) {
        const count = Number(after.count ?? 0);
        if (after.grade === "confirm_fact") {
          return [`${after.ticked ? "Marked confirmed" : "Marked not confirmed"}: all ${count} facts to confirm`];
        }
        return [`${after.ticked ? "Will be applied" : "Won't be applied"}: all ${count} ${group} items`];
      }
      if (after.grade === "confirm_fact") {
        return [`${after.ticked ? "Confirmed with the client" : "Not confirmed yet"}: ${Number(after.number ?? 0)}. ${String(after.title ?? "")}`];
      }
      return [`${after.ticked ? "Will be applied" : "Won't be applied"}: ${Number(after.number ?? 0)}. ${String(after.title ?? "")} (${group})`];
    }

    case "mockups.run_stuck": {
      const built = Array.isArray(after.built) ? (after.built as string[]) : [];
      return [
        built.length > 0
          ? `Concept ${built.join(" and ")} kept; the review can be run again`
          : "Failed to start",
        String(after.reason ?? ""),
      ].filter(Boolean);
    }

    case "mockups.checks_rerun":
      return Array.isArray(after.concepts)
        ? (after.concepts as { concept: string; before: number; after: number; codeFixes?: string[] }[]).map(
            (c) =>
              `Concept ${c.concept}: ${c.before} failing before, ${c.after} now${
                c.codeFixes && c.codeFixes.length > 0 ? `; fixed by code: ${c.codeFixes.join(", ")}` : ""
              }`,
          )
        : [];

    case "mockups.concept_shown_anyway":
      return [`Concept ${after.concept}: shown anyway, under 4.5${before.held ? ` (it ${before.held})` : ""}`];

    case "mockups.send_to_client_changed":
      return [`Concept ${after.concept}: ${after.sendToClient ? "in the client pack" : "left out of the client pack"}`];

    case "slack.connected":
    case "slack.replaced":
    case "team_slack.connected":
    case "team_slack.replaced":
      return after.webhook ? [`Webhook ${short(after.webhook)}`] : [];
    case "slack.disconnected":
      return before.webhook ? [`Webhook ${short(before.webhook)}`] : [];

    default:
      return [];
  }
}

/* Whole cents as dollars, for History; "not set" for blank. */
function moneyText(value: unknown): string {
  if (typeof value !== "number") return "not set";
  return `$${(value / 100).toLocaleString("en-US", { minimumFractionDigits: value % 100 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

const PLAN_FIELDS: Record<string, string> = {
  name: "name",
  kind: "kind of page",
  slug: "address",
  mainKeyword: "main keyword",
  supportingKeywords: "supporting keywords",
  title: "title",
  metaDescription: "meta description",
  h1: "H1",
};
