import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  CopyObjectCommand,
  HeadObjectCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
  CompleteMultipartUploadCommand,
  AbortMultipartUploadCommand,
  ListMultipartUploadsCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { maxUploadBytes, isUploadAllowed, uploadUrlExpirySeconds, downloadUrlExpirySeconds, playbackUrlExpirySeconds } from "@/shared/lib/settings/admin-settings";
import { clampPlaybackExpirySeconds } from "@/shared/lib/media/playback-policy";
import { r2Bucket, r2Client } from "@/shared/infrastructure/storage/r2-client";
import { encodeContentDispositionFilename } from "@/shared/infrastructure/storage/content-disposition";
import { MULTIPART_PART_SIZE_BYTES } from "@files/infrastructure/storage/upload-constants";

export {
  MULTIPART_THRESHOLD_BYTES,
  MULTIPART_PART_SIZE_BYTES,
  MULTIPART_PARALLEL_PARTS,
} from "@files/infrastructure/storage/upload-constants";

/**
 * Both helpers now delegate to the shared client so the whole process shares one
 * HTTP agent — a new `S3Client` per call meant a new TLS handshake per call. They
 * stay as local names because ~20 call sites below read better this way.
 */
function getR2Client(): S3Client {
  return r2Client();
}

function getBucket(): string {
  return r2Bucket();
}

/**
 * Re-exported, not defined here: the per-account restore in `src/features/backup` writes
 * objects too and cannot import this module across the feature boundary, so the key format
 * now lives in `@/shared/infrastructure/storage/r2-key`. The name stays exported from here
 * because ~20 call sites in this feature read better with it local.
 */
export { buildR2Key } from "@/shared/infrastructure/storage/r2-key";

export function getThumbnailKey(fileId: string, size: number, ext: string = "webp"): string {
  return `thumbnails/${fileId}_${size}.${ext}`;
}

export function getLegacyThumbnailKey(fileId: string): string {
  return `thumbnails/${fileId}.jpg`;
}

/**
 * `ContentLength` is deliberately signed for a real body: it pins the URL to the
 * exact byte count /init reserved quota for, so a leaked URL cannot be used to
 * write a larger object than was accounted for. `content-length` is not in the
 * signer's unsignable set, so it lands in `X-Amz-SignedHeaders` and the client's
 * PUT must reproduce it — which the browser does automatically from the blob.
 *
 * Zero is the exception. Empty files are now legal (a real project is full of
 * `.gitkeep` and empty `__init__.py`), there is nothing to pin — 0 is the floor,
 * not a budget — and whether a falsy `ContentLength` survives serialization into
 * the signature is an SDK implementation detail we should not be betting a 403
 * on. Omitting it leaves the signature silent about length; `headObject` at
 * complete time still rejects anything that is not actually 0 bytes.
 */
export async function getPresignedUploadUrl(
  r2Key: string,
  mimeType: string,
  sizeBytes: number
): Promise<string> {
  const client = getR2Client();
  const command = new PutObjectCommand({
    Bucket: getBucket(),
    Key: r2Key,
    ContentType: mimeType,
    ContentLength: sizeBytes > 0 ? sizeBytes : undefined,
  });

  const expiry = uploadUrlExpirySeconds();
  return getSignedUrl(client, command, { expiresIn: expiry });
}

/**
 * Whole-object write and batch delete moved to `src/shared` for the same reason as the
 * streaming upload below: the per-account restore writes objects while staging and its
 * sweeper deletes what a failed restore left behind, and it cannot import this feature.
 * Re-exported here so every existing call site keeps its import.
 */
export { putR2Object, deleteR2Objects } from "@/shared/infrastructure/storage/r2-objects";

/**
 * Streaming upload lives in `src/shared` now that backups write objects too, and
 * the layer rules rightly stop a second feature importing this one. Re-exported
 * here so every existing call site keeps its import.
 */
export { uploadR2Stream } from "@/shared/infrastructure/storage/r2-stream";

/**
 * Presigned GET URL for a stored object.
 *
 * When `downloadName` is given, the URL carries `response-content-disposition:
 * attachment` so R2 itself forces a download (with the right filename) instead
 * of letting the browser render the file inline. This is the reliable way to
 * force downloads — headers on our own 302 redirect do NOT carry over to R2.
 *
 * `contentType` lets callers override the served MIME (e.g. octet-stream for
 * dangerous file types) directly on the R2 response.
 */
export async function getPresignedDownloadUrl(
  r2Key: string,
  opts: { downloadName?: string; contentType?: string } = {}
): Promise<string> {
  const client = getR2Client();

  let contentDisposition: string | undefined;
  if (opts.downloadName) {
    contentDisposition = `attachment; ${encodeContentDispositionFilename(opts.downloadName)}`;
  }

  const command = new GetObjectCommand({
    Bucket: getBucket(),
    Key: r2Key,
    ResponseContentDisposition: contentDisposition,
    ResponseContentType: opts.contentType,
  });

  const expiry = downloadUrlExpirySeconds();
  return getSignedUrl(client, command, { expiresIn: expiry });
}

