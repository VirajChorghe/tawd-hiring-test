import type { Metadata } from "next";

import { ConfirmButton } from "./confirm-button";

/*
  F2: the client's "I got it" for the test message. No login. The page
  asks for a click rather than confirming on load, because email security
  scanners (Outlook's Safe Links and the like) open every link in an email
  on their own; only a person presses the button.
*/

export const metadata: Metadata = { title: "Confirm your test message", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";

export default async function ConfirmPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main className="client-page">
      <p className="client-page-brand">Velocity Media Lab</p>
      <h1 className="page-title">Did the test message arrive?</h1>
      <p className="hint">One click tells us website messages reach you.</p>
      <ConfirmButton token={token} />
    </main>
  );
}
