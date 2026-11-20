import { eq } from "drizzle-orm";

import { actorFields, recordActivity } from "@tawd/core/activity";
import { assertCan, can, type Viewer } from "@tawd/core/permissions";
import { project } from "@tawd/core/schema";
import { readVideoLinks, type SiteVideo } from "@tawd/core/site";
import type { ServiceContext } from "@/lib/users";

/*
  The client's social videos (Jason, 29 September 2026): TikTok and
  Instagram links, pasted one per line (a title after " | "), kept on the
  project. The site build makes them a Videos page and the home page's
  featured videos, as click-to-play thumbnails.
*/

export class SiteVideosError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SiteVideosError";
  }
}

export async function saveSiteVideos(ctx: ServiceContext, actor: Viewer, projectId: string, text: string): Promise<{ saved: number; rejected: string[] }> {
  if (!can(actor, "project.edit") && !can(actor, "design.decide")) assertCan(actor, "project.edit");
  const { videos, rejected } = readVideoLinks(text);
  if (rejected.length && videos.length === 0) throw new SiteVideosError(`None of these is a TikTok or Instagram video link: ${rejected.slice(0, 3).join("; ")}.`);
  await ctx.db.update(project).set({ videos }).where(eq(project.id, projectId));
  await recordActivity(ctx.db, {
    action: "project.videos_saved",
    entityType: "project",
    entityId: projectId,
    ...actorFields(actor),
    valueAfter: { videos: videos.map((v) => v.url), rejected },
    ipAddress: ctx.ipAddress,
    userAgent: ctx.userAgent,
  });
  return { saved: videos.length, rejected };
}

export async function loadSiteVideos(db: ServiceContext["db"], projectId: string): Promise<SiteVideo[]> {
  const [row] = await db.select({ videos: project.videos }).from(project).where(eq(project.id, projectId)).limit(1);
  return (row?.videos as SiteVideo[] | null) ?? [];
}

/* The saved videos as the text box shows them. */
export function videosText(videos: SiteVideo[]): string {
  return videos.map((v) => (v.title ? `${v.url} | ${v.title}` : v.url)).join("\n");
}
