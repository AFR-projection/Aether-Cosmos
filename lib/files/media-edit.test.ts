import { describe, it, expect } from "vitest";
import {
  AUDIO_EXTRACT_TARGETS,
  CROP_ASPECTS,
  DEFAULT_EDIT_QUALITY,
  FULL_FRAME,
  IMAGE_CONVERT_FORMATS,
  MIN_CROP_FRACTION,
  MIN_TRIM_SECONDS,
  RESIZE_PRESETS,
  buildImageEditRequest,
  buildExtractAudioArgs,
  buildTrimArgs,
  canExtractAudioFrom,
  canReencodeInPlace,
  chooseImageEncoder,
  clampRect,
  clampTrimWindow,
  containerExtensionFor,
  copyFileName,
  currentImageFormat,
  emptyImageDraft,
  encoderForFormat,
  extractedAudioName,
  fitAspect,
  formatClock,
  hasImageChanges,
  isFullFrame,
  isMissingAudioStreamError,
  mediaEditorKindFor,
  mirrorRect,
  nextRotation,
  outputSizeError,
  renameForExtension,
  resizeIfChanged,
  rotateRect,
  rotatedFrame,
  rotationForTurn,
  scaleToHeight,
  scaleToLongestEdge,
  scaleToWidth,
  sharpGeometry,
  toPixelCrop,
  trimError,
  type ImageEditDraft,
  type Rotation,
} from "@/lib/files/media-edit";
import {
  EDIT_MAX_DIMENSION,
  EDIT_MAX_OUTPUT_PIXELS,
  EDIT_SOURCE_MAX_BYTES,
  TRIM_MAX_SECONDS,
} from "@/lib/files/edit-limits";

/**
 * These rules decide which pixels of someone's photo survive, so the geometry is pinned
 * against the pipeline it feeds: rotate, then extract, then resize. A crop measured in
 * the wrong frame does not fail — it quietly returns the wrong part of the image.
 */

const PHOTO = { width: 4000, height: 3000 };

function draft(over: Partial<ImageEditDraft> = {}): ImageEditDraft {
  return { ...emptyImageDraft(), ...over };
}

describe("clampRect", () => {
  it("leaves a rectangle already inside the frame alone", () => {
    expect(clampRect({ x: 0.1, y: 0.2, width: 0.5, height: 0.4 })).toEqual({
      x: 0.1,
      y: 0.2,
      width: 0.5,
      height: 0.4,
    });
  });

  it("pulls a rectangle that runs off the right edge back inside", () => {
    expect(clampRect({ x: 0.8, y: 0, width: 0.5, height: 1 })).toEqual({
      x: 0.5,
      y: 0,
      width: 0.5,
      height: 1,
    });
  });

  it("clamps a negative origin to the corner", () => {
    expect(clampRect({ x: -0.4, y: -1, width: 0.3, height: 0.3 })).toEqual({
      x: 0,
      y: 0,
      width: 0.3,
      height: 0.3,
    });
  });

  it("takes the magnitude of an inverted drag", () => {
    // The pointer crossed the anchor, so the drag reports a negative extent.
    expect(clampRect({ x: 0.3, y: 0.3, width: -0.2, height: -0.1 })).toEqual({
      x: 0.3,
      y: 0.3,
      width: 0.2,
      height: 0.1,
    });
  });

  it("floors a collapsed drag, so `extract` never gets a zero extent", () => {
    const result = clampRect({ x: 0.5, y: 0.5, width: 0, height: 0 });
    expect(result.width).toBe(MIN_CROP_FRACTION);
    expect(result.height).toBe(MIN_CROP_FRACTION);
  });

  it("survives a rectangle built from NaN", () => {
    const result = clampRect({ x: NaN, y: NaN, width: NaN, height: NaN });
    expect(result).toEqual({ x: 0, y: 0, width: MIN_CROP_FRACTION, height: MIN_CROP_FRACTION });
  });

  it("caps an oversized rectangle at the whole frame", () => {
    expect(clampRect({ x: 0.2, y: 0.2, width: 3, height: 9 })).toEqual({
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    });
  });
});

describe("isFullFrame", () => {
  it("recognises the untouched frame", () => {
    expect(isFullFrame(FULL_FRAME)).toBe(true);
  });

  it("tolerates the rounding a pointer drag leaves behind", () => {
    expect(isFullFrame({ x: 0.0005, y: 0, width: 0.9995, height: 1 })).toBe(true);
  });

  it("treats a real crop as a crop, however small", () => {
    expect(isFullFrame({ x: 0, y: 0, width: 0.98, height: 1 })).toBe(false);
    expect(isFullFrame({ x: 0.02, y: 0, width: 0.98, height: 1 })).toBe(false);
  });
});

describe("toPixelCrop", () => {
  it("resolves fractions against the frame", () => {
    expect(toPixelCrop({ x: 0.25, y: 0.5, width: 0.5, height: 0.25 }, PHOTO)).toEqual({
      x: 1000,
      y: 1500,
      width: 2000,
      height: 750,
    });
  });

  it("keeps the region inside the frame when rounding would push it out", () => {
    // 0.9999 * 100 rounds to 100, which as a width at x=0 is fine but at x=1 is not.
    const result = toPixelCrop({ x: 0.995, y: 0.995, width: 0.9, height: 0.9 }, { width: 100, height: 100 });
    expect(result.x + result.width).toBeLessThanOrEqual(100);
    expect(result.y + result.height).toBeLessThanOrEqual(100);
  });

  it("never returns a zero extent", () => {
    const result = toPixelCrop({ x: 0, y: 0, width: 0.001, height: 0.001 }, { width: 10, height: 10 });
    expect(result.width).toBeGreaterThanOrEqual(1);
    expect(result.height).toBeGreaterThanOrEqual(1);
  });

  it("returns whole pixels", () => {
    const result = toPixelCrop({ x: 0.333, y: 0.333, width: 0.333, height: 0.333 }, { width: 999, height: 777 });
    for (const value of Object.values(result)) expect(Number.isInteger(value)).toBe(true);
  });
});

describe("nextRotation", () => {
  it("turns a quarter clockwise", () => {
    expect(nextRotation(0, 90)).toBe(90);
    expect(nextRotation(180, 90)).toBe(270);
  });

  it("wraps past a full turn back to zero", () => {
    expect(nextRotation(270, 90)).toBe(0);
  });

  it("wraps a counter-clockwise turn from zero", () => {
    expect(nextRotation(0, -90)).toBe(270);
  });

  it("ignores a delta that is not a number", () => {
    expect(nextRotation(90, NaN)).toBe(90);
  });
});

