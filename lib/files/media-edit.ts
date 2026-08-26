/**
 * What a media edit means — the rules, away from the DOM, away from sharp and ffmpeg.
 *
 * The panels in `components/editors` decide nothing: they collect a draft and hand it
 * here. `app/api/files/edit/route.ts` and the worker's ffmpeg call read the same
 * helpers. A crop rectangle that disagrees with the pipeline silently cuts the wrong
 * part of someone's photo, so the geometry lives in one place and is pinned by tests.
 *
 * Two orderings matter, and are encoded here rather than remembered:
 *
 * - The image pipeline auto-orients, then rotates, then mirrors, then extracts, then
 *   resizes. A crop is therefore expressed against the *rotated and mirrored* frame and a
 *   resize against the *cropped* one — `toPixelCrop` and `planResize` each take the frame
 *   they belong to, and `rotateRect`/`mirrorRect` move an existing crop with the frame so
 *   turning or flipping the image keeps the same region selected.
 * - `ffmpeg -ss` placed before `-i` seeks by keyframe, which is what makes a trim
 *   instant instead of a re-encode. The cut lands on the nearest keyframe at or before
 *   the mark, so the panel says so rather than pretending to frame accuracy.
 */

import {
  EDIT_MAX_DIMENSION,
  EDIT_MAX_OUTPUT_PIXELS,
  EDIT_REFUSED_MIME_TYPES,
  EDIT_SOURCE_MAX_BYTES,
  TRIM_MAX_SECONDS,
} from "./edit-limits";
import type { PreviewKind } from "../preview/detect-preview-type";

export type Size = { width: number; height: number };

/* ─────────────────────────────  Crop geometry  ───────────────────────────── */

/**
 * A crop expressed as fractions of the frame, `0..1` from the top-left corner.
 *
 * Fractions rather than pixels because the overlay is laid out in whatever CSS size the
 * stage happens to give it, while the server needs source pixels. A resolution-independent
 * draft means resizing the window mid-edit cannot move the crop.
 */
export type NormalizedRect = { x: number; y: number; width: number; height: number };

export const FULL_FRAME: NormalizedRect = { x: 0, y: 0, width: 1, height: 1 };

/** The smallest crop a drag may produce, per axis. Below this the handles overlap. */
export const MIN_CROP_FRACTION = 0.05;

/** Rectangles are compared with a tolerance: a drag never lands on exactly `1`. */
const FRAME_EPSILON = 0.002;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * A rectangle forced back inside the frame, with a floor on its size.
 *
 * Every rectangle a pointer drag produces goes through here: a drag inverts when the
 * pointer crosses the opposite edge, leaves the stage entirely when it keeps going, and
 * a zero-width result would reach sharp as `extract({ width: 0 })`.
 */
export function clampRect(rect: NormalizedRect): NormalizedRect {
  const width = Math.min(1, Math.max(MIN_CROP_FRACTION, Math.abs(rect.width) || 0));
  const height = Math.min(1, Math.max(MIN_CROP_FRACTION, Math.abs(rect.height) || 0));
  return {
    x: Math.min(clamp01(rect.x), 1 - width),
    y: Math.min(clamp01(rect.y), 1 - height),
    width,
    height,
  };
}

/** Whether a crop keeps every pixel, so the request can leave `crop` out entirely. */
export function isFullFrame(rect: NormalizedRect): boolean {
  return (
    Math.abs(rect.x) < FRAME_EPSILON &&
    Math.abs(rect.y) < FRAME_EPSILON &&
    Math.abs(rect.width - 1) < FRAME_EPSILON &&
    Math.abs(rect.height - 1) < FRAME_EPSILON
  );
}

export type PixelRect = { x: number; y: number; width: number; height: number };

/**
 * A normalized crop resolved against a concrete frame, in whole pixels.
 *
 * `extract` refuses a region that runs past the edge, and rounding four independent
 * fractions can produce exactly that, so the offsets are rounded first and the extents
 * are then fitted into what is left of the frame.
 */
