import "./load-env";
import { performance } from "node:perf_hooks";
import { and, desc, eq, isNull, like, sql } from "drizzle-orm";
import { GetObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { db } from "../src/shared/infrastructure/db";
import { files, sessions, users } from "../src/shared/infrastructure/db/schema";

/**
 * Measure both video delivery paths, with the same script before and after the
 * direct-R2 change so the two runs are comparable.
 *
 * Read-only by construction: it SELECTs, it presigns, it GETs byte ranges. It never
 * writes to Aiven and never writes to R2. `recordBandwidth` is therefore measured as
 * its SELECT half only, and the report says so — the UPDATE half costs at least as
 * much and serialises on one `users` row, which is the part that cannot be measured
 * without billing somebody.
 *
 * What it cannot tell you: numbers from this machine are this machine's numbers. Run
 * it on the VPS to get the VPS's. The one comparison that IS location-independent is
 * the count of Aiven round trips inside the byte path, which is the whole point.
 *
 * Usage:  npx tsx scripts/measure-playback.ts [--sample-bytes=1048576] [--label=before]
 */

const SAMPLE_BYTES = numberFlag("sample-bytes", 1024 * 1024);
const LABEL = stringFlag("label", "run");

function stringFlag(name: string, fallback: string): string {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function numberFlag(name: string, fallback: number): number {
  const raw = stringFlag(name, "");
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ms(value: number): string {
  return `${value.toFixed(1)} ms`;
}

function mib(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}

function throughput(bytes: number, elapsedMs: number): string {
  if (elapsedMs <= 0) return "n/a";
  return `${(bytes / 1024 / 1024 / (elapsedMs / 1000)).toFixed(2)} MiB/s`;
}

async function timed<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; elapsedMs: number }> {
  const started = performance.now();
  const value = await fn();
  return { value, elapsedMs: performance.now() - started };
}

function r2Client(): S3Client {
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
    },
  });
}

type Sample = {
  id: string;
  name: string;
  userId: string;
  r2Key: string;
  sizeBytes: number;
  mimeType: string;
};

/**
 * One video per size bucket, so a stutter that only happens on big files has something
 * to be compared against. Buckets rather than "the N largest": the whole question is
 * whether size is the variable.
 */
async function pickSamples(): Promise<Sample[]> {
  const buckets: { label: string; min: number; max: number }[] = [
    { label: "small (<16 MiB)", min: 1, max: 16 * 1024 * 1024 },
    {
      label: "medium (16–128 MiB)",
      min: 16 * 1024 * 1024,
      max: 128 * 1024 * 1024,
    },
    {
      label: "large (128 MiB–1 GiB)",
      min: 128 * 1024 * 1024,
      max: 1024 * 1024 * 1024,
    },
    {
      label: "huge (>1 GiB)",
      min: 1024 * 1024 * 1024,
      max: Number.MAX_SAFE_INTEGER,
    },
  ];

  const picked: Sample[] = [];
  for (const bucket of buckets) {
    const [row] = await db
      .select({
        id: files.id,
        name: files.name,
        userId: files.userId,
        r2Key: files.r2Key,
        sizeBytes: files.sizeBytes,
        mimeType: files.mimeType,
      })
      .from(files)
      .where(
        and(
          like(files.mimeType, "video/%"),
          eq(files.status, "ready"),
          eq(files.encrypted, false),
          isNull(files.deletedAt),
          sql`${files.sizeBytes} >= ${bucket.min}`,
          sql`${files.sizeBytes} < ${bucket.max}`,
        ),
      )
      .orderBy(desc(files.sizeBytes))
      .limit(1);
    if (row) picked.push(row);
  }
  return picked;
}

/**
 * The Aiven round trips `/api/files/[id]/preview` pays on EVERY range request, timed
 * one at a time in the order the route makes them. Any session row will do: what is
 * being measured is the round trip, not the row.
 */
async function measureHotPathQueries(sample: Sample) {
  const [anySession] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .limit(1);
  const sessionId = anySession?.id ?? "00000000-0000-0000-0000-000000000000";

  const ping = await timed(() => db.execute(sql`select 1 as ok`));
  const session = await timed(() =>
    db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1),
  );
  const user = await timed(() =>
    db.select().from(users).where(eq(users.id, sample.userId)).limit(1),
  );
  const file = await timed(() =>
    db.select().from(files).where(eq(files.id, sample.id)).limit(1),
  );
  // The read half of recordBandwidth. Its UPDATE is deliberately not run.
  const bandwidthRead = await timed(() =>
    db.select().from(users).where(eq(users.id, sample.userId)).limit(1),
  );

  return {
    ping: ping.elapsedMs,
    session: session.elapsedMs,
    user: user.elapsedMs,
    file: file.elapsedMs,
    bandwidthRead: bandwidthRead.elapsedMs,
    // What a range request waits for before the first byte of the R2 GET is asked for.
    perRangeRequest: session.elapsedMs + user.elapsedMs + file.elapsedMs,
  };
}

