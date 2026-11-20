import { parseDocument } from "htmlparser2";
import type { ChildNode, Element } from "domhandler";
import type { FormFieldKey, IntakeData } from "../intake/schema";

/*
  F1, Website forms (1 October 2026, docs/plans/forms-email-domains.md):
  what the site's forms ask and who gets the messages, from the intake's
  Website forms section, by code. The AI still lays the form out in the
  site's style; applyForms then writes its fields from this definition,
  dressed in the classes the AI's own form used, so the fields are always
  exactly the ones chosen.
*/

export type FormFieldType = "text" | "tel" | "email" | "textarea" | "select" | "file" | "checkbox";

export interface FormFieldSpec {
  key: "name" | FormFieldKey;
  label: string;
  type: FormFieldType;
  autocomplete?: string;
  options?: string[];
  /** The form-field line under a tickbox or an upload. */
  hint?: string;
}

const SPECS: Record<"name" | FormFieldKey, Omit<FormFieldSpec, "key">> = {
  name: { label: "Name", type: "text", autocomplete: "name" },
  phone: { label: "Phone", type: "tel", autocomplete: "tel" },
  email: { label: "Email", type: "email", autocomplete: "email" },
  message: { label: "Message", type: "textarea" },
  service: { label: "Service needed", type: "select" },
  address: { label: "Address or ZIP code", type: "text", autocomplete: "street-address" },
  bestTime: { label: "Best time to call", type: "select", options: ["Morning", "Afternoon", "Evening", "Any time"] },
  heardAbout: { label: "How did you hear about us?", type: "select", options: ["Google", "Facebook or Instagram", "A friend or neighbor", "Saw our truck or sign", "Other"] },
  photos: { label: "Photos", type: "file", hint: "One photo, up to 8 MB." },
  emergency: { label: "This is an emergency", type: "checkbox" },
  textConsent: { label: "It's OK to text me about my request", type: "checkbox" },
};

/* The standard form, as before F1: what a site gets when the section is empty. */
export const STANDARD_FIELDS: { key: FormFieldKey; required: boolean }[] = [
  { key: "phone", required: true },
  { key: "email", required: false },
  { key: "message", required: true },
];

/* The short form on other pages when the Contact page has the quote form. */
const SHORT: FormFieldKey[] = ["phone", "email", "message"];

export interface FormDefinitionField extends FormFieldSpec {
  required: boolean;
}

export interface FormDefinition {
  /** Who gets the messages: the section's addresses, else the business email. */
  recipients: string[];
  /** Every field, Name first. */
  fields: FormDefinitionField[];
  quoteForm: boolean;
  thankYouLine: string;
}

export const isEmail = (value: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value.trim());

export function formDefinition(intake: Pick<IntakeData, "forms" | "business" | "services">): FormDefinition {
  const chosen = intake.forms.fields.length ? intake.forms.fields : STANDARD_FIELDS;
  const services = intake.services.items.map((s) => s.name.trim()).filter(Boolean);
  const fields: FormDefinitionField[] = [
    { key: "name", ...SPECS.name, required: true },
    ...chosen.map((f) => {
      const spec = { key: f.key, ...SPECS[f.key], required: f.required };
      // The services from the intake, and a way out for anything else.
      return f.key === "service" ? { ...spec, options: [...services, "Something else"] } : spec;
    }),
  ];
  const listed = intake.forms.recipients.filter(isEmail);
  const business = intake.business.email.trim();
  return {
    recipients: listed.length ? [...new Set(listed)] : isEmail(business) ? [business] : [],
    fields,
    quoteForm: intake.forms.quoteForm === true,
    thankYouLine: intake.forms.thankYouLine.trim(),
  };
}

/* ---------- writing a form's fields in the site's own look ---------- */

const isElement = (node: ChildNode): node is Element => node.type === "tag" || node.type === "script" || node.type === "style";
const esc = (text: string) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const cls = (value: string | undefined) => (value?.trim() ? ` class="${esc(value.trim())}"` : "");

function find(nodes: ChildNode[], test: (el: Element) => boolean): Element | null {
  for (const n of nodes) {
    if (!isElement(n)) continue;
    if (test(n)) return n;
    const inside = find(n.children, test);
    if (inside) return inside;
  }
  return null;
}

const isField = (el: Element) => (el.name === "input" && !["hidden", "submit", "button", "checkbox", "radio"].includes((el.attribs.type ?? "text").toLowerCase())) || el.name === "textarea" || el.name === "select";
const isButton = (el: Element) => (el.name === "button" && (el.attribs.type ?? "submit").toLowerCase() === "submit") || (el.name === "input" && (el.attribs.type ?? "").toLowerCase() === "submit");
const holds = (el: Element, test: (e: Element) => boolean) => test(el) || Boolean(find(el.children, test));

interface FormLook {
  wrapper: { tag: string; className: string } | null;
  label: string;
  input: string;
  textarea: string;
  select: string;
  button: { className: string; text: string };
}

