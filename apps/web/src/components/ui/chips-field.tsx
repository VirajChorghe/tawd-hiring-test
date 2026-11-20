"use client";

import { useId, useState } from "react";

/*
  A list of short words as chips: type a word and press Enter or a comma,
  or paste "honest, fast, local" and each becomes a chip. Backspace in the
  empty box removes the last one. Words may contain spaces ("family run").

  The typed text is kept apart from the saved list, so a comma or a space
  is never swallowed while typing - which is exactly what the old mood
  words field did.
*/

export function splitWords(raw: string): string[] {
  return raw
    .split(/[,;\n]/)
    .map((word) => word.trim().replace(/\s+/g, " "))
    .filter(Boolean);
}

export function ChipsField({
  label,
  values,
  onChange,
  placeholder,
  hint,
  max = 12,
}: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  hint?: string;
  max?: number;
}) {
  const id = useId();
  const [draft, setDraft] = useState("");

  const add = (raw: string) => {
    const words = splitWords(raw);
    if (words.length === 0) return;
    const seen = new Set(values.map((v) => v.toLowerCase()));
    const next = [...values];
    for (const word of words) {
      if (next.length >= max) break;
      if (seen.has(word.toLowerCase())) continue;
      seen.add(word.toLowerCase());
      next.push(word);
    }
    onChange(next);
    setDraft("");
  };

  return (
    <div className="field">
      <label className="field-label" htmlFor={id}>
        <span>{label}</span>
      </label>
      <div className="chips-input">
        {values.map((word, index) => (
          <span key={`${word}-${index}`} className="chip">
            {word}
            <button
              type="button"
              className="chip-remove"
              aria-label={`Remove ${word}`}
              onClick={() => onChange(values.filter((_, i) => i !== index))}
            >
              &times;
            </button>
          </span>
        ))}
        <input
          id={id}
          className="chips-input-box"
          value={draft}
          placeholder={values.length === 0 ? placeholder : "Add another"}
          disabled={values.length >= max}
          onChange={(event) => {
            const text = event.target.value;
            // A comma finishes a word; everything before it becomes chips.
            if (/[,;\n]/.test(text)) {
              const last = text.split(/[,;\n]/).pop() ?? "";
              add(text.slice(0, text.length - last.length));
              setDraft(last.trimStart());
            } else {
              setDraft(text);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              add(draft);
            } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => add(draft)}
          onPaste={(event) => {
            const text = event.clipboardData.getData("text");
            if (/[,;\n]/.test(text)) {
              event.preventDefault();
              add(`${draft}${text}`);
            }
          }}
        />
      </div>
      {hint ? <p className="hint">{hint} Press Enter or type a comma after each one.</p> : null}
    </div>
  );
}