export function toPixelCrop(rect: NormalizedRect, frame: Size): PixelRect {
  const safe = clampRect(rect);
  const width = Math.max(1, Math.floor(frame.width));
  const height = Math.max(1, Math.floor(frame.height));
  const x = Math.min(Math.max(0, Math.round(safe.x * width)), width - 1);
  const y = Math.min(Math.max(0, Math.round(safe.y * height)), height - 1);
  return {
    x,
    y,
    width: Math.max(1, Math.min(width - x, Math.round(safe.width * width))),
    height: Math.max(1, Math.min(height - y, Math.round(safe.height * height))),
  };
}

/* ─────────────────────────────  Rotation  ───────────────────────────── */

export type Rotation = 0 | 90 | 180 | 270;

/** A quarter-turn added to the current rotation, kept inside `0 | 90 | 180 | 270`. */
export function nextRotation(current: Rotation, delta: number): Rotation {
  const total = (((current + (Number.isFinite(delta) ? delta : 0)) % 360) + 360) % 360;
  return ((Math.round(total / 90) * 90) % 360) as Rotation;
}

/**
 * The rotation to store after the user turns the image on screen by `delta`.
 *
 * The preview composes as mirror(rotate(source)), and conjugating a rotation by a single
 * reflection inverts it — so with exactly one mirror on, storing a right turn would look
 * like a left one. "Rotate right" has to keep turning the picture right, so the stored
 * angle goes the other way instead. Two mirrors are a half turn, which commutes, so they
 * cancel each other out and nothing is reversed.
 */
export function rotationForTurn(current: Rotation, delta: number, mirrored: boolean): Rotation {
  return nextRotation(current, mirrored ? -delta : delta);
}

/** The frame a rotation leaves behind: a quarter-turn swaps the axes. */
export function rotatedFrame(frame: Size, rotation: Rotation): Size {
  return rotation === 90 || rotation === 270
    ? { width: frame.height, height: frame.width }
    : { width: frame.width, height: frame.height };
}

/**
 * A crop carried through a quarter-turn, so turning the image keeps the same region
 * selected instead of snapping the selection back to the whole frame.
 *
 * The rectangle is in fractions of the frame and the frame's axes swap, so the sides swap
 * with them: clockwise sends the top edge to the right-hand side, anticlockwise to the
 * left. `delta` is the turn being applied, not the rotation being arrived at.
 */
export function rotateRect(rect: NormalizedRect, delta: number): NormalizedRect {
  const turn = (((Math.round(delta / 90) * 90) % 360) + 360) % 360;
  if (turn === 0) return clampRect(rect);
  if (turn === 180) {
    return clampRect({
      x: 1 - (rect.x + rect.width),
      y: 1 - (rect.y + rect.height),
      width: rect.width,
      height: rect.height,
    });
  }
  return clampRect(
    turn === 90
      ? { x: 1 - (rect.y + rect.height), y: rect.x, width: rect.height, height: rect.width }
      : { x: rect.y, y: 1 - (rect.x + rect.width), width: rect.height, height: rect.width }
  );
}

/* ─────────────────────────────  Mirroring  ───────────────────────────── */

/** Which way a mirror runs: `"horizontal"` swaps left and right. */
export type MirrorAxis = "horizontal" | "vertical";

/**
 * A crop carried through a mirror, for the same reason `rotateRect` exists: the pixels
 * under the selection move, so the selection moves with them.
 *
 * A mirror leaves the frame the same size, so only the leading edge changes — the width
 * and height are untouched.
 */
export function mirrorRect(rect: NormalizedRect, axis: MirrorAxis): NormalizedRect {
  return clampRect(
    axis === "horizontal"
      ? { ...rect, x: 1 - (rect.x + rect.width) }
      : { ...rect, y: 1 - (rect.y + rect.height) }
  );
}