describe("rotatedFrame", () => {
  it("swaps the axes on a quarter turn", () => {
    expect(rotatedFrame(PHOTO, 90)).toEqual({ width: 3000, height: 4000 });
    expect(rotatedFrame(PHOTO, 270)).toEqual({ width: 3000, height: 4000 });
  });

  it("leaves the frame alone on a half turn", () => {
    expect(rotatedFrame(PHOTO, 180)).toEqual(PHOTO);
    expect(rotatedFrame(PHOTO, 0)).toEqual(PHOTO);
  });
});

describe("rotateRect", () => {
  /** The top-left quarter, so every turn lands it in an unmistakably different corner. */
  const topLeft = { x: 0, y: 0, width: 0.5, height: 0.5 };

  it("carries a rectangle clockwise with the frame", () => {
    expect(rotateRect(topLeft, 90)).toEqual({ x: 0.5, y: 0, width: 0.5, height: 0.5 });
  });

  it("carries a rectangle anticlockwise with the frame", () => {
    expect(rotateRect(topLeft, -90)).toEqual({ x: 0, y: 0.5, width: 0.5, height: 0.5 });
  });

  it("sends it to the opposite corner on a half turn", () => {
    expect(rotateRect(topLeft, 180)).toEqual({ x: 0.5, y: 0.5, width: 0.5, height: 0.5 });
  });

  it("leaves the rectangle where it is for a full turn or none at all", () => {
    const rect = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
    expect(rotateRect(rect, 0)).toEqual(rect);
    expect(rotateRect(rect, 360)).toEqual(rect);
    expect(rotateRect(rect, -360)).toEqual(rect);
  });

  it("swaps the proportions on a quarter turn, because the frame did", () => {
    const wide = { x: 0.1, y: 0.4, width: 0.8, height: 0.2 };
    const turned = rotateRect(wide, 90);
    expect(turned.width).toBeCloseTo(0.2, 10);
    expect(turned.height).toBeCloseTo(0.8, 10);
  });

  it("returns to the original rectangle after four quarter turns", () => {
    const rect = { x: 0.2, y: 0.1, width: 0.3, height: 0.4 };
    let carried = rect;
    for (let turn = 0; turn < 4; turn += 1) carried = rotateRect(carried, 90);
    expect(carried.x).toBeCloseTo(rect.x, 10);
    expect(carried.y).toBeCloseTo(rect.y, 10);
    expect(carried.width).toBeCloseTo(rect.width, 10);
    expect(carried.height).toBeCloseTo(rect.height, 10);
  });

  it("keeps the result inside the frame", () => {
    // A rectangle that already pokes out is clamped rather than carried out further.
    const turned = rotateRect({ x: 0.8, y: 0.8, width: 0.5, height: 0.5 }, 90);
    expect(turned.x).toBeGreaterThanOrEqual(0);
    expect(turned.y).toBeGreaterThanOrEqual(0);
    expect(turned.x + turned.width).toBeLessThanOrEqual(1);
    expect(turned.y + turned.height).toBeLessThanOrEqual(1);
  });
});

describe("mirrorRect", () => {
  it("mirrors the leading edge horizontally, not the whole coordinate", () => {
    // x = 0.1 with width 0.3 ends at 0.4, so the mirror starts at 1 - 0.4.
    expect(mirrorRect({ x: 0.1, y: 0.25, width: 0.3, height: 0.5 }, "horizontal")).toEqual({
      x: 0.6,
      y: 0.25,
      width: 0.3,
      height: 0.5,
    });
  });

  it("leaves a vertically centred rectangle in place, and never moves x", () => {
    expect(mirrorRect({ x: 0.1, y: 0.25, width: 0.3, height: 0.5 }, "vertical")).toEqual({
      x: 0.1,
      y: 0.25,
      width: 0.3,
      height: 0.5,
    });
  });

  it("moves a rectangle that is not vertically centred", () => {
    expect(mirrorRect({ x: 0, y: 0, width: 1, height: 0.25 }, "vertical")).toEqual({
      x: 0,
      y: 0.75,
      width: 1,
      height: 0.25,
    });
  });

  it("is its own inverse, so toggling a flip twice restores the crop", () => {
    const rect = { x: 0.15, y: 0.05, width: 0.35, height: 0.45 };
    for (const axis of ["horizontal", "vertical"] as const) {
      const back = mirrorRect(mirrorRect(rect, axis), axis);
      expect(back.x).toBeCloseTo(rect.x, 10);
      expect(back.y).toBeCloseTo(rect.y, 10);
      expect(back.width).toBeCloseTo(rect.width, 10);
      expect(back.height).toBeCloseTo(rect.height, 10);
    }
  });

  it("leaves the size alone — a mirror moves pixels, it does not scale them", () => {
    const mirrored = mirrorRect({ x: 0.2, y: 0.3, width: 0.4, height: 0.6 }, "horizontal");
    expect(mirrored.width).toBeCloseTo(0.4, 10);
    expect(mirrored.height).toBeCloseTo(0.6, 10);
  });

  it("leaves a full frame full, so a flip on its own is not read as a crop", () => {
    expect(isFullFrame(mirrorRect({ ...FULL_FRAME }, "horizontal"))).toBe(true);
    expect(isFullFrame(mirrorRect({ ...FULL_FRAME }, "vertical"))).toBe(true);
  });
});

describe("rotationForTurn", () => {
  it("stores the turn it was given when nothing is mirrored", () => {
    expect(rotationForTurn(0, 90, false)).toBe(90);
    expect(rotationForTurn(90, -90, false)).toBe(0);
    expect(rotationForTurn(270, 90, false)).toBe(0);
  });

  it("stores the reverse turn when one mirror is on, so the screen still turns that way", () => {
    expect(rotationForTurn(0, 90, true)).toBe(270);
    expect(rotationForTurn(0, -90, true)).toBe(90);
    expect(rotationForTurn(180, 90, true)).toBe(90);
  });

  it("comes back to where it started after four turns, mirrored or not", () => {
    for (const mirrored of [false, true]) {
      let rotation: Rotation = 90;
      for (let turn = 0; turn < 4; turn += 1) rotation = rotationForTurn(rotation, 90, mirrored);
      expect(rotation).toBe(90);
    }
  });
});

