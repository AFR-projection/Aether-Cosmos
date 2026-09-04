/**
 * Whole-object writes and deletes, for the two features that now do both.
 *
 * These two helpers were defined in `@files/infrastructure/storage/r2.ts` until the
 * per-account restore needed them: it writes objects while staging and its sweeper deletes
 * the ones a failed restore left behind, and the layer rules rightly stop `src/features/backup`
 * importing another feature. Moved here rather than copied — a second implementation of
 * "which keys are safe to delete" is the kind of duplicate that drifts and then deletes
 * something it should not — and re-exported from the Files module so its ~20 call sites keep
 * their import.
 *
 * Deliberately small: no presigning, no multipart, no `Content-Disposition`. Streaming lives
 * in `r2-stream.ts`, and everything about how a download is *presented* stays with the feature
 * that owns the file.
 */

import { DeleteObjectsCommand, PutObjectCommand } from "@aws-sdk/client-s3";

import { r2Bucket, r2Client } from "./r2-client";

/**
 * Overwrite one object with bytes already in memory.
 *
 * The in-browser text editor writes back over the caller's own object, and that is a
 * single small `PutObject` — the multipart path in `r2-stream.ts` is for streams whose size is
 * not known in advance. A restore uses this for the one case multipart cannot express, a
 * zero-byte file.
 */
export async function putR2Object(
  r2Key: string,
  body: Buffer,
  contentType: string
): Promise<void> {
  await r2Client().send(
    new PutObjectCommand({
      Bucket: r2Bucket(),
      Key: r2Key,
      Body: body,
      ContentType: contentType,
    })
  );
}

/**
 * Batch delete R2 keys (chunks of 1000). Skips pending/notes keys.
 *
 * The skip list is the reason this is shared rather than reimplemented: `""` is a row whose
 * upload never started, `"pending"` is the placeholder the multipart path writes, and a
 * `notes/` key names an object that was never created because a note's body is a row. Sending
 * any of them to `DeleteObjects` is a request that either fails or deletes nothing, and the
 * sweeper runs this over rows it did not create.
 */
export async function deleteR2Objects(r2Keys: string[]): Promise<void> {
  const keys = [...new Set(r2Keys)].filter(
    (k) => k && k !== "pending" && !k.startsWith("notes/")
  );
  if (keys.length === 0) return;

  const client = r2Client();
  const bucket = r2Bucket();
  for (let i = 0; i < keys.length; i += 1000) {
    const chunk = keys.slice(i, i + 1000);
    await client.send(
      new DeleteObjectsCommand({
        Bucket: bucket,
        Delete: {
          Objects: chunk.map((Key) => ({ Key })),
          Quiet: true,
        },
      })
    );
  }
}