/* ─────────────────────────  Server pipeline geometry  ───────────────────────── */

/** What the route hands sharp: the same edit, in the order sharp really applies things. */
export type SharpGeometry = {
  rotate: number;
  flop: boolean;
  flip: boolean;
  crop: PixelRect | null;
};

/**
 * Translate an edit from the order the editor previews in into the order sharp works in.
 *
 * The editor's contract is source → rotate → mirror → crop → resize, and the crop the
 * client sends is measured against the rotated AND mirrored frame — that is what the panel
 * draws over. sharp does not compose in chain order, and this is measured against 0.35.3
 * rather than read from its typings, which claim flip/flop happen after the rotation:
 *
 *   • `.rotate(90).flop()` and `.flop().rotate(90)` produce the SAME image, and it is the
 *     flop-then-rotate one. Mirrors live in the same stage as the rotation and run before
 *     its angle, whichever way round they are called.
 *   • `extract()` lifts that stage above itself only when an angle is already pending
 *     (`rotateBefore` in `sharp/dist/resize.cjs`, which does not count flip/flop as a
 *     rotation). With nothing rotated the extract runs FIRST and the mirror lands on the
 *     cropped tile instead of the whole frame.
 *
 * Both are corrected here rather than left to the chain, using the two identities that make
 * it exact: mirroring after a quarter turn is mirroring the OTHER axis before it
 * (`flop ∘ rot90 = rot90 ∘ flip`), and cropping a mirrored frame is mirroring the crop back
 * into the unmirrored one. A half turn commutes with both mirrors, so it needs neither.
 */
export function sharpGeometry(input: {
  rotate?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  crop?: PixelRect | null;
  /** The auto-oriented source frame — what sharp extracts from when nothing is rotated. */
  source: Size;
}): SharpGeometry {
  const turn = (((input.rotate ?? 0) % 360) + 360) % 360;
  const quarter = turn === 90 || turn === 270;
  const horizontal = Boolean(input.flipHorizontal);
  const vertical = Boolean(input.flipVertical);
  const geometry: SharpGeometry = {
    rotate: turn,
    flop: quarter ? vertical : horizontal,
    flip: quarter ? horizontal : vertical,
    crop: input.crop ?? null,
  };
  // With a rotation pending the extract already happens last, so the crop is measured
  // against the frame sharp will extract from and passes straight through.
  if (!geometry.crop || turn !== 0) return geometry;

  const { x, y, width, height } = geometry.crop;
  return {
    ...geometry,
    crop: {
      x: horizontal ? Math.max(0, Math.floor(input.source.width) - (x + width)) : x,
      y: vertical ? Math.max(0, Math.floor(input.source.height) - (y + height)) : y,
      width,
      height,
    },
  };
}

/* ─────────────────────────────  Aspect ratios  ───────────────────────────── */
export type CropAspect = { id: string; label: string; ratio: number | null };

/** `null` leaves the crop free; every other ratio is width ÷ height in pixels. */
export const CROP_ASPECTS: readonly CropAspect[] = [
  { id: "free", label: "Free", ratio: null },
  { id: "1:1", label: "1:1", ratio: 1 },
  { id: "4:3", label: "4:3", ratio: 4 / 3 },
  { id: "3:4", label: "3:4", ratio: 3 / 4 },
  { id: "16:9", label: "16:9", ratio: 16 / 9 },
  { id: "9:16", label: "9:16", ratio: 9 / 16 },
];

/**
 * The rectangle reshaped to a pixel aspect ratio, keeping its centre and never growing.
 *
 * The ratio is a ratio of *pixels*, but the rectangle is stored as fractions of a frame
 * that is rarely square — so the frame's own proportions have to come into it, or "1:1"
 * on a 3:2 photo would produce a rectangle.
 */
