import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { ConceptDetailView, type Tab } from "@/components/mockups/concept-detail";
import { getDb } from "@tawd/core/db";
import { loadConceptDetail } from "@/lib/concept-detail";
import { loadPolish } from "@/lib/polish";
import { requireUser } from "@/lib/session";
import { slackWarningFor } from "@/lib/slack-settings";

/*
  One concept: the full render with pinned team comments, the Creative
  Director's review, the checks, the versions, and Request changes.
  ?v=N looks at an earlier version; ?compare=N puts another beside it.
*/

export const metadata: Metadata = { title: "Concept - TAWD" };
export const dynamic = "force-dynamic";

export default async function ConceptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; conceptId: string }>;
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { id, conceptId } = await params;
  const query = (await searchParams) ?? {};
  const current = await requireUser();

  const number = (value: string | string[] | undefined) => {
    const n = Number(Array.isArray(value) ? value[0] : value);
    return Number.isInteger(n) && n > 0 ? n : undefined;
  };

  // A malformed id is simply not found, rather than a database error.
  if (!/^[0-9a-f-]{36}$/i.test(conceptId)) notFound();

  const detail = await loadConceptDetail(getDb(), current, id, conceptId, {
    version: number(query.v),
    compare: number(query.compare),
  });
  if (!detail) notFound();

  const tabs: Tab[] = ["comments", "review", "checks", "versions"];
  const tab = tabs.find((t) => t === query.tab) ?? "comments";

  return (
    <ConceptDetailView
      detail={detail}
      initialTab={tab}
      startRequesting={query.request === "1"}
      slackWarning={await slackWarningFor(getDb(), id)}
      // No critique and polish on the homepage file the team supplied: it is not changed by AI.
      polish={detail.concept.supplied ? null : await loadPolish(getDb(), conceptId)}
    />
  );
}
