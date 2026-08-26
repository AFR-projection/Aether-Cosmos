"use client";

/**
 * Crop, rotate, flip, resize, convert and re-compress an image without leaving the preview.
 *
 * Everything here is a *proposal*: the draft is normalized geometry, and only Save turns
 * it into a request for `POST /api/files/edit`. Nothing is applied to pixels in the
 * browser — the server re-runs the same numbers through sharp, so what you see is a
 * transform of the displayed image and not a second, slightly different rendering.
 *
 * Three coordinate systems meet in this file and mixing them up silently crops the wrong
 * region, so they are named apart everywhere:
 *   • `natural`  — the image as the browser decoded it (already auto-oriented).
 *   • `rotated`  — that frame after the draft's rotation. Mirroring never changes a frame's
 *                  proportions, so the *flips* do not need a frame of their own; the crop is
 *                  fractions of this frame as it looks once it has also been mirrored,
 *                  because the server rotates, then mirrors, then extracts.
 *   • `display`  — `rotated` fitted into the measured stage. Pointer maths only.
 *
 * The `<img>` transform has to compose in the server's order, and CSS applies transform
 * functions right-to-left: `scaleX(-1) scaleY(-1) rotate(Rdeg)` is mirror(rotate(source)),
 * which is exactly `.rotate().flop().flip()`. Putting a scale to the *right* of the
 * rotation would mirror the source first and rotate the mirror — the crop would then sit
 * over the wrong pixels on every quarter turn.
 */