export function fitAspect(rect: NormalizedRect, ratio: number, frame: Size): NormalizedRect {
  const safe = clampRect(rect);
  if (!Number.isFinite(ratio) || ratio <= 0 || frame.width <= 0 || frame.height <= 0) return safe;

  // Ratio of the normalized sides, which is the pixel ratio undone by the frame's own.
  const normalizedRatio = ratio * (frame.height / frame.width);
  let width = safe.width;
  let height = width / normalizedRatio;
  if (height > safe.height) {
    height = safe.height;
    width = height * normalizedRatio;
  }

  return clampRect({
    x: safe.x + safe.width / 2 - width / 2,
    y: safe.y + safe.height / 2 - height / 2,
    width,
    height,
  });
}

/* ─────────────────────────────  Resizing  ───────────────────────────── */

export type ResizePlan = Size;

/** Offered as one-click downscales; each is a longest-edge ceiling, never an upscale. */
export const RESIZE_PRESETS = [2560, 1920, 1280, 800] as const;

/** A new width with the height following the frame's proportions. */
export function scaleToWidth(frame: Size, width: number): ResizePlan {
  const target = Math.max(1, Math.round(width));
  return { width: target, height: Math.max(1, Math.round((target * frame.height) / frame.width)) };
}

/** A new height with the width following the frame's proportions. */
export function scaleToHeight(frame: Size, height: number): ResizePlan {
  const target = Math.max(1, Math.round(height));
  return { width: Math.max(1, Math.round((target * frame.width) / frame.height)), height: target };
}

/**
 * The frame fitted inside a square of `edge` pixels.
 *
 * Only ever shrinks: a 640 px preset on an 800 px-wide photo is a downscale, but on a
 * 320 px one it would be an upscale that invents detail and grows the file.
 */
export function scaleToLongestEdge(frame: Size, edge: number): ResizePlan {
  const longest = Math.max(frame.width, frame.height);
  if (!Number.isFinite(edge) || edge <= 0 || longest <= edge) {
    return { width: Math.max(1, Math.round(frame.width)), height: Math.max(1, Math.round(frame.height)) };
  }
  return frame.width >= frame.height ? scaleToWidth(frame, edge) : scaleToHeight(frame, edge);
}

/** A resize that would change nothing collapses to `null`, so the draft stays clean. */
export function resizeIfChanged(plan: ResizePlan | null, frame: Size): ResizePlan | null {
  if (!plan) return null;
  return plan.width === frame.width && plan.height === frame.height ? null : plan;
}

/**
 * Why an output size cannot be produced, or `null`.
 *
 * Mirrors `withinOutputBounds` so the refusal arrives while the number is being typed,
 * rather than as a 400 after the request. The server still checks: this is the courtesy.
 */
export function outputSizeError(size: ResizePlan): string | null {
  if (
    !Number.isInteger(size.width) ||
    !Number.isInteger(size.height) ||
    size.width < 1 ||
    size.height < 1
  ) {
    return "Width and height must be whole numbers, at least 1 pixel each.";
  }
  if (size.width > EDIT_MAX_DIMENSION || size.height > EDIT_MAX_DIMENSION) {
    return `Keep both sides at or under ${EDIT_MAX_DIMENSION.toLocaleString("en-US")} px.`;
  }
  if (size.width * size.height > EDIT_MAX_OUTPUT_PIXELS) {
    return `That comes to more than ${Math.round(EDIT_MAX_OUTPUT_PIXELS / 1_000_000)} megapixels — reduce the size.`;
  }
  return null;
}

/* ─────────────────────────────  The image draft  ───────────────────────────── */

export type ImageEditDraft = {
  rotation: Rotation;
  /** Mirror left-to-right. Applied after the rotation, as the server does. */
  flipHorizontal: boolean;
  /** Mirror top-to-bottom. */
  flipVertical: boolean;
  /** Fractions of the *rotated and mirrored* frame, because extraction happens after both. */
  crop: NormalizedRect;
  /** Output size in pixels, or `null` to keep whatever the crop left. */
  resize: ResizePlan | null;
  /** Re-encode quality `1..100`, or `null` to leave the encoder alone. */
  quality: number | null;
  /** Write the image out as a different format, or `null` to keep its own. */
  convertTo: ImageFormat | null;
};

