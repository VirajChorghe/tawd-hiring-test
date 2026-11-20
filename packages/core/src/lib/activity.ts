import { createHash } from "node:crypto";
import { asc, desc, eq, gt, sql } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { activityLog, appSetting } from "@tawd/core/schema";

/*
  The activity log.

  Two independent protections:

  1. Prevention. A database trigger rejects every UPDATE, DELETE and TRUNCATE
     on activity_log, so no code path here can alter history even by mistake.
     See drizzle/0001_activity_log_append_only.sql.

  2. Detection. Each entry carries a SHA-256 fingerprint of its own contents
     plus the previous entry's fingerprint. Changing any earlier row breaks
     every fingerprint after it. A PostgreSQL superuser at the console can
     always disable a trigger - no database can prevent that - but they cannot
     rebuild the chain without being noticed.

  The hash is computed here rather than in SQL so it behaves identically on
  the production database and on the in-process PostgreSQL used by tests.
*/

export type ActivityAction =
  | "login.succeeded"
  | "login.failed"
  | "logout"
  | "user.created"
  | "user.disabled"
  | "user.enabled"
  | "user.roles_changed"
  | "user.renamed"
  | "user.deleted"
  | "user.admin_changed"
  | "user.password_reset"
  | "user.password_changed"
  | "user.password_reset_requested"
  | "user.password_reset_by_email"
  | "email.sent"
  | "email.not_sent"
  | "project.created"
  | "project.updated"
  | "project.status_changed"
  | "project.members_changed"
  | "project.gate_overridden"
  | "project.deleted"
  | "intake.updated"
  | "intake.file_added"
  | "intake.file_captioned"
  | "intake.file_removed"
  | "mockups.run_started"
  | "mockups.directions_overridden"
  | "mockups.run_stopped"
  | "mockups.run_finished"
  | "mockups.review_finished"
  | "mockups.concept_built"
  | "mockups.concept_failed"
  | "mockups.concept_resumed"
  | "mockups.changes_requested"
  | "mockups.changes_finished"
  | "mockups.changes_failed"
  | "mockups.client_decision"
  | "mockups.client_pack_downloaded"
  | "mockups.send_to_client_changed"
  | "mockups.concept_shown_anyway"
  | "mockups.review_rerun"
  | "mockups.checks_rerun"
  | "mockups.run_stuck"
  | "figma.linked"
  | "figma.checked"
  | "figma.page_chosen"
  | "figma.import_queued"
  | "figma.imported"
  | "figma.import_failed"
  | "design.review_started"
  | "design.reviewed"
  | "design.review_failed"
  | "design.fix_ticked"
  | "design.copy_started"
  | "design.copy_accepted"
  | "design.copy_replayed"
  | "design.copy_repair_started"
  | "design.copy_repaired"
  | "design.copy_fill_started"
  | "design.copy_filled"
  | "design.copy_fill_dropped"
  | "design.style_kit_started"
  | "design.style_kit_built"
  | "design.style_kit_font_changed"
  | "work.stopped"
  | "project.ai_cap_changed"
  | "project.videos_saved"
  | "design.copy_built"
  | "design.copy_failed"
  | "design.improve_started"
  | "design.improved"
  | "design.improve_failed"
  | "design.change_decided"
  | "design.decisions_version_started"
  | "design.decisions_version_built"
  | "design.decisions_version_failed"
  | "design.put_on_board"
  | "intake.brand_guide_read"
  | "intake.brand_guide_suggestion"
  | "pricing.package_saved"
  | "seo.research_started"
  | "seo.research_finished"
  | "settings.seo_limit_changed"
  | "content.plan_made"
  | "content.plan_page_added"
  | "content.plan_page_changed"
  | "content.plan_page_removed"
  | "content.plan_reordered"
  | "content.drafts_started"
  | "content.page_drafted"
  | "content.redraft_requested"
  // Design + content (0.100.0): pages queued to be improved from the current site's words, and a page put back to them.
  | "content.improve_started"
  // Prepare the content (0.100.0): the one consent for keyword research, the plan and the Home page's draft.
  | "content.prepare_started"
  // Prepare the content's plan or Home draft didn't start after the research (Fable's review M3).
  | "content.prepare_stopped"
  | "content.page_reverted_to_kept"
  | "content.page_edited"
  | "content.page_approved"
  | "content.comment_added"
  | "content.comment_resolved"
  | "content.ai_checked"
  | "content.client_decision"
  | "site.build_started"
  | "site.build_stalled"
  | "site.built"
  | "site.preview_started"
  | "site.wordpress_package_made"
  | "site.wp_preview_started"
  | "site.wp_preview_deployed"
  | "site.wp_preview_remove_started"
  | "site.wp_preview_removed"
  // Previews on the preview domain at 20i (12 October 2026).
  | "site.wp_preview_holder_created"
  | "site.wp_preview_move_refused"
  | "site.wp_preview_moved"
  | "site.wp_preview_move_confirmed"
  | "site.wp_preview_moved_back"
  | "site.wp_preview_move_back_failed"
  | "site.wp_preview_holder_test_started"
  | "site.wp_preview_holder_test_done"
  | "site.wp_preview_holder_switched_on"
  | "site.wp_preview_holder_test_abandoned"
  | "site.wp_login_shown"
  | "site.wp_domain_on_bluehost"
  // Build B on 20i (5 October 2026).
  | "site.wp_package_created"
  | "site.wp_package_deleted"
  | "site.wp_domain_on_host"
  | "site.wp_cert_requested"
  | "site.wp_cert_issued"
  | "site.wp_cert_renewed"
  | "site.wp_cert_failed"
  | "site.wp_cert_confirmed"
  | "site.wp_paid_cert_confirmed"
  | "site.wp_ip_changed"
  | "site.wp_ip_fixed"
  | "site.wp_suspended"
  | "site.wp_restored"
  | "site.wp_suspend_requested"
  | "site.wp_cache_purged"
  | "site.wp_limit_confirmed"
  | "site.wp_golive_started"
  | "site.wp_rollback_started"
  | "project.form_plugin_changed"
  | "site.preview_deployed"
  | "site.preview_decision"
  | "site.edit_requested"
  | "mockups.home_words_writing"
  | "mockups.home_words_used"
  | "mockups.home_words_written"
  // The wireframe (3 October 2026).
  | "mockups.wireframe_saved"
  | "mockups.wireframe_approved"
  | "mockups.wireframe_reset"
  | "mockups.wireframe_switched"
  | "intake.current_site_read_again"
  // Keep the current site (6 October 2026).
  | "content.site_import_started"
  | "content.site_import_used"
  | "content.site_import_archive"
  | "content.site_import_archive_busy"
  // One read of the current site (0.96.0): the plan made or updated by itself, intake answers filled from the site.
  | "content.kept_plan_updated"
  | "intake.prefilled_from_site"
  // Blocked sites (Part D): a paid read through Jina Reader or Zyte, and a route past its monthly cap.
  | "content.blocked_site_read"
  | "content.blocked_route_capped"
  | "content.blocked_route_stopped"
  | "content.blocked_read_approved"
  | "settings.blocked_route_cap_changed"
  | "site.quote_answered"
  | "site.invoice_saved"
  | "pricing.included_hours_changed"
  | "site.edit_started"
  | "site.edit_made"
  | "site.edit_closed"
  | "site.time_logged"
  | "pricing.addon_saved"
  | "project.addon_added"
  | "project.addon_removed"
  | "project.addon_priced"
  | "project.addon_quantity_changed"
  | "project.hosting_changed"
  | "logo.design_started"
  | "logo.designed"
  | "logo.chosen"
  | "design_md.created"
  | "design_md.failed"
  | "health.flag_confirmed"
  | "tracking.saved"
  | "seo.connection_tested"
  | "seo.dma_list_loaded"
  | "mockups.logo_swap_started"
  | "mockups.logo_swapped"
  | "mockups.logo_approved"
  | "design.pages_confirmed"
  | "design.pages_renamed"
  | "design.site_tidy_started"
  | "design.site_tidied"
  | "design.link_rules_saved"
  | "design.seo_suggest_started"
  | "design.seo_suggested"
  | "design.seo_approved"
  | "design.kit_repair_undone"
  | "design.suggestion_decided"
  | "design.review_skipped"
  | "design.exact_approved"
  | "design.mobile_started"
  | "design.mobile_made"
  | "design.mobile_decided"
  | "design.exact_copies_started"
  | "figma.upload_started"
  | "figma.new_read_started"
  | "figma.new_read_band_corrected"
  | "figma.new_read_word_corrected"
  | "figma.new_read_picture_corrected"
  | "figma.new_read_pictures_prepared"
  | "figma.new_page_build_started"
  | "figma.upload_read"
  | "golive.fee_paid"
  | "golive.fee_unpaid"
  | "golive.domain_confirmed"
  | "golive.email_read"
  | "golive.cloudflare_ready"
  | "golive.email_verified"
  | "golive.email_confirmed"
  | "golive.netlify_domain"
  | "golive.nameservers_switched"
  | "golive.registry_checked"
  | "golive.domain_detected"
  | "golive.path_chosen"
  | "golive.records_ok"
  | "golive.client_link_made"
  | "golive.client_said_done"
  | "forms.bounced"
  | "forms.test_sent"
  | "forms.test_confirmed"
  | "forms.message_viewed"
  | "forms.message_resent"
  | "delivery.inboxes_saved"
  | "delivery.test_sent"
  | "delivery.test_answered"
  | "delivery.site_form_missing"
  | "delivery.preview_form_checked"
  | "site.speed_checked"
  | "site.speed_overridden"
  // The page-by-page review (3 October 2026).
  | "site.page_approved"
  | "site.pages_approved_unchanged"
  | "site.page_approval_withdrawn"
  | "site.pages_overridden"
  // Fix these (3 October 2026).
  | "site.page_fix_started"
  | "site.page_fixed"
  // Done / Not done after a fix (3c, 5 October 2026).
  | "site.page_comment_done"
  | "site.page_comment_not_done"
  | "golive.https_confirmed"
  | "golive.https_not_ready"
  | "golive.ga4_recorded"
  // From 0.49.0 only (the tick was removed in 0.50.0); kept so old log rows still read.
  | "golive.counsel_reviewed"
  | "privacy_law.checked"
  | "privacy_law.reviewed"
  | "golive.went_live"
  | "golive.rolled_back"
  | "golive.failed"
  | "system.e2e_check"
  | "bluehost.key_made"
  | "bluehost.check_started"
  | "bluehost.host_key_forgotten"
  | "bluehost.host_key_trusted"
  | "twentyi.key_made"
  | "twentyi.check_started"
  | "twentyi.package_type_chosen"
  | "twentyi.cert_path_chosen"
  | "ssh.host_key_trusted"
  | "ssh.host_key_forgotten"
  | "mockups.reference_study_started"
  | "mockups.references_studied"
  | "mockups.photo_text_started"
  | "mockups.photo_text_checked"
  | "mockups.polish_started"
  | "mockups.polished"
  | "seo.site_check_started"
  | "seo.site_checked"
  | "seo.redirect_edited"
  | "seo.audit_started"
  | "seo.audit_reported"
  | "seo.golive_check_started"
  | "seo.golive_checked"
  | "seo.golive_signed_off"
  | "seo.safe_fixes_applied"
  | "project.price_changed"
  | "project.cancelled"
  | "project.cancellation_undone"
  | "intake.prefilled"
  | "intake.prefill_confirmed"
  | "intake.prefill_corrected"
  | "settings.monthly_limit_changed"
  | "settings.step_model_changed"
  | "slack.connected"
  | "slack.replaced"
  | "slack.disconnected"
  // The team's Slack channel on System (29 September 2026).
  | "team_slack.connected"
  | "team_slack.replaced"
  | "team_slack.disconnected";

