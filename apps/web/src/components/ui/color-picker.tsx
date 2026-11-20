"use client";

import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";

import { hexToHsv, hsvToHex, normalizeHex, type Hsv } from "@tawd/core/intake";

/*
  A full colour picker (the founders' request, 25 September 2026): the
  swatch opens a square for saturation and brightness with a hue slider
  under it; the hex box takes a typed or pasted code; the eyedropper picks
  a colour from anywhere on screen where the browser offers one (Chrome and
  Edge). Keyboard: arrows move the square's point and the hue.
*/

interface EyeDropperResult {
  sRGBHex: string;
}
interface EyeDropperLike {
  open: () => Promise<EyeDropperResult>;
}
declare global {
  interface Window {
    EyeDropper?: new () => EyeDropperLike;
  }
}

const START: Hsv = { h: 210, s: 0.6, v: 0.5 };

export function ColorPicker({
  label,
  value,
  onChange,
  placeholder = "#1F4E79",
  initiallyOpen = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  /** Start with the panel open: for the screenshots and tests. */
  initiallyOpen?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(initiallyOpen);
  const [text, setText] = useState(value);
  // Kept while picking, so the hue survives dragging to grey or black.
  const [hsv, setHsv] = useState<Hsv>(() => hexToHsv(value) ?? START);
  const root = useRef<HTMLDivElement>(null);
  const valid = normalizeHex(value) !== null;

  // Only in a browser that has one (Chrome, Edge); never on the server.
  const canDrop = useSyncExternalStore(
    () => () => {},
    () => typeof window.EyeDropper === "function",
    () => false,
  );

  // A new value from outside (a logo swatch, a saved answer) shows in the box and the square.
  const [seen, setSeen] = useState(value);
  if (seen !== value) {
    setSeen(value);
    setText(value);
    const next = hexToHsv(value);
    if (next && normalizeHex(value) !== hsvToHex(hsv)) setHsv(next);
  }

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  const choose = (next: Hsv) => {
    setHsv(next);
    onChange(hsvToHex(next));
  };

  const drag = (element: HTMLElement, event: React.PointerEvent, apply: (x: number, y: number) => void) => {
    element.setPointerCapture(event.pointerId);
    const at = (e: { clientX: number; clientY: number }) => {
      const box = element.getBoundingClientRect();
      apply(
        Math.min(1, Math.max(0, (e.clientX - box.left) / box.width)),
        Math.min(1, Math.max(0, (e.clientY - box.top) / box.height)),
      );
    };
    at(event);
    const move = (e: PointerEvent) => at(e);
    const up = () => {
      element.removeEventListener("pointermove", move);
      element.removeEventListener("pointerup", up);
    };
    element.addEventListener("pointermove", move);
    element.addEventListener("pointerup", up);
  };

  const pickFromScreen = async () => {
    if (!window.EyeDropper) return;
    try {
      const picked = await new window.EyeDropper().open();
      const normal = normalizeHex(picked.sRGBHex);
      if (normal) onChange(normal);
    } catch {
      // Cancelled with Escape: nothing to do.
    }
  };

  return (
    <div className="field color-picker" ref={root}>
      <label className="field-label" htmlFor={`${id}-hex`}>
        <span>{label}</span>
      </label>
      <div className="color-picker-row">
      <div className="inline-row">
        {valid ? (
          <button
            type="button"
            className="color-swatch color-swatch-button"
            style={{ background: value }}
            aria-label={`Choose the ${label.toLowerCase()}`}
            aria-expanded={open}
            aria-controls={`${id}-panel`}
            onClick={() => setOpen((v) => !v)}
          />
        ) : (
          // Empty (Jason, 26 September 2026): a rainbow swatch that says what it does.
          <button
            type="button"
            className="color-swatch-empty"
            aria-label={`Pick the ${label.toLowerCase()}`}
            aria-expanded={open}
            aria-controls={`${id}-panel`}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="rainbow-dot" aria-hidden="true" />
            Pick a color
          </button>
        )}
        <input
          id={`${id}-hex`}
          className="input"
          value={text}
          placeholder={placeholder}
          spellCheck={false}
          onChange={(event) => {
            setText(event.target.value);
            const normal = normalizeHex(event.target.value);
            onChange(normal ?? event.target.value);
          }}
          onBlur={() => {
            const normal = normalizeHex(text);
            if (normal) setText(normal);
          }}
        />
        {canDrop ? (
          <button type="button" className="btn btn-secondary btn-icon" onClick={pickFromScreen} aria-label="Pick a colour from the screen" title="Pick a colour from the screen">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M19.5 4.5a2.1 2.1 0 0 0-3 0L14 7l-1-1-2 2 1 1-7.3 7.3a2 2 0 0 0-.6 1.4V20h2.3a2 2 0 0 0 1.4-.6L15 12l1 1 2-2-1-1 2.5-2.5a2.1 2.1 0 0 0 0-3Z" />
            </svg>
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="color-panel" id={`${id}-panel`} role="dialog" aria-label={`${label} picker`}>
          <div
            className="color-square"
            style={{ backgroundColor: `hsl(${hsv.h} 100% 50%)` }}
            role="slider"
            tabIndex={0}
            aria-label="Saturation and brightness"
            aria-valuetext={`saturation ${Math.round(hsv.s * 100)}%, brightness ${Math.round(hsv.v * 100)}%`}
            aria-valuenow={Math.round(hsv.s * 100)}
            onPointerDown={(event) => drag(event.currentTarget, event, (x, y) => choose({ ...hsv, s: x, v: 1 - y }))}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 0.1 : 0.02;
              const moves: Record<string, Partial<Hsv>> = {
                ArrowLeft: { s: Math.max(0, hsv.s - step) },
                ArrowRight: { s: Math.min(1, hsv.s + step) },
                ArrowUp: { v: Math.min(1, hsv.v + step) },
                ArrowDown: { v: Math.max(0, hsv.v - step) },
              };
              const move = moves[event.key];
              if (move) {
                event.preventDefault();
                choose({ ...hsv, ...move });
              }
            }}
          >
            <span className="color-square-thumb" style={{ left: `${hsv.s * 100}%`, top: `${(1 - hsv.v) * 100}%` }} aria-hidden="true" />
          </div>
          <div
            className="color-hue"
            role="slider"
            tabIndex={0}
            aria-label="Hue"
            aria-valuemin={0}
            aria-valuemax={360}
            aria-valuenow={Math.round(hsv.h)}
            onPointerDown={(event) => drag(event.currentTarget, event, (x) => choose({ ...hsv, h: Math.min(359.9, x * 360) }))}
            onKeyDown={(event) => {
              const step = event.shiftKey ? 20 : 3;
              if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
                event.preventDefault();
                choose({ ...hsv, h: (hsv.h - step + 360) % 360 });
              } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
                event.preventDefault();
                choose({ ...hsv, h: (hsv.h + step) % 360 });
              }
            }}
          >
            <span className="color-hue-thumb" style={{ left: `${(hsv.h / 360) * 100}%` }} aria-hidden="true" />
          </div>
          <div className="color-panel-foot">
            <span className="color-panel-value">
              <span className="color-dot" style={{ background: hsvToHex(hsv) }} aria-hidden="true" />
              {valid ? normalizeHex(value) : hsvToHex(hsv)}
            </span>
            <button type="button" className="btn btn-primary btn-small" onClick={() => setOpen(false)}>
              Done
            </button>
          </div>
        </div>
      ) : null}
      </div>
      {value && !valid ? <p className="hint-error">Use a hex code, for example #1F4E79.</p> : null}
    </div>
  );
}
