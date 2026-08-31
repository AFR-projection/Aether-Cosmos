import "./load-env";
import { ListObjectsV2Command, S3Client } from "@aws-sdk/client-s3";

type AwsLikeError = Error & {
  Code?: string;
  code?: string;
  $metadata?: { httpStatusCode?: number };
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function explainR2Error(error: unknown): string {
  const current = error as AwsLikeError;
  const code = current.Code ?? current.code ?? current.name ?? "UNKNOWN";
  const status = current.$metadata?.httpStatusCode;
  const detail = current.message || String(error);

  switch (code) {
    case "InvalidAccessKeyId":
      return "R2_ACCESS_KEY_ID is not recognized by this Cloudflare account";
    case "SignatureDoesNotMatch":
      return "R2_SECRET_ACCESS_KEY does not match the Access Key ID";
    case "AccessDenied":
      return "the R2 token cannot list this bucket; grant Object Read & Write access to the selected bucket";
    case "NoSuchBucket":
      return "R2_BUCKET_NAME does not exist in this Cloudflare account";
    case "ENOTFOUND":
    case "EAI_AGAIN":
      return "the VPS cannot resolve the Cloudflare R2 endpoint; check DNS/network access";
    case "ETIMEDOUT":
    case "ECONNRESET":
      return "the connection from the VPS to Cloudflare R2 timed out or was reset";
    default:
      return `${code}${status ? ` HTTP ${status}` : ""}: ${detail}`;
  }
}

async function verifyProductionR2() {
  const accountId = required("R2_ACCOUNT_ID");
  const accessKeyId = required("R2_ACCESS_KEY_ID");
  const secretAccessKey = required("R2_SECRET_ACCESS_KEY");
  const bucket = required("R2_BUCKET_NAME");

  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
    requestHandler: { requestTimeout: 15_000, connectionTimeout: 10_000 },
    maxAttempts: 2,
  });

  try {
    await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    console.log(`R2 bucket accessible: ${bucket}`);
  } catch (error) {
    throw new Error(`R2 verification failed: ${explainR2Error(error)}`);
  } finally {
    client.destroy();
  }
}

verifyProductionR2().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