describe("sharpGeometry", () => {
  const SOURCE = { width: 200, height: 100 };

  it("passes a plain rotation straight through", () => {
    expect(sharpGeometry({ rotate: 90, source: SOURCE })).toEqual({
      rotate: 90,
      flop: false,
      flip: false,
      crop: null,
    });
  });

  it("normalizes a negative angle, which sharp would take either way", () => {
    expect(sharpGeometry({ rotate: -90, source: SOURCE }).rotate).toBe(270);
    expect(sharpGeometry({ rotate: -360, source: SOURCE }).rotate).toBe(0);
  });

  it("keeps the axes as asked when nothing is rotated", () => {
    expect(sharpGeometry({ flipHorizontal: true, source: SOURCE })).toMatchObject({
      flop: true,
      flip: false,
    });
    expect(sharpGeometry({ flipVertical: true, source: SOURCE })).toMatchObject({
      flop: false,
      flip: true,
    });
  });

  it("swaps the axes across a quarter turn, because that is the same mirror", () => {
    // sharp mirrors BEFORE it rotates, and `flop ∘ rot90 = rot90 ∘ flip`.
    for (const rotate of [90, 270]) {
      expect(sharpGeometry({ rotate, flipHorizontal: true, source: SOURCE })).toMatchObject({
        flop: false,
        flip: true,
      });
      expect(sharpGeometry({ rotate, flipVertical: true, source: SOURCE })).toMatchObject({
        flop: true,
        flip: false,
      });
    }
  });

  it("leaves the axes alone across a half turn, which commutes with both mirrors", () => {
    expect(
      sharpGeometry({ rotate: 180, flipHorizontal: true, flipVertical: true, source: SOURCE })
    ).toMatchObject({ flop: true, flip: true });
    expect(sharpGeometry({ rotate: 180, flipHorizontal: true, source: SOURCE })).toMatchObject({
      flop: true,
      flip: false,
    });
  });

  it("mirrors a crop back into the source frame when nothing is rotated", () => {
    // The extract runs before the mirror in that case, so the rectangle has to be the one
    // the mirror will turn into what the caller asked for.
    expect(
      sharpGeometry({
        flipHorizontal: true,
        crop: { x: 10, y: 20, width: 40, height: 30 },
        source: SOURCE,
      }).crop
    ).toEqual({ x: 150, y: 20, width: 40, height: 30 });
    expect(
      sharpGeometry({
        flipVertical: true,
        crop: { x: 10, y: 20, width: 40, height: 30 },
        source: SOURCE,
      }).crop
    ).toEqual({ x: 10, y: 50, width: 40, height: 30 });
  });

  it("mirrors both edges of a crop when both mirrors are on", () => {
    expect(
      sharpGeometry({
        flipHorizontal: true,
        flipVertical: true,
        crop: { x: 0, y: 0, width: 20, height: 10 },
        source: SOURCE,
      }).crop
    ).toEqual({ x: 180, y: 90, width: 20, height: 10 });
  });

  it("leaves a crop where it is when there is a rotation to hide behind", () => {
    // With an angle pending the extract already happens after the mirror, so moving the
    // rectangle here would move it twice.
    for (const rotate of [90, 180, 270]) {
      expect(
        sharpGeometry({
          rotate,
          flipHorizontal: true,
          flipVertical: true,
          crop: { x: 10, y: 20, width: 40, height: 30 },
          source: SOURCE,
        }).crop
      ).toEqual({ x: 10, y: 20, width: 40, height: 30 });
    }
  });

  it("leaves a crop where it is when there is no mirror", () => {
    expect(
      sharpGeometry({ crop: { x: 10, y: 20, width: 40, height: 30 }, source: SOURCE }).crop
    ).toEqual({ x: 10, y: 20, width: 40, height: 30 });
  });

  it("never sends a negative offset, even if the crop overruns the frame", () => {
    const crop = sharpGeometry({
      flipHorizontal: true,
      flipVertical: true,
      crop: { x: 0, y: 0, width: 500, height: 500 },
      source: SOURCE,
    }).crop;
    expect(crop).toEqual({ x: 0, y: 0, width: 500, height: 500 });
  });

  it("mirrors a full-frame crop onto itself", () => {
    expect(
      sharpGeometry({
        flipHorizontal: true,
        crop: { x: 0, y: 0, width: SOURCE.width, height: SOURCE.height },
        source: SOURCE,
      }).crop
    ).toEqual({ x: 0, y: 0, width: SOURCE.width, height: SOURCE.height });
  });
});

describe("fitAspect", () => {
  it("makes a square crop square in pixels, not in fractions", () => {
    const rect = fitAspect(FULL_FRAME, 1, PHOTO);
    expect(rect.width * PHOTO.width).toBeCloseTo(rect.height * PHOTO.height, 6);
  });

  it("fills the short axis of a landscape frame for a square crop", () => {
    const rect = fitAspect(FULL_FRAME, 1, PHOTO);
    expect(rect.height).toBeCloseTo(1, 6);
    expect(rect.width).toBeCloseTo(0.75, 6);
  });

  it("keeps the centre of the rectangle it was given", () => {
    const before = { x: 0.1, y: 0.1, width: 0.4, height: 0.4 };
    const after = fitAspect(before, 16 / 9, PHOTO);
    expect(after.x + after.width / 2).toBeCloseTo(before.x + before.width / 2, 6);
    expect(after.y + after.height / 2).toBeCloseTo(before.y + before.height / 2, 6);
  });

  it("shrinks rather than grows, so the crop stays inside what was selected", () => {
    const before = { x: 0.25, y: 0.25, width: 0.5, height: 0.5 };
    const after = fitAspect(before, 1, PHOTO);
    expect(after.width).toBeLessThanOrEqual(before.width + 1e-9);
    expect(after.height).toBeLessThanOrEqual(before.height + 1e-9);
  });

  it("nudges a reshaped crop back inside the frame", () => {
    const after = fitAspect({ x: 0.9, y: 0.9, width: 0.1, height: 0.1 }, 16 / 9, PHOTO);
    expect(after.x + after.width).toBeLessThanOrEqual(1 + 1e-9);
    expect(after.y + after.height).toBeLessThanOrEqual(1 + 1e-9);
  });

  it("declines a ratio that is not a positive number", () => {
    const rect = { x: 0.1, y: 0.1, width: 0.5, height: 0.5 };
    expect(fitAspect(rect, 0, PHOTO)).toEqual(rect);
    expect(fitAspect(rect, NaN, PHOTO)).toEqual(rect);
  });

  it("offers a free option and no duplicate ratios", () => {
    expect(CROP_ASPECTS[0]).toMatchObject({ id: "free", ratio: null });
    const ratios = CROP_ASPECTS.map((a) => a.ratio);
    expect(new Set(ratios).size).toBe(ratios.length);
  });
});