/**
 * Content-Disposition encoding moved to `src/shared` alongside the client, since
 * backups name their downloads the same way. Re-exported for existing importers.
 */
export { encodeContentDispositionFilename };

/**
 * Presigned GET URL for PLAYING a media object, as opposed to downloading one.
 *
 * Separate from `getPresignedDownloadUrl` because the two want opposite things from every
 * knob. A download wants `attachment`, the real filename, and the shortest possible life. A
 * playback URL wants `inline`, no filename at all, and a life that covers the whole viewing —
 * every buffer segment and every seek is a fresh range request signed by this one URL, so a
 * 60-second download expiry would stop a film one minute in.
 *
 * Three response overrides ride along, and each earns its place:
 *
 *   - `ResponseContentType` pins the type R2 serves, so the browser is not left sniffing and
 *     an object stored with a wrong `ContentType` still plays.
 *   - `ResponseContentDisposition: inline` with NO filename: the URL may end up in a network
 *     log, and there is no reason for the original filename to be in it.
 *   - `ResponseCacheControl: private, max-age=<lifetime>` is the one that makes seeking
 *     backwards cheap. R2 objects carry no cache headers of their own, so without this the
 *     browser re-fetches bytes it already has. `private` keeps it out of shared caches, and
 *     tying max-age to the signature's lifetime means a cached range can never outlive the
 *     capability that authorized it.
 *
 * Returns the deadline too: the caller hands it to the player, which uses it to re-issue
 * before the signature dies instead of discovering it through a stall.
 */
export async function getPresignedPlaybackUrl(
  r2Key: string,
  opts: { contentType: string; expirySeconds?: number }
): Promise<{ url: string; expiresAt: Date; expiresInSeconds: number }> {
  const client = getR2Client();
  const expiry = clampPlaybackExpirySeconds(opts.expirySeconds ?? playbackUrlExpirySeconds());

  const url = await getSignedUrl(
    client,
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: r2Key,
      ResponseContentType: opts.contentType,
      ResponseContentDisposition: "inline",
      ResponseCacheControl: `private, max-age=${expiry}`,
    }),
    { expiresIn: expiry }
  );

  return {
    url,
    expiresAt: new Date(Date.now() + expiry * 1000),
    expiresInSeconds: expiry,
  };
}

export async function deleteR2Object(r2Key: string): Promise<void> {
  if (!r2Key || r2Key === "pending" || r2Key.startsWith("notes/")) return;
  const client = getR2Client();
  await client.send(
    new DeleteObjectCommand({
      Bucket: getBucket(),
      Key: r2Key,
    })
  );
}

export async function copyR2Object(sourceKey: string, destKey: string): Promise<void> {
  const client = getR2Client();
  await client.send(
    new CopyObjectCommand({
      Bucket: getBucket(),
      CopySource: `${getBucket()}/${sourceKey}`,
      Key: destKey,
    })
  );
}

export type MultipartPresign = {
  uploadId: string;
  partSize: number;
  parts: { partNumber: number; url: string }[];
};

export async function createMultipartUploadSession(
  r2Key: string,
  mimeType: string
): Promise<string> {
  const client = getR2Client();
  const created = await client.send(
    new CreateMultipartUploadCommand({
      Bucket: getBucket(),
      Key: r2Key,
      ContentType: mimeType,
    })
  );
  if (!created.UploadId) throw new Error("Failed to create multipart upload");
  return created.UploadId;
}

export async function getPresignedMultipartPartUrl(
  r2Key: string,
  uploadId: string,
  partNumber: number
): Promise<string> {
  const client = getR2Client();
  const expiry = uploadUrlExpirySeconds();
  return getSignedUrl(
    client,
    new UploadPartCommand({
      Bucket: getBucket(),
      Key: r2Key,
      UploadId: uploadId,
      PartNumber: partNumber,
    }),
    { expiresIn: expiry }
  );
}

export function planMultipartParts(sizeBytes: number): number {
  return Math.ceil(sizeBytes / MULTIPART_PART_SIZE_BYTES);
}

/** Create multipart upload and return presigned URLs for each part. */
export async function createMultipartUpload(
  r2Key: string,
  mimeType: string,
  sizeBytes: number
): Promise<MultipartPresign> {
  const client = getR2Client();
  const bucket = getBucket();
  const expiry = uploadUrlExpirySeconds();

  const uploadId = await createMultipartUploadSession(r2Key, mimeType);

  const partCount = planMultipartParts(sizeBytes);
  const parts: { partNumber: number; url: string }[] = [];

  for (let partNumber = 1; partNumber <= partCount; partNumber++) {
    const url = await getSignedUrl(
      client,
      new UploadPartCommand({
        Bucket: bucket,
        Key: r2Key,
        UploadId: uploadId,
        PartNumber: partNumber,
      }),
      { expiresIn: expiry }
    );
    parts.push({ partNumber, url });
  }

  return {
    uploadId,
    partSize: MULTIPART_PART_SIZE_BYTES,
    parts,
  };
}

