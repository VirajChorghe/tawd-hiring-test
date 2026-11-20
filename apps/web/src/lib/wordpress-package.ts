import { eq } from "drizzle-orm";
import { zipSync } from "fflate";
import { project } from "@tawd/core/schema";
import { formDefinition, themeSlug, wordpressPackage, WpPackageError, type WpPackageReport } from "@tawd/core/site";
import { loadPackageInput } from "@tawd/core/wp-preview";
import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, type Viewer } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import type { Database } from "@tawd/core/db";
import { netlifySetup } from "@/lib/netlify";
import type { ServiceContext } from "@/lib/users";

/*
  Build B, B1 (1 October 2026): "Download the WordPress package". Made on
  the spot from a finished Build A build's files, by code (no AI, no cost,
  nothing sent anywhere): the theme, the pages as blocks, the forms, the
  pictures and install.php. B2 installs the same package on 20i over
  SSH. Logged.
*/

export { WpPackageError };

/* Who the site's forms send to: the Website forms addresses (else the business email), with VML's copy (F1). */
export async function formEmailsFor(db: Database, actor: Viewer, projectId: string): Promise<{ to: string[]; copy: string | null }> {
  const intake = await loadIntake(db, actor, projectId);
  return { to: intake ? formDefinition(intake.data).recipients : [], copy: netlifySetup().copyEmail };
}

export async function makeWordPressPackage(
  ctx: ServiceContext,
  actor: Viewer,
  projectId: string,
  version: number,
): Promise<{ zip: Uint8Array; fileName: string; report: WpPackageReport }> {
  assertCan(actor, "project.edit");
  const [row] = await ctx.db.select({ clientName: project.clientName, formPlugin: project.formPlugin }).from(project).where(eq(project.id, projectId)).limit(1);
  if (!row) throw new WpPackageError("That project no longer exists.");
  const input = await loadPackageInput(ctx.db, projectId, version);
  if (!input) throw new WpPackageError("That build isn't finished, or its files are missing: the package is made from a finished Build A build.");

  const made = wordpressPackage({ clientName: row.clientName, ...input, formEmails: await formEmailsFor(ctx.db, actor, projectId), formPlugin: row.formPlugin === "gravityforms" ? "gravityforms" : "cf7" });

  const folder = `${themeSlug(row.clientName)}-wordpress-v${version}`;
  const entries: Record<string, Uint8Array> = {};
  for (const [path, bytes] of made.files) entries[`${folder}/${path}`] = bytes;

  await recordActivity(ctx.db, {
    action: "site.wordpress_package_made",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { version, pages: made.report.pages, native: made.report.native, html: made.report.html, forms: made.report.forms },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { zip: zipSync(entries, { level: 6 }), fileName: `${folder}.zip`, report: made.report };
}