describe("resize helpers", () => {
  it("keeps the proportions when only the width is given", () => {
    expect(scaleToWidth(PHOTO, 2000)).toEqual({ width: 2000, height: 1500 });
  });

  it("keeps the proportions when only the height is given", () => {
    expect(scaleToHeight(PHOTO, 1500)).toEqual({ width: 2000, height: 1500 });
  });

  it("rounds to whole pixels rather than emitting a fraction", () => {
    const plan = scaleToWidth({ width: 1000, height: 333 }, 777);
    expect(Number.isInteger(plan.height)).toBe(true);
  });

  it("never returns a zero side", () => {
    expect(scaleToWidth({ width: 4000, height: 3 }, 1).height).toBeGreaterThanOrEqual(1);
  });

  it("fits the longest edge for a landscape frame", () => {
    expect(scaleToLongestEdge(PHOTO, 1920)).toEqual({ width: 1920, height: 1440 });
  });

  it("fits the longest edge for a portrait frame", () => {
    expect(scaleToLongestEdge({ width: 3000, height: 4000 }, 1920)).toEqual({ width: 1440, height: 1920 });
  });

  it("refuses to upscale a frame that is already smaller than the preset", () => {
    expect(scaleToLongestEdge({ width: 320, height: 240 }, 1920)).toEqual({ width: 320, height: 240 });
  });

  it("offers presets in descending order", () => {
    const presets = [...RESIZE_PRESETS];
    expect(presets).toEqual([...presets].sort((a, b) => b - a));
  });

  it("collapses a resize that changes nothing", () => {
    expect(resizeIfChanged({ width: 4000, height: 3000 }, PHOTO)).toBeNull();
    expect(resizeIfChanged({ width: 4000, height: 2999 }, PHOTO)).toEqual({ width: 4000, height: 2999 });
    expect(resizeIfChanged(null, PHOTO)).toBeNull();
  });
});

describe("outputSizeError", () => {
  it("accepts an ordinary size", () => {
    expect(outputSizeError({ width: 1920, height: 1080 })).toBeNull();
  });

  it("rejects a fractional or empty size", () => {
    expect(outputSizeError({ width: 100.5, height: 100 })).toMatch(/whole numbers/i);
    expect(outputSizeError({ width: 0, height: 100 })).toMatch(/whole numbers/i);
  });

  it("rejects a side past the dimension ceiling", () => {
    expect(outputSizeError({ width: EDIT_MAX_DIMENSION + 1, height: 10 })).toMatch(/under/i);
  });

  it("rejects an area past the pixel ceiling even when both sides pass", () => {
    const side = EDIT_MAX_DIMENSION;
    expect(side * side).toBeGreaterThan(EDIT_MAX_OUTPUT_PIXELS);
    expect(outputSizeError({ width: side, height: side })).toMatch(/megapixels/i);
  });
});

describe("hasImageChanges", () => {
  it("is false for a fresh draft", () => {
    expect(hasImageChanges(emptyImageDraft())).toBe(false);
  });

  it("is true once anything is set", () => {
    expect(hasImageChanges(draft({ rotation: 90 }))).toBe(true);
    expect(hasImageChanges(draft({ crop: { x: 0, y: 0, width: 0.5, height: 1 } }))).toBe(true);
    expect(hasImageChanges(draft({ resize: { width: 100, height: 75 } }))).toBe(true);
    expect(hasImageChanges(draft({ quality: DEFAULT_EDIT_QUALITY }))).toBe(true);
  });

  it("counts a flip on its own, which moves no edges and resizes nothing", () => {
    expect(hasImageChanges(draft({ flipHorizontal: true }))).toBe(true);
    expect(hasImageChanges(draft({ flipVertical: true }))).toBe(true);
  });

  it("counts a conversion on its own, since it rewrites the whole file", () => {
    expect(hasImageChanges(draft({ convertTo: "webp" }))).toBe(true);
  });
});

describe("buildImageEditRequest", () => {
  const base = { fileId: "file-1", natural: PHOTO };

  it("refuses a draft that asks for nothing", () => {
    const plan = buildImageEditRequest({ ...base, draft: emptyImageDraft() });
    expect(plan).toEqual({ ok: false, reason: expect.stringMatching(/nothing to save/i) });
  });

  it("refuses before the image has reported its size", () => {
    const plan = buildImageEditRequest({
      ...base,
      natural: { width: 0, height: 0 },
      draft: draft({ rotation: 90 }),
    });
    expect(plan).toEqual({ ok: false, reason: expect.stringMatching(/finish loading/i) });
  });

  it("sends a bare rotation with no crop or size", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ rotation: 270 }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request).toEqual({ fileId: "file-1", action: "rotate", rotate: 270 });
    expect(plan.output).toEqual({ width: 3000, height: 4000 });
  });

  it("measures the crop against the rotated frame, because the pipeline rotates first", () => {
    // The right half of a portrait-rotated 4000×3000 photo is 1500 px of the 3000 px width.
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({ rotation: 90, crop: { x: 0.5, y: 0, width: 0.5, height: 1 } }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.crop).toEqual({ x: 1500, y: 0, width: 1500, height: 4000 });
    expect(plan.request.rotate).toBe(90);
    expect(plan.request.action).toBe("crop");
  });

  it("measures the crop against the natural frame when there is no rotation", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({ crop: { x: 0.5, y: 0, width: 0.5, height: 1 } }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.crop).toEqual({ x: 2000, y: 0, width: 2000, height: 3000 });
    expect(plan.request.rotate).toBeUndefined();
  });

  it("leaves the crop out when the whole frame is kept", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ quality: 70 }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.crop).toBeUndefined();
    expect(plan.request).toEqual({ fileId: "file-1", action: "compress", quality: 70 });
  });

  it("measures a resize against the cropped size, because the pipeline crops first", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        resize: { width: 1000, height: 750 },
      }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    // The crop leaves 2000×1500; the resize is a real change against that, so it rides along.
    expect(plan.request.crop).toEqual({ x: 0, y: 0, width: 2000, height: 1500 });
    expect(plan.request.width).toBe(1000);
    expect(plan.request.height).toBe(750);
    expect(plan.output).toEqual({ width: 1000, height: 750 });
  });

  it("drops a resize that matches what the crop already produced", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({
        crop: { x: 0, y: 0, width: 0.5, height: 0.5 },
        resize: { width: 2000, height: 1500 },
      }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.width).toBeUndefined();
    expect(plan.request.height).toBeUndefined();
    expect(plan.output).toEqual({ width: 2000, height: 1500 });
  });

  it("reports the resulting size for a plain resize", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ resize: { width: 1920, height: 1440 } }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.action).toBe("resize");
    expect(plan.output).toEqual({ width: 1920, height: 1440 });
  });

  it("refuses an output the server would refuse too", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({ resize: { width: EDIT_MAX_DIMENSION + 1, height: 10 } }),
    });
    expect(plan.ok).toBe(false);
  });

  it("names the most destructive action, so the activity line is honest", () => {
    const all = draft({ rotation: 90, crop: { x: 0, y: 0, width: 0.5, height: 1 }, quality: 80 });
    const plan = buildImageEditRequest({ ...base, draft: all });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.action).toBe("crop");
  });

  it("carries quality alongside a crop, so one pass does both", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({ crop: { x: 0, y: 0, width: 0.5, height: 1 }, quality: 60 }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.quality).toBe(60);
  });

  it("asks for a copy only when told to", () => {
    const inPlace = buildImageEditRequest({ ...base, draft: draft({ rotation: 90 }) });
    if (!inPlace.ok) throw new Error(inPlace.reason);
    expect("saveAsCopy" in inPlace.request).toBe(false);

    const copy = buildImageEditRequest({ ...base, draft: draft({ rotation: 90 }), saveAsCopy: true });
    if (!copy.ok) throw new Error(copy.reason);
    expect(copy.request.saveAsCopy).toBe(true);
  });

  it("sends a bare mirror as its own action", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ flipHorizontal: true }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request).toEqual({ fileId: "file-1", action: "flip", flipHorizontal: true });
    // A mirror moves pixels around inside the same rectangle.
    expect(plan.output).toEqual(PHOTO);
  });

  it("sends both mirrors together, because they are independent axes", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({ flipHorizontal: true, flipVertical: true }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.flipHorizontal).toBe(true);
    expect(plan.request.flipVertical).toBe(true);
  });

  it("omits a flip that is off rather than sending false", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ flipVertical: true }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect("flipHorizontal" in plan.request).toBe(false);
    expect(plan.request.flipVertical).toBe(true);
  });

  it("sends a bare conversion as its own action", () => {
    const plan = buildImageEditRequest({ ...base, draft: draft({ convertTo: "webp" }) });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request).toEqual({ fileId: "file-1", action: "convert", format: "webp" });
    expect(plan.output).toEqual(PHOTO);
  });

  it("carries a conversion alongside geometry, so one pass does all of it", () => {
    const plan = buildImageEditRequest({
      ...base,
      draft: draft({
        rotation: 90,
        flipHorizontal: true,
        crop: { x: 0, y: 0, width: 0.5, height: 1 },
        convertTo: "avif",
        quality: 70,
      }),
    });
    if (!plan.ok) throw new Error(plan.reason);
    expect(plan.request.rotate).toBe(90);
    expect(plan.request.flipHorizontal).toBe(true);
    expect(plan.request.crop).toEqual({ x: 0, y: 0, width: 1500, height: 4000 });
    expect(plan.request.format).toBe("avif");
    expect(plan.request.quality).toBe(70);
    // The crop is still the most destructive thing in there.
    expect(plan.request.action).toBe("crop");
  });

  it("names a conversion above a rotation, and a flip last of all", () => {
    const converted = buildImageEditRequest({
      ...base,
      draft: draft({ rotation: 180, flipVertical: true, convertTo: "png" }),
    });
    if (!converted.ok) throw new Error(converted.reason);
    expect(converted.request.action).toBe("convert");

    const rotated = buildImageEditRequest({
      ...base,
      draft: draft({ rotation: 180, flipVertical: true }),
    });
    if (!rotated.ok) throw new Error(rotated.reason);
    expect(rotated.request.action).toBe("rotate");
  });
});

