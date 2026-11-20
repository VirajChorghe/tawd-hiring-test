"use client";

import { useEffect, useId, useRef, useState } from "react";

/*
  Fonts (Jason, 26 September 2026): a picker for headings and one for body
  text. Each opens a short list of good free Google fonts, each shown in
  its own style, with "Let TAWD choose (no preference)" first and the
  default, and "Other" to type a specific font. The list is radio buttons,
  so it works from the keyboard like any other choice.
*/

export const HEADING_FONTS = ["Montserrat", "Poppins", "Playfair Display", "Merriweather", "Oswald", "Raleway", "Lora", "Roboto Slab", "DM Serif Display", "Work Sans"];
export const BODY_FONTS = ["Inter", "Open Sans", "Roboto", "Lato", "Source Sans 3", "Nunito Sans", "Work Sans", "IBM Plex Sans", "Merriweather", "Lora"];

const ALL = [...new Set([...HEADING_FONTS, ...BODY_FONTS])];
export const GOOGLE_CSS = `https://fonts.googleapis.com/css2?${ALL.map((f) => `family=${f.replace(/ /g, "+")}`).join("&")}&display=swap`;

/* The fonts' own stylesheet, added to the page once, only where a picker is shown. */
function useFontStylesheet() {
  useEffect(() => {
    if (document.querySelector("link[data-tawd-font-picker]")) return;
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = GOOGLE_CSS;
    link.setAttribute("data-tawd-font-picker", "");
    document.head.appendChild(link);
  }, []);
}

export function FontPicker(props: {
  label: string;
  value: string;
  fonts: string[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Start with the list open: for the screenshots and tests. */
  initiallyOpen?: boolean;
}) {
  useFontStylesheet();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(Boolean(props.initiallyOpen));
  const isListed = props.value === "" || props.fonts.includes(props.value);
  const [other, setOther] = useState(isListed ? "" : props.value);
  const [choosingOther, setChoosingOther] = useState(!isListed);

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

  const shown = props.value || "Let TAWD choose (no preference)";
  const choose = (value: string) => {
    setChoosingOther(false);
    props.onChange(value);
    setOpen(false);
  };

  return (
    <div className="field font-picker" ref={root}>
      <span className="field-label" id={`${id}-label`}>
        <span>{props.label}</span>
      </span>
      <button
        type="button"
        className="select font-picker-button"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={props.disabled}
        onClick={() => setOpen((v) => !v)}
      >
        <span id={`${id}-value`} style={props.value ? { fontFamily: `"${props.value}", system-ui, sans-serif` } : undefined}>
          {shown}
        </span>
      </button>
      {open ? (
        <fieldset className="font-picker-list" id={`${id}-list`}>
          <legend className="visually-hidden">{props.label}</legend>
          <label className="font-option">
            <input type="radio" name={id} checked={props.value === "" && !choosingOther} onChange={() => choose("")} />
            <span>Let TAWD choose (no preference)</span>
          </label>
          {props.fonts.map((font) => (
            <label key={font} className="font-option">
              <input type="radio" name={id} checked={props.value === font && !choosingOther} onChange={() => choose(font)} />
              <span style={{ fontFamily: `"${font}", system-ui, sans-serif` }}>{font}</span>
            </label>
          ))}
          <label className="font-option">
            <input type="radio" name={id} checked={choosingOther} onChange={() => setChoosingOther(true)} />
            <span>Other</span>
          </label>
          {choosingOther ? (
            <div className="font-other">
              <label className="visually-hidden" htmlFor={`${id}-other`}>
                The font&rsquo;s name
              </label>
              <input
                id={`${id}-other`}
                className="input"
                placeholder="The font's name, e.g. Barlow"
                value={other}
                autoFocus
                onChange={(e) => {
                  setOther(e.target.value);
                  props.onChange(e.target.value.trim());
                }}
              />
            </div>
          ) : null}
        </fieldset>
      ) : null}
    </div>
  );
}
