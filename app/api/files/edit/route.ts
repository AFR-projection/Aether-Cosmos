import { NextRequest } from "next/server";
import { z } from "zod";
import sharp from "sharp";
import { eq } from "drizzle-orm";
import { db, recalculateUsedBytes } from "@/lib/db";
import { files, users } from "@/lib/db/schema";
import { requireAuth, getClientIp } from "@/lib/auth/session";
import {
  getAccessibleFile,
  getEffectiveUserId,
  fileRefusal,
  fileDomainOwnerId,
  resolveWritableDestination,
} from "@/lib/auth/permissions";
import { objectExists, downloadFromR2Stream, putR2Object, buildR2Key } from "@/lib/storage/r2";
import { validateCsrf } from "@/lib/security";
import { enqueueJob, getQueue } from "@/lib/queue";
import { logActivity } from "@/lib/auth/audit";
import { snapshotFileVersion } from "@/lib/files/versions";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { readStreamBounded, StreamTooLargeError } from "@/lib/storage/read-bounded";
import {
  EDIT_INPUT_MAX_PIXELS,
  EDIT_MAX_DIMENSION,
  EDIT_REFUSED_MIME_TYPES,
  EDIT_SOURCE_MAX_BYTES,
  TRIM_MAX_SECONDS,
  withinOutputBounds,
} from "@/lib/files/edit-limits";
import {
  DEFAULT_EDIT_QUALITY,
  canReencodeInPlace,
  chooseImageEncoder,
  containerExtensionFor,
  copyFileName,
  encoderForFormat,
  renameForExtension,
  sharpGeometry,
} from "@/lib/files/media-edit";

/**
 * Every dimension is bounded here rather than left to sharp: the numbers below
 * describe an allocation, and `resize` with `fit: "inside"` will happily enlarge to
 * whatever it is given. See `lib/files/edit-limits.ts`.
 */
const dimension = z.number().int().positive().max(EDIT_MAX_DIMENSION);

const editSchema = z.object({
  fileId: z.string().uuid(),
  action: z.enum(["crop", "rotate", "flip", "resize", "convert", "compress"]),
  crop: z
    .object({
      x: z.number().int().min(0).max(EDIT_MAX_DIMENSION),
      y: z.number().int().min(0).max(EDIT_MAX_DIMENSION),
      width: dimension,
      height: dimension,
    })
    .optional(),
  /**
   * Quarter turns only. An arbitrary angle pads the canvas with background colour, which
   * makes the crop the client measured against the preview meaningless, and mirroring
   * around such an angle is no longer a mirror of either axis.
   */
  rotate: z
    .number()
    .int()
    .min(-360)
    .max(360)
    .refine((value) => value % 90 === 0, { message: "rotate must be a multiple of 90" })
    .optional(),
  /** Mirror left-to-right, applied after the rotation so the crop still lines up. */
  flipHorizontal: z.boolean().optional(),
  flipVertical: z.boolean().optional(),
  width: dimension.optional(),
  height: dimension.optional(),
  quality: z.number().int().min(1).max(100).optional(),
  /**
   * Write the result as this format instead of the file's own. Only the four the editor
   * can encode are accepted — the point of a conversion is a file whose name, type and
   * bytes agree, and that is only true for a format we can name.
   */
  format: z.enum(["jpeg", "png", "webp", "avif"]).optional(),
  /**
   * Write the result to a new file instead of over this one. The in-place path keeps a
   * version to come back to, but "keep the original as it is" is the safer default for
   * anyone who is still deciding, and a version buried in a panel is not that.
   */
  saveAsCopy: z.boolean().optional(),
});

/**
 * Whether the owner can afford to store `sizeBytes` more than they already do.
 *
 * An edit is not automatically free: an upscale, a lossless PNG rewrite, or a copy all
 * grow the account. `replacingBytes` is what the new bytes take the place of, which is
 * the old object on an in-place edit and nothing at all on a copy.
 */
async function quotaRefusal(ownerId: string, sizeBytes: number, replacingBytes: number) {
  const [owner] = await db
    .select({
      quotaBytes: users.quotaBytes,
      usedBytes: users.usedBytes,
      reservedBytes: users.reservedBytes,
    })
    .from(users)
    .where(eq(users.id, ownerId))
    .limit(1);
  if (!owner) return null;

  const projected = owner.usedBytes - replacingBytes + owner.reservedBytes + sizeBytes;
  if (projected <= owner.quotaBytes) return null;
  return apiError("This would go over the storage quota. Free up some space first.", 413, {
    code: "QUOTA_EXCEEDED",
    quotaBytes: owner.quotaBytes,
    usedBytes: owner.usedBytes,
  });
}