import { useEffect, useRef, useState } from "react";
import {
  Check,
  Copy,
  Crop,
  FlipHorizontal,
  FlipVertical,
  Loader2,
  RotateCcw,
  RotateCw,
  Undo2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/system/spinner";
import { apiFetch } from "@/lib/api/client";
import {
  buildImageEditRequest,
  clampRect,
  CROP_ASPECTS,
  currentImageFormat,
  DEFAULT_EDIT_QUALITY,
  encoderForFormat,
  fitAspect,
  FULL_FRAME,
  hasImageChanges,
  IMAGE_CONVERT_FORMATS,
  isFullFrame,
  MIN_CROP_FRACTION,
  mirrorRect,
  RESIZE_PRESETS,
  resizeIfChanged,
  rotatedFrame,
  rotateRect,
  rotationForTurn,
  scaleToLongestEdge,
  toPixelCrop,
  type ImageEditDraft,
  type ImageFormat,
  type MirrorAxis,
  type NormalizedRect,
  type Rotation,
  type Size,
} from "@/lib/files/media-edit";
import { notify } from "@/lib/system/notify-store";
import { cn } from "@/lib/utils";

interface ImageEditPanelProps {
  /** Same URL the viewer streams; the panel never fetches the bytes itself. */
  src: string;
  fileId: string;
  fileName: string;
  mimeType: string;
  /**
   * The draft asks for something the server has not been told about yet. The preview
   * modal needs this to stop a backdrop click from discarding it. Pass a STABLE function.
   */
  onDirtyChange?: (dirty: boolean) => void;
  /** A save landed. The caller re-reads the row and busts its own stream cache. */
  onSaved?: (result: {
    savedAsCopy: boolean;
    sizeBytes: number;
    mimeType: string;
    /** Only a copy reports these — an in-place save keeps the row it already had. */
    fileId?: string;
    name?: string;
  }) => void;
}

/**
 * How far the preview may be blown up past 1:1.
 *
 * A 48 px favicon needs *some* magnification to be croppable at all, but past this it is
 * only a blurry rectangle — and the crop is stored as fractions, so the magnification
 * never reaches the output.
 */
const MAX_PREVIEW_SCALE = 2;

/** Arrow-key nudge, as a fraction of the frame. Shift multiplies it. */
const NUDGE = 0.01;
const NUDGE_COARSE = 0.1;

/** The frame fitted inside the stage, in CSS pixels. */
function fitInside(frame: Size, stage: Size): Size {
  if (frame.width <= 0 || frame.height <= 0 || stage.width <= 0 || stage.height <= 0) {
    return { width: 0, height: 0 };
  }
  const scale = Math.min(
    stage.width / frame.width,
    stage.height / frame.height,
    MAX_PREVIEW_SCALE
  );
  return { width: frame.width * scale, height: frame.height * scale };
}

/** `1.5` → `3:2`-ish; used only for the aspect-locked resize maths. */
function normalizedRatio(ratio: number, frame: Size): number {
  return ratio * (frame.height / frame.width);
}

type HandleKind = "move" | "n" | "s" | "e" | "w" | "nw" | "ne" | "sw" | "se";

/** The eight resize grips, with the cursor each one should show. */
const HANDLES: { kind: HandleKind; cursor: string; corner: boolean }[] = [
  { kind: "nw", cursor: "nwse-resize", corner: true },
  { kind: "ne", cursor: "nesw-resize", corner: true },
  { kind: "sw", cursor: "nesw-resize", corner: true },
  { kind: "se", cursor: "nwse-resize", corner: true },
  { kind: "n", cursor: "ns-resize", corner: false },
  { kind: "s", cursor: "ns-resize", corner: false },
  { kind: "w", cursor: "ew-resize", corner: false },
  { kind: "e", cursor: "ew-resize", corner: false },
];

/** Where each grip sits on the crop box. Centred on the edge, half of it outside. */
const HANDLE_CLASS: Record<Exclude<HandleKind, "move">, string> = {
  nw: "left-0 top-0 -translate-x-1/2 -translate-y-1/2",
  ne: "right-0 top-0 translate-x-1/2 -translate-y-1/2",
  sw: "bottom-0 left-0 -translate-x-1/2 translate-y-1/2",
  se: "bottom-0 right-0 translate-x-1/2 translate-y-1/2",
  n: "left-1/2 top-0 -translate-x-1/2 -translate-y-1/2",
  s: "bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2",
  w: "left-0 top-1/2 -translate-x-1/2 -translate-y-1/2",
  e: "right-0 top-1/2 translate-x-1/2 -translate-y-1/2",
};

/**
 * The crop rectangle after a drag of `dx`/`dy` (fractions of the frame).
 *
 * A move only ever translates — `clampRect` pushes the rectangle back inside the frame
 * without shrinking it, so dragging into a wall slides along it instead of resizing.
 * A grip moves the edges it is named after; with an aspect locked, only the corners are
 * offered and the height follows the width with the opposite corner pinned.
 */
function applyDrag(input: {
  kind: HandleKind;
  origin: NormalizedRect;
  dx: number;
  dy: number;
  ratio: number | null;
  frame: Size;
}): NormalizedRect {
  const { kind, origin, dx, dy, ratio, frame } = input;
  if (kind === "move") return clampRect({ ...origin, x: origin.x + dx, y: origin.y + dy });

  let left = origin.x;
  let top = origin.y;
  let right = origin.x + origin.width;
  let bottom = origin.y + origin.height;

  if (kind.includes("w")) left = Math.min(left + dx, right - MIN_CROP_FRACTION);
  if (kind.includes("e")) right = Math.max(right + dx, left + MIN_CROP_FRACTION);
  if (kind.includes("n")) top = Math.min(top + dy, bottom - MIN_CROP_FRACTION);
  if (kind.includes("s")) bottom = Math.max(bottom + dy, top + MIN_CROP_FRACTION);

  if (ratio === null) {
    return clampRect({ x: left, y: top, width: right - left, height: bottom - top });
  }

  // Aspect locked: the width the pointer asked for, the height that ratio demands, and
  // the corner opposite the grip held still so the box grows the way it was grabbed.
  const width = Math.max(right - left, MIN_CROP_FRACTION);
  const height = width / normalizedRatio(ratio, frame);
  const x = kind.includes("w") ? right - width : left;
  const y = kind.includes("n") ? bottom - height : top;
  return clampRect({ x, y, width, height });
}

/**
 * A labelled range input on the panel's light surface.
 *
 * `.media-range` is the house scrubber — the same control the audio and video viewers
 * use — so the filled portion is painted from `--pct` rather than `accent-color`.
 */
function EditSlider({
  label,
  value,
  min,
  max,
  step = 1,
  valueText,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  valueText: string;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
  return (
    <input
      type="range"
      className="media-range"
      data-surface="light"
      min={min}
      max={max}
      step={step}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-valuetext={valueText}
      style={{ ["--pct" as string]: `${pct}%` }}
      onChange={(e) => onChange(Number(e.target.value))}
    />
  );
}

/**
 * The crop rectangle, drawn over the displayed image.
 *
 * One pointer handler sits on the whole overlay and reads which grip was grabbed off
 * `data-handle`, so the eight grips and the move surface cost one listener between them.
 * The drag origin lives in a ref: a rectangle that only ever comes from `applyDrag` on the
 * *starting* rectangle cannot accumulate rounding drift over a long drag.
 */
function CropOverlay({
  rect,
  frame,
  display,
  ratio,
  onChange,
}: {
  rect: NormalizedRect;
  /** The rotated frame in image pixels — the aspect maths needs its proportions. */
  frame: Size;
  /** The same frame in CSS pixels, which is the unit pointer deltas arrive in. */
  display: Size;
  ratio: number | null;
  onChange: (rect: NormalizedRect) => void;
}) {
  const dragRef = useRef<{
    kind: HandleKind;
    pointerId: number;
    startX: number;
    startY: number;
    origin: NormalizedRect;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]");
    const kind = grip?.dataset.handle as HandleKind | undefined;
    if (!kind || display.width <= 0 || display.height <= 0) return;
    // Also stops the browser's own image drag, which would abandon the crop mid-gesture.
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      kind,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      origin: rect,
    };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    onChange(
      applyDrag({
        kind: drag.kind,
        origin: drag.origin,
        dx: (e.clientX - drag.startX) / display.width,
        dy: (e.clientY - drag.startY) / display.height,
        ratio,
        frame,
      })
    );
  };

  const endDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId === e.pointerId) dragRef.current = null;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? NUDGE_COARSE : NUDGE;
    const delta: Record<string, [number, number]> = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    };
    const moved = delta[e.key];
    if (!moved) return;
    e.preventDefault();

    const [dx, dy] = moved;
    // Alt resizes from the bottom-right. With an aspect locked the height follows the
    // width, so a vertical resize key has to be restated as the width change behind it —
    // otherwise Alt+Up and Alt+Down would silently do nothing.
    const locked = e.altKey && ratio !== null && dx === 0;
    onChange(
      applyDrag({
        kind: e.altKey ? "se" : "move",
        origin: rect,
        dx: locked ? dy * normalizedRatio(ratio, frame) : dx,
        dy: locked ? 0 : dy,
        ratio,
        frame,
      })
    );
  };

  const asPercent = (value: number) => `${value * 100}%`;
  const grips = ratio === null ? HANDLES : HANDLES.filter((handle) => handle.corner);

  return (
    <div
      className="absolute inset-0 touch-none"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        data-handle="move"
        role="group"
        tabIndex={0}
        aria-label={
          `Crop region, ${Math.round(rect.width * 100)}% wide and ` +
          `${Math.round(rect.height * 100)}% tall, ${Math.round(rect.x * 100)}% from the left ` +
          `and ${Math.round(rect.y * 100)}% from the top. ` +
          `Arrow keys move it, Alt with an arrow resizes it, Shift moves further.`
        }
        onKeyDown={onKeyDown}
        className="absolute cursor-move outline-none ring-1 ring-white/90 focus-visible:ring-2 focus-visible:ring-accent"
        style={{
          left: asPercent(rect.x),
          top: asPercent(rect.y),
          width: asPercent(rect.width),
          height: asPercent(rect.height),
          // Dims everything outside the crop in one paint, with no extra elements to
          // keep in sync with the rectangle.
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.55)",
        }}
      >
        <div aria-hidden className="pointer-events-none absolute inset-0">
          <div className="absolute left-1/3 top-0 h-full w-px bg-white/25" />
          <div className="absolute left-2/3 top-0 h-full w-px bg-white/25" />
          <div className="absolute left-0 top-1/3 h-px w-full bg-white/25" />
          <div className="absolute left-0 top-2/3 h-px w-full bg-white/25" />
        </div>
        {grips.map((handle) => (
          <span
            key={handle.kind}
            data-handle={handle.kind}
            style={{ cursor: handle.cursor }}
            // The visible dot is small enough not to hide the photo; the pseudo-element
            // gives it a finger-sized hit area, and `closest()` credits the hit to it.
            className={cn(
              "absolute h-3 w-3 rounded-full border-2 border-white bg-accent shadow-sm",
              "before:absolute before:-inset-3 before:content-['']",
              HANDLE_CLASS[handle.kind as Exclude<HandleKind, "move">]
            )}
          />
        ))}
      </div>
    </div>
  );
}

