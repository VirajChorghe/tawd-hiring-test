// heic-convert ships no types. It exports a single function that decodes a
// HEIC/HEIF buffer and re-encodes it to the requested format.
declare module "heic-convert" {
  interface HeicConvertOptions {
    buffer: Buffer | Uint8Array | ArrayBufferLike;
    format: "JPEG" | "PNG";
    /** JPEG quality, 0 to 1. Ignored for PNG. */
    quality?: number;
  }
  function convert(options: HeicConvertOptions): Promise<ArrayBuffer>;
  export default convert;
}
