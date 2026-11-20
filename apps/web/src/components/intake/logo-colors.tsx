"use client";

import { useEffect, useRef, useState } from "react";

import { logoPalette, normalizeHex, type PaletteColor } from "@tawd/core/intake";
import { Button } from "@/components/ui/button";

/*
  "Suggest colors from the logo": the uploaded logo, drawn small in the
  browser (it comes from TAWD's own address, so its pixels can be read),
  and its main colours offered as one-click swatches. No AI, nothing sent
  anywhere.

  With no brand colours entered, the logo's main colours are put in by
  themselves (27 September 2026: the brand must come from the client, and
  every guessed palette was wrong). The PM can change them; saving keeps
  them, marked as taken from the logo.
*/

async function readLogo(url: string): Promise<Uint8ClampedArray> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const scale = Math.min(1, 160 / Math.max(image.naturalWidth || 160, image.naturalHeight || 160));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round((image.naturalWidth || 160) * scale));
  canvas.height = Math.max(1, Math.round((image.naturalHeight || 160) * scale));
  const context = canvas.getContext("2d");
  if (!context) throw new Error("no canvas");
  context.drawImage(image, 0, 0, canvas.width, canvas.height);
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

export function LogoColors({
  projectId,
  logoIds,
  used,
  canEdit,
  onPick,
  onAutoFill,
  fromLogo,
  initial,
}: {
  projectId: string;
  logoIds: string[];
  /** The brand colours already chosen, marked on their swatches. */
  used: string[];
  canEdit: boolean;
  onPick: (hex: string) => void;
  /** Called once with the logo's main colours when no brand colour is entered yet. */
  onAutoFill?: (hexes: string[]) => void;
  /** The colours in the form were taken from the logo. */
  fromLogo?: boolean;
  /** Colours already read: for the screenshots and tests. */
  initial?: PaletteColor[];
}) {
  const [state, setState] = useState<"idle" | "reading" | "done" | "failed">(initial ? "done" : "idle");
  const [colors, setColors] = useState<PaletteColor[]>(initial ?? []);
  const tried = useRef(false);
  const empty = used.every((c) => !c);
  const logoKey = logoIds.join(",");

  useEffect(() => {
    if (!onAutoFill || !canEdit || !empty || !logoKey || tried.current || initial) return;
    tried.current = true;
    void suggest().then((found) => {
      if (found && found.length > 0) onAutoFill(found.slice(0, 2).map((c) => c.hex));
    });
    // Once per logo set, when the form has no colour yet.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logoKey, empty, canEdit]);

  if (logoIds.length === 0) return null;
  const chosen = new Set(used.map((c) => normalizeHex(c)).filter(Boolean));

  async function suggest(): Promise<PaletteColor[] | null> {
    setState("reading");
    try {
      const found: PaletteColor[] = [];
      for (const id of logoIds) {
        for (const color of logoPalette(await readLogo(`/projects/${projectId}/intake/files/${id}`))) {
          if (!found.some((f) => f.hex === color.hex)) found.push(color);
        }
      }
      setColors(found.slice(0, 8));
      setState("done");
      return found;
    } catch {
      setState("failed");
      return null;
    }
  }

  return (
    <div className="logo-colors">
      {fromLogo && !empty ? (
        <p className="hint">Primary and Accent were taken from the logo. Change them if they aren&rsquo;t right.</p>
      ) : null}
      {state === "idle" || state === "reading" ? (
        <Button small variant="secondary" disabled={!canEdit || state === "reading"} onClick={() => void suggest()}>
          {state === "reading" ? "Reading the logo..." : "Suggest colors from the logo"}
        </Button>
      ) : state === "failed" ? (
        <p className="hint-error">The logo&rsquo;s colors couldn&rsquo;t be read. Type them in or use the picker.</p>
      ) : colors.length === 0 ? (
        <p className="hint">No colors found: the logo may be white or see-through.</p>
      ) : (
        <>
          <p className="hint">From the logo, most used first. Click one to use it: it fills Primary, then Accent, then goes with the others.</p>
          <div className="logo-swatches" role="list">
            {colors.map((color) => {
              const isUsed = chosen.has(color.hex);
              return (
                <button
                  key={color.hex}
                  type="button"
                  role="listitem"
                  className={isUsed ? "logo-swatch is-used" : "logo-swatch"}
                  disabled={!canEdit || isUsed}
                  onClick={() => onPick(color.hex)}
                  title={isUsed ? `${color.hex} is already a brand color` : `Use ${color.hex}`}
                >
                  <span className="logo-swatch-chip" style={{ background: color.hex }} aria-hidden="true" />
                  <span>{color.hex}</span>
                  {isUsed ? <span className="logo-swatch-used">In use</span> : null}
                </button>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
}
