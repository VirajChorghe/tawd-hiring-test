import { and, eq, isNull, or } from "drizzle-orm";

import type { Database } from "@tawd/core/db";
import { user } from "@tawd/core/schema";
import { appBaseUrl, slackEscape } from "@tawd/core/slack";
import { deliverMail } from "./mail";
import { postTeamSlack } from "./team-slack";

/*
  A Site check that TAWD ran by itself after a deploy failed (Jason, 29
  September 2026): the admins hear about it three ways: the red strip on
  every page (SiteCheckWarning), an email to every admin through Resend,
  and a post to the team Slack channel when one is set. A check that
  passes says nothing anywhere.
*/
const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export async function alertSiteCheckFailed(db: Database, failure: { version: string; step: string | null; detail: string | null }): Promise<void> {
  const where = failure.step ? ` at "${failure.step}"` : "";
  const what = `The automatic Site check after the ${failure.version} deploy failed${where}.`;
  const link = `${appBaseUrl()}/admin/system#site-check`;
  const detail = failure.detail ? `\n\n${failure.detail}` : "";

  // nosemgrep: ajinabraham.njsscan.generic.error_disclosure.generic_error_disclosure -- the failure goes only to TAWD's own admins by email, escaped
  try {
    const admins = await db
      .select({ id: user.id, email: user.email })
      .from(user)
      .where(and(eq(user.role, "admin"), isNull(user.deletedAt), or(isNull(user.banned), eq(user.banned, false))));
    for (const admin of admins) {
      deliverMail(
        db,
        {
          to: admin.email,
          subject: `TAWD: the Site check after ${failure.version} failed`,
          text: `${what}${detail}\n\nThe live site may have a broken page or step. Open System to see each step and run it again:\n${link}\n\nTAWD emails only when a check fails.`,
          html: `<p>${escape(what)}</p>${failure.detail ? `<p>${escape(failure.detail)}</p>` : ""}<p>The live site may have a broken page or step. <a href="${link}">Open System</a> to see each step and run it again.</p><p style="color:#5b6570">TAWD emails only when a check fails.</p>`,
        },
        { purpose: "site_check_failed", userId: admin.id },
      );
    }
  } catch (error) {
    console.error(`Couldn't email the admins about the Site check: ${error instanceof Error ? error.message : "unknown"}`);
  }

  const slack = await postTeamSlack(db, `:warning: ${slackEscape(what)}${failure.detail ? ` ${slackEscape(failure.detail)}` : ""} <${link}|Open System>`);
  if (slack) console.warn(`The Site check's Slack post didn't go through: ${slack}`);
}