export async function completeMultipartUpload(
  r2Key: string,
  uploadId: string,
  parts: { partNumber: number; etag: string }[]
): Promise<void> {
  const client = getR2Client();
  await client.send(
    new CompleteMultipartUploadCommand({
      Bucket: getBucket(),
      Key: r2Key,
      UploadId: uploadId,
      MultipartUpload: {
        Parts: parts
          .slice()
          .sort((a, b) => a.partNumber - b.partNumber)
          .map((p) => ({
            PartNumber: p.partNumber,
            ETag: p.etag,
          })),
      },
    })
  );
}

export async function abortMultipartUpload(r2Key: string, uploadId: string): Promise<void> {
  const client = getR2Client();
  try {
    await client.send(
      new AbortMultipartUploadCommand({
        Bucket: getBucket(),
        Key: r2Key,
        UploadId: uploadId,
      })
    );
  } catch {
    // ignore
  }
}

export async function downloadFromR2Bytes(r2Key: string, maxBytes: number = 16): Promise<Buffer> {
  const client = getR2Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: r2Key,
      Range: `bytes=0-${maxBytes - 1}`,
    })
  );
  return Buffer.from(await response.Body!.transformToByteArray());
}

export async function headObject(r2Key: string) {
  const client = getR2Client();
  const response = await client.send(
    new HeadObjectCommand({
      Bucket: getBucket(),
      Key: r2Key,
    })
  );
  return {
    contentLength: response.ContentLength ?? 0,
    contentType: response.ContentType,
    eTag: response.ETag,
    checksumSha256: response.ChecksumSHA256,
  };
}

export async function downloadFromR2Stream(r2Key: string, byteRange?: string) {
  const client = getR2Client();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: getBucket(),
      Key: r2Key,
      ...(byteRange ? { Range: byteRange } : {}),
    })
  );
  return {
    body: response.Body,
    contentType: response.ContentType,
    contentLength: response.ContentLength,
    contentRange: response.ContentRange,
    eTag: response.ETag,
    lastModified: response.LastModified,
    statusCode: response.$metadata.httpStatusCode,
  };
}

export async function objectExists(r2Key: string): Promise<boolean> {
  try {
    const client = getR2Client();
    await client.send(
      new HeadObjectCommand({
        Bucket: getBucket(),
        Key: r2Key,
      })
    );
    return true;
  } catch {
    return false;
  }
}

export type MultipartUploadSummary = {
  key: string;
  uploadId: string;
  initiatedAt: Date | null;
};

/** List incomplete multipart sessions for reconciliation; never exposes secrets. */
export async function listMultipartUploads(prefix?: string): Promise<MultipartUploadSummary[]> {
  const client = getR2Client();
  const bucket = getBucket();
  const uploads: MultipartUploadSummary[] = [];
  let keyMarker: string | undefined;
  let uploadIdMarker: string | undefined;
  do {
    const response = await client.send(new ListMultipartUploadsCommand({
      Bucket: bucket,
      Prefix: prefix,
      KeyMarker: keyMarker,
      UploadIdMarker: uploadIdMarker,
      MaxUploads: 1000,
    }));
    for (const upload of response.Uploads ?? []) {
      if (upload.Key && upload.UploadId) {
        uploads.push({ key: upload.Key, uploadId: upload.UploadId, initiatedAt: upload.Initiated ?? null });
      }
    }
    keyMarker = response.NextKeyMarker;
    uploadIdMarker = response.NextUploadIdMarker;
  } while (keyMarker || uploadIdMarker);
  return uploads;
}

export type R2ObjectSummary = {
  key: string;
  sizeBytes: number;
  lastModified: Date | null;
};

/** List objects only for a controlled prefix; callers must apply a grace period. */
export async function listR2Objects(prefix: string, maxObjects = 1000): Promise<R2ObjectSummary[]> {
  const client = getR2Client();
  const bucket = getBucket();
  const objects: R2ObjectSummary[] = [];
  let continuationToken: string | undefined;
  do {
    const response = await client.send(new ListObjectsV2Command({
      Bucket: bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
      MaxKeys: 1000,
    }));
    for (const object of response.Contents ?? []) {
      if (object.Key) objects.push({ key: object.Key, sizeBytes: object.Size ?? 0, lastModified: object.LastModified ?? null });
      if (objects.length >= maxObjects) break;
    }
    if (objects.length >= maxObjects) break;
    continuationToken = response.NextContinuationToken;
  } while (continuationToken);
  return objects;
}

export function isAllowedMimeType(mimeType: string, filename = "file"): boolean {
  return isUploadAllowed(mimeType, filename).allowed;
}

export function getMaxFileSize(): number {
  return maxUploadBytes();
}
