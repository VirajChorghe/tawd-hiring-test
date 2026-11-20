import { eq } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { hostingAccountCheck } from "@tawd/core/schema";
import { PACKAGE_LIMIT, PACKAGE_WARN_AT, PREVIEW_HOLDER_SETTING, TWENTYI_NEXT_PLAN, nextPlanWords, previewDomainSetting, type AccountCheckItem, type AccountCheckResult, type PreviewHolderState } from "@tawd/core/wp-preview";
import type { TwentyiCheckJobData } from "@tawd/core/queue";

import { getTwentyi, TwentyiError } from "./twentyi";
import { setting } from "./wp-preview";

/*
  "Check the 20i account" (Build B on 20i, 5 October 2026): read-only calls
  to 20i's API with the worker's TWENTYI_API_KEY. Whether the key works,
  how many packages the account holds (20i's own count, which includes any
  sites VML keeps there outside TAWD), the package types (an admin chooses
  TAWD's on System). 20i's API has no list of data centres (20i.apib):
  a package goes where VML's account puts it. No AI, no SSH, nothing changed.
*/
export async function runTwentyiCheckJob(job: TwentyiCheckJobData): Promise<void> {
  const db = getDb();
  const [check] = await db.select().from(hostingAccountCheck).where(eq(hostingAccountCheck.id, job.checkId)).limit(1);
  if (!check || check.status !== "queued") return;
  await db.update(hostingAccountCheck).set({ status: "working" }).where(eq(hostingAccountCheck.id, check.id));

  const api = getTwentyi();
  const items: AccountCheckItem[] = [];
  let packages: number | null = null;
  let types: { id: string; label: string }[] = [];
  let keyWorks = false;

  try {
    const list = await api.listPackages();
    packages = list.length;
    keyWorks = true;
    items.push({ key: "key", label: "TAWD's 20i API key", state: "yes", detail: "20i accepted it." });
    items.push({
      key: "packages",
      label: "Packages used",
      state: packages >= PACKAGE_LIMIT ? "no" : packages >= PACKAGE_WARN_AT ? "warn" : "yes",
      detail:
        packages >= PACKAGE_LIMIT
          ? `${packages} of ${PACKAGE_LIMIT}: the next site moves VML to ${nextPlanWords()}. An admin confirms it on the project's Build page.`
          : `${packages} of ${PACKAGE_LIMIT}${packages >= PACKAGE_WARN_AT ? `: ${PACKAGE_LIMIT - packages} left before ${TWENTYI_NEXT_PLAN.name}` : ""}.`,
    });
    // The preview domain's placeholder (12 October 2026): one of the packages above, never a client's site.
    const previewDomain = previewDomainSetting();
    if (previewDomain) {
      const state = (await setting<PreviewHolderState>(PREVIEW_HOLDER_SETTING)) ?? {};
      const holder = list.find((p) => p.name === previewDomain || p.names.includes(previewDomain));
      const result = state.result ? ` Switch-off check (${state.result.at.slice(0, 10)}): ${state.result.note}` : state.test ? " The switch-off check is running." : "";
      items.push(
        holder
          ? {
              key: "holder",
              label: `Placeholder for ${previewDomain}`,
              state: holder.enabled || state.test ? "yes" : "no",
              detail: `Package ${holder.id}${holder.enabled ? "" : " (switched off at 20i: TAWD switches it back on)"}: it lets previews use ${previewDomain}, and counts as one of the ${PACKAGE_LIMIT}. Never suspend or delete it in My20i.${result}`,
            }
          : { key: "holder", label: `Placeholder for ${previewDomain}`, state: "warn", detail: `Not made yet: TAWD makes it at the next WordPress deploy (one of the ${PACKAGE_LIMIT} packages).` },
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : "20i didn't answer.";
    items.push({ key: "key", label: "TAWD's 20i API key", state: "no", detail: message });
    if (error instanceof TwentyiError && (error.kind === "config" || error.kind === "auth")) {
      await finish(check.id, { items, keyWorks, packages, types });
      return;
    }
  }

  try {
    types = (await api.listPackageTypes()).map((t) => ({ id: t.id, label: t.label }));
    items.push(
      types.length
        ? { key: "types", label: "Package types", state: "yes", detail: `${types.length}: ${types.map((t) => t.label).join(", ")}. An admin chooses the one TAWD uses (below).` }
        : { key: "types", label: "Package types", state: "warn", detail: "None yet. Make one in My20i (Linux, WordPress-capable), then check again." },
    );
  } catch (error) {
    items.push({ key: "types", label: "Package types", state: "no", detail: error instanceof Error ? error.message : "20i didn't answer." });
  }

  await finish(check.id, { items, keyWorks, packages, types });
}

async function finish(checkId: string, results: AccountCheckResult): Promise<void> {
  await getDb().update(hostingAccountCheck).set({ status: "done", results, finishedAt: new Date() }).where(eq(hostingAccountCheck.id, checkId));
}

export async function markTwentyiCheckFailed(checkId: string, message: string): Promise<void> {
  await getDb().update(hostingAccountCheck).set({ status: "failed", failureReason: message.slice(0, 1000), finishedAt: new Date() }).where(eq(hostingAccountCheck.id, checkId));
}