/** Data plane A: R2 GET issued by the server, which is what the proxy route does. */
async function measureServerSideGet(client: S3Client, sample: Sample) {
  const end = Math.min(SAMPLE_BYTES, sample.sizeBytes) - 1;
  const started = performance.now();
  const response = await client.send(
    new GetObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME!,
      Key: sample.r2Key,
      Range: `bytes=0-${end}`,
    }),
  );
  const ttfb = performance.now() - started;
  let received = 0;
  for await (const chunk of response.Body as AsyncIterable<Uint8Array>)
    received += chunk.length;
  return {
    status: response.$metadata.httpStatusCode ?? 0,
    contentRange: response.ContentRange ?? null,
    eTag: response.ETag ?? null,
    ttfb,
    totalMs: performance.now() - started,
    received,
  };
}

/** Data plane B: what the browser does once it holds a presigned URL. */
async function measureDirectGet(url: string, range: string) {
  const started = performance.now();
  const response = await fetch(url, { headers: { Range: range } });
  const ttfb = performance.now() - started;
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    ttfb,
    totalMs: performance.now() - started,
    received: body.byteLength,
    headers: {
      "accept-ranges": response.headers.get("accept-ranges"),
      "content-range": response.headers.get("content-range"),
      "content-length": response.headers.get("content-length"),
      "content-type": response.headers.get("content-type"),
      etag: response.headers.get("etag"),
      "last-modified": response.headers.get("last-modified"),
      "cache-control": response.headers.get("cache-control"),
      "cf-cache-status": response.headers.get("cf-cache-status"),
      age: response.headers.get("age"),
    },
  };
}

/**
 * Status + headers for one range, WITHOUT reading the body.
 *
 * `bytes=0-` on a 3 GB film is a 3 GB download; the matrix below asks for exactly that
 * shape because it is what Chrome asks for, so the body is aborted the moment the
 * headers are in. Egress is billed either way, so it stays unread.
 */