describe("copyFileName", () => {
  it("keeps the extension after the suffix", () => {
    expect(copyFileName("report.png")).toBe("report (edited).png");
  });

  it("uses only the last dot, so a versioned name survives", () => {
    expect(copyFileName("archive.tar.gz")).toBe("archive.tar (edited).gz");
  });

  it("appends to a name with no extension", () => {
    expect(copyFileName("README")).toBe("README (edited)");
  });

  it("treats a dot-file as having no extension to preserve", () => {
    expect(copyFileName(".gitignore")).toBe(".gitignore (edited)");
  });

  it("takes a different suffix", () => {
    expect(copyFileName("clip.mp4", "trimmed")).toBe("clip (trimmed).mp4");
  });
});

describe("renameForExtension", () => {
  it("replaces the extension", () => {
    expect(renameForExtension("photo.tiff", ".jpg")).toBe("photo.jpg");
  });

  it("adds one when there was none", () => {
    expect(renameForExtension("photo", ".jpg")).toBe("photo.jpg");
  });

  it("leaves a dot-file's name intact", () => {
    expect(renameForExtension(".profile", ".jpg")).toBe(".profile.jpg");
  });
});

describe("chooseImageEncoder", () => {
  it("preserves the format for everything sharp writes natively", () => {
    expect(chooseImageEncoder("image/png")).toMatchObject({ format: "png", extension: ".png" });
    expect(chooseImageEncoder("image/webp")).toMatchObject({ format: "webp", extension: ".webp" });
    expect(chooseImageEncoder("image/avif")).toMatchObject({ format: "avif", extension: ".avif" });
    expect(chooseImageEncoder("image/jpeg")).toMatchObject({ format: "jpeg", extension: ".jpg" });
  });

  it("treats the non-standard jpeg spelling as jpeg", () => {
    expect(chooseImageEncoder("image/jpg").format).toBe("jpeg");
  });

  it("ignores case and parameters on the mime type", () => {
    expect(chooseImageEncoder("IMAGE/PNG; charset=binary").format).toBe("png");
  });

  it("falls back to jpeg for a format it cannot write back", () => {
    expect(chooseImageEncoder("image/tiff")).toMatchObject({ format: "jpeg", mimeType: "image/jpeg" });
  });

  it("returns a mime type that agrees with the extension it hands out", () => {
    for (const mime of ["image/png", "image/webp", "image/avif", "image/jpeg", "image/heic"]) {
      const encoder = chooseImageEncoder(mime);
      expect(renameForExtension("x.bin", encoder.extension)).toContain(encoder.extension);
      expect(encoder.mimeType.startsWith("image/")).toBe(true);
    }
  });
});

describe("encoderForFormat", () => {
  it("hands out an encoder whose format, mime type and extension agree", () => {
    expect(encoderForFormat("jpeg")).toEqual({
      format: "jpeg",
      mimeType: "image/jpeg",
      extension: ".jpg",
    });
    expect(encoderForFormat("png")).toEqual({
      format: "png",
      mimeType: "image/png",
      extension: ".png",
    });
    expect(encoderForFormat("webp")).toEqual({
      format: "webp",
      mimeType: "image/webp",
      extension: ".webp",
    });
    expect(encoderForFormat("avif")).toEqual({
      format: "avif",
      mimeType: "image/avif",
      extension: ".avif",
    });
  });

  it("covers every format the panel offers, so no chip can pick a missing encoder", () => {
    for (const option of IMAGE_CONVERT_FORMATS) {
      expect(encoderForFormat(option.id).format).toBe(option.id);
    }
  });

  it("agrees with the format-preserving chooser for a source of the same type", () => {
    for (const option of IMAGE_CONVERT_FORMATS) {
      const encoder = encoderForFormat(option.id);
      expect(chooseImageEncoder(encoder.mimeType)).toEqual(encoder);
    }
  });
});

