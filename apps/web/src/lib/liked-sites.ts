import { and, eq, inArray } from "drizzle-orm";

import { likedSiteShot } from "@tawd/core/schema";
import { loadIntake } from "@tawd/core/intake/service";
import { getStorage } from "@tawd/core/intake/storage";
import { SYSTEM_ACTOR } from "@tawd/core/permissions";
import { LIKED_SITES_JOB, likedSitesJobId } from "@tawd/core/queue";
import { getQueue } from "@/lib/mockups";
import type { ServiceContext } from "@/lib/users";

/*
  "Websites they like": after the Website section is saved, each listed
  site gets a screenshot (the worker takes it, once; no AI). A site taken
  off the list loses its screenshot. The team sees thumbnails; the mockup
  builder sees them as inspiration only.
*/

type Db = ServiceContext["db"];

export async function syncLikedSites(ctx: ServiceContext, projectId: string): Promise<void> {
  const intake = await loadIntake(ctx.db, SYSTEM_ACTOR, projectId);
  const urls = [...new Set((intake?.data.website.likedWebsites ?? []).map((u) => u.trim()).filter(Boolean))].slice(0, 3);
  const rows = await ctx.db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));

  const gone = rows.filter((r) => !urls.includes(r.url));
  for (const row of gone) {
    if (row.imageKey) await getStorage().remove(row.imageKey);
    if (row.pageImageKey) await getStorage().remove(row.pageImageKey);
  }
  if (gone.length > 0) await ctx.db.delete(likedSiteShot).where(inArray(likedSiteShot.id, gone.map((r) => r.id)));

  const fresh = urls.filter((url) => !rows.some((r) => r.url === url));
  if (fresh.length > 0) await ctx.db.insert(likedSiteShot).values(fresh.map((url) => ({ projectId, url })));
  const waiting = await ctx.db
    .select({ id: likedSiteShot.id })
    .from(likedSiteShot)
    .where(and(eq(likedSiteShot.projectId, projectId), eq(likedSiteShot.status, "queued")));
  if (waiting.length === 0) return;
  try {
    await getQueue().add(LIKED_SITES_JOB, { projectId }, { jobId: likedSitesJobId(projectId, Date.now()), attempts: 1 });
  } catch {
    // The queue isn't answering: the rows stay queued and go with the next save.
  }
}

export interface LikedShotView {
  url: string;
  status: "queued" | "done" | "failed";
  imageUrl: string | null;
  failureReason: string | null;
}

export async function loadLikedShots(db: Db, projectId: string): Promise<LikedShotView[]> {
  const rows = await db.select().from(likedSiteShot).where(eq(likedSiteShot.projectId, projectId));
  return Promise.all(
    rows.map(async (r) => ({
      url: r.url,
      status: r.status as LikedShotView["status"],
      imageUrl: r.imageKey ? await getStorage().signDownload(r.imageKey, "website.jpg") : null,
      failureReason: r.failureReason,
    })),
  );
}
