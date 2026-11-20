import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getDb } from "@tawd/core/db";
import { can } from "@tawd/core/permissions";
import { Banner } from "@/components/ui/banner";
import { PrivacyLawActions, PrivacyReview } from "@/components/admin/privacy-law-actions";
import { formatWhen } from "@/lib/labels";
import { loadPrivacyLaws } from "@/lib/privacy-laws";
import { requireUser } from "@/lib/session";
import { listPeopleNames } from "@/lib/users";

export const metadata: Metadata = { title: "Privacy laws - TAWD" };
export const dynamic = "force-dynamic";

const COVERAGE: Record<string, string> = { yes: "Usually", maybe: "Sometimes", no: "Rarely" };

/*
  The state privacy rules (28 September 2026): every rule, what it applies
  to, its wording, its official source and when it was last checked; the
  quarterly review. Admins only. The wording is changed in docs/policies,
  then checked here.
*/
export default async function PrivacyLawsPage() {
  const current = await requireUser();
  if (!can(current, "settings.manage")) redirect("/projects");
  const db = getDb();
  const people = await listPeopleNames(db);
  const { rows, review, reviewDue } = await loadPrivacyLaws(db, people);
  const stale = rows.filter((r) => r.stale).length;

  return (
    <div className="page">
      <div className="page-head spend-head">
        <div>
          <h1 className="page-title">Privacy laws</h1>
          <p className="page-lede">
            The state sections added to every site&rsquo;s privacy policy, for the states its address, locations or service areas are in. Each is checked
            against its official source; a state unchecked for three months is flagged on its projects. Admins only.
          </p>
        </div>
      </div>

      {reviewDue ? (
        <Banner tone="warning" title="Time for the quarterly review">
          Open each rule&rsquo;s official source, check the law hasn&rsquo;t changed, update docs/policies if it has, then record the review below.
        </Banner>
      ) : null}

      <div className="card content-card privacy-review">
        <div>
          <h2 className="card-title">Quarterly review</h2>
          <p className="hint">
            {review ? `Last reviewed ${formatWhen(review.at)}${review.by ? ` by ${people.get(review.by) ?? "a team member"}` : ""}.` : "Not reviewed in TAWD yet; the rules were checked against their sources on the dates below."}{" "}
            {stale ? `${stale} rule${stale === 1 ? " is" : "s are"} over three months old.` : "Every rule was checked within three months."}
          </p>
        </div>
        <PrivacyReview />
      </div>

      <div className="card privacy-laws">
        <table className="exact-pages">
          <thead>
            <tr>
              <th>State</th>
              <th>Law</th>
              <th>Applies to</th>
              <th>Wording</th>
              <th>Source</th>
              <th>Last checked</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ rule, lastChecked, checkedBy, stale: old }) => (
              <tr key={rule.key}>
                <td>
                  <strong>{rule.stateName}</strong>
                </td>
                <td>
                  {rule.lawName}
                  <br />
                  <span className="hint">{rule.citation}</span>
                </td>
                <td className="hint">
                  <span className="badge badge-info">Small local business: {COVERAGE[rule.coverage] ?? rule.coverage}</span>
                  <br />
                  {rule.appliesTo}
                </td>
                <td className="hint">
                  {rule.addOn.trim() ? (
                    <details>
                      <summary>{rule.healthOnly ? "Health projects only" : "The section"}</summary>
                      <pre className="privacy-wording">{rule.addOn}</pre>
                    </details>
                  ) : (
                    "No section (the baseline covers it)"
                  )}
                  {rule.notes ? <p className="hint">{rule.notes}</p> : null}
                </td>
                <td className="hint">
                  {rule.sourceUrls.length ? (
                    rule.sourceUrls.map((url) => (
                      <a key={url} href={url} target="_blank" rel="noreferrer" className="privacy-source">
                        {url.replace(/^https?:\/\//, "").slice(0, 48)}
                      </a>
                    ))
                  ) : (
                    <span className="hint-amber">No official source reached</span>
                  )}
                </td>
                <td>
                  <span className={old ? "badge badge-warning" : "badge badge-done"}>{lastChecked.getTime() === 0 ? "Not verified" : lastChecked.toISOString().slice(0, 10)}</span>
                  {checkedBy ? <span className="hint"> by {checkedBy}</span> : null}
                  <PrivacyLawActions lawKey={rule.key} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