describe("currentImageFormat", () => {
  it("names the format a file already is", () => {
    expect(currentImageFormat("image/png")).toBe("png");
    expect(currentImageFormat("image/webp")).toBe("webp");
    expect(currentImageFormat("image/avif")).toBe("avif");
    expect(currentImageFormat("image/jpeg")).toBe("jpeg");
  });

  it("folds the non-standard jpeg spelling in, so `.jpg` is not offered a conversion to jpeg", () => {
    expect(currentImageFormat("image/jpg")).toBe("jpeg");
  });

  it("ignores case and parameters", () => {
    expect(currentImageFormat("IMAGE/WEBP; charset=binary")).toBe("webp");
  });

  it("is null for a format the editor cannot write, so every target is a real change", () => {
    expect(currentImageFormat("image/tiff")).toBeNull();
    expect(currentImageFormat("image/heic")).toBeNull();
    expect(currentImageFormat("image/bmp")).toBeNull();
    expect(currentImageFormat("image/svg+xml")).toBeNull();
  });
});

describe("IMAGE_CONVERT_FORMATS", () => {
  it("offers each format once, with something to read next to it", () => {
    const ids = IMAGE_CONVERT_FORMATS.map((option) => option.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const option of IMAGE_CONVERT_FORMATS) {
      expect(option.label.length).toBeGreaterThan(0);
      expect(option.note.length).toBeGreaterThan(0);
    }
  });
});

describe("canReencodeInPlace", () => {
  it("is true for the formats sharp writes back", () => {
    for (const mime of ["image/jpeg", "image/jpg", "image/png", "image/webp", "image/avif"]) {
      expect(canReencodeInPlace(mime)).toBe(true);
    }
  });

  it("is false for a format that has to become jpeg", () => {
    expect(canReencodeInPlace("image/tiff")).toBe(false);
    expect(canReencodeInPlace("image/heic")).toBe(false);
    expect(canReencodeInPlace("image/bmp")).toBe(false);
  });

  it("agrees with chooseImageEncoder about which sources keep their format", () => {
    for (const mime of ["image/png", "image/tiff", "image/webp", "image/x-icon"]) {
      const keeps = chooseImageEncoder(mime).mimeType === mime;
      expect(canReencodeInPlace(mime)).toBe(keeps || mime === "image/jpg");
    }
  });

  it("ignores case and parameters", () => {
    expect(canReencodeInPlace("Image/PNG; charset=binary")).toBe(true);
  });
});

describe("containerExtensionFor", () => {
  it("keeps the source container, because a stream copy cannot change one", () => {
    expect(containerExtensionFor("video/webm")).toBe("webm");
    expect(containerExtensionFor("video/x-matroska")).toBe("mkv");
    expect(containerExtensionFor("video/quicktime")).toBe("mov");
    expect(containerExtensionFor("audio/flac")).toBe("flac");
    expect(containerExtensionFor("audio/wav")).toBe("wav");
  });

  it("maps the two mp4 families to their conventional extensions", () => {
    expect(containerExtensionFor("video/mp4")).toBe("mp4");
    expect(containerExtensionFor("audio/mp4")).toBe("m4a");
  });

  it("ignores case and parameters", () => {
    expect(containerExtensionFor("VIDEO/MP4; codecs=avc1")).toBe("mp4");
  });

  it("reports no mapping rather than guessing", () => {
    expect(containerExtensionFor("video/x-ms-wmv")).toBeNull();
    expect(containerExtensionFor("application/pdf")).toBeNull();
    expect(containerExtensionFor("")).toBeNull();
  });
});

describe("buildTrimArgs", () => {
  const args = buildTrimArgs({ inputPath: "/tmp/in.mp4", outputPath: "/tmp/out.mp4", startSeconds: 12.25, endSeconds: 30 });

  it("seeks before the input, which is what keeps a trim instant", () => {
    expect(args.indexOf("-ss")).toBeLessThan(args.indexOf("-i"));
  });

  it("cuts by duration rather than by end mark", () => {
    // `-to` after an input-side `-ss` is measured from the seek point in some builds and
    // from the file start in others; `-t` has one meaning everywhere.
    expect(args[args.indexOf("-t") + 1]).toBe("17.750");
    expect(args).not.toContain("-to");
  });

  it("copies streams instead of re-encoding", () => {
    expect(args[args.indexOf("-c") + 1]).toBe("copy");
  });

  it("keeps the result playable when the cut lands mid-GOP", () => {
    expect(args[args.indexOf("-avoid_negative_ts") + 1]).toBe("make_zero");
  });

  it("carries audio and video only, and tolerates either being absent", () => {
    const maps = args.filter((_, i) => args[i - 1] === "-map");
    expect(maps).toEqual(["0:v?", "0:a?"]);
  });

  it("never blocks on stdin or writes an interactive prompt", () => {
    expect(args).toContain("-nostdin");
    expect(args).toContain("-y");
  });

  it("puts the output path last", () => {
    expect(args[args.length - 1]).toBe("/tmp/out.mp4");
  });

  it("clamps a negative start to the beginning of the clip", () => {
    const negative = buildTrimArgs({ inputPath: "i", outputPath: "o", startSeconds: -5, endSeconds: 10 });
    expect(negative[negative.indexOf("-ss") + 1]).toBe("0.000");
  });

  it("never asks for a non-positive duration", () => {
    const inverted = buildTrimArgs({ inputPath: "i", outputPath: "o", startSeconds: 10, endSeconds: 2 });
    expect(Number(inverted[inverted.indexOf("-t") + 1])).toBeGreaterThanOrEqual(MIN_TRIM_SECONDS);
  });
});

