import "dotenv/config";
import { asc, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "../lib/db/schema";
import { brains } from "../lib/db/schema";
import { enrichBrain } from "../lib/brain/enrich/enrich-service";
import {
  runRelateBrainJob,
  runRelateMemoryJob,
  type RelateMemoryReport,
} from "../lib/brain/graph/relate-jobs";

/**
 * One-time operational backfill for PHASE 2 derived relationships.
 *
 * Memories created BEFORE the write-path relate chain shipped never had a
 * `relate_memory` job enqueued, so their `memory_derived_links` rows were never
 * computed. That is why `brain_get_related` comes back empty on an older brain even
 * though enrichment already produced entities and links. This script runs the same
 * bounded sweep the `relate_brain` worker job runs, but INLINE — it does not depend on
 * Redis or a running worker, which matters when the worker process is down.
 *
 * It introduces NO new scoring or policy: it only invokes `runRelateMemoryJob`
 * (covered by tests/brain-phase2-db.test.ts) per memory. `reconcileDerivedEdges` is
 * idempotent, so re-running is safe and converges on the same rows.
 *
 * Derived edges are written to `memory_derived_links` only. This never touches
 * `memory_links`, so it does NOT change the "orphan" health counts (those count
 * explicit memory->memory links by design).
 *
 * Usage:
 *   npx tsx scripts/brain-backfill-relate.ts                 # all active brains, inline
 *   npx tsx scripts/brain-backfill-relate.ts --brain <id>    # one brain
 *   npx tsx scripts/brain-backfill-relate.ts --enrich        # enrich first, then relate
 *   npx tsx scripts/brain-backfill-relate.ts --limit 500     # raise the per-brain cap
 */

type Args = { brainId?: string; limit?: number; enrich: boolean };

function parseArgs(argv: string[]): Args {
  const args: Args = { enrich: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--brain") args.brainId = argv[++i];
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--enrich") args.enrich = true;
  }
  if (args.limit !== undefined && (!Number.isFinite(args.limit) || args.limit < 1)) {
    console.error("--limit must be a positive number");
    process.exit(1);
  }
  return args;
}

type BrainTotals = {
  found: number;
  processed: number;
  inserted: number;
  updated: number;
  deleted: number;
};

async function backfillBrain(
  db: ReturnType<typeof drizzle<typeof schema>>,
  brainId: string,
  limit: number | undefined,
  enrich: boolean
): Promise<BrainTotals> {
  if (enrich) {
    const report = await enrichBrain(db, { brainId, limit });
    console.log(
      `  enrich: processed=${report.processed} ready=${report.ready} ` +
        `skipped=${report.skipped} failed=${report.failed} remaining=${report.remaining}`
    );
  }

  const totals: BrainTotals = { found: 0, processed: 0, inserted: 0, updated: 0, deleted: 0 };

  // Reuse the exact bounded selection (batch cap, oldest-first, skip soft-deleted) the
  // relate_brain worker job uses, but run each memory INLINE instead of enqueuing.
  const sweep = await runRelateBrainJob(db, brainId, limit, async (memoryId) => {
    const r: RelateMemoryReport = await runRelateMemoryJob(db, brainId, memoryId);
    totals.processed += 1;
    totals.inserted += r.inserted;
    totals.updated += r.updated;
    totals.deleted += r.deleted;
  });
  totals.found = sweep.found;

  console.log(
    `  relate: found=${totals.found} processed=${totals.processed} ` +
      `+${totals.inserted}~${totals.updated}-${totals.deleted}`
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

    console.log(`Backfilling derived relationships for ${targets.length} brain(s)\n`);
    const grand: BrainTotals = { found: 0, processed: 0, inserted: 0, updated: 0, deleted: 0 };
    for (const brain of targets) {
      console.log(`Brain ${brain.name} (${brain.id}):`);
      const t = await backfillBrain(db, brain.id, args.limit, args.enrich);
      grand.found += t.found;
      grand.processed += t.processed;
      grand.inserted += t.inserted;
      grand.updated += t.updated;
      grand.deleted += t.deleted;
    }

    console.log(
      `\nDone. brains=${targets.length} memories=${grand.processed} ` +
        `derived edges +${grand.inserted}~${grand.updated}-${grand.deleted}`
    );
  } finally {
    await client.end();
  }
}

main();
