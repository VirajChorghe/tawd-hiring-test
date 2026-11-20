import type Anthropic from "@anthropic-ai/sdk";

/*
  A picture's real type, from its first bytes (gap 10, 5 November 2026: the
  Critique and polish step labelled the review's JPEG renders "image/png",
  the API refused them, and polish never ran). Every picture TAWD sends to
  the AI is labelled from its bytes, never from what the code expects.
*/

export type ImageMediaType = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

export function imageMediaType(bytes: Buffer): ImageMediaType | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (bytes.length >= 12 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString("ascii", 0, 6))) return "image/gif";
  return null;
}

/** An image block for the API, labelled by its bytes. A picture of no known type is a plain error, never a mislabelled call. */
export function imageBlock(bytes: Buffer): Anthropic.ImageBlockParam {
  const mediaType = imageMediaType(bytes);
  if (!mediaType) throw new Error("A picture for the AI is not a JPEG, PNG, WebP or GIF, so it was not sent.");
  return { type: "image", source: { type: "base64", media_type: mediaType, data: bytes.toString("base64") } };
}
