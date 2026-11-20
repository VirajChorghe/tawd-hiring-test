import { after } from "next/server";

import { postProjectSlack, type SlackEvent } from "@tawd/core/slack";
import type { ServiceContext } from "@/lib/users";

/*
  Posting to Slack from the web app, after the action has answered.

  Inside a request, Next's after() runs the post once the response has
  gone, so the person never waits on Slack. Outside one (tests, scripts)
  it starts straight away and is tracked, so a test can wait for it.
  postProjectSlack itself never throws; this never throws either.
*/

const pending = new Set<Promise<unknown>>();

export function notifySlack(db: ServiceContext["db"], projectId: string, event: SlackEvent): void {
  const task = () => postProjectSlack(db, projectId, event);
  try {
    after(task);
  } catch {
    const running = task().finally(() => pending.delete(running));
    pending.add(running);
  }
}

/** For tests: wait for every post started outside a request. */
export async function settleSlackPosts(): Promise<void> {
  await Promise.all([...pending]);
}