/** Where a re-compress starts: visually lossless for photos, well under the original. */
export const DEFAULT_EDIT_QUALITY = 82;

export function emptyImageDraft(): ImageEditDraft {
  return {
    rotation: 0,
    flipHorizontal: false,
    flipVertical: false,
    crop: { ...FULL_FRAME },
    resize: null,
    quality: null,
    convertTo: null,
  };
}

/** Whether the draft asks for anything at all. Drives both Save and the unsaved guard. */
export function hasImageChanges(draft: ImageEditDraft): boolean {
  return (
    draft.rotation !== 0 ||
    draft.flipHorizontal ||
    draft.flipVertical ||
    !isFullFrame(draft.crop) ||
    draft.resize !== null ||
    draft.quality !== null ||
    draft.convertTo !== null
  );
}

export type ImageEditAction = "crop" | "rotate" | "flip" | "resize" | "convert" | "compress";

/** The body `POST /api/files/edit` accepts. Kept structural so the route can zod it. */
export type ImageEditRequest = {
  fileId: string;
  action: ImageEditAction;
  rotate?: number;
  flipHorizontal?: boolean;
  flipVertical?: boolean;
  crop?: PixelRect;
  width?: number;
  height?: number;
  quality?: number;
  /** Encode the result as this format instead of the file's own. */
  format?: ImageFormat;
  saveAsCopy?: boolean;
};

export type ImageEditPlan =
  | { ok: true; request: ImageEditRequest; output: Size }
  | { ok: false; reason: string };

/**
 * The draft turned into a request, or the reason it cannot be sent.
 *
 * `action` is only a label for the activity feed — the server applies whichever of
 * `rotate`, the flips, `crop`, `width`/`height`, `format` and `quality` are present — so
 * it names the most destructive thing the request does rather than trying to describe all
 * of it.
 */
export function buildImageEditRequest(input: {
  fileId: string;
  draft: ImageEditDraft;
  /** The image as displayed: already auto-oriented by the browser, as the server will. */
  natural: Size;
  saveAsCopy?: boolean;
}): ImageEditPlan {
  const { fileId, draft, natural, saveAsCopy = false } = input;

  if (!(natural.width >= 1) || !(natural.height >= 1)) {
    return { ok: false, reason: "Wait for the image to finish loading." };
  }
  if (!hasImageChanges(draft)) {
    return {
      ok: false,
      reason: "Nothing to save yet — rotate, flip, crop, resize, convert or compress first.",
    };
  }

  const rotated = rotatedFrame(
    { width: Math.round(natural.width), height: Math.round(natural.height) },
    draft.rotation
  );
  const crop = isFullFrame(draft.crop) ? null : toPixelCrop(draft.crop, rotated);
  const cropped: Size = crop ? { width: crop.width, height: crop.height } : rotated;
  const resize = resizeIfChanged(draft.resize, cropped);
  const output = resize ?? cropped;

  const invalid = outputSizeError(output);
  if (invalid) return { ok: false, reason: invalid };

  const request: ImageEditRequest = {
    fileId,
    action: crop
      ? "crop"
      : resize
        ? "resize"
        : draft.convertTo
          ? "convert"
          : draft.rotation !== 0
            ? "rotate"
            : draft.flipHorizontal || draft.flipVertical
              ? "flip"
              : "compress",
  };
  if (draft.rotation !== 0) request.rotate = draft.rotation;
  if (draft.flipHorizontal) request.flipHorizontal = true;
  if (draft.flipVertical) request.flipVertical = true;
  if (crop) request.crop = crop;
  if (resize) {
    request.width = resize.width;
    request.height = resize.height;
  }
  if (draft.quality !== null) request.quality = draft.quality;
  if (draft.convertTo) request.format = draft.convertTo;
  if (saveAsCopy) request.saveAsCopy = true;

  return { ok: true, request, output };
}