export async function POST(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = editSchema.parse(await request.json());
    const ip = getClientIp(request);

    // Area is the number that bounds the allocation; a single capped dimension is
    // not enough (12000 x 12000 is 144 MP).
    if (!withinOutputBounds(body.width, body.height)) {
      return apiError("The result would be too large", 400, { code: "EDIT_OUTPUT_TOO_LARGE" });
    }
    if (!withinOutputBounds(body.crop?.width, body.crop?.height)) {
      return apiError("That crop area is too large", 400, { code: "EDIT_OUTPUT_TOO_LARGE" });
    }

    const accessible = await getAccessibleFile(sessionUser, body.fileId);
    if (!accessible) return apiError("File not found", 404);
    // A member who can see the file gets told WHY, not a 404 that looks like a bug.
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);
    const file = accessible.file;

    if (!file.mimeType.startsWith("image/")) {
      return apiError("Only images can be edited", 400);
    }
    if (EDIT_REFUSED_MIME_TYPES.includes(file.mimeType)) {
      return apiError("SVG files can't be edited on the server", 400, { code: "EDIT_MIME_REFUSED" });
    }
    // The server holds ciphertext for an end-to-end encrypted file and no key to read
    // it with, so there is nothing here for sharp to decode.
    if (file.encrypted) {
      return apiError("Encrypted files can't be edited on the server", 400, {
        code: "EDIT_ENCRYPTED_REFUSED",
      });
    }

    if (file.r2Key.startsWith("notes/") || !(await objectExists(file.r2Key))) {
      return apiError("This file isn't in storage yet. Upload it again first.", 404);
    }

    // Refuse before spending the bandwidth when the recorded size already says no.
    if (Number(file.sizeBytes) > EDIT_SOURCE_MAX_BYTES) {
      return apiError("This file is too large to edit on the server", 413, {
        code: "EDIT_SOURCE_TOO_LARGE",
        maxBytes: EDIT_SOURCE_MAX_BYTES,
      });
    }

    // A copy needs somewhere to go, and the folder this file sits in is only writable
    // for a caller who could have put a file there themselves. Checked before the
    // download so a refusal costs nothing.
    let destinationFolderId = file.folderId;
    if (body.saveAsCopy) {
      const dest = await resolveWritableDestination(sessionUser, file.folderId, {
        fileOwnerId: file.userId,
        domainOwnerId: await fileDomainOwnerId(file),
      });
      if (!dest.ok) return apiError(dest.message, dest.status);
      destinationFolderId = dest.folderId;
    }

    const source = await downloadFromR2Stream(file.r2Key);
    if (!source.body) return apiError("File is empty", 404);

    let buffer: Buffer;
    try {
      // The recorded size is uploader-declared on the legacy presign path, so the
      // bytes get counted again on the way in.
      buffer = await readStreamBounded(source.body, EDIT_SOURCE_MAX_BYTES);
    } catch (error) {
      if (error instanceof StreamTooLargeError) {
        return apiError("This file is too large to edit on the server", 413, {
          code: "EDIT_SOURCE_TOO_LARGE",
          maxBytes: error.maxBytes,
        });
      }
      throw error;
    }

    // `limitInputPixels` bounds the DECODE — a 200 KB PNG can declare a
    // 60000x60000 canvas, which is a bomb of the same shape as the ZIP one.
    const decoded = sharp(buffer, { limitInputPixels: EDIT_INPUT_MAX_PIXELS });

    const meta = await decoded.metadata().catch(() => null);
    if (!meta) {
      return apiError("This image can't be read", 400, { code: "EDIT_FAILED" });
    }
    // Every operation below works on a single frame, so an animated GIF or WebP would
    // come back as its first frame with the animation gone. Refused rather than silently
    // flattened, and refused before the version snapshot so nothing is left behind.
    if ((meta.pages ?? 1) > 1) {
      return apiError("Animated images can't be edited here — only the first frame would survive.", 400, {
        code: "EDIT_ANIMATED_REFUSED",
      });
    }

    // sharp applies mirrors and extracts in its own order rather than the chain's, so the
    // request is translated into that order first — see `sharpGeometry`. The frame it
    // measures a crop against is the AUTO-ORIENTED source, which is also the frame the
    // browser drew and the client took its fractions from.
    const geometry = sharpGeometry({
      rotate: body.rotate,
      flipHorizontal: body.flipHorizontal,
      flipVertical: body.flipVertical,
      crop: body.crop ?? null,
      source: { width: meta.autoOrient.width, height: meta.autoOrient.height },
    });

    // Auto-orient first, so the pixels match what the browser drew when the crop was
    // drawn over it. A phone photo carries its rotation in EXIF, and cropping the
    // unrotated buffer takes a rectangle from the wrong side of the image.
    let pipeline = decoded.autoOrient();

    if (geometry.rotate) pipeline = pipeline.rotate(geometry.rotate);
    if (geometry.flop) pipeline = pipeline.flop();
    if (geometry.flip) pipeline = pipeline.flip();
    if (geometry.crop) {
      pipeline = pipeline.extract({
        left: geometry.crop.x,
        top: geometry.crop.y,
        width: geometry.crop.width,
        height: geometry.crop.height,
      });
    }
    if (body.width || body.height) {
      pipeline = pipeline.resize(body.width, body.height, { fit: "inside" });
    }

    // Re-encoding keeps the file's own format unless a conversion asked for another one.
    // The old pipeline always wrote JPEG, which left `.png` files holding JPEG bytes.
    const encoder = body.format ? encoderForFormat(body.format) : chooseImageEncoder(file.mimeType);
    const recompress =
      body.action === "compress" || body.quality !== undefined || body.format !== undefined;
    const formatChanged = body.format
      ? encoder.mimeType !== file.mimeType.toLowerCase().split(";")[0].trim()
      : recompress && !canReencodeInPlace(file.mimeType);
    if (recompress) {
      if (encoder.format === "png") {
        // PNG is lossless, so "quality" only means anything once the palette is
        // quantized. A conversion that named no quality is asking for a PNG, not for a
        // 256-colour one, so it gets the lossless encoder instead.
        pipeline =
          body.quality !== undefined || body.action === "compress"
            ? pipeline.png({
                compressionLevel: 9,
                effort: 10,
                palette: true,
                quality: body.quality ?? DEFAULT_EDIT_QUALITY,
              })
            : pipeline.png({ compressionLevel: 9 });
      } else {
        const quality = body.quality ?? DEFAULT_EDIT_QUALITY;
        if (encoder.format === "webp") {
          pipeline = pipeline.webp({ quality });
        } else if (encoder.format === "avif") {
          pipeline = pipeline.avif({ quality });
        } else {
          pipeline = pipeline.jpeg({ quality, mozjpeg: true });
        }
      }
    }

    let output: Buffer;
    try {
      output = await pipeline.toBuffer();
    } catch (error) {
      // A crop outside the image, or an input sharp will not decode, is a bad
      // request — not a 500 from the image library.
      return apiError(
        error instanceof Error && /extract_area|limitInputPixels|unsupported image/i.test(error.message)
          ? "Those edit settings aren't valid for this image"
          : "Couldn't process this image",
        400,
        { code: "EDIT_FAILED" }
      );
    }

    const mimeType = formatChanged ? encoder.mimeType : file.mimeType;
    const now = new Date();

    if (body.saveAsCopy) {
      const refusal = await quotaRefusal(file.userId, output.length, 0);
      if (refusal) return refusal;

      const baseName = copyFileName(file.name);
      const copyName = formatChanged ? renameForExtension(baseName, encoder.extension) : baseName;
      const [created] = await db
        .insert(files)
        .values({
          // The copy belongs to the file's OWNER, not to whoever edited it — keying it
          // by the caller would file a shared copy under the wrong account.
          userId: file.userId,
          folderId: destinationFolderId,
          name: copyName,
          mimeType,
          sizeBytes: output.length,
          r2Key: "pending",
          isNote: false,
        })
        .returning();

      const newKey = buildR2Key(file.userId, created.id, copyName);
      await putR2Object(newKey, output, mimeType);
      await db
        .update(files)
        .set({
          r2Key: newKey,
          status: "ready",
          completedAt: now,
          verifiedAt: now,
          updatedAt: now,
        })
        .where(eq(files.id, created.id));
      await recalculateUsedBytes(file.userId);
      await enqueueJob("generate_thumbnail", { fileId: created.id, r2Key: newKey, mimeType });
      await logActivity(sessionUser, "copy", {
        resourceType: "file",
        resourceId: created.id,
        metadata: { sourceId: file.id, via: "edit" },
        ip,
      });

      return apiSuccess({
        fileId: created.id,
        name: copyName,
        sizeBytes: output.length,
        mimeType,
        savedAsCopy: true,
      });
    }

    const refusal = await quotaRefusal(file.userId, output.length, Number(file.sizeBytes));
    if (refusal) return refusal;

    // Overwriting in place is only safe because the previous bytes stay reachable.
    await snapshotFileVersion(file, getEffectiveUserId(sessionUser));

    await putR2Object(file.r2Key, output, mimeType);

    await db
      .update(files)
      .set({
        sizeBytes: output.length,
        updatedAt: now,
        // A format sharp cannot write back becomes JPEG, so the name and the type have
        // to follow — an extension that lies breaks every later read of the file.
        ...(formatChanged
          ? { mimeType, name: renameForExtension(file.name, encoder.extension) }
          : {}),
      })
      .where(eq(files.id, body.fileId));

    // The edit changes the object's size, and `usedBytes` is what the quota is read
    // from. Without this an account slowly drifts away from what it actually stores.
    await recalculateUsedBytes(file.userId);

    await enqueueJob("generate_thumbnail", {
      fileId: body.fileId,
      r2Key: file.r2Key,
      mimeType,
    });

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { action: body.action, ...(body.format ? { format: body.format } : {}) },
      ip,
    });

    return apiSuccess({ sizeBytes: output.length, mimeType, savedAsCopy: false });
  } catch (error) {
    return handleApiError(error);
  }
}

