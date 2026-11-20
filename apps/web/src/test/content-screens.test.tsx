import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

/*
  The Content screens after the official run (8 October 2026): keyword
  research unticked on the sandbox with the reason, the plan step pointing
  to Prepare the content, the copy pack in its own step (no dead end), each
  page's row reachable by Back to Content, and the next page to approve.
*/

vi.mock("next/navigation", () => ({ useRouter: () => ({ push() {}, refresh() {} }), usePathname: () => "/projects" }));

import { CopyPackCard, PageDraftsCard } from "@/components/content/page-drafts-card";
import { PrepareContentCard } from "@/components/content/prepare-card";
import { PagePlan } from "@/components/content/page-plan";
import { ApprovalCard } from "@/components/content/page-review";

const prepare = (research: { included: boolean; line: string; why: string | null; ticked?: boolean }) =>
  renderToStaticMarkup(<PrepareContentCard projectId="p" canRun research={research} planLine="Page plan" homeLine="The Home page's draft: about $0.40" total="About $0.40 in all." cheaper="Cheaper" usable="Usable" />);

describe("Prepare the content", () => {
  it("leaves sandbox keyword research unticked and says why", () => {
    const html = prepare({ included: true, line: "Keyword research: free (sandbox)", why: "Left out for now: DataForSEO is on its free sandbox.", ticked: false });
    expect(html).not.toMatch(/<input type="checkbox" checked/);
    expect(html).toContain("Left out for now: DataForSEO is on its free sandbox.");
  });

  it("ticks real keyword research and gives no reason", () => {
    const html = prepare({ included: true, line: "Keyword research: about $0.20", why: null, ticked: true });
    expect(html).toMatch(/<input type="checkbox" checked/);
  });
});

describe("the page plan's step before there's a plan", () => {
  it("points to Prepare the content, with the plan alone second", () => {
    const html = renderToStaticMarkup(<PagePlan projectId="p" canEdit prepareFirst pages={[]} kinds={[]} countLine="" tierWarning={null} hasResearch={false} titleLimit={60} metaLimit={155} remakeDeletes="" />);
    expect(html).toContain('<a class="btn btn-primary" href="#prepare">Prepare the content</a>');
    expect(html).toContain("Only the page plan");
  });
});

describe("the copy pack's step", () => {
  const base = { projectId: "p", canDecide: true, waitingLine: "3 of 11 pages approved so far", decisionLine: null, decisionChanges: false, canMoveToBuild: false };

  it("holds the download and the decision once every page is approved", () => {
    const html = renderToStaticMarkup(<CopyPackCard {...base} allApproved />);
    expect(html).toContain('id="copy-pack"');
    expect(html).toContain("Download the copy pack");
    expect(html).toContain("Record the client’s decision");
  });

  it("says what it waits for until then", () => {
    const html = renderToStaticMarkup(<CopyPackCard {...base} allApproved={false} />);
    expect(html).toContain("The copy pack opens here once every page is approved: 3 of 11 pages approved so far.");
    expect(html).not.toContain("Download the copy pack");
  });

  it("is no longer inside the drafts' step, and each page's row has its own address", () => {
    const html = renderToStaticMarkup(
      <PageDraftsCard projectId="p" canDraft rows={[{ pageId: "x1", name: "Home", href: "#", version: "v1", state: "approved", stateLabel: "Approved", aiWriting: "-", aiFlagged: false, comments: 0, placeholders: 0 }]} undrafted={0} approved={1} drafting={false} allApproved estimateLine="" />,
    );
    expect(html).not.toContain("Download the copy pack");
    expect(html).toContain('id="page-x1"');
    expect(html).toContain("the copy pack and the client’s answer are in the next step");
  });
});

describe("a page's approval", () => {
  const approved = { projectId: "p", pageId: "x1", canApprove: true, approvedLine: "Version 1, by Mei, Oct 8.", ready: true, placeholders: 0, backHref: "/projects/p/content#page-x1" };

  it("offers the next page still to approve", () => {
    const html = renderToStaticMarkup(<ApprovalCard {...approved} next={{ name: "Drain cleaning", href: "/projects/p/content/x2" }} />);
    expect(html).toContain('href="/projects/p/content/x2"');
    expect(html).toContain("Next to approve: Drain cleaning");
  });

  it("goes back to the page's row on Content when none is left", () => {
    const html = renderToStaticMarkup(<ApprovalCard {...approved} next={null} />);
    expect(html).toContain('href="/projects/p/content#page-x1"');
  });
});