/* ─────────────────────────────  Naming a copy  ───────────────────────────── */

/**
 * `report.png` → `report (edited).png`.
 *
 * A dot-file (`.gitignore`) has no extension to preserve and a name with no dot keeps
 * none — both take the suffix at the end, where it still reads as part of the name.
 */
export function copyFileName(name: string, suffix = "edited"): string {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : "";
  return `${stem} (${suffix})${extension}`;
}

/** `photo.tiff` → `photo.jpg`, for when the encoder had to change the format. */
export function renameForExtension(name: string, extension: string): string {
  const dot = name.lastIndexOf(".");
  return `${dot > 0 ? name.slice(0, dot) : name}${extension}`;
}

/* ─────────────────────────────  Choosing an encoder  ───────────────────────────── */

export type ImageEncoder = {
  format: ImageFormat;
  mimeType: string;
  extension: string;
};

/** Every format the editor can write. Anything else becomes JPEG. */
export type ImageFormat = "jpeg" | "png" | "webp" | "avif";

const JPEG_ENCODER: ImageEncoder = { format: "jpeg", mimeType: "image/jpeg", extension: ".jpg" };
const PNG_ENCODER: ImageEncoder = { format: "png", mimeType: "image/png", extension: ".png" };
const WEBP_ENCODER: ImageEncoder = { format: "webp", mimeType: "image/webp", extension: ".webp" };
const AVIF_ENCODER: ImageEncoder = { format: "avif", mimeType: "image/avif", extension: ".avif" };

const ENCODERS: Record<string, ImageEncoder> = {
  "image/jpeg": JPEG_ENCODER,
  "image/jpg": JPEG_ENCODER,
  "image/png": PNG_ENCODER,
  "image/webp": WEBP_ENCODER,
  "image/avif": AVIF_ENCODER,
};

const ENCODERS_BY_FORMAT: Record<ImageFormat, ImageEncoder> = {
  jpeg: JPEG_ENCODER,
  png: PNG_ENCODER,
  webp: WEBP_ENCODER,
  avif: AVIF_ENCODER,
};

/** The formats offered as conversion targets, in the order the panel lists them. */
export const IMAGE_CONVERT_FORMATS: readonly {
  id: ImageFormat;
  label: string;
  /** One line on what the choice costs, shown next to the chip. */
  note: string;
}[] = [
  { id: "jpeg", label: "JPEG", note: "Smallest, lossy, no transparency." },
  { id: "png", label: "PNG", note: "Lossless with transparency; larger files." },
  { id: "webp", label: "WebP", note: "Smaller than JPEG at the same quality." },
  { id: "avif", label: "AVIF", note: "Smallest of the four; slowest to encode." },
];

/** The encoder for a format the caller asked for by name. */
export function encoderForFormat(format: ImageFormat): ImageEncoder {
  return ENCODERS_BY_FORMAT[format];
}

/**
 * The format a file already is, if the editor can write it — otherwise `null`.
 *
 * The panel uses this to mark the current format rather than offering a conversion that
 * would rewrite the file for nothing. `null` (a TIFF, a BMP, a HEIC) means every target
 * is a real change.
 */
export function currentImageFormat(mimeType: string): ImageFormat | null {
  const key = mimeType.toLowerCase().split(";")[0].trim();
  return ENCODERS[key]?.format ?? null;
}

/**
 * The encoder a re-compress should use for a source of this type.
 *
 * Format-preserving on purpose. The old pipeline always wrote JPEG bytes, which left a
 * `.png` holding a JPEG: the browser coped, every later sharp call and every download
 * did not. Anything else — TIFF, BMP, HEIC — becomes JPEG, and the caller renames the
 * file so its extension stops lying.
 */
