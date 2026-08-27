/**
 * Bounds for server-side image editing.
 *
 * `POST /api/files/edit` used to take `width`, `height`, `rotate` and the crop box
 * as bare numbers and hand them to sharp. `resize` runs with `fit: "inside"` and no
 * `withoutEnlargement`, so it ENLARGES: `{"width":100000,"height":100000}` is a
 * ~200-byte request that asks for a 10-gigapixel canvas — tens of gigabytes of
 * resident memory in the shared Node process, from one authenticated caller
 * editing their own file. The source object was also read with a single
 * `transformToByteArray()`, with no ceiling of its own.
 *
 * So there are three ceilings: how many bytes we will read, how many pixels we
 * will decode, and how many pixels we will produce. All three refuse with 4xx
 * before the memory is spent.
 */

/** Largest source object we will pull into memory to edit. */
export const EDIT_SOURCE_MAX_BYTES = 64 * 1024 * 1024;

/** Largest image we will let the decoder expand to (sharp's own input guard). */
export const EDIT_INPUT_MAX_PIXELS = 80_000_000;

/** Largest single output dimension. */
export const EDIT_MAX_DIMENSION = 12_000;

/** Largest output area, which is the number that actually bounds the allocation. */
export const EDIT_MAX_OUTPUT_PIXELS = 40_000_000;

/** Longest trim window we will hand to ffmpeg, in seconds. */
export const TRIM_MAX_SECONDS = 24 * 60 * 60;

/**
 * Largest video we will pull out of storage to extract its audio.
 *
 * The worker streams the source to a temporary file rather than buffering it, so this
 * bounds the worker's disk and the time one job can hold a slot for — not its heap. A
 * ceiling well above any ordinary upload, low enough that a 40 GB master cannot park a
 * job for an hour.
 */
export const EXTRACT_AUDIO_SOURCE_MAX_BYTES = 8 * 1024 * 1024 * 1024;

/**
 * Rasterizing SVG means running librsvg over attacker-authored markup, which is a
 * parser (and historically a network client) we have no reason to expose here —
 * every edit action produces raster output anyway.
 */
export const EDIT_REFUSED_MIME_TYPES = ["image/svg+xml", "image/svg"];

/** Does this crop/resize request stay inside the output ceiling? */
export function withinOutputBounds(width?: number, height?: number): boolean {
  if (width !== undefined && width > EDIT_MAX_DIMENSION) return false;
  if (height !== undefined && height > EDIT_MAX_DIMENSION) return false;
  if (width !== undefined && height !== undefined) {
    return width * height <= EDIT_MAX_OUTPUT_PIXELS;
  }
  return true;
}
