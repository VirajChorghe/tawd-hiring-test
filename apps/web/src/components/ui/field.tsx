"use client";

import { useId } from "react";

/*
  One field, in the four states DESIGN.md defines: normal, focused (handled in
  CSS), missing-required (amber, with a line saying why it matters), and
  error (red, with a line saying how to fix it).

  "Required" and "Optional" are written as words. Never a lone asterisk: an
  asterisk is a symbol people have to decode, and screen readers read it as
  "star".
*/

export interface FieldMarker {
  required?: boolean;
  /** Shown when a required answer is missing: why this matters downstream. */
  whyItMatters?: string;
}

export function FieldLabel({
  htmlFor,
  children,
  required,
  markerText,
}: {
  htmlFor?: string;
  children: React.ReactNode;
  required?: boolean;
  /** Overrides the plain Required/Optional wording, e.g. "Only if offered". */
  markerText?: string;
}) {
  return (
    <label className="field-label" htmlFor={htmlFor}>
      <span>{children}</span>
      {markerText ? (
        <span className={required ? "field-required" : "field-optional"}>
          {markerText}
        </span>
      ) : required ? (
        <span className="field-required">Required</span>
      ) : (
        <span className="field-optional">Optional</span>
      )}
    </label>
  );
}

export function TextField({
  label,
  value,
  onChange,
  required = false,
  markerText,
  missing = false,
  whyItMatters,
  error,
  hint,
  placeholder,
  type = "text",
  id,
  inputRef,
  note,
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  markerText?: string;
  missing?: boolean;
  whyItMatters?: string;
  error?: string;
  hint?: string;
  placeholder?: string;
  type?: "text" | "email" | "tel" | "url";
  /** Given explicitly where the Required-info card needs to focus it. */
  id?: string;
  inputRef?: React.Ref<HTMLInputElement>;
  /** A line under the input, such as the "from the design" mark. */
  note?: React.ReactNode;
  /** Greyed out, as the current website is when "No current website available" is ticked. */
  disabled?: boolean;
}) {
  const generated = useId();
  const fieldId = id ?? generated;

  const showMissing = missing && !error;

  return (
    <div className="field">
      <FieldLabel htmlFor={fieldId} required={required} markerText={markerText}>
        {label}
      </FieldLabel>
      <input
        id={fieldId}
        ref={inputRef}
        type={type}
        className={[
          "input",
          showMissing ? "is-missing" : null,
          error ? "is-error" : null,
        ]
          .filter(Boolean)
          .join(" ")}
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {error ? <p className="hint-error">{error}</p> : null}
      {showMissing && whyItMatters ? (
        <p className="hint-missing">{whyItMatters}</p>
      ) : null}
      {!error && !showMissing && hint ? <p className="hint">{hint}</p> : null}
      {note}
    </div>
  );
}

export function TextAreaField({
  label,
  value,
  onChange,
  required = false,
  markerText,
  hint,
  placeholder,
  rows = 4,
  id,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  markerText?: string;
  hint?: string;
  placeholder?: string;
  rows?: number;
  id?: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <div className="field">
      <FieldLabel htmlFor={fieldId} required={required} markerText={markerText}>
        {label}
      </FieldLabel>
      <textarea
        id={fieldId}
        className="textarea"
        rows={rows}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

export function SelectField<T extends string>({
  label,
  value,
  onChange,
  options,
  required = false,
  markerText,
  hint,
  emptyLabel = "Not answered yet",
  id,
}: {
  label: string;
  value: T | null;
  onChange: (value: T | null) => void;
  options: { value: T; label: string }[];
  required?: boolean;
  markerText?: string;
  hint?: string;
  emptyLabel?: string;
  id?: string;
}) {
  const generated = useId();
  const fieldId = id ?? generated;

  return (
    <div className="field">
      <FieldLabel htmlFor={fieldId} required={required} markerText={markerText}>
        {label}
      </FieldLabel>
      <select
        id={fieldId}
        className="select"
        value={value ?? ""}
        onChange={(event) =>
          onChange(event.target.value === "" ? null : (event.target.value as T))
        }
      >
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint ? <p className="hint">{hint}</p> : null}
    </div>
  );
}

/*
  Yes, no, or nobody has asked yet.

  The third state earns its keep: "we have not asked about financing" is not
  the same as "they do not offer financing", and only one of those belongs on
  a finished website.
*/
export function YesNoField({
  label,
  value,
  onChange,
  hint,
  required = false,
}: {
  label: string;
  value: boolean | null;
  onChange: (value: boolean | null) => void;
  hint?: string;
  required?: boolean;
}) {
  return (
    <SelectField
      label={label}
      hint={hint}
      required={required}
      value={value === null ? null : value ? "yes" : "no"}
      onChange={(next) => onChange(next === null ? null : next === "yes")}
      options={[
        { value: "yes", label: "Yes" },
        { value: "no", label: "No" },
      ]}
      emptyLabel="Not asked yet"
    />
  );
}