export type ActivityEntityType = "user" | "project" | "session" | "setting";

/*
  The very first admin is created by a command on the server, with nobody
  signed in to credit it to. Those entries record no actor id - there is no
  user row to point at - but still name the actor in plain text, so the log
  says who did it without inventing a foreign key that cannot exist.
*/
export const SYSTEM_ACTOR_ID = "system";

export function actorFields(actor: { id: string; email: string }): {
  actorUserId: string | null;
  actorEmail: string;
} {
  return {
    actorUserId: actor.id === SYSTEM_ACTOR_ID ? null : actor.id,
    actorEmail: actor.email,
  };
}

export interface RecordActivityInput {
  action: ActivityAction;
  entityType: ActivityEntityType;
  entityId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  valueBefore?: unknown;
  valueAfter?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  /** Tests pass a fixed time; production leaves it out. */
  occurredAt?: Date;
}

/** Stable across key order, so the same entry always hashes the same way. */
function canonical(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function computeEntryHash(
  entry: {
    occurredAt: Date;
    actorUserId: string | null;
    actorEmail: string | null;
    action: string;
    entityType: string;
    entityId: string | null;
    valueBefore: unknown;
    valueAfter: unknown;
    ipAddress: string | null;
    userAgent: string | null;
  },
  prevHash: string | null,
): string {
  return createHash("sha256")
    .update(
      canonical({
        prevHash,
        occurredAt: entry.occurredAt.toISOString(),
        actorUserId: entry.actorUserId,
        actorEmail: entry.actorEmail,
        action: entry.action,
        entityType: entry.entityType,
        entityId: entry.entityId,
        valueBefore: entry.valueBefore ?? null,
        valueAfter: entry.valueAfter ?? null,
        ipAddress: entry.ipAddress,
        userAgent: entry.userAgent,
      }),
    )
    .digest("hex");
}

// Any constant works; it only has to be the same everywhere.
const CHAIN_LOCK_KEY = 4815162342;

/*
  Appends one entry.

  Runs inside a transaction holding an advisory lock, so two simultaneous
  actions cannot both read the same previous fingerprint and produce a forked
  chain. The lock is released automatically when the transaction ends.
*/
export async function recordActivity(
  db: Database,
  input: RecordActivityInput,
): Promise<void> {
  const entry = {
    occurredAt: input.occurredAt ?? new Date(),
    actorUserId: input.actorUserId ?? null,
    actorEmail: input.actorEmail ?? null,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId ?? null,
    valueBefore: input.valueBefore ?? null,
    valueAfter: input.valueAfter ?? null,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  };

  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(${CHAIN_LOCK_KEY})`);

    const [previous] = await tx
      .select({ hash: activityLog.hash })
      .from(activityLog)
      .orderBy(desc(activityLog.seq))
      .limit(1);

    const prevHash = previous?.hash ?? null;

    await tx.insert(activityLog).values({
      ...entry,
      prevHash,
      hash: computeEntryHash(entry, prevHash),
    });
  });
}

export interface ChainVerificationResult {
  valid: boolean;
  entriesChecked: number;
  /** seq of the first entry that does not match, if any. */
  brokenAtSeq: number | null;
  reason: string | null;
}

/* The rows read at a time, so the check's memory stays flat however long the log grows. */
const CHAIN_BATCH = 2_000;

interface ChainWalk extends ChainVerificationResult {
  /** The last entry that verified (where the next check starts). */
  lastSeq: number | null;
  lastHash: string | null;
}

/*
  Walks the log in order from just after `from` (the start when null) and
  recomputes every fingerprint, in batches.

  A mismatch means an entry was altered, removed or inserted out of band -
  which the trigger should have made impossible.
*/
async function walkChain(db: Database, from: { seq: number; hash: string } | null): Promise<ChainWalk> {
  let expectedPrev: string | null = from?.hash ?? null;
  let afterSeq = from?.seq ?? 0;
  let checked = 0;

  for (;;) {
    const rows = await db
      .select()
      .from(activityLog)
      .where(gt(activityLog.seq, afterSeq))
      .orderBy(asc(activityLog.seq))
      .limit(CHAIN_BATCH);

    for (const row of rows) {
      checked += 1;
      const broken = (reason: string): ChainWalk => ({
        valid: false,
        entriesChecked: checked,
        brokenAtSeq: row.seq,
        reason,
        lastSeq: afterSeq || null,
        lastHash: expectedPrev,
      });

      if (row.prevHash !== expectedPrev) return broken("entry does not link to the one before it");

      const recomputed = computeEntryHash(
        {
          occurredAt: row.occurredAt,
          actorUserId: row.actorUserId,
          actorEmail: row.actorEmail,
          action: row.action,
          entityType: row.entityType,
          entityId: row.entityId,
          valueBefore: row.valueBefore,
          valueAfter: row.valueAfter,
          ipAddress: row.ipAddress,
          userAgent: row.userAgent,
        },
        row.prevHash,
      );
      if (recomputed !== row.hash) return broken("entry contents do not match its fingerprint");

      expectedPrev = row.hash;
      afterSeq = row.seq;
    }

    if (rows.length < CHAIN_BATCH) break;
  }

  return { valid: true, entriesChecked: checked, brokenAtSeq: null, reason: null, lastSeq: afterSeq || null, lastHash: expectedPrev };
}

/* The whole log, checked from the start (nothing saved). */
export async function verifyActivityChain(db: Database): Promise<ChainVerificationResult> {
  const { valid, entriesChecked, brokenAtSeq, reason } = await walkChain(db, null);
  return { valid, entriesChecked, brokenAtSeq, reason };
}

/*
  Where the log was last checked to, and the last full check (13 October
  2026, the whole-code review: the Activity page re-checked the whole log
  on every visit, slower forever). The page checks only what was added
  since `seq`; the worker's daily work checks everything again, so an old
  entry altered out of band is still found within a day.
*/
export const ACTIVITY_CHECK_SETTING = "activity_chain_check";

export interface ActivityCheckState {
  seq?: number | null;
  hash?: string | null;
  checkedAt?: string;
  full?: { at: string; entries: number; valid: boolean; brokenAtSeq: number | null; reason: string | null };
}

export interface ActivityCheckResult extends ChainVerificationResult {
  /** The last full check, if one has run. */
  full: ActivityCheckState["full"] | null;
}

async function checkState(db: Database): Promise<ActivityCheckState> {
  const [row] = await db.select().from(appSetting).where(eq(appSetting.key, ACTIVITY_CHECK_SETTING)).limit(1);
  return (row?.value as ActivityCheckState | undefined) ?? {};
}

/*
  Merged into the stored state in one statement, so a page visit and the
  daily check running at once never undo each other (CodeRabbit, PR #10):
  the checkpoint only moves forward, and the first page check's "full" is
  written only when no full check has saved one (a break found meanwhile
  stays).
*/
export async function saveCheckState(
  db: Database,
  patch: { checkpoint?: { seq: number | null; hash: string | null; checkedAt: string }; full?: ActivityCheckState["full"]; fullOnlyIfNone?: boolean },
): Promise<void> {
  const checkpoint = patch.checkpoint ? JSON.stringify(patch.checkpoint) : "{}";
  const seq = patch.checkpoint?.seq ?? 0;
  const full = patch.full ? JSON.stringify({ full: patch.full }) : "{}";
  const current = sql`coalesce(${appSetting.value}, '{}'::jsonb)`;
  await db
    .insert(appSetting)
    .values({ key: ACTIVITY_CHECK_SETTING, value: { ...(patch.checkpoint ?? {}), ...(patch.full ? { full: patch.full } : {}) } })
    .onConflictDoUpdate({
      target: appSetting.key,
      set: {
        value: sql`(case when coalesce((${current}->>'seq')::bigint, 0) <= ${seq} then ${current} || ${checkpoint}::jsonb else ${current} end)
          || (case when ${patch.fullOnlyIfNone ?? false} and ${current} ? 'full' then '{}'::jsonb else ${full}::jsonb end)`,
        updatedAt: new Date(),
      },
    });
}

/* The Activity page's check: only the entries added since the last good check. The first time ever, the whole log. */
export async function checkActivityChainSince(db: Database): Promise<ActivityCheckResult> {
  const state = await checkState(db);
  // A full check that found a break keeps saying so until the next full check.
  if (state.full && !state.full.valid) {
    return { valid: false, entriesChecked: state.full.entries, brokenAtSeq: state.full.brokenAtSeq, reason: state.full.reason, full: state.full };
  }
  const from = state.seq && state.hash ? { seq: state.seq, hash: state.hash } : null;
  const walk = await walkChain(db, from);
  const at = new Date().toISOString();
  if (walk.valid) {
    // The first check from the start is a full check too.
    const full = from ? state.full : { at, entries: walk.entriesChecked, valid: true, brokenAtSeq: null, reason: null };
    await saveCheckState(db, { checkpoint: { seq: walk.lastSeq, hash: walk.lastHash, checkedAt: at }, ...(from ? {} : { full, fullOnlyIfNone: true }) });
    return { valid: true, entriesChecked: walk.entriesChecked, brokenAtSeq: null, reason: null, full: full ?? null };
  }
  return { valid: false, entriesChecked: walk.entriesChecked, brokenAtSeq: walk.brokenAtSeq, reason: walk.reason, full: state.full ?? null };
}

/* The daily full check (the worker): the whole log again, in batches. */
export async function checkActivityChainFull(db: Database): Promise<ActivityCheckResult> {
  const walk = await walkChain(db, null);
  const at = new Date().toISOString();
  const full = { at, entries: walk.entriesChecked, valid: walk.valid, brokenAtSeq: walk.brokenAtSeq, reason: walk.reason };
  await saveCheckState(db, walk.valid ? { checkpoint: { seq: walk.lastSeq, hash: walk.lastHash, checkedAt: at }, full } : { full });
  return { valid: walk.valid, entriesChecked: walk.entriesChecked, brokenAtSeq: walk.brokenAtSeq, reason: walk.reason, full };
}
