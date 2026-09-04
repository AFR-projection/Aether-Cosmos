import { S3Client } from "@aws-sdk/client-s3";

/**
 * The one R2 client.
 *
 * It lives in `src/shared` rather than inside the Files feature because two
 * features now write objects — files and backups — and the layer rules are right
 * to refuse the second one an import of the first. Promoting the client is the
 * whole of the shared part: buckets, keys and lifecycles stay with whoever owns
 * them.
 *
 * Cached, unlike the per-call construction it replaces: an `S3Client` holds the
 * HTTP agent, so a new one per request means a new TLS handshake per request.
 * Nothing is cached on the failure path, so a container started before its
 * credentials were set still recovers once they are.
 */
let client: S3Client | null = null;

export function r2Client(): S3Client {
  if (client) return client;

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error("R2 credentials are not configured");
  }

  client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });
  return client;
}

export function r2Bucket(): string {
  const bucket = process.env.R2_BUCKET_NAME;
  if (!bucket) throw new Error("R2_BUCKET_NAME is not set");
  return bucket;
}

/** Test seam: drop the cached client so a changed environment is picked up. */
export function resetR2Client(): void {
  client = null;
}
