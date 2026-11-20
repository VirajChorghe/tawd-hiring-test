import type { Metadata } from "next";

import { LabButtons } from "./lab-buttons";

/*
  F4: where TAWD's monthly delivery check landed, from whoever checks that
  test inbox. Two buttons on a page, not two links in the email, so email
  scanners (which open every link) can't answer for a person.
*/

export const metadata: Metadata = { title: "Delivery check", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function LabPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="client-page">
      <p className="client-page-brand">Velocity Media Lab</p>
      <h1 className="page-title">Where did this test land?</h1>
      <p className="hint">TAWD&rsquo;s monthly check that clients&rsquo; website messages reach their inboxes.</p>
      <LabButtons token={token} />
    </main>
  );
}
