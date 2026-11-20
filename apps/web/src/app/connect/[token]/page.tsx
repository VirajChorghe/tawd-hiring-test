import type { Metadata } from "next";

import { getDb } from "@tawd/core/db";
import { loadClientPage } from "@/lib/connect";
import { ClientSteps } from "./steps";

/*
  F3, Connect the domain (1 October 2026): the client's private page. No
  login and no TAWD menu: what to change where their domain's DNS is
  managed, in their provider's words, and an I've done it button. The link
  is the key; a link that's no longer good says so and nothing else.
*/

export const metadata: Metadata = { title: "Connect your domain", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ConnectPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const page = await loadClientPage(getDb(), token);

  if (!page) {
    return (
      <main className="client-page">
        <p className="client-page-brand">Velocity Media Lab</p>
        <h1 className="page-title">This link has expired</h1>
        <p className="hint">Ask your Velocity Media Lab contact for a new one.</p>
      </main>
    );
  }

  const access = process.env.VML_DNS_ACCESS_EMAIL?.trim() || null;
  return (
    <main className="client-page">
      <p className="client-page-brand">Velocity Media Lab</p>
      <h1 className="page-title">Connect {page.domain} to your new website</h1>
      <p className="hint">
        {page.check?.ok
          ? `All set: ${page.domain} points at your new website. We'll take it from here.`
          : `Two changes where your domain's DNS is managed${page.host ? ` (${page.host.name})` : ""}. Your email ${page.emailProvider ? `(${page.emailProvider}) ` : ""}isn't touched.`}
      </p>
      <ClientSteps
        token={token}
        domain={page.domain}
        providerName={page.guide.name}
        providerUrl={page.guide.url}
        where={page.guide.where}
        watch={page.guide.watch}
        changes={page.changes}
        done={Boolean(page.check?.ok)}
        doneAt={page.doneAt ? page.doneAt.toISOString() : null}
        instructions={page.instructions}
        access={page.guide.access ? page.guide.access.replace("the VML email below", access ?? "your Velocity Media Lab contact's email") : null}
      />
    </main>
  );
}
