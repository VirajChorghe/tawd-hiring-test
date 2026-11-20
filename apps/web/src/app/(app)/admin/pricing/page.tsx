import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { count, isNull } from "drizzle-orm";

import { getDb } from "@tawd/core/db";
import { project, projectAddon } from "@tawd/core/schema";
import { can } from "@tawd/core/permissions";
import { AddonList, PriceList } from "@/components/money/price-list";
import { IncludedHoursCard } from "@/components/money/included-hours";
import { includedHoursByTier } from "@/lib/updates";
import { ButtonLink } from "@/components/ui/button";
import { formatMoney, listAddons, listPackages, moneyInputValue as cents } from "@/lib/pricing";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Pricing - TAWD" };
export const dynamic = "force-dynamic";

/* The price list: each package's build fee and monthly fee. Admins only. */
export default async function PricingPage() {
  const current = await requireUser();
  if (!can(current, "money.manage")) redirect("/projects");

  const db = getDb();
  const packages = await listPackages(db);
  const counts = await db.select({ key: project.packageKey, n: count() }).from(project).groupBy(project.packageKey);
  const addons = await listAddons(db);
  const hours = await includedHoursByTier(db);
  const addonCounts = await db.select({ key: projectAddon.addonKey, n: count() }).from(projectAddon).where(isNull(projectAddon.removedAt)).groupBy(projectAddon.addonKey);

  return (
    <div className="page">
      <div className="page-head spend-head">
        <div>
          <h1 className="page-title">Pricing</h1>
          <p className="page-lede">What each package costs the client: a one-off build fee and a monthly fee. Admins only.</p>
        </div>
        <ButtonLink href="/admin/revenue">Revenue</ButtonLink>
      </div>

      <PriceList
        rows={packages.map((p) => ({
          key: p.key,
          name: p.name,
          buildFee: cents(p.buildFeeCents),
          monthlyFee: cents(p.monthlyFeeCents),
          buildFeeText: formatMoney(p.buildFeeCents),
          monthlyFeeText: formatMoney(p.monthlyFeeCents),
          projects: counts.find((c) => c.key === p.key)?.n ?? 0,
        }))}
      />
      <p className="hint money-note">
        A new project copies its package&rsquo;s prices on the day it is created and keeps them, so a change here only
        reaches projects created afterwards. To change one project&rsquo;s price, use Price and billing on its page. Every
        change is recorded in the activity log. The 12-month minimum applies to every package.
      </p>

      <h2 className="section-title money-subtitle">Included hours a month</h2>
      <IncludedHoursCard hours={hours} />

      <h2 className="section-title money-subtitle">Add-ons</h2>
      <p className="hint money-note" style={{ marginTop: 0, marginBottom: 14 }}>
        Extras added to a project&rsquo;s price. One-off ones count with its build fee: the logo TAWD designs when a client has
        none, and the full SEO audit, priced by the size of the client&rsquo;s current site. Monthly ones count with its monthly
        fee: WordPress hosting, added by itself when a project that isn&rsquo;t Pro moves to WordPress. The client-supplied design is
        priced per page and added by itself when a project&rsquo;s design is read or imported, the page count taken from the design; Pro
        includes both. Hours over the plan, New page and Redesign price the quotes on Updates. A project keeps the price an
        add-on had when it was added; one added before its price was set gets the first price set.
      </p>
      <AddonList
        rows={addons.map((a) => ({
          key: a.key,
          name: a.name,
          price: cents(a.priceCents),
          priceText: formatMoney(a.priceCents),
          quoted: a.quoted,
          monthly: a.monthly,
          perPage: a.perPage,
          projects: addonCounts.find((c) => c.key === a.key)?.n ?? 0,
        }))}
      />
    </div>
  );
}