describe("clampTrimWindow", () => {
  it("leaves a valid window alone", () => {
    expect(clampTrimWindow({ startSeconds: 2, endSeconds: 8 }, 60)).toEqual({ startSeconds: 2, endSeconds: 8 });
  });

  it("pulls both marks inside the clip", () => {
    expect(clampTrimWindow({ startSeconds: 90, endSeconds: 200 }, 60)).toEqual({
      startSeconds: 60 - MIN_TRIM_SECONDS,
      endSeconds: 60,
    });
  });

  it("pushes the end out when the handles meet", () => {
    expect(clampTrimWindow({ startSeconds: 5, endSeconds: 5 }, 60)).toEqual({
      startSeconds: 5,
      endSeconds: 5 + MIN_TRIM_SECONDS,
    });
  });

  it("pulls the start back when there is no room at the end", () => {
    const result = clampTrimWindow({ startSeconds: 10, endSeconds: 10 }, 10);
    expect(result.endSeconds).toBe(10);
    expect(result.startSeconds).toBe(10 - MIN_TRIM_SECONDS);
  });

  it("uncrosses handles that passed each other", () => {
    const result = clampTrimWindow({ startSeconds: 9, endSeconds: 3 }, 60);
    expect(result.endSeconds - result.startSeconds).toBeGreaterThanOrEqual(MIN_TRIM_SECONDS);
  });

  it("falls back to the hard ceiling when the duration is unknown", () => {
    const result = clampTrimWindow({ startSeconds: 0, endSeconds: TRIM_MAX_SECONDS * 2 }, null);
    expect(result.endSeconds).toBe(TRIM_MAX_SECONDS);
  });

  it("survives NaN from a range input that reported no value", () => {
    expect(clampTrimWindow({ startSeconds: NaN, endSeconds: NaN }, 60)).toEqual({
      startSeconds: 0,
      endSeconds: MIN_TRIM_SECONDS,
    });
  });

  it("rounds to milliseconds, which is all ffmpeg is told about", () => {
    const result = clampTrimWindow({ startSeconds: 1.23456789, endSeconds: 9.87654321 }, 60);
    expect(result).toEqual({ startSeconds: 1.235, endSeconds: 9.877 });
  });
});

describe("trimError", () => {
  it("accepts a window that cuts something", () => {
    expect(trimError({ startSeconds: 5, endSeconds: 20 }, 60)).toBeNull();
  });

  it("rejects a clip shorter than the floor", () => {
    expect(trimError({ startSeconds: 5, endSeconds: 5.2 }, 60)).toMatch(/at least/i);
  });

  it("rejects an inverted window", () => {
    expect(trimError({ startSeconds: 20, endSeconds: 5 }, 60)).toMatch(/at least/i);
  });

  it("rejects marks that are not numbers", () => {
    expect(trimError({ startSeconds: NaN, endSeconds: 5 }, 60)).toMatch(/start and an end/i);
    expect(trimError({ startSeconds: -1, endSeconds: 5 }, 60)).toMatch(/start and an end/i);
  });

  it("rejects a window past the hard ceiling", () => {
    expect(trimError({ startSeconds: 0, endSeconds: TRIM_MAX_SECONDS + 1 }, null)).toMatch(/longer than/i);
  });

  it("rejects a start beyond the end of the clip", () => {
    expect(trimError({ startSeconds: 90, endSeconds: 120 }, 60)).toMatch(/past the end/i);
  });

  it("refuses a trim that would rewrite the file for no change", () => {
    // A snapshot and a re-upload cost the user quota; producing the same bytes is not free.
    expect(trimError({ startSeconds: 0, endSeconds: 60 }, 60)).toMatch(/whole clip/i);
  });

  it("accepts a window when the duration is not known yet", () => {
    expect(trimError({ startSeconds: 0, endSeconds: 10 }, null)).toBeNull();
  });
});

describe("formatClock", () => {
  it("shows minutes, seconds and tenths", () => {
    expect(formatClock(95.4)).toBe("1:35.4");
  });

  it("pads the seconds so the label does not jump", () => {
    expect(formatClock(61)).toBe("1:01.0");
    expect(formatClock(0)).toBe("0:00.0");
  });

  it("adds an hour field only when there is one", () => {
    expect(formatClock(3675)).toBe("1:01:15.0");
    expect(formatClock(3599.9)).toBe("59:59.9");
  });

  it("carries a rounded tenth into the seconds rather than showing .10", () => {
    expect(formatClock(59.98)).toBe("1:00.0");
  });

  it("treats nonsense as the start of the clip", () => {
    expect(formatClock(NaN)).toBe("0:00.0");
    expect(formatClock(-5)).toBe("0:00.0");
  });
});

describe("canExtractAudioFrom", () => {
  it("takes video of any container", () => {
    for (const mime of ["video/mp4", "video/webm", "video/x-matroska", "video/x-flv"]) {
      expect(canExtractAudioFrom(mime)).toBe(true);
    }
  });

  it("refuses audio, since extracting a sound file from itself is just a copy", () => {
    expect(canExtractAudioFrom("audio/mpeg")).toBe(false);
  });

  it("refuses everything that is not media", () => {
    for (const mime of ["image/png", "application/pdf", "text/plain", ""]) {
      expect(canExtractAudioFrom(mime)).toBe(false);
    }
  });

  it("reads a type with parameters and odd casing", () => {
    expect(canExtractAudioFrom("VIDEO/MP4; codecs=avc1")).toBe(true);
  });
});

describe("AUDIO_EXTRACT_TARGETS", () => {
  it("tries MP3 first, because that is the one every browser plays", () => {
    expect(AUDIO_EXTRACT_TARGETS[0]).toMatchObject({
      encoder: "libmp3lame",
      extension: ".mp3",
      mimeType: "audio/mpeg",
    });
  });

  it("falls back to an encoder that is part of ffmpeg itself", () => {
    // libmp3lame is an external library and can be missing from a build; the native AAC
    // encoder cannot, so the fallback always exists.
    expect(AUDIO_EXTRACT_TARGETS.at(-1)).toMatchObject({
      encoder: "aac",
      extension: ".m4a",
      mimeType: "audio/mp4",
    });
  });

  it("downmixes anything wider than stereo, and leaves mono as mono", () => {
    // libmp3lame refuses more than two channels outright, which is most of the 5.1 tracks
    // that come with real video. `-ac 2` would also pointlessly upmix mono.
    for (const target of AUDIO_EXTRACT_TARGETS) {
      const filter = target.encoderArgs[target.encoderArgs.indexOf("-af") + 1];
      expect(filter).toBe("aformat=channel_layouts=mono|stereo");
    }
  });

  it("names a real extension and a mime type that matches it", () => {
    for (const target of AUDIO_EXTRACT_TARGETS) {
      expect(target.extension.startsWith(".")).toBe(true);
      expect(target.mimeType.startsWith("audio/")).toBe(true);
      expect(target.label.length).toBeGreaterThan(0);
    }
  });
});