/* How the AI dressed its form: the first field's wrapper, label and box, and the send button. */
function lookOf(form: Element): FormLook {
  const firstField = find(form.children, isField);
  let wrapper: FormLook["wrapper"] = null;
  if (firstField) {
    let up = firstField.parent as Element | null;
    while (up && up !== form) {
      if (find(up.children, (e) => e.name === "label")) {
        wrapper = { tag: up.name, className: up.attribs.class ?? "" };
        break;
      }
      up = up.parent as Element | null;
    }
  }
  const input = find(form.children, (e) => e.name === "input" && isField(e));
  const textarea = find(form.children, (e) => e.name === "textarea");
  const select = find(form.children, (e) => e.name === "select");
  const label = find(form.children, (e) => e.name === "label");
  const button = find(form.children, isButton);
  const buttonText = button ? (button.name === "input" ? (button.attribs.value ?? "") : textOf(button)) : "";
  const boxClass = input?.attribs.class ?? textarea?.attribs.class ?? "";
  return {
    wrapper,
    label: label?.attribs.class ?? "",
    input: boxClass,
    textarea: textarea?.attribs.class ?? boxClass,
    select: select?.attribs.class ?? boxClass,
    button: { className: button?.attribs.class ?? "", text: buttonText.trim() || "Send message" },
  };
}

function textOf(node: ChildNode): string {
  if (node.type === "text") return node.data;
  if (!isElement(node)) return "";
  return node.children.map(textOf).join("").replace(/\s+/g, " ");
}

/* One field, in the form's own look. */
function fieldHtml(f: FormDefinitionField, look: FormLook, formName: string): string {
  const id = `${formName}-${f.key}`;
  const req = f.required ? " required" : "";
  const mark = f.required ? "" : f.type === "checkbox" ? "" : " (optional)";
  let control: string;
  if (f.type === "checkbox") {
    const box = `<label${cls(look.label)}><input type="checkbox" id="${id}" name="${f.key}" value="Yes"${req}> ${esc(f.label)}</label>`;
    return look.wrapper ? `<${look.wrapper.tag}${cls(look.wrapper.className)}>${box}</${look.wrapper.tag}>` : box;
  }
  if (f.type === "textarea") control = `<textarea${cls(look.textarea)} id="${id}" name="${f.key}" rows="4"${req}></textarea>`;
  else if (f.type === "select")
    control = `<select${cls(look.select)} id="${id}" name="${f.key}"${req}><option value="">Choose one</option>${(f.options ?? []).map((o) => `<option>${esc(o)}</option>`).join("")}</select>`;
  else if (f.type === "file") control = `<input${cls(look.input)} type="file" id="${id}" name="${f.key}" accept="image/*"${req}>`;
  else control = `<input${cls(look.input)} type="${f.type}" id="${id}" name="${f.key}"${f.autocomplete ? ` autocomplete="${f.autocomplete}"` : ""}${req}>`;
  const label = `<label${cls(look.label)} for="${id}">${esc(f.label)}${mark}</label>`;
  const hint = f.hint ? `<small>${esc(f.hint)}</small>` : "";
  const inner = `${label}${control}${hint}`;
  return look.wrapper ? `<${look.wrapper.tag}${cls(look.wrapper.className)}>${inner}</${look.wrapper.tag}>` : inner;
}

/*
  Every form on a page, its fields written from the definition. What the
  AI put around the fields (a heading, a line such as "We reply within a
  day") stays where it was. On the Contact page with the quote form, the
  form asks everything and says "Request a quote"; elsewhere it's the
  short form.
*/
export function applyForms(html: string, def: FormDefinition, page: { isContact: boolean }): string {
  const doc = parseDocument(html, { withStartIndices: true, withEndIndices: true, decodeEntities: true });
  const forms: Element[] = [];
  const collect = (nodes: ChildNode[]) => {
    for (const n of nodes) {
      if (!isElement(n)) continue;
      if (n.name === "form") forms.push(n);
      else collect(n.children);
    }
  };
  collect(doc.children);
  if (forms.length === 0) return html;

  const quote = def.quoteForm && page.isContact;
  const fields = def.quoteForm && !page.isContact ? def.fields.filter((f) => f.key === "name" || SHORT.includes(f.key as FormFieldKey)) : def.fields;
  let out = "";
  let at = 0;
  forms.forEach((form, index) => {
    const look = lookOf(form);
    const name = quote && index === 0 ? "quote" : index === 0 ? "contact" : `contact-${index + 1}`;
    const tops = form.children;
    const zone = tops.map((n) => isElement(n) && (holds(n, isField) || holds(n, isButton) || holds(n, (e) => e.name === "label")));
    const first = zone.indexOf(true);
    const last = zone.lastIndexOf(true);
    const keep = (from: number, to: number) => tops.slice(from, to).map((n) => html.slice(n.startIndex!, n.endIndex! + 1)).join("");
    const leading = first < 0 ? keep(0, tops.length) : keep(0, first);
    const trailing = first < 0 ? "" : keep(last + 1, tops.length);
    const buttonText = quote ? "Request a quote" : look.button.text;
    const body = `${fields.map((f) => fieldHtml(f, look, name)).join("")}<button type="submit"${cls(look.button.className)}>${esc(buttonText)}</button>`;
    const attrs = Object.entries(form.attribs)
      .filter(([k]) => ["class", "id"].includes(k))
      .map(([k, v]) => ` ${k}="${esc(v)}"`)
      .join("");
    // Photos need the browser to send the file itself.
    const enctype = fields.some((f) => f.type === "file") ? ' enctype="multipart/form-data"' : "";
    out += html.slice(at, form.startIndex!) + `<form name="${name}"${attrs}${enctype}>${leading}${body}${trailing}</form>`;
    at = form.endIndex! + 1;
  });
  return out + html.slice(at);
}

/* For the build prompt: the fields the form must have, so the AI leaves room for them. */
export function formPromptLine(def: FormDefinition): string {
  return def.fields.map((f) => `${f.label}${f.required ? "" : " (optional)"}`).join(", ");
}
