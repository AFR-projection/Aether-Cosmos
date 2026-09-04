import { RELATE_SWEEP_MAX } from "@brain/application/commands/relate-jobs";
import { enqueueJob } from "@/shared/infrastructure/queue";

/**
 * What a Brain restore leaves for the worker to finish.
 *
 * A `.afrbak` carries the graph a person *authored* — `memory_links`, `brain_relationships`,
 * `memory_mentions`, `brain_entities` — and it carries `memories.embedding`, so semantic search
 * works the moment the restore commits. What it deliberately does not carry is
 * `memory_derived_links`: the automatically scored edges behind `/brain/graph` and "related
 * memories". `table-classification.ts` puts them under `DERIVED_TABLES` for a good reason —
 * every row references two memory ids that a restore reissues, and the scorer's own version is
 * baked into `computed_by`, so an archive's edges would arrive pointing at nothing and claiming
 * to have been computed by a scorer this instance may no longer run.
 *
 * The consequence, before this module existed, was a restore that looked complete and a graph
 * that was empty: nothing recomputes those edges except `relate_memory`, and nothing enqueues
 * `relate_memory` except writing a memory through `memory-service`. An import writes rows
 * straight through its sink, so no job was ever queued and the edges appeared only if the
 * account happened to edit each memory by hand afterwards.
 *
 * ## Why this lives next to the route and not in `src/features/backup`
 *
 * Because it is the seam between two features, and the layer rules in `eslint.config.mjs` say
 * where a seam goes: features are siblings, so `src/features/backup` may not import `@brain/*`,
 * and anything two of them need is either promoted to `src/shared` or composed in `app/`.
 * `RELATE_SWEEP_MAX` is brain's policy about brain's own job — it has no business in `src/shared`
 * — and asking backup to schedule brain work would be exactly the dependency the rule forbids.
 * The route already imports `listBrains` from one feature and `restoreAccountArchive` from the
 * other, so this is the composition point, and this file sits in it.
 *
 * ## Why it is a function and not four lines in the handler
 *
 * `enqueueJob` swallows its own failures and returns `false`, which is right — a queue that is
 * down must not fail a restore that already committed — but it means the *route* cannot tell the
 * person anything true unless someone counts. This counts, and the count reaches the response, so
 * "your graph is being rebuilt" and "your graph will rebuild when the worker is running again"
 * are two different sentences the UI can actually say. On a single-VPS deployment where the
 * worker is a separate process that can be stopped, that difference is the whole message.
 */

export interface DerivedRebuildReport {
  /** Brains a job was attempted for. */
  brains: number;
  /** Jobs the queue accepted. Below `brains` means Redis is unavailable or disabled. */
  queued: number;
}

/**
 * Ask the worker to recompute the derived graph of each brain.
 *
 * One `relate_brain` per brain, which fans out into one `relate_memory` per live memory. Both
 * jobs are idempotent — `relate_memory` is deduped by memory id (`relate:<id>`) and *reconciles*
 * the memory's edges rather than appending to them — so a brain that already has its edges costs
 * a no-op, and running this after a `merge` that matched everything is harmless.
 *
 * `RELATE_SWEEP_MAX` is passed rather than left to the sweep's default of `RELATE_SWEEP_LIMIT`
 * (200) because this caller wants the whole brain, not a batch of it: the sweep takes the oldest
 * N memories and deliberately does not re-queue itself, so the limit this passes is exactly how
 * far the rebuild reaches. One thousand is the sweep's own hard ceiling and cannot be raised from
 * here. A restored brain larger than that gets its oldest thousand memories scored now and the
 * rest when each is next written — the honest boundary, and the alternative is teaching a shared
 * brain job to paginate itself, which its own doc rejects for good reason.
 *
 * `enqueue` is injected so this is verifiable without Redis; the default is the real queue.
 */
export async function scheduleDerivedGraphRebuild(
  brainIds: readonly string[],
  enqueue: (brainId: string) => Promise<boolean> = (brainId) =>
    enqueueJob("relate_brain", { brainId, limit: RELATE_SWEEP_MAX })
): Promise<DerivedRebuildReport> {
  const unique = [...new Set(brainIds)];
  let queued = 0;

  for (const brainId of unique) {
    // Per brain rather than around the loop: one brain whose enqueue throws must not decide
    // that the others are not worth trying. Nothing is rethrown at all — the restore this
    // follows has already committed, and failing the request now would report a data loss that
    // did not happen.
    try {
      if (await enqueue(brainId)) queued += 1;
    } catch {
      // Deliberately ignored — see above. `queued` is what the response tells the truth with.
    }
  }

  return { brains: unique.length, queued };
}
