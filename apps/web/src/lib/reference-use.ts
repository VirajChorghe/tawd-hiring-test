import { and, eq, isNotNull } from "drizzle-orm";

import { conceptVersion, likedSiteShot } from "@tawd/core/schema";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { loadIntake } from "@tawd/core/intake/service";
import { likedNoteFor } from "@tawd/core/intake";
import { getStorage } from "@tawd/core/intake/storage";
import { conceptOutline, referenceUse, type ReferenceOutline, type ReferenceUse } from "@tawd/core/mockups";
import type { ServiceContext } from "@/lib/users";
import { wireframeSetsOrder } from "@/lib/wireframe";

/*
  How much of each reference site a concept used (Jason, 7 October 2026):
  measured by code from the concept's saved homepage and each studied
  site's outline (core reference-use.ts), free. Worked out the first time
  a version is shown and saved on it; again only when the reference sites
  change.
*/

type Db = ServiceContext["db"];

export interface ConceptReferenceUse {
  /** The average over the sites, 0 to 100. */
  percent: number;
  sites: (ReferenceUse & { liked: string })[];
  /** An approved wireframe set the section order, not the references. */
  orderFromWireframe: boolean;
}

interface Stored {
  urls: string[];
  items: ReferenceUse[];
}

export async function loadReferenceUse(
  db: Db,
  projectId: string,
  version: { id: string; htmlKey: string | null; referenceUse: unknown },
): Promise<ConceptReferenceUse | null> {
  const shots = await db
    .select({ url: likedSiteShot.url, outline: likedSiteShot.outline })
    .from(likedSiteShot)
    .where(and(eq(likedSiteShot.projectId, projectId), isNotNull(likedSiteShot.outline)));
  if (shots.length === 0 || !version.htmlKey) return null;
  const urls = shots.map((s) => s.url).sort();
  let stored = version.referenceUse as Stored | null;
  if (!stored || stored.urls.join(" ") !== urls.join(" ")) {
    const html = await getStorage()
      .get(version.htmlKey)
      .catch(() => null);
    if (!html) return null;
    const mine = conceptOutline(html.toString("utf8"));
    stored = { urls, items: shots.map((s) => referenceUse(s.url, s.outline as ReferenceOutline, mine)) };
    await db.update(conceptVersion).set({ referenceUse: stored }).where(eq(conceptVersion.id, version.id));
  }
  const website = (await loadIntake(db, SYSTEM_ACTOR, projectId).catch(() => null))?.data.website;
  return {
    percent: Math.round(stored.items.reduce((sum, i) => sum + i.percent, 0) / stored.items.length),
    sites: stored.items.map((i) => ({ ...i, liked: website ? likedNoteFor(website, i.url) : "" })),
    orderFromWireframe: await wireframeSetsOrder(db, projectId),
  };
}
