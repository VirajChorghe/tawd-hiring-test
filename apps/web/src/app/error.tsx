"use client";

import Link from "next/link";
import { useEffect } from "react";

import { StatusPage } from "@/components/brand/status-page";

/*
  Anything that fails while showing a page. The details go to the server
  log (and the browser console); the person gets one plain sentence and a
  way to carry on.
*/
export default function ErrorPage({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      title="Something went wrong"
      line={`TAWD couldn't show this page. Try again, and if it keeps happening, tell an admin${
        error.digest ? ` (reference ${error.digest})` : ""
      }.`}
      action={
        <>
          <button type="button" className="btn btn-secondary" onClick={() => reset()}>
            Try again
          </button>
          <Link href="/projects" className="btn btn-primary">
            Back to Projects
          </Link>
        </>
      }
    />
  );
}
