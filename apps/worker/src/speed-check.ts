import { eq } from "drizzle-orm";
import { getDb } from "@tawd/core/db";
import { speedCheck } from "@tawd/core/schema";
import type { SpeedCheckJobData } from "@tawd/core/queue";
import { pageSpeedUrl, readPageSpeed, type SpeedResult } from "@tawd/core/site";

/*
  The Speed check (1 October 2026): Google PageSpeed on a preview, on a
  phone and a computer, both at once. Free (Google's API, with VML's key
  when it's set), no AI, no browser of TAWD's own.
*/

type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
let pageSpeedFetch: Fetch | null = null;

/** Tests pass a stand-in for Google PageSpeed. */
export function setSpeedCheckFetchForTesting(stand: Fetch | null): void {
  pageSpeedFetch = stand;
}

async function oneDevice(url: string, strategy: "mobile" | "desktop"): Promise<SpeedResult> {
  const key = process.env.PAGESPEED_API_KEY?.trim() || null;
  const response = await (pageSpeedFetch ?? fetch)(pageSpeedUrl(url, strategy, key), { signal: AbortSignal.timeout(120_000) });
  const body = (await response.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!response.ok) {
    const reason = body?.error?.message ?? `it answered ${response.status}`;
    // Without VML's key, every Google user shares one small daily allowance.
    if (/quota/i.test(reason)) throw new Error(key ? "Google's daily PageSpeed allowance for VML's key is used up: try again tomorrow." : "Google's shared free allowance is used up for today: an admin adds PAGESPEED_API_KEY (Coolify, tawd-web-new and tawd-worker-new) for VML's own allowance.");
    throw new Error(`PageSpeed couldn't check the page: ${reason.slice(0, 300)}`);
  }
  const read = readPageSpeed(body);
  if (!read) throw new Error("PageSpeed's answer had no scores.");
  return read;
}

export async function runSpeedCheckJob(data: SpeedCheckJobData): Promise<void> {
  const db = getDb();
  const [row] = await db.select().from(speedCheck).where(eq(speedCheck.id, data.checkId)).limit(1);
  if (!row || row.status !== "queued") return;
  try {
    const [mobile, desktop] = await Promise.all([oneDevice(row.url, "mobile"), oneDevice(row.url, "desktop")]);
    await db.update(speedCheck).set({ status: "done", results: { mobile, desktop }, error: null, finishedAt: new Date() }).where(eq(speedCheck.id, row.id));
  } catch (error) {
    await db
      .update(speedCheck)
      .set({ status: "failed", error: error instanceof Error ? error.message : "PageSpeed didn't answer.", finishedAt: new Date() })
      .where(eq(speedCheck.id, row.id));
  }
}