/**
 * The trim job overwrites the object in place, so the window has to make sense
 * before it is queued: `-ss 10 -to 5` is not an error to ffmpeg, it is an empty
 * output written over the caller's media.
 */
const trimSchema = z
  .object({
    fileId: z.string().uuid(),
    startSeconds: z.number().min(0).max(TRIM_MAX_SECONDS),
    endSeconds: z.number().positive().max(TRIM_MAX_SECONDS),
  })
  .refine((v) => v.endSeconds > v.startSeconds, {
    message: "endSeconds must be greater than startSeconds",
    path: ["endSeconds"],
  });

export async function PUT(request: NextRequest) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const sessionUser = await requireAuth();
    const body = trimSchema.parse(await request.json());
    const ip = getClientIp(request);

    const accessible = await getAccessibleFile(sessionUser, body.fileId);
    if (!accessible) return apiError("File not found", 404);
    if (!accessible.canEdit) return apiError(fileRefusal(accessible, "edit"), 403);
    const file = accessible.file;

    // Without this the worker would run ffmpeg over a PDF or a spreadsheet and, on
    // the runs where ffmpeg produces something, write it back over the original.
    if (!file.mimeType.startsWith("video/") && !file.mimeType.startsWith("audio/")) {
      return apiError("Only video or audio files can be trimmed", 400, {
        code: "TRIM_MIME_REFUSED",
      });
    }

    // A trim copies streams rather than re-encoding, and a stream copy cannot change
    // container. A type with no container to write back to is refused here rather than
    // queued to fail somewhere the user will never see the error.
    if (!containerExtensionFor(file.mimeType)) {
      return apiError("This format can't be trimmed without re-encoding it first.", 400, {
        code: "TRIM_CONTAINER_UNSUPPORTED",
      });
    }

    // ffmpeg would be handed ciphertext, and would either fail or write garbage back.
    if (file.encrypted) {
      return apiError("Encrypted files can't be trimmed on the server", 400, {
        code: "TRIM_ENCRYPTED_REFUSED",
      });
    }

    if (file.r2Key.startsWith("notes/") || !(await objectExists(file.r2Key))) {
      return apiError("This file isn't in storage yet. Upload it again first.", 404);
    }

    // The work happens in the worker, so an unreachable queue means nothing will ever
    // happen. Checked before the snapshot: `{ queued: true }` with no worker behind it
    // left the caller waiting for a file that was never going to change.
    if (!getQueue()) {
      return apiError("Trimming is temporarily unavailable. Try again in a few minutes.", 503, {
        code: "TRIM_QUEUE_UNAVAILABLE",
      });
    }

    // The trim replaces the object in place, so keep a version to come back to —
    // the image path already does this and the media path silently did not.
    await snapshotFileVersion(file, getEffectiveUserId(sessionUser));

    const queued = await enqueueJob("trim_media", {
      fileId: body.fileId,
      r2Key: file.r2Key,
      mimeType: file.mimeType,
      startSeconds: body.startSeconds,
      endSeconds: body.endSeconds,
    });
    if (!queued) {
      return apiError("Trimming is temporarily unavailable. Try again in a few minutes.", 503, {
        code: "TRIM_QUEUE_UNAVAILABLE",
      });
    }

    await logActivity(sessionUser, "edit", {
      resourceType: "file",
      resourceId: file.id,
      metadata: { action: "trim", startSeconds: body.startSeconds, endSeconds: body.endSeconds },
      ip,
    });

    return apiSuccess({ queued: true });
  } catch (error) {
    return handleApiError(error);
  }
}