export function chooseImageEncoder(mimeType: string): ImageEncoder {
  const key = mimeType.toLowerCase().split(";")[0].trim();
  return ENCODERS[key] ?? JPEG_ENCODER;
}

/**
 * Whether a re-compress can keep the file's own format.
 *
 * The answer decides whether the file has to be renamed: a TIFF that comes back as JPEG
 * needs its extension and mime type corrected, while a JPEG re-compressed as JPEG must
 * be left alone — silently renaming a file the user did not ask to rename is worse than
 * the wrong extension it would be fixing.
 */
export function canReencodeInPlace(mimeType: string): boolean {
  return mimeType.toLowerCase().split(";")[0].trim() in ENCODERS;
}

/* ─────────────────────────────  Trimming  ───────────────────────────── */

/** The shortest clip a trim may produce. */
export const MIN_TRIM_SECONDS = 0.5;

export type TrimWindow = { startSeconds: number; endSeconds: number };

/**
 * The container ffmpeg should write for a source of this type, or `null` for "cannot".
 *
 * A stream copy cannot change container: Matroska packets do not go into a `.mp4`, and
 * the previous code wrote exactly that for every `video/*` that was not MP4. Types with
 * no mapping are refused by the route rather than queued to fail in the worker.
 */
const TRIM_CONTAINERS: Record<string, string> = {
  "video/mp4": "mp4",
  "video/quicktime": "mov",
  "video/webm": "webm",
  "video/x-matroska": "mkv",
  "video/x-msvideo": "avi",
  "video/mpeg": "mpg",
  "video/ogg": "ogv",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/webm": "weba",
};

export function containerExtensionFor(mimeType: string): string | null {
  return TRIM_CONTAINERS[mimeType.toLowerCase().split(";")[0].trim()] ?? null;
}

/**
 * The ffmpeg invocation for a trim that copies streams instead of re-encoding.
 *
 * `-ss` sits before `-i` deliberately: ffmpeg then seeks the container rather than
 * decoding up to the mark, which is the difference between a second and a minute. The
 * price is keyframe granularity, and `-avoid_negative_ts make_zero` is what keeps the
 * result playable when the cut lands mid-GOP. Only audio and video are carried over;
 * a stream copy of subtitles or attachments is where muxers start refusing the job.
 */
export function buildTrimArgs(input: {
  inputPath: string;
  outputPath: string;
  startSeconds: number;
  endSeconds: number;
}): string[] {
  const start = Math.max(0, Number.isFinite(input.startSeconds) ? input.startSeconds : 0);
  const end = Number.isFinite(input.endSeconds) ? input.endSeconds : start;
  const duration = Math.max(MIN_TRIM_SECONDS, end - start);
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-ss",
    start.toFixed(3),
    "-i",
    input.inputPath,
    "-t",
    duration.toFixed(3),
    "-map",
    "0:v?",
    "-map",
    "0:a?",
    "-c",
    "copy",
    "-avoid_negative_ts",
    "make_zero",
    "-y",
    input.outputPath,
  ];
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * A trim window pulled back inside the clip, with the minimum length enforced.
 *
 * Handles are dragged, and two handles that pass each other would otherwise produce a
 * negative duration. The end moves first because that is the handle a drag was usually
 * on; only when there is no room left does the start give way.
 */
export function clampTrimWindow(window: TrimWindow, duration: number | null): TrimWindow {
  const limit =
    duration !== null && Number.isFinite(duration) && duration > 0
      ? Math.min(duration, TRIM_MAX_SECONDS)
      : TRIM_MAX_SECONDS;
  const start = Math.min(Math.max(0, Number.isFinite(window.startSeconds) ? window.startSeconds : 0), limit);
  let end = Math.min(Math.max(0, Number.isFinite(window.endSeconds) ? window.endSeconds : 0), limit);
  let begin = start;
  if (end - begin < MIN_TRIM_SECONDS) {
    end = Math.min(limit, begin + MIN_TRIM_SECONDS);
    begin = Math.max(0, end - MIN_TRIM_SECONDS);
  }
  return { startSeconds: round3(begin), endSeconds: round3(end) };
}