export default function ImageEditPanel({
  src,
  fileId,
  fileName,
  mimeType,
  onDirtyChange,
  onSaved,
}: ImageEditPanelProps) {
  const [rotation, setRotation] = useState<Rotation>(0);
  /**
   * The mirrors, applied *after* the rotation exactly as the server applies them.
   *
   * Two flips on the same axis cancel, which is why these are booleans rather than a count.
   */
  const [flipHorizontal, setFlipHorizontal] = useState(false);
  const [flipVertical, setFlipVertical] = useState(false);
  const [crop, setCrop] = useState<NormalizedRect>(() => ({ ...FULL_FRAME }));
  const [quality, setQuality] = useState<number | null>(null);
  /** Write the result as another format, or `null` to keep the file's own. */
  const [convertTo, setConvertTo] = useState<ImageFormat | null>(null);
  /**
   * The longest output edge in pixels, or `null` for "leave it alone".
   *
   * This — not a width/height pair — is the whole resize state, so that a later crop
   * re-derives the plan instead of leaving two fields disagreeing about the output.
   */
  const [resizeTarget, setResizeTarget] = useState<number | null>(null);
  const [aspectId, setAspectId] = useState("free");
  const [natural, setNatural] = useState<Size | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [stage, setStage] = useState<Size>({ width: 0, height: 0 });
  const [saving, setSaving] = useState<"replace" | "copy" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const stageRef = useRef<HTMLDivElement | null>(null);

  // The crop needs the stage in CSS pixels, and the stage is whatever the modal has left
  // over after the header — a number no layout pass here can predict.
  useEffect(() => {
    const node = stageRef.current;
    if (!node) return;
    // `observe()` reports the current size straight away, so the first measurement
    // arrives through the callback rather than from the effect body.
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) setStage({ width: box.width, height: box.height });
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  /**
   * The dirty callback is reached through a ref so a caller passing an inline arrow cannot
   * make the unmount cleanup fire on every render — which would clear the parent's
   * unsaved-changes guard while the edit was still open.
   */
  const dirtyCallbackRef = useRef(onDirtyChange);
  useEffect(() => {
    dirtyCallbackRef.current = onDirtyChange;
  }, [onDirtyChange]);
  useEffect(() => () => dirtyCallbackRef.current?.(false), []);

  /* Everything below is derived in render on purpose. A stored copy of the output size or
     the resize plan is one more thing that can fall out of step with the crop. */
  const rotated = natural ? rotatedFrame(natural, rotation) : null;
  const display = rotated ? fitInside(rotated, stage) : { width: 0, height: 0 };
  const cropped: Size | null = rotated
    ? isFullFrame(crop)
      ? rotated
      : toPixelCrop(crop, rotated)
    : null;
  const longestEdge = cropped ? Math.max(cropped.width, cropped.height) : 0;
  const resize =
    cropped && resizeTarget !== null
      ? resizeIfChanged(scaleToLongestEdge(cropped, resizeTarget), cropped)
      : null;
  const output = resize ?? cropped;

  const draft: ImageEditDraft = {
    rotation,
    flipHorizontal,
    flipVertical,
    crop,
    resize,
    quality,
    convertTo,
  };
  const dirty = hasImageChanges(draft);
  const plan = natural ? buildImageEditRequest({ fileId, draft, natural }) : null;
  const aspect = CROP_ASPECTS.find((option) => option.id === aspectId) ?? CROP_ASPECTS[0];
  const quarterTurn = rotation === 90 || rotation === 270;
  /** `null` for a TIFF or a HEIC: the editor cannot write those, so every target is a change. */
  const sourceFormat = currentImageFormat(mimeType);
  const target = convertTo ? IMAGE_CONVERT_FORMATS.find((option) => option.id === convertTo) : null;
  // PNG has no lossy mode, so a quality number there means "quantise to a palette" — a
  // different bargain, and the note under the slider has to say which one is being made.
  const targetIsPng = (convertTo ?? sourceFormat) === "png";

  // Report the moment the draft diverges: the parent's close guard has to know before the
  // first click outside, not when Save is pressed.
  useEffect(() => {
    dirtyCallbackRef.current?.(dirty);
  }, [dirty]);

  const reset = () => {
    setRotation(0);
    setFlipHorizontal(false);
    setFlipVertical(false);
    setCrop({ ...FULL_FRAME });
    setQuality(null);
    setConvertTo(null);
    setResizeTarget(null);
    setAspectId("free");
    setError(null);
  };

  /**
   * Turn the picture a quarter of the way round, the way it looks on screen.
   *
   * With exactly one mirror on, the preview turns the opposite way to the stored angle — a
   * rotation conjugated by a reflection runs backwards — so the button keeps its meaning by
   * storing the reverse turn. `rotationForTurn` is where that lives; the crop always follows
   * the screen, so it takes the turn the user asked for either way.
   */
  const rotateBy = (delta: number) => {
    const mirrored = flipHorizontal !== flipVertical;
    setRotation((current) => rotationForTurn(current, delta, mirrored));
    setCrop((current) => rotateRect(current, delta));
    // The locked ratio described the crop in pixels, and those have just swapped axes.
    setAspectId("free");
  };

  /**
   * Toggle a mirror, and carry the crop across with it.
   *
   * Without `mirrorRect` the rectangle would stay where it was on screen while the pixels
   * underneath slid out from under it — the selection has to follow the image, the same way
   * it follows a rotation. The aspect stays locked because a mirror does not swap the axes.
   */
  const flipBy = (axis: MirrorAxis) => {
    if (axis === "horizontal") setFlipHorizontal((current) => !current);
    else setFlipVertical((current) => !current);
    setCrop((current) => mirrorRect(current, axis));
  };

  const chooseAspect = (option: (typeof CROP_ASPECTS)[number]) => {
    const ratio = option.ratio;
    setAspectId(option.id);
    if (ratio === null || !rotated) return;
    setCrop((current) => fitAspect(current, ratio, rotated));
  };

  /**
   * Send the draft.
   *
   * `copy` writes a new file and leaves this one alone, so the draft survives the save —
   * the original really is still unedited, and the close guard should keep saying so.
   * `replace` overwrites (a version snapshot is taken server-side) and starts clean.
   */
  const save = async (mode: "replace" | "copy") => {
    if (!natural || saving) return;
    const built = buildImageEditRequest({ fileId, draft, natural, saveAsCopy: mode === "copy" });
    if (!built.ok) {
      setError(built.reason);
      return;
    }

    setSaving(mode);
    setError(null);
    try {
      const res = await apiFetch<{
        sizeBytes: number;
        mimeType: string;
        savedAsCopy: boolean;
        fileId?: string;
        name?: string;
      }>("/api/files/edit", { method: "POST", body: JSON.stringify(built.request) });

      if (!res.success || !res.data) {
        setError(res.error ?? "The edit couldn't be saved.");
        return;
      }

      if (mode === "replace") reset();
      notify({
        title: mode === "copy" ? "Copy saved" : "Image saved",
        description:
          mode === "copy"
            ? `${res.data.name ?? "A copy"} — the original is untouched.`
            : `${fileName} now measures ${built.output.width} × ${built.output.height}. The previous version was kept.`,
        tone: "success",
      });
      onSaved?.({ ...res.data, savedAsCopy: res.data.savedAsCopy ?? mode === "copy" });
    } catch {
      setError("The edit couldn't be sent. Check your connection and try again.");
    } finally {
      setSaving(null);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col lg:flex-row">
      <div
        ref={stageRef}
        className="relative grid min-h-0 flex-1 place-items-center overflow-hidden bg-viewer-stage p-4"
      >
        {loadFailed ? (
          <p role="alert" className="max-w-xs text-center text-sm text-white/70">
            This image couldn’t be loaded for editing. Close the editor and try the preview
            again.
          </p>
        ) : (
          <div
            className="relative"
            style={{ width: display.width || undefined, height: display.height || undefined }}
          >
            {!natural && (
              <span className="absolute inset-0 grid place-items-center">
                <Spinner size="lg" />
              </span>
            )}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={src}
              alt={fileName}
              draggable={false}
              className={cn("absolute left-1/2 top-1/2 select-none", !natural && "opacity-0")}
              style={{
                // A quarter turn swaps the box the image occupies *before* the rotation,
                // so that after it the image fills the wrapper exactly and the crop
                // fractions line up with what is on screen.
                width: quarterTurn ? display.height : display.width,
                height: quarterTurn ? display.width : display.height,
                // Right-to-left: rotate the source, then mirror the result — the server's
                // order. `translate` stays leftmost so it keeps centring the finished box.
                transform:
                  `translate(-50%, -50%) scaleX(${flipHorizontal ? -1 : 1}) ` +
                  `scaleY(${flipVertical ? -1 : 1}) rotate(${rotation}deg)`,
                transformOrigin: "center center",
              }}
              onLoad={(e) => {
                const img = e.currentTarget;
                setNatural({ width: img.naturalWidth, height: img.naturalHeight });
                setLoadFailed(false);
              }}
              onError={() => setLoadFailed(true)}
            />
            {rotated && display.width > 0 && (
              <CropOverlay
                rect={crop}
                frame={rotated}
                display={display}
                ratio={aspect.ratio}
                onChange={setCrop}
              />
            )}
          </div>
        )}
      </div>

      <aside className="flex w-full shrink-0 flex-col gap-5 overflow-y-auto border-t border-border/60 bg-card p-4 lg:w-72 lg:border-l lg:border-t-0">
        <section>
          <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Rotate &amp; flip
          </h3>
          <div className="mt-2 grid grid-cols-2 gap-2">
            <Button variant="secondary" size="sm" onClick={() => rotateBy(-90)}>
              <RotateCcw className="h-3.5 w-3.5" />
              Left
            </Button>
            <Button variant="secondary" size="sm" onClick={() => rotateBy(90)}>
              <RotateCw className="h-3.5 w-3.5" />
              Right
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={flipHorizontal}
              className={cn(flipHorizontal && "border-accent/40 bg-accent/10 text-accent")}
              onClick={() => flipBy("horizontal")}
            >
              <FlipHorizontal className="h-3.5 w-3.5" />
              Mirror
            </Button>
            <Button
              variant="secondary"
              size="sm"
              aria-pressed={flipVertical}
              className={cn(flipVertical && "border-accent/40 bg-accent/10 text-accent")}
              onClick={() => flipBy("vertical")}
            >
              <FlipVertical className="h-3.5 w-3.5" />
              Flip
            </Button>
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Crop
            </h3>
            {!isFullFrame(crop) && (
              <button
                type="button"
                className="text-[11px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                onClick={() => setCrop({ ...FULL_FRAME })}
              >
                Clear
              </button>
            )}
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {CROP_ASPECTS.map((option) => (
              <button
                key={option.id}
                type="button"
                aria-pressed={option.id === aspectId}
                onClick={() => chooseAspect(option)}
                className={cn(
                  "h-8 rounded-lg border text-xs font-medium transition-colors",
                  option.id === aspectId
                    ? "border-accent/40 bg-accent/10 text-accent"
                    : "border-border/60 bg-surface text-muted-foreground hover:border-accent/30 hover:text-foreground"
                )}
              >
                {option.label}
              </button>
            ))}
          </div>
          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
            <Crop className="mt-0.5 h-3 w-3 shrink-0" />
            Drag inside the frame to move the crop, or a grip to resize it. With an aspect
            locked only the corners move.
          </p>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Resize
            </h3>
            <span className="font-mono text-[11px] text-muted-foreground">
              {resizeTarget === null ? "Original" : `${resizeTarget} px`}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {RESIZE_PRESETS.map((preset) => {
              // A preset larger than the crop would be an upscale, which `scaleToLongestEdge`
              // refuses anyway — better to say so than to offer a button that does nothing.
              const upscale = longestEdge > 0 && preset >= longestEdge;
              return (
                <button
                  key={preset}
                  type="button"
                  disabled={upscale}
                  aria-pressed={resizeTarget === preset}
                  onClick={() => setResizeTarget(preset)}
                  className={cn(
                    "h-8 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40",
                    resizeTarget === preset
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border/60 bg-surface text-muted-foreground enabled:hover:border-accent/30 enabled:hover:text-foreground"
                  )}
                  title={upscale ? "Larger than the current crop" : `Longest edge ${preset} px`}
                >
                  {preset}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={resizeTarget === null}
              onClick={() => setResizeTarget(null)}
              className={cn(
                "col-span-2 h-8 rounded-lg border text-xs font-medium transition-colors",
                resizeTarget === null
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border/60 bg-surface text-muted-foreground hover:border-accent/30 hover:text-foreground"
              )}
            >
              Original
            </button>
          </div>
          <div className="mt-2">
            <EditSlider
              label="Longest output edge in pixels"
              min={Math.min(64, Math.max(1, Math.round(longestEdge)))}
              max={Math.max(1, Math.round(longestEdge))}
              value={Math.min(resizeTarget ?? longestEdge, longestEdge) || 1}
              disabled={longestEdge <= 64}
              valueText={
                output ? `${output.width} by ${output.height} pixels` : "waiting for the image"
              }
              onChange={(value) =>
                setResizeTarget(value >= Math.round(longestEdge) ? null : Math.round(value))
              }
            />
          </div>
        </section>

        <section>
          <div className="flex items-baseline justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Format
            </h3>
            <span className="font-mono text-[11px] text-muted-foreground">
              {sourceFormat ? sourceFormat.toUpperCase() : "Other"}
            </span>
          </div>
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            {IMAGE_CONVERT_FORMATS.map((option) => {
              // Converting a file to the format it already is would rewrite every byte for
              // no change at all, so its own format is the "Keep" chip and nothing else.
              const own = option.id === sourceFormat;
              const active = convertTo === option.id;
              return (
                <button
                  key={option.id}
                  type="button"
                  disabled={own}
                  aria-pressed={active}
                  onClick={() => setConvertTo(option.id)}
                  className={cn(
                    "h-8 rounded-lg border text-xs font-medium transition-colors disabled:opacity-40",
                    active
                      ? "border-accent/40 bg-accent/10 text-accent"
                      : "border-border/60 bg-surface text-muted-foreground enabled:hover:border-accent/30 enabled:hover:text-foreground"
                  )}
                  title={own ? "Already this format" : option.note}
                >
                  {option.label}
                </button>
              );
            })}
            <button
              type="button"
              aria-pressed={convertTo === null}
              onClick={() => setConvertTo(null)}
              className={cn(
                "col-span-2 h-8 rounded-lg border text-xs font-medium transition-colors",
                convertTo === null
                  ? "border-accent/40 bg-accent/10 text-accent"
                  : "border-border/60 bg-surface text-muted-foreground hover:border-accent/30 hover:text-foreground"
              )}
            >
              Keep
            </button>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
            {target
              ? `${target.note} The file is renamed to end in ${encoderForFormat(target.id).extension}.`
              : "Kept as it is. Pick a format to re-encode the image into it."}
          </p>
        </section>

        <section>
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Compress
            </h3>
            <button
              type="button"
              role="switch"
              aria-checked={quality !== null}
              aria-label="Re-compress the image"
              onClick={() => setQuality((current) => (current === null ? DEFAULT_EDIT_QUALITY : null))}
              className={cn(
                "relative h-5 w-9 shrink-0 rounded-full transition-colors",
                quality !== null ? "bg-accent" : "bg-border"
              )}
            >
              <span
                className={cn(
                  "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                  quality !== null ? "left-[1.125rem]" : "left-0.5"
                )}
              />
            </button>
          </div>
          {quality !== null && (
            <div className="mt-2">
              <EditSlider
                label="Encoder quality"
                min={40}
                max={100}
                value={quality}
                valueText={`quality ${quality} of 100`}
                onChange={setQuality}
              />
              <p className="mt-1 text-[11px] text-muted-foreground">
                Quality {quality}.{" "}
                {targetIsPng
                  ? "PNG is lossless — compressing it quantises the image to a palette, which can shift colours."
                  : "Lower means a smaller file and more visible artefacts."}
              </p>
            </div>
          )}
        </section>

        <section className="mt-auto space-y-2 border-t border-border/60 pt-4">
          <dl className="space-y-1 text-[11px]">
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Source</dt>
              <dd className="font-mono text-muted-foreground">
                {natural ? `${natural.width} × ${natural.height}` : "—"}
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted-foreground">Output</dt>
              <dd className="font-mono text-foreground">
                {output ? `${output.width} × ${output.height}` : "—"}
              </dd>
            </div>
            {target && (
              <div className="flex justify-between gap-2">
                <dt className="text-muted-foreground">Written as</dt>
                <dd className="font-mono text-foreground">
                  {sourceFormat ? `${sourceFormat.toUpperCase()} → ` : ""}
                  {target.label}
                </dd>
              </div>
            )}
          </dl>

          {error ? (
            <p role="alert" className="text-[11px] leading-relaxed text-danger">
              {error}
            </p>
          ) : dirty && plan && !plan.ok ? (
            <p role="status" className="text-[11px] leading-relaxed text-warning">
              {plan.reason}
            </p>
          ) : null}

          <Button
            className="w-full"
            disabled={!dirty || saving !== null || !plan?.ok}
            onClick={() => save("replace")}
          >
            {saving === "replace" ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Check className="h-4 w-4" />
            )}
            Save
          </Button>
          <div className="flex gap-2">
            <Button
              variant="secondary"
              size="sm"
              className="flex-1"
              disabled={!dirty || saving !== null || !plan?.ok}
              onClick={() => save("copy")}
            >
              {saving === "copy" ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Copy className="h-3.5 w-3.5" />
              )}
              Save as copy
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={!dirty || saving !== null}
              onClick={reset}
            >
              <Undo2 className="h-3.5 w-3.5" />
              Reset
            </Button>
          </div>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Saving overwrites the file and keeps the previous bytes as a version. A copy
            leaves the original alone.
          </p>
        </section>
      </aside>
    </div>
  );
}
