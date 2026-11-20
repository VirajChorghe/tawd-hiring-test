"use client";

import { useRef } from "react";

/*
  The designer's Figma frame and TAWD's faithful copy side by side. The
  two scroll together, at the same point down each page, so the same
  section is in view on both.
*/
export function CopyCompare({
  designUrl,
  copyUrl,
  frameName,
  captions,
}: {
  designUrl: string | null;
  copyUrl: string | null;
  frameName: string;
  /** Other captions for the two sides, for the improved design next to the copy. */
  captions?: { left: string; right: string };
}) {
  const left = useRef<HTMLDivElement>(null);
  const right = useRef<HTMLDivElement>(null);
  const syncing = useRef(false);

  const follow = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to || syncing.current) return;
    syncing.current = true;
    const share = from.scrollTop / Math.max(1, from.scrollHeight - from.clientHeight);
    to.scrollTop = share * (to.scrollHeight - to.clientHeight);
    window.requestAnimationFrame(() => {
      syncing.current = false;
    });
  };

  return (
    <div className="copy-compare">
      <figure className="compare-item">
        <figcaption>{captions?.left ?? <>The designer&rsquo;s Figma frame, &ldquo;{frameName}&rdquo;</>}</figcaption>
        <div className="render-frame copy-compare-scroll" ref={left} onScroll={() => follow(left.current, right.current)}>
          {designUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
            <img src={designUrl} alt={captions?.left ?? `The designer's ${frameName} frame`} />
          ) : (
            <p className="hint">The imported picture of this frame is missing.</p>
          )}
        </div>
      </figure>
      <figure className="compare-item">
        <figcaption>{captions?.right ?? <>TAWD&rsquo;s copy, as a web page</>}</figcaption>
        <div className="render-frame copy-compare-scroll" ref={right} onScroll={() => follow(right.current, left.current)}>
          {copyUrl ? (
            // eslint-disable-next-line @next/next/no-img-element -- a short-lived signed R2 link
            <img src={copyUrl} alt={captions?.right ?? "TAWD's faithful copy of the design"} />
          ) : (
            <p className="hint">The copy has no picture.</p>
          )}
        </div>
      </figure>
    </div>
  );
}