/**
 * Why a trim window cannot be sent, or `null`.
 *
 * The "keeps the whole clip" case is a refusal rather than a silent no-op: a trim
 * snapshots a version and rewrites the object, and doing that to produce the same file
 * spends the user's quota for nothing.
 */
export function trimError(window: TrimWindow, duration: number | null): string | null {
  const { startSeconds, endSeconds } = window;
  if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0) {
    return "Set a start and an end point on the timeline.";
  }
  if (endSeconds - startSeconds < MIN_TRIM_SECONDS) {
    return `Keep the clip at least ${MIN_TRIM_SECONDS} seconds long.`;
  }
  if (endSeconds > TRIM_MAX_SECONDS) {
    return "This clip is longer than the trimmer can handle.";
  }
  if (duration !== null && Number.isFinite(duration) && duration > 0) {
    if (startSeconds >= duration) return "The start point is past the end of the clip.";
    if (endSeconds - startSeconds >= duration - 0.05) {
      return "That keeps the whole clip — move a handle to cut something.";
    }
  }
  return null;
}

/**
 * `95.4` → `1:35.4`, `3675` → `1:01:15.0`.
 *
 * Tenths because a trim handle moves in tenths, and a label that rounds to whole
 * seconds makes two different marks look identical.
 */
export function formatClock(seconds: number): string {
  const tenthsTotal = Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 10) : 0;
  const whole = Math.floor(tenthsTotal / 10);
  const tenths = tenthsTotal % 10;
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  const tail = `${String(secs).padStart(2, "0")}.${tenths}`;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, "0")}:${tail}`
    : `${minutes}:${tail}`;
}

/* ──────────────────────────  Which editor a file gets  ────────────────────── */

/** `"image"` opens the crop/rotate/resize panel; `"trim"` opens the timeline. */
export type MediaEditorKind = "image" | "trim";

/**
 * Which media editor this file can have, if any.
 *
 * Every clause here mirrors a refusal the route would answer with, so a button never
 * appears that could only produce an error: SVG is refused outright (rasterizing
 * attacker markup), an end-to-end encrypted file cannot be edited server-side at all
 * (the server holds ciphertext and no key), a note's body lives in the database rather
 * than in storage, and an image over `EDIT_SOURCE_MAX_BYTES` is more than the editor
 * will read into memory.
 *
 * The size ceiling is deliberately image-only: a trim is a stream copy that ffmpeg
 * reads from a file rather than a buffer, so a two-hour video is not the same kind of
 * problem as a two-hundred-megapixel PNG.
 */
export function mediaEditorKindFor(input: {
  /** Does the caller have write permission on this file? */
  canEdit: boolean;
  encrypted: boolean;
  isNote: boolean;
  /** Accepts the string a `bigint` column arrives as. */
  sizeBytes: number | string;
  mimeType: string;
  /** Whatever `detectPreviewKind` made of the file. */
  previewKind: PreviewKind;
}): MediaEditorKind | null {
  const { canEdit, encrypted, isNote, sizeBytes, mimeType, previewKind } = input;
  if (!canEdit || encrypted || isNote) return null;
  if (EDIT_REFUSED_MIME_TYPES.includes(mimeType.toLowerCase())) return null;

  if (previewKind === "image") {
    // A missing or unparseable size is treated as too big: guessing small here trades a
    // disabled button for a 413 after the upload of a draft.
    const bytes = Number(sizeBytes);
    if (!Number.isFinite(bytes) || bytes > EDIT_SOURCE_MAX_BYTES) return null;
    return "image";
  }

  if (previewKind === "video" || previewKind === "audio") {
    // A stream copy cannot change container, so a format with no muxer to write back
    // into has no trim available either.
    return containerExtensionFor(mimeType) ? "trim" : null;
  }

  return null;
}
