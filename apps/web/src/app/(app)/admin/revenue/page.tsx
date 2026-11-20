import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { Banner } from "@/components/ui/banner";
import { ButtonLink } from "@/components/ui/button";
import { dayLabel, formatMoney, loadRevenue, monthLabel } from "@/lib/pricing";
import { monthMinutesByProject } from "@/lib/edits";
import { includedHoursByTier } from "@/lib/updates";
import { project as projectTable } from "@tawd/core/schema";
import { hoursStanding } from "@tawd/core/site";
import { requireUser } from "@/lib/session";

export const metadata: Metadata = { title: "Revenue - TAWD" };
export const dynamic = "force-dynamic";

/*
  What the clients pay, counted from the day each site went live. Admins
  only. Going live counts as paid: the build fee in the month it went live,
  the monthly fee every month from then until the month it was cancelled.
  No card or payment data: this is a tracker, not a till.
*/
export default async function RevenuePage() {
  const current = await requireUser();
  if (!can(current, "money.manage")) redirect("/projects");

  const report = await loadRevenue(getDb());
  const minutes = await monthMinutesByProject(getDb());
  // The included hours of each client's tier (Pricing, 1 October 2026).
  const hoursByTier = await includedHoursByTier(getDb());
  const tiers = await getDb().select({ id: projectTable.id, tier: projectTable.tier }).from(projectTable);
  const included = new Map(tiers.map((t) => [t.id, hoursByTier[t.tier as keyof typeof hoursByTier] ?? 8]));
  const { thisMonth } = report;
  const yearTotal = report.months.reduce((sum, m) => sum + m.total, 0);
  const active = report.clients.filter((c) => c.state === "active");
  const money = (cents: number) => formatMoney(cents);

  return (
    <div className="page">
      <div className="page-head spend-head">
        <div>
          <h1 className="page-title">Revenue</h1>
          <p className="page-lede">What the clients pay, counted from the day each site went live. Admins only.</p>
        </div>
        <ButtonLink href="/admin/pricing">Pricing</ButtonLink>
      </div>

      {report.unpriced.length > 0 ? (
        <div style={{ marginBottom: 24 }}>
          <Banner title={`${report.unpriced.length} live ${report.unpriced.length === 1 ? "client has" : "clients have"} no price`}>
            {report.unpriced.join(", ")} {report.unpriced.length === 1 ? "counts" : "count"} as $0 until an admin sets a price
            under Price and billing on the project.
          </Banner>
        </div>
      ) : null}

      <div className="spend-cards">
        <div className="card spend-card spend-card-wide">
          <p className="spend-card-label">Monthly revenue</p>
          <p className="spend-card-value">{money(thisMonth.monthlyFees)}</p>
          <p className="hint">
            From {thisMonth.liveClients} live client{thisMonth.liveClients === 1 ? "" : "s"} in {monthLabel(thisMonth.month)}
          </p>
        </div>
        <div className="card spend-card">
          <p className="spend-card-label">Build fees this month</p>
          <p className="spend-card-value">{money(thisMonth.buildFees)}</p>
          <p className="hint">Sites that went live in {monthLabel(thisMonth.month).split(" ")[0]}</p>
        </div>
        <div className="card spend-card">
          <p className="spend-card-label">Total this month</p>
          <p className="spend-card-value">{money(thisMonth.total)}</p>
          <p className="hint">Build fees and monthly fees</p>
        </div>
        <div className="card spend-card">
          <p className="spend-card-label">Last 12 months</p>
          <p className="spend-card-value">{money(yearTotal)}</p>
          <p className="hint">
            {monthLabel(report.months[0]!.month)} to {monthLabel(thisMonth.month)}
          </p>
        </div>
      </div>

      <div className="card spend-tabs-card money-table-card">
        <h2 className="card-title money-table-title">By month</h2>
        <div className="table-scroll">
          <table className="spend-table">
            <thead>
              <tr>
                <th>Month</th>
                <th className="align-right">Build fees</th>
                <th className="align-right">Monthly fees</th>
                <th className="align-right">Total</th>
                <th className="align-right">Live clients</th>
              </tr>
            </thead>
            <tbody>
              {[...report.months].reverse().map((m) => (
                <tr key={m.month}>
                  <td>{monthLabel(m.month)}</td>
                  <td className="align-right">{money(m.buildFees)}</td>
                  <td className="align-right">{money(m.monthlyFees)}</td>
                  <td className="align-right">
                    <strong>{money(m.total)}</strong>
                  </td>
                  <td className="align-right">{m.liveClients}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="spend-note">
          A build fee counts in the month the site went live; the monthly fee counts every month from then, up to and
          including the month it was cancelled.
        </p>
      </div>

      <div className="card spend-tabs-card money-table-card">
        <h2 className="card-title money-table-title">
          Live clients <span className="muted-strong">({active.length} active)</span>
        </h2>
        <div className="table-scroll">
          <table className="spend-table">
            <thead>
              <tr>
                <th>Client</th>
                <th>Plan</th>
                <th>Went live</th>
                <th className="align-right">Build fee</th>
                <th className="align-right">Monthly fee</th>
                <th className="align-right">Dev hours this month</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {report.clients.length === 0 ? (
                <tr>
                  <td colSpan={7} className="empty">
                    No site has gone live yet. A project counts here from the day it moves to Live.
                  </td>
                </tr>
              ) : (
                report.clients.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Link href={`/projects/${c.id}`} className="plain-link">
                        <strong>{c.clientName}</strong>
                      </Link>
                    </td>
                    <td>{c.packageName}</td>
                    <td>{dayLabel(c.liveAt!)}</td>
                    <td className={c.buildFeeCents === null ? "align-right money-unset" : "align-right"}>{formatMoney(c.buildFeeCents)}</td>
                    <td className={c.monthlyFeeCents === null ? "align-right money-unset" : "align-right"}>
                      {formatMoney(c.monthlyFeeCents)}
                      {c.monthlyAddonCents ? <span className="hint"> + {formatMoney(c.monthlyAddonCents)} add-on</span> : null}
                    </td>
                    <td className={hoursStanding(minutes.get(c.id) ?? 0, included.get(c.id)).over > 0 ? "align-right content-warn" : "align-right"}>
                      {hoursStanding(minutes.get(c.id) ?? 0, included.get(c.id)).used} of {included.get(c.id) ?? 8}
                    </td>
                    <td>
                      {c.state === "active" ? (
                        <span className="badge badge-done">Active, month {c.monthsLive}</span>
                      ) : (
                        <span className="money-status">
                          <span className="badge badge-info">Cancelled {dayLabel(c.cancelledOn!)}</span>
                          {c.underMinimum ? (
                            <span className="badge badge-warning">Before the 12-month minimum ({c.monthsLive} of 12)</span>
                          ) : null}
                        </span>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <p className="spend-note">No card or payment details are kept in TAWD: going live counts as paid.</p>
      </div>
    </div>
  );
}
