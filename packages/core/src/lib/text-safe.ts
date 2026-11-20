/*
  Text the database can keep (F-033, audit November 2026). A scraped page can
  hold a NUL byte or half an emoji (a lone surrogate); Postgres refuses both
  in text and jsonb ("unsupported Unicode escape sequence"), and the whole
  site read then failed for good. Both are removed before saving; real
  emoji, accents and everything else stay.
*/

const NOT_STORABLE = /\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** The text without NUL bytes and lone surrogates. */
export function storableText(text: string): string {
  return text.replace(NOT_STORABLE, "");
}

/** The same value with every string (and object key) made storable. Plain data only: arrays, plain objects and primitives; anything else is returned as it is. */
export function storable<T>(value: T): T {
  if (typeof value === "string") return storableText(value) as T;
  if (Array.isArray(value)) return value.map((item) => storable(item)) as T;
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) return value;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) out[storableText(key)] = storable(item);
    return out as T;
  }
  return value;
}
