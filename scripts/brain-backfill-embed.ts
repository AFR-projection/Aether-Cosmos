import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import { brains } from "../lib/db/schema";
import {
  runEmbedBrainJob,
  runEmbedMemoryJob,
  type EmbedMemoryReport,
} from "../lib/brain/embedding/embed-jobs";
import { getEmbeddingProvider } from "../lib/brain/embedding/resolve";

/**
 * One-time operational backfill for P9 semantic embeddings.
 *
 * Memories created before embeddings were configured never had an `embed_memory` job
 * run, so their `embedding` column is NULL and the semantic leg cannot see them. This
 * runs the same bounded sweep the `embed_brain` worker job runs, but INLINE — it does
 * not need Redis or a running worker, which matters when the worker process is down.
 *
 * It introduces NO new policy: it resolves the configured provider once and invokes
 * `runEmbedMemoryJob` (covered by tests) per memory. That job is idempotent — a memory
 * whose stored model matches and is fresh is skipped — so re-running is safe and cheap.
 * With no provider configured it prints a notice and exits without touching a row.
 *
 * Writes touch ONLY the three embedding columns, always brain-scoped. `memory_links`,
 * `memory_derived_links`, enrichment and relate bookkeeping are never touched.
 *
 * Usage:
 *   npx tsx scripts/brain-backfill-embed.ts                 # all active brains, inline
 *   npx tsx scripts/brain-backfill-embed.ts --brain <id>    # one brain
 *   npx tsx scripts/brain-backfill-embed.ts --limit 500     # raise the per-brain cap
 */

type Args = { brainId?: string; limit?: number };

function parseArgs(argv: string[]): Args {
  const args: Args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brain") args.brainId = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    console.error("--limit must be a positive number");
    process.exit(1);
  }
  return args;
}

type BrainTotals = { found: number; processed: number; embedded: number; skipped: number };

async function backfillBrain(
  db: ReturnType<typeof drizzle<typeof schema>>,
  brainId: string,
  limit: number | undefined,
  provider: Awaited<ReturnType<typeof getEmbeddingProvider>>
): Promise<BrainTotals> {
  const totals: BrainTotals = { found: 0, processed: 0, embedded: 0, skipped: 0 };

  // Reuse the exact bounded selection (batch cap, oldest-first, skip soft-deleted) the
  // embed_brain worker job uses, but run each memory INLINE instead of enqueuing. The
  // provider is resolved once and passed down so the sweep does not re-read config per
  // memory.
  const sweep = await runEmbedBrainJob(db, brainId, limit, async (memoryId) => {
    const r: EmbedMemoryReport = await runEmbedMemoryJob(db, brainId, memoryId, provider);
    totals.processed += 1;
    if (r.embedded) totals.embedded += 1;
    if (r.skipped) totals.skipped += 1;
  });
  totals.found = sweep.found;

  console.log(
    `  embed: found=${totals.found} processed=${totals.processed} ` +
      `embedded=${totals.embedded} skipped=${totals.skipped}`
  );
  return totals;
}

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error("DATABASE_URL is not set (check your .env)");
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const client = postgres(connectionString, { max: 1 });
  const db = drizzle(client, { schema });

  try {
    const provider = await getEmbeddingProvider(db);
    if (!(await provider.available())) {
      console.error(
        "No embedding provider is configured/enabled. Set the OpenRouter key + model in " +
          "/brain/settings and enable it, then re-run."
      );
      process.exitCode = 1;
      return;
    }
    console.log(`Using embedding model "${provider.model}" (${provider.dimensions}-d)\n`);

    let targets: { id: string; name: string }[];
    if (args.brainId) {
      targets = await db
        .select({ id: brains.id, name: brains.name })
        .from(brains)
        .where(eq(brains.id, args.brainId));
      if (targets.length === 0) {
        console.error(`Brain ${args.brainId} not found`);
        process.exitCode = 1;
        return;
      }
    } else {
      targets = await db
        .select({ id: brains.id, name: brains.name })
        .from(brains)
        .where(eq(brains.status, "active"))
        .orderBy(asc(brains.createdAt));
    }

    console.log(`Backfilling semantic embeddings for ${targets.length} brain(s)\n`);
    const grand: BrainTotals = { found: 0, processed: 0, embedded: 0, skipped: 0 };
    for (const brain of targets) {
      console.log(`Brain ${brain.name} (${brain.id}):`);
      const t = await backfillBrain(db, brain.id, args.limit, provider);
      grand.found += t.found;
      grand.processed += t.processed;
      grand.embedded += t.embedded;
      grand.skipped += t.skipped;
    }

    console.log(
      `\nDone. brains=${targets.length} memories=${grand.processed} ` +
        `embedded=${grand.embedded} skipped=${grand.skipped}`
    );
  } finally {
    await client.end();
  }
}

main();