async function probeRange(url: string, range: string) {
  const controller = new AbortController();
  const started = performance.now();
  try {
    const response = await fetch(url, {
      headers: { Range: range },
      signal: controller.signal,
    });
    const ttfb = performance.now() - started;
    const contentRange = response.headers.get("content-range");
    const contentLength = response.headers.get("content-length");
    controller.abort();
    return { status: response.status, ttfb, contentRange, contentLength };
  } catch (error) {
    controller.abort();
    return {
      status: 0,
      ttfb: performance.now() - started,
      contentRange: null,
      contentLength: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The range shapes a real player actually emits, against the presigned URL. This is the
 * check that seeking will work once Next.js is out of the byte path — the app's own
 * parser stops being involved, so R2's behaviour is the only behaviour left.
 */
function rangeMatrix(
  size: number,
): { label: string; range: string; expect: number }[] {
  const mid = Math.floor(size / 2);
  return [
    {
      label: "open-ended from 0 (Chrome's first request)",
      range: "bytes=0-",
      expect: 206,
    },
    {
      label: "probe (Safari's first request)",
      range: "bytes=0-1",
      expect: 206,
    },
    {
      label: "closed range",
      range: `bytes=0-${Math.min(65535, size - 1)}`,
      expect: 206,
    },
    {
      label: "seek forward (mid-file, open-ended)",
      range: `bytes=${mid}-`,
      expect: 206,
    },
    {
      label: "seek backward (closed, earlier)",
      range: "bytes=1024-65535",
      expect: 206,
    },
    {
      label: "suffix range (tail, where a non-faststart moov lives)",
      range: "bytes=-65536",
      expect: 206,
    },
    {
      label: "unsatisfiable (past the end)",
      range: `bytes=${size + 1024}-`,
      expect: 416,
    },
  ];
}

/** Detect faststart from the first 64 KiB: a faststart MP4 puts `moov` before `mdat`. */
async function probeFaststart(url: string): Promise<string> {
  const response = await fetch(url, { headers: { Range: "bytes=0-65535" } });
  if (!response.ok) return `could not read header (HTTP ${response.status})`;
  const head = Buffer.from(await response.arrayBuffer()).toString("latin1");
  const moov = head.indexOf("moov");
  const mdat = head.indexOf("mdat");
  const ftyp = head.indexOf("ftyp");
  if (ftyp < 0)
    return "not an ISO-BMFF container (no ftyp) — faststart does not apply";
  if (moov < 0)
    return "moov NOT in the first 64 KiB → progressive start needs a tail range first";
  if (mdat >= 0 && mdat < moov) return "mdat before moov → NOT faststart";
  return "moov before mdat → faststart";
}

async function main() {
  const samples = await pickSamples();
  if (samples.length === 0) {
    console.log("No plaintext ready video files found. Nothing to measure.");
    return;
  }

  const client = r2Client();
  const lines: string[] = [];
  const say = (text: string) => {
    console.log(text);
    lines.push(text);
  };

  say(`# Playback measurement — ${LABEL}`);
  say("");
  say(
    `Run at ${new Date().toISOString()} from \`${process.platform}\`, sample size ${mib(SAMPLE_BYTES)}.`,
  );
  say("");
  say(
    "Numbers are this machine's. The location-independent result is the **count of Aiven " +
      "round trips inside the byte path**, and the two R2 measurements are comparable to " +
      "each other because both were taken from here.",
  );

  for (const sample of samples) {
    say("");
    say(`## ${sample.name} — ${mib(sample.sizeBytes)} (${sample.mimeType})`);
    say("");

    const q = await measureHotPathQueries(sample);
    say(
      "### Aiven, per range request (control plane cost the legacy route pays every chunk)",
    );
    say("");
    say("| query | latency |");
    say("|---|---|");
    say(`| \`SELECT 1\` (raw round trip) | ${ms(q.ping)} |`);
    say(`| \`SELECT sessions\` (requireAuth) | ${ms(q.session)} |`);
    say(`| \`SELECT users\` (requireAuth) | ${ms(q.user)} |`);
    say(`| \`SELECT files\` (getAccessibleFile) | ${ms(q.file)} |`);
    say(
      `| \`SELECT users\` (recordBandwidth read half) | ${ms(q.bandwidthRead)} |`,
    );
    say(
      `| **total before a byte is requested** | **${ms(q.perRangeRequest)}** |`,
    );
    say("");
    say(
      "`recordBandwidth`'s `UPDATE users` is not run by this script. It costs at least as " +
        "much as its read half and takes a row lock on one `users` row, which is what made " +
        "concurrent chunks queue behind each other.",
    );
    say("");

    const presign = await timed(() =>
      getSignedUrl(
        client,
        new GetObjectCommand({
          Bucket: process.env.R2_BUCKET_NAME!,
          Key: sample.r2Key,
        }),
        { expiresIn: 3600 },
      ),
    );
    const url = presign.value;

    const server = await measureServerSideGet(client, sample);
    const direct = await measureDirectGet(
      url,
      `bytes=0-${Math.min(SAMPLE_BYTES, sample.sizeBytes) - 1}`,
    );

    say("### Data plane");
    say("");
    say("| path | status | TTFB | total | bytes | throughput |");
    say("|---|---|---|---|---|---|");
    say(
      `| A: R2 GET from the server (legacy hop 1 of 2) | ${server.status} | ${ms(server.ttfb)} | ` +
        `${ms(server.totalMs)} | ${mib(server.received)} | ${throughput(server.received, server.totalMs)} |`,
    );
    say(
      `| B: presigned URL, direct (new data plane) | ${direct.status} | ${ms(direct.ttfb)} | ` +
        `${ms(direct.totalMs)} | ${mib(direct.received)} | ${throughput(direct.received, direct.totalMs)} |`,
    );
    say("");
    say(
      `Presign call itself: ${ms(presign.elapsedMs)} (local signing, no network).`,
    );
    say("");

    say("Response headers R2 returns to the browser on the direct path:");
    say("");
    say("| header | value |");
    say("|---|---|");
    for (const [key, value] of Object.entries(direct.headers)) {
      say(`| \`${key}\` | ${value ?? "_(absent)_"} |`);
    }
    say("");

    say("### Range matrix, direct against R2");
    say("");
    say("| shape | sent | status | expected | Content-Range | TTFB |");
    say("|---|---|---|---|---|---|");
    for (const probe of rangeMatrix(sample.sizeBytes)) {
      const result = await probeRange(url, probe.range);
      const verdict =
        result.status === probe.expect ? "✅" : `❌ want ${probe.expect}`;
      say(
        `| ${probe.label} | \`${probe.range}\` | ${result.status} | ${verdict} | ` +
          `${result.contentRange ?? "—"} | ${ms(result.ttfb)} |`,
      );
    }
    say("");

    say(`Faststart: ${await probeFaststart(url)}`);
  }

  client.destroy();

  const { writeFile } = await import("node:fs/promises");
  const outPath = `docs/playback-measurement-${LABEL}.md`;
  await writeFile(outPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`\nWritten to ${outPath}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.stack : error);
    process.exit(1);
  });
