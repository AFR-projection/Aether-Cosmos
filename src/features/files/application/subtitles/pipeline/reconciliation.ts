import { subtitleLocaleSetHash } from "@files/domain/services/subtitles/locale-targets";
import type { BackfillCursor, SourceIdentity, SubtitlePipelineStore } from "./contracts";
import { ensureSubtitlePipeline, SUBTITLE_PIPELINE_POLICY_VERSION } from "./ensure";

export type BackfillPageResult = {
  readonly processed: number;
  readonly cursor: BackfillCursor | null;
  readonly done: boolean;
};

/** Keyset-paginated library backfill. Cursor advances even when ensure reuses an existing run. */
export async function backfillSubtitlePipelines(
  store: SubtitlePipelineStore,
  input: { cursor?: BackfillCursor | null; limit?: number; policyVersion?: number; now?: Date } = {}
): Promise<BackfillPageResult> {
  const limit = input.limit ?? 100;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new RangeError("limit must be 1..1000");
  const rows = await store.listUndiscoveredSources(input.cursor ?? null, limit);
  for (const source of rows) {
    await ensureSubtitlePipeline(
      { fileId: source.fileId, policyVersion: input.policyVersion ?? SUBTITLE_PIPELINE_POLICY_VERSION, now: input.now },
      store
    );
  }
  const last = rows.at(-1);
  return {
    processed: rows.length,
    cursor: last ? sourceCursor(last) : input.cursor ?? null,
    done: rows.length < limit,
  };
}

function sourceCursor(source: SourceIdentity & { createdAt?: Date }): BackfillCursor {
  const createdAt = source.createdAt;
  if (!(createdAt instanceof Date)) throw new Error("Backfill sources must include createdAt");
  return { createdAt, fileId: source.fileId };
}

/** Add-only locale reconciliation: existing/removed locales and completed outputs are untouched. */
export async function reconcileSubtitleLocales(
  store: SubtitlePipelineStore,
  input: { runId: string; locales?: readonly string[]; now?: Date }
): Promise<{ added: number; localeSetHash: string }> {
  const run = await store.getRun(input.runId);
  if (!run) throw new Error("SUBTITLE_RUN_NOT_FOUND");
  const desired = input.locales ?? undefined;
  const localeSetHash = subtitleLocaleSetHash(desired);
  const current = new Set((await store.listTargets(run.id)).map((target) => target.language));
  // Hash helper already canonicalizes aliases; target derivation is performed by ensure's domain helper.
  const { deriveAutomaticSubtitleTargets } = await import("@files/domain/services/subtitles/locale-targets");
  const additions = deriveAutomaticSubtitleTargets("und", desired)
    .map((target) => target.language)
    .filter((language) => !current.has(language));
  const added = await store.addAutomaticTargets(run.id, additions, localeSetHash, input.now ?? new Date());
  return { added, localeSetHash };
}
