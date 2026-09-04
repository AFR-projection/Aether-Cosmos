import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  GetObjectCommand,
  UploadPartCommand,
} from "@aws-sdk/client-s3";
import { Readable } from "stream";
import { r2Bucket, r2Client } from "./r2-client";

/** R2 rejects a non-final part below this, and reports it as an opaque failure. */
export const MIN_MULTIPART_PART_BYTES = 5 * 1024 * 1024;

export const DEFAULT_STREAM_PART_BYTES = 64 * 1024 * 1024;

/**
 * Read a whole object as a Node stream.
 *
 * Here rather than in the Files feature for the reason on {@link r2Client}: two features
 * now read objects, and the layer rules are right to refuse the second one an import of
 * the first. This is the plain whole-object read — no range, no presigning, no
 * `Content-Type` negotiation — because that is all a second reader needs, and every
 * decision about *how a download is presented* stays with the feature that owns the file.
 *
 * `null` rather than a throw for a missing body, so the caller phrases that outcome in its
 * own vocabulary. A missing *object* still throws, because the SDK's 404 is the only thing
 * that can tell "the row outlived its bytes" from "the bucket is having a bad day", and
 * flattening it here would take that distinction away from everyone.
 */
export async function downloadR2Stream(r2Key: string): Promise<{ body: Readable | null }> {
  const response = await r2Client().send(
    new GetObjectCommand({ Bucket: r2Bucket(), Key: r2Key })
  );
  if (response.Body === undefined || response.Body === null) return { body: null };
  // The SDK's body is a union; `workers/index.ts` narrows the same one the same way, and
  // through `unknown` for the same reason: `Blob` and `ReadableStream` are both in the
  // union, so neither cast is a widening the compiler will do on its own.
  const body = response.Body as unknown;
  if (typeof (body as { pipe?: unknown }).pipe === "function") return { body: body as Readable };
  return { body: Readable.fromWeb(body as import("stream/web").ReadableStream) };
}

/**
 * Stream an internally generated object to R2 without buffering it in memory.
 *
 * Multipart is used even for small streams so generated archives can exceed the
 * single-PUT object limit without changing the caller's code path.
 *
 * `opts.partSize` trades the object-size ceiling against resident memory: exactly
 * one part is buffered at a time, so the 64 MiB default reaches 640 GB while
 * holding 64 MiB. A backup running beside a Postgres dump on a 2 GB box passes
 * something smaller and accepts the lower ceiling.
 */
export async function uploadR2Stream(
  r2Key: string,
  body: Readable,
  contentType: string,
  opts: { partSize?: number } = {}
): Promise<void> {
  const client = r2Client();
  const bucket = r2Bucket();
  const created = await client.send(new CreateMultipartUploadCommand({
    Bucket: bucket,
    Key: r2Key,
    ContentType: contentType,
  }));
  if (!created.UploadId) throw new Error("Failed to create streaming multipart upload");

  const partSize = Math.max(
    MIN_MULTIPART_PART_BYTES,
    opts.partSize ?? DEFAULT_STREAM_PART_BYTES
  );
  const parts: { PartNumber: number; ETag: string }[] = [];
  const buffers: Buffer[] = [];
  let bufferedBytes = 0;
  let partNumber = 1;

  const flush = async () => {
    if (bufferedBytes === 0) return;
    const response = await client.send(new UploadPartCommand({
      Bucket: bucket,
      Key: r2Key,
      UploadId: created.UploadId,
      PartNumber: partNumber,
      Body: Buffer.concat(buffers, bufferedBytes),
    }));
    if (!response.ETag) throw new Error(`Streaming multipart part ${partNumber} has no ETag`);
    parts.push({ PartNumber: partNumber, ETag: response.ETag });
    partNumber += 1;
    buffers.length = 0;
    bufferedBytes = 0;
  };

  try {
    for await (const rawChunk of body) {
      const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
      let offset = 0;
      while (offset < chunk.length) {
        const take = Math.min(partSize - bufferedBytes, chunk.length - offset);
        buffers.push(chunk.subarray(offset, offset + take));
        bufferedBytes += take;
        offset += take;
        if (bufferedBytes === partSize) await flush();
      }
    }
    await flush();
    if (parts.length === 0) throw new Error("Cannot upload an empty streaming object");
    await client.send(new CompleteMultipartUploadCommand({
      Bucket: bucket,
      Key: r2Key,
      UploadId: created.UploadId,
      MultipartUpload: { Parts: parts },
    }));
  } catch (error) {
    await client.send(new AbortMultipartUploadCommand({
      Bucket: bucket,
      Key: r2Key,
      UploadId: created.UploadId,
    })).catch(() => {});
    throw error;
  }
}