describe("buildExtractAudioArgs", () => {
  const target = AUDIO_EXTRACT_TARGETS[0];
  const args = buildExtractAudioArgs({
    inputPath: "/tmp/clip.mp4",
    outputPath: "/tmp/clip.mp3",
    target,
  });

  it("takes exactly one audio stream", () => {
    // A film with a commentary track should not quietly produce a two-track file, and an
    // explicit map is also what makes ffmpeg FAIL on a video with no audio at all instead
    // of writing an empty container.
    const maps = args.filter((_, i) => args[i - 1] === "-map");
    expect(maps).toEqual(["0:a:0"]);
  });

  it("drops video, subtitles and data, which no audio muxer accepts", () => {
    expect(args).toContain("-vn");
    expect(args).toContain("-sn");
    expect(args).toContain("-dn");
  });

  it("re-encodes with the target's encoder and its quality flags", () => {
    expect(args[args.indexOf("-c:a") + 1]).toBe("libmp3lame");
    expect(args).not.toContain("copy");
    for (const flag of target.encoderArgs) expect(args).toContain(flag);
  });

  it("keeps the tags the container carried", () => {
    expect(args[args.indexOf("-map_metadata") + 1]).toBe("0");
  });

  it("reads the input it was given and writes the output it was given", () => {
    expect(args[args.indexOf("-i") + 1]).toBe("/tmp/clip.mp4");
    expect(args.at(-1)).toBe("/tmp/clip.mp3");
  });

  it("never blocks on stdin or waits for an overwrite prompt", () => {
    expect(args).toContain("-nostdin");
    expect(args).toContain("-y");
  });

  it("uses the fallback encoder when handed the fallback target", () => {
    const fallback = buildExtractAudioArgs({
      inputPath: "/tmp/clip.mkv",
      outputPath: "/tmp/clip.m4a",
      target: AUDIO_EXTRACT_TARGETS[1],
    });
    expect(fallback[fallback.indexOf("-c:a") + 1]).toBe("aac");
    expect(fallback[fallback.indexOf("-b:a") + 1]).toBe("192k");
  });
});

describe("extractedAudioName", () => {
  it("marks the new file as the audio of the old one and takes the new extension", () => {
    expect(extractedAudioName("Holiday.mp4", ".mp3")).toBe("Holiday (audio).mp3");
    expect(extractedAudioName("Holiday.mp4", ".m4a")).toBe("Holiday (audio).m4a");
  });

  it("keeps a name with dots in it intact", () => {
    expect(extractedAudioName("s01.e02.final.mkv", ".mp3")).toBe("s01.e02.final (audio).mp3");
  });

  it("gives a name with no extension one", () => {
    expect(extractedAudioName("recording", ".mp3")).toBe("recording (audio).mp3");
  });

  it("does not mistake a dot-file's leading dot for an extension", () => {
    expect(extractedAudioName(".hidden", ".mp3")).toBe(".hidden (audio).mp3");
  });
});

describe("isMissingAudioStreamError", () => {
  it("recognises the map failure ffmpeg reports for a silent video", () => {
    expect(
      isMissingAudioStreamError("Stream map '0:a:0' matches no streams.\nTo ignore this, add …")
    ).toBe(true);
  });

  it("recognises the muxer complaining that nothing was written", () => {
    expect(isMissingAudioStreamError("Output file #0 does not contain any stream")).toBe(true);
  });

  it("reads whatever case the build printed", () => {
    expect(isMissingAudioStreamError("STREAM MAP '0:A:0' MATCHES NO STREAMS.")).toBe(true);
  });

  it("does not swallow a real failure", () => {
    // A missing encoder has to stay a failure: it is the reason the fallback target is
    // tried, and a retry on another worker could succeed.
    expect(isMissingAudioStreamError("Unknown encoder 'libmp3lame'")).toBe(false);
    expect(isMissingAudioStreamError("Invalid data found when processing input")).toBe(false);
    expect(isMissingAudioStreamError("")).toBe(false);
  });
});

describe("mediaEditorKindFor", () => {
  /**
   * Every `null` here matches a refusal `POST`/`PUT /api/files/edit` would answer with.
   * A button that can only produce an error is worse than no button, so the two lists
   * are pinned against each other.
   */
  function subject(over: Partial<Parameters<typeof mediaEditorKindFor>[0]> = {}) {
    return mediaEditorKindFor({
      canEdit: true,
      encrypted: false,
      isNote: false,
      sizeBytes: 2 * 1024 * 1024,
      mimeType: "image/jpeg",
      previewKind: "image",
      ...over,
    });
  }

  it("offers the image editor for a raster image", () => {
    expect(subject()).toBe("image");
    expect(subject({ mimeType: "image/png" })).toBe("image");
    expect(subject({ mimeType: "image/webp" })).toBe("image");
  });

  it("offers the trimmer for media whose container can be written back", () => {
    expect(subject({ previewKind: "video", mimeType: "video/mp4" })).toBe("trim");
    expect(subject({ previewKind: "audio", mimeType: "audio/mpeg" })).toBe("trim");
  });

  it("offers nothing without write permission", () => {
    expect(subject({ canEdit: false })).toBeNull();
    expect(subject({ canEdit: false, previewKind: "video", mimeType: "video/mp4" })).toBeNull();
  });

  it("offers nothing for an end-to-end encrypted file", () => {
    // The server holds ciphertext and no key; sharp and ffmpeg would read noise.
    expect(subject({ encrypted: true })).toBeNull();
  });

  it("offers nothing for a note", () => {
    // A note's body is a database column, not a stored object.
    expect(subject({ isNote: true })).toBeNull();
  });

  it("refuses SVG even when it arrives as the image kind", () => {
    expect(subject({ mimeType: "image/svg+xml" })).toBeNull();
    expect(subject({ mimeType: "IMAGE/SVG+XML" })).toBeNull();
    expect(subject({ previewKind: "svg", mimeType: "image/svg+xml" })).toBeNull();
  });

  it("refuses an image the editor would not read into memory", () => {
    expect(subject({ sizeBytes: EDIT_SOURCE_MAX_BYTES + 1 })).toBeNull();
    expect(subject({ sizeBytes: EDIT_SOURCE_MAX_BYTES })).toBe("image");
  });

  it("accepts the string a bigint column arrives as", () => {
    expect(subject({ sizeBytes: "1048576" })).toBe("image");
    expect(subject({ sizeBytes: String(EDIT_SOURCE_MAX_BYTES + 1) })).toBeNull();
  });

  it("takes an empty size as zero but refuses one that is not a number at all", () => {
    expect(subject({ sizeBytes: "" })).toBe("image");
    expect(subject({ sizeBytes: "not a number" })).toBeNull();
  });

  it("does not apply the image size ceiling to a trim", () => {
    // ffmpeg streams from a file and copies packets; a long video is not a big buffer.
    expect(
      subject({
        previewKind: "video",
        mimeType: "video/mp4",
        sizeBytes: EDIT_SOURCE_MAX_BYTES * 20,
      })
    ).toBe("trim");
  });

  it("offers nothing for media with no container to copy back into", () => {
    expect(subject({ previewKind: "audio", mimeType: "audio/x-aiff" })).toBeNull();
  });

  it("offers nothing for the kinds that have no media editor at all", () => {
    for (const kind of ["pdf", "text", "csv", "archive", "document", "unsupported"] as const) {
      expect(subject({ previewKind: kind, mimeType: "application/pdf" })).toBeNull();
    }
  });
});
