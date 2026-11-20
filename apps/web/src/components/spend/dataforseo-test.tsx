"use client";

import { useState, useTransition } from "react";

import { loadDmaMarketsAction, testDataForSeoAction } from "@/app/actions";
import { Button } from "@/components/ui/button";
import type { ConnectionTest } from "@/lib/seo-data";

/*
  "Test DataForSEO connection" (admins, 26 September 2026): the same free
  request as a curl to /v3/appendix/user_data, made by the web app with its
  own settings. Shows the exact endpoint, the HTTP status and DataForSEO's
  reason; the login mostly hidden, the password never, only its length.
  Since 5 November 2026 it then makes one real keyword lookup (about $0.01
  live), so an IP block on real work shows here first.
*/
export function DataForSeoTest(props: { dmaLine: string }) {
  const [dmaNote, setDmaNote] = useState<string | null>(null);
  const [result, setResult] = useState<ConnectionTest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, start] = useTransition();

  return (
    <div className="dataforseo-test" style={{ marginTop: 12 }}>
      <div className="row" style={{ gap: 8, flexWrap: "wrap" }}>
        <Button
          small
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              const answer = await testDataForSeoAction();
              if (answer.ok) setResult(answer.result);
              else setError(answer.message);
            })
          }
        >
          {busy ? "Testing..." : "Test DataForSEO connection (about $0.01 live)"}
        </Button>
        <Button
          small
          disabled={busy}
          onClick={() =>
            start(async () => {
              setError(null);
              const answer = await loadDmaMarketsAction();
              if (!answer.ok) setError(answer.message);
              else
                setDmaNote(
                  answer.count
                    ? `Loaded ${answer.count} TV markets: the DMA choice is on in the intake.`
                    : "DataForSEO's list has no DMAs: the DMA choice stays hidden; counties work as before.",
                );
            })
          }
        >
          Load TV markets (DMAs)
        </Button>
      </div>
      <p className="hint">{dmaNote ?? props.dmaLine}</p>
      {error ? <p className="hint-error">{error}</p> : null}
      {result ? (
        <div
          className={result.ok ? "hint content-done" : "hint-error"}
          role="status"
          style={{ marginTop: 8 }}
        >
          <p>{result.message}</p>
          <ul>
            <li>
              Called by: the {result.service} (the worker never calls
              DataForSEO)
            </li>
            <li>
              Endpoint: {result.endpoint} (
              {result.sandbox
                ? "the sandbox, because DATAFORSEO_LIVE isn't on"
                : "live"}
              )
            </li>
            <li>
              HTTP status: {result.httpStatus ?? "no answer"}
              {result.dataForSeo ? `; DataForSEO: ${result.dataForSeo}` : ""}
            </li>
            <li>
              Login sent: {result.login || "(empty)"}; password:{" "}
              {result.passwordLength} characters
            </li>
            {result.tidied.length ? (
              <li>Tidied before sending: {result.tidied.join("; ")}</li>
            ) : null}
            {result.dataCall ? (
              <li>
                Real lookup: {result.dataCall.endpoint}: {result.dataCall.message}
              </li>
            ) : null}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
