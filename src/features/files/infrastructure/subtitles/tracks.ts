import { and, asc, desc, eq, gt, gte, inArray, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "@/shared/infrastructure/db/schema";
import { db as defaultDb } from "@/shared/infrastructure/db";
import { subtitleCues, subtitleTracks } from "@/shared/infrastructure/db/schema";
import { SUBTITLE_MAX_CUES } from "@files/domain/services/subtitles/limits";
import type { SubtitleCue } from "@files/domain/services/subtitles/vtt";

/**
 * Reading and writing subtitle tracks and their lines.
 *
 * Everything that touches the two subtitle tables goes through here, so three properties can be
 * stated once instead of being re-established at every call site:
 *
 *  - **A track is always reached through its file.** {@link getTrackForFile} takes both ids and
 *    matches on both, so a caller that has already checked permission on a file cannot be handed
 *    a track belonging to a different one by passing a guessed uuid.
 *  - **Cues are replaced, never merged.** {@link replaceCues} deletes and re-inserts inside one
 *    transaction. That is what makes a worker retry safe — a job that died halfway leaves partial
 *    cues, and a merge would produce a track with a repeated middle.
 *  - **A job claims its track.** {@link claimTrack} moves a row to `processing` only from
 *    `queued`/`processing`, so a duplicate delivery of the same BullMQ job cannot double the work
 *    of a track somebody has since deleted or that already finished.
 */

type SubtitleDb = PostgresJsDatabase<typeof schema>;

export type SubtitleTrackRow = typeof subtitleTracks.$inferSelect;
export type SubtitleOrigin = SubtitleTrackRow["origin"];

export const WHOLE_VTT_MAX_CUES = 20_000;
export const WHOLE_VTT_MAX_ESTIMATED_BYTES = 10 * 1024 * 1024;
export const CUE_WINDOW_MAX_MS = 30 * 60 * 1000;
export const CUE_WINDOW_MAX_CUES = 500;

export type CueCursor = { startMs: number; idx: number };
export type CueWindow = {
  cues: SubtitleCue[];
  nextCursor: CueCursor | null;
};
export type WholeVttSize = { cueCount: number; estimatedBytes: number };

/** Conservative UTF-8 VTT size, including identifier, timing, and blank-line overhead. */
export function estimateVttBytes(cues: readonly SubtitleCue[]): number {
  let bytes = Buffer.byteLength("WEBVTT\n", "utf8");
  for (const cue of cues) {
    bytes +=
      Buffer.byteLength(cue.text, "utf8") +
      String(cue.idx + 1).length +
      // Two timestamps, the arrow, separators, and a blank line. Hours may exceed two digits.
      48 +
      String(Math.floor(Math.max(cue.startMs, cue.endMs) / 3_600_000)).length * 2;
  }
  return bytes;
}

export function wholeVttRequiresSegmentation(size: WholeVttSize): boolean {
  return size.cueCount > WHOLE_VTT_MAX_CUES || size.estimatedBytes > WHOLE_VTT_MAX_ESTIMATED_BYTES;
}

function assertSafeTimestamp(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative safe integer`);
  }
}

/** Every track of one file, oldest first, so the CC menu order is stable across reloads. */
export async function listTracks(
  fileId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow[]> {
  return db
    .select()
    .from(subtitleTracks)
    .where(
      and(eq(subtitleTracks.fileId, fileId), eq(subtitleTracks.trackState, "current"))
    )
    .orderBy(asc(subtitleTracks.createdAt), asc(subtitleTracks.id));
}

/** One track, by id alone. For the worker, which has already been told which track to build. */
export async function getTrack(
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow | null> {
  const [row] = await db.select().from(subtitleTracks).where(eq(subtitleTracks.id, trackId)).limit(1);
  return row ?? null;
}

/**
 * One track, scoped to the file it must belong to.
 *
 * The scoping is the point: every route already knows whether the caller may see a given file, so
 * matching on both ids turns that one permission check into the answer for the track as well.
 */
export async function getTrackForFile(
  fileId: string,
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow | null> {
  const [row] = await db
    .select()
    .from(subtitleTracks)
    .where(
      and(
        eq(subtitleTracks.id, trackId),
        eq(subtitleTracks.fileId, fileId),
        eq(subtitleTracks.trackState, "current")
      )
    )
    .limit(1);
  return row ?? null;
}

/**
 * The file's transcription track, whatever language it turned out to be.
 *
 * Found by origin rather than by language, and that is the whole reason it exists: a track is
 * created before anybody knows what the audio is (carrying {@link UNDETERMINED_LANGUAGE}) and
 * renamed when the provider reports a detection. Looking it up by language afterwards would miss
 * it, and upserting by language would leave a second placeholder row behind on the next request.
 *
 * At most one exists in practice — the route always reuses this one — but the ordering makes the
 * choice deterministic if a historical row ever produced two.
 */
/**
 * Find an ASR track in candidate or current state for this file.
 */
export async function findAsrTrack(
  fileId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow | null> {
  const [row] = await db
    .select()
    .from(subtitleTracks)
    .where(
      and(
        eq(subtitleTracks.fileId, fileId),
        eq(subtitleTracks.origin, "asr"),
        inArray(subtitleTracks.trackState, ["candidate", "current"])
      )
    )
    .orderBy(desc(subtitleTracks.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Create or reset a candidate track for pipeline materialization.
 * Returns the track row (new or existing candidate).
 */
export async function createCandidateTrack(
  input: UpsertTrackInput & { trackState: "candidate" },
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow> {
  return db.transaction(async (tx) => {
    const now = new Date();
    if (input.pipelineRunId) {
      const [existing] = await tx.select().from(subtitleTracks)
        .where(and(
          eq(subtitleTracks.pipelineRunId, input.pipelineRunId),
          eq(subtitleTracks.language, input.language),
          eq(subtitleTracks.origin, input.origin),
          eq(subtitleTracks.trackState, "candidate")
        )).limit(1);
      if (existing) {
        const [updated] = await tx.update(subtitleTracks).set({
          status: input.status ?? "processing",
          translatedFromId: input.translatedFromId ?? null,
          sourceVersion: input.sourceVersion ?? null,
          sourceR2Key: input.sourceR2Key ?? null,
          sourceMimeType: input.sourceMimeType ?? null,
          sourceTrackRevision: input.sourceTrackRevision ?? null,
          cueCount: input.cueCount ?? 0,
          durationSeconds: input.durationSeconds ?? 0,
          provider: input.provider ?? null,
          model: input.model ?? null,
          failureCode: null,
          failureMessage: null,
          createdBy: input.createdBy,
          updatedAt: now,
        }).where(eq(subtitleTracks.id, existing.id)).returning();
        return updated;
      }
    }
    const [inserted] = await tx.insert(subtitleTracks).values({
      fileId: input.fileId,
      language: input.language,
      origin: input.origin,
      status: input.status ?? "processing",
      trackState: "candidate",
      translatedFromId: input.translatedFromId ?? null,
      pipelineRunId: input.pipelineRunId ?? null,
      sourceVersion: input.sourceVersion ?? null,
      sourceR2Key: input.sourceR2Key ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceTrackRevision: input.sourceTrackRevision ?? null,
      progress: 0,
      cueCount: input.cueCount ?? 0,
      durationSeconds: input.durationSeconds ?? 0,
      provider: input.provider ?? null,
      model: input.model ?? null,
      createdBy: input.createdBy,
      readyAt: null,
      updatedAt: now,
    }).returning();
    return inserted;
  });
}

/** Put a track back in the queue: progress cleared, previous failure forgotten. */
export async function requeueTrack(
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<void> {
  await db
    .update(subtitleTracks)
    .set({
      status: "queued",
      progress: 0,
      failureCode: null,
      failureMessage: null,
      updatedAt: new Date(),
    })
    .where(eq(subtitleTracks.id, trackId));
}

/** Read every cue. Callers must gate this with {@link getWholeVttSize}; nothing is truncated. */
export async function listCues(
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleCue[]> {
  return db
    .select({
      idx: subtitleCues.idx,
      startMs: subtitleCues.startMs,
      endMs: subtitleCues.endMs,
      text: subtitleCues.text,
    })
    .from(subtitleCues)
    .where(eq(subtitleCues.trackId, trackId))
    .orderBy(asc(subtitleCues.idx));
}

/** Count and estimate a complete WebVTT without loading cue text into the application. */
export async function getWholeVttSize(
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<WholeVttSize> {
  const [row] = await db
    .select({
      cueCount: sql<number>`count(*)::bigint`,
      estimatedBytes: sql<number>`(
        7 + coalesce(sum(
          octet_length(${subtitleCues.text})
          + length((${subtitleCues.idx} + 1)::text)
          + 56
        ), 0)
      )::bigint`,
    })
    .from(subtitleCues)
    .where(eq(subtitleCues.trackId, trackId));
  return {
    cueCount: Number(row?.cueCount ?? 0),
    estimatedBytes: Number(row?.estimatedBytes ?? 7),
  };
}

/**
 * A stable time window. The cursor is `(start_ms, idx)`, so equal timestamps cannot skip cues.
 * One extra row is fetched only to decide whether a continuation cursor is needed.
 */
export async function listCueWindow(
  trackId: string,
  input: { startMs: number; endMs: number; cursor?: CueCursor | null; limit?: number },
  db: SubtitleDb = defaultDb
): Promise<CueWindow> {
  assertSafeTimestamp(input.startMs, "startMs");
  assertSafeTimestamp(input.endMs, "endMs");
  if (input.endMs <= input.startMs || input.endMs - input.startMs > CUE_WINDOW_MAX_MS) {
    throw new RangeError(`Cue windows must be greater than zero and at most ${CUE_WINDOW_MAX_MS}ms`);
  }
  const limit = input.limit ?? CUE_WINDOW_MAX_CUES;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > CUE_WINDOW_MAX_CUES) {
    throw new RangeError(`limit must be between 1 and ${CUE_WINDOW_MAX_CUES}`);
  }
  if (input.cursor) {
    assertSafeTimestamp(input.cursor.startMs, "cursor.startMs");
    if (!Number.isSafeInteger(input.cursor.idx) || input.cursor.idx < 0) {
      throw new RangeError("cursor.idx must be a non-negative safe integer");
    }
  }

  const cursorFilter = input.cursor
    ? or(
        gt(subtitleCues.startMs, input.cursor.startMs),
        and(eq(subtitleCues.startMs, input.cursor.startMs), gt(subtitleCues.idx, input.cursor.idx))
      )
    : undefined;
  const rows = await db
    .select({
      idx: subtitleCues.idx,
      startMs: subtitleCues.startMs,
      endMs: subtitleCues.endMs,
      text: subtitleCues.text,
    })
    .from(subtitleCues)
    .where(
      and(
        eq(subtitleCues.trackId, trackId),
        gte(subtitleCues.startMs, input.startMs),
        lt(subtitleCues.startMs, input.endMs),
        cursorFilter
      )
    )
    .orderBy(asc(subtitleCues.startMs), asc(subtitleCues.idx))
    .limit(limit + 1);
  const cues = rows.slice(0, limit);
  const last = cues.at(-1);
  return {
    cues,
    nextCursor:
      rows.length > limit && last ? { startMs: last.startMs, idx: last.idx } : null,
  };
}

/**
 * Replace a track's lines wholesale, and keep `cue_count` in step.
 *
 * One transaction, delete then insert. Anything gentler would have to reconcile what a half-failed
 * previous attempt left behind, and reconciling timed text against timed text is exactly the kind
 * of merge that produces a track with a duplicated middle nobody notices until they watch it.
 *
 * Inserted in chunks because a feature-length film is thousands of rows and a single multi-row
 * INSERT of that size runs into parameter limits.
 */
export async function replaceCues(
  trackId: string,
  cues: readonly SubtitleCue[],
  db: SubtitleDb = defaultDb
): Promise<void> {
  if (cues.length > SUBTITLE_MAX_CUES) {
    throw new RangeError(`A subtitle track cannot contain more than ${SUBTITLE_MAX_CUES} cues`);
  }
  for (const cue of cues) {
    assertSafeTimestamp(cue.startMs, "cue.startMs");
    assertSafeTimestamp(cue.endMs, "cue.endMs");
  }
  await db.transaction(async (tx) => {
    await tx.delete(subtitleCues).where(eq(subtitleCues.trackId, trackId));
    for (let start = 0; start < cues.length; start += 500) {
      const slice = cues.slice(start, start + 500);
      await tx.insert(subtitleCues).values(
        slice.map((cue) => ({
          trackId,
          idx: cue.idx,
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text,
        }))
      );
    }
    await tx
      .update(subtitleTracks)
      .set({ cueCount: cues.length, updatedAt: new Date() })
      .where(eq(subtitleTracks.id, trackId));
  });
}

export type RevisionReplaceResult =
  | { ok: true; revision: number }
  | { ok: false; reason: "missing" | "revision_conflict" };

/** Whole-track editor save, serialized by an atomic revision compare-and-swap. */
export async function replaceCuesAtRevision(
  trackId: string,
  expectedRevision: number,
  cues: readonly SubtitleCue[],
  db: SubtitleDb = defaultDb
): Promise<RevisionReplaceResult> {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new RangeError("expectedRevision must be a positive safe integer");
  }
  if (cues.length > SUBTITLE_MAX_CUES) {
    throw new RangeError(`A subtitle track cannot contain more than ${SUBTITLE_MAX_CUES} cues`);
  }
  for (const cue of cues) {
    assertSafeTimestamp(cue.startMs, "cue.startMs");
    assertSafeTimestamp(cue.endMs, "cue.endMs");
  }

  return db.transaction(async (tx) => {
    const [claimed] = await tx
      .update(subtitleTracks)
      .set({
        revision: sql`${subtitleTracks.revision} + 1`,
        userEditedAt: new Date(),
        cueCount: cues.length,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(subtitleTracks.id, trackId),
          eq(subtitleTracks.revision, expectedRevision)
        )
      )
      .returning({ revision: subtitleTracks.revision });
    if (!claimed) {
      const [existing] = await tx
        .select({ id: subtitleTracks.id })
        .from(subtitleTracks)
        .where(eq(subtitleTracks.id, trackId))
        .limit(1);
      return { ok: false, reason: existing ? "revision_conflict" : "missing" };
    }

    await tx.delete(subtitleCues).where(eq(subtitleCues.trackId, trackId));
    for (let start = 0; start < cues.length; start += 500) {
      await tx.insert(subtitleCues).values(
        cues.slice(start, start + 500).map((cue) => ({
          trackId,
          idx: cue.idx,
          startMs: cue.startMs,
          endMs: cue.endMs,
          text: cue.text,
        }))
      );
    }
    return { ok: true, revision: claimed.revision };
  });
}

export type UpsertTrackInput = {
  fileId: string;
  language: string;
  origin: SubtitleOrigin;
  createdBy: string | null;
  translatedFromId?: string | null;
  status?: SubtitleTrackRow["status"];
  cueCount?: number;
  durationSeconds?: number;
  provider?: string | null;
  model?: string | null;
  trackState?: SubtitleTrackRow["trackState"];
  pipelineRunId?: string | null;
  sourceVersion?: number | null;
  sourceR2Key?: string | null;
  sourceMimeType?: string | null;
  sourceTrackRevision?: number | null;
};

/**
 * The track for this (file, language, origin), created or reset.
 *
 * Asking for Indonesian a second time must not add a second "Indonesia" to the menu, so the
 * unique index does the work and the conflict path *resets* the row: back to the requested status,
 * progress zero, previous failure cleared. The old cues are left for {@link replaceCues} to
 * remove, which keeps the currently-playing track readable until the new one is complete.
 */
export async function upsertTrack(
  input: UpsertTrackInput,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow> {
  const now = new Date();
  const status = input.status ?? "queued";
  const trackState = input.trackState ?? "current";
  const [row] = await db
    .insert(subtitleTracks)
    .values({
      fileId: input.fileId,
      language: input.language,
      origin: input.origin,
      status,
      trackState,
      translatedFromId: input.translatedFromId ?? null,
      pipelineRunId: input.pipelineRunId ?? null,
      sourceVersion: input.sourceVersion ?? null,
      sourceR2Key: input.sourceR2Key ?? null,
      sourceMimeType: input.sourceMimeType ?? null,
      sourceTrackRevision: input.sourceTrackRevision ?? null,
      progress: 0,
      cueCount: input.cueCount ?? 0,
      durationSeconds: input.durationSeconds ?? 0,
      provider: input.provider ?? null,
      model: input.model ?? null,
      createdBy: input.createdBy,
      readyAt: status === "ready" ? now : null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [subtitleTracks.fileId, subtitleTracks.language, subtitleTracks.origin],
      // The unique index is partial (`WHERE track_state = 'current'`), so the conflict target
      // must carry the same predicate.
      targetWhere: sql`${subtitleTracks.trackState} = 'current'`,
      set: {
        status,
        trackState,
        progress: 0,
        translatedFromId: input.translatedFromId ?? null,
        pipelineRunId: input.pipelineRunId ?? null,
        sourceVersion: input.sourceVersion ?? null,
        sourceR2Key: input.sourceR2Key ?? null,
        sourceMimeType: input.sourceMimeType ?? null,
        sourceTrackRevision: input.sourceTrackRevision ?? null,
        cueCount: input.cueCount ?? 0,
        durationSeconds: input.durationSeconds ?? 0,
        provider: input.provider ?? null,
        model: input.model ?? null,
        failureCode: null,
        failureMessage: null,
        createdBy: input.createdBy,
        readyAt: status === "ready" ? now : null,
        updatedAt: now,
      },
    })
    .returning();
  return row;
}

/**
 * Take ownership of a track for this job, or refuse.
 *
 * Returns the row only if it moved to `processing` from `queued` or `processing`. A track that has
 * since been deleted, or that another delivery of the same job already finished, yields `null` and
 * the worker stops — which is what makes the jobs safe to retry.
 */
export async function claimTrack(
  trackId: string,
  db: SubtitleDb = defaultDb
): Promise<SubtitleTrackRow | null> {
  const [row] = await db
    .update(subtitleTracks)
    .set({ status: "processing", updatedAt: new Date() })
    .where(
      and(
        eq(subtitleTracks.id, trackId),
        inArray(subtitleTracks.status, ["queued", "processing"])
      )
    )
    .returning();
  return row ?? null;
}

/**
 * Move the progress bar.
 *
 * Never moves it backwards: the transcription and translation halves of one track both report
 * into this column, and a late update from the earlier phase would otherwise make a finished
 * transcript look like it had restarted.
 */
export async function setTrackProgress(
  trackId: string,
  progress: number,
  db: SubtitleDb = defaultDb
): Promise<void> {
  const clamped = Math.max(0, Math.min(100, Math.round(progress)));
  await db
    .update(subtitleTracks)
    .set({
      progress: sql`greatest(${subtitleTracks.progress}, ${clamped})`,
      updatedAt: new Date(),
    })
    .where(eq(subtitleTracks.id, trackId));
}

export async function markTrackReady(
  trackId: string,
  fields: {
    language?: string;
    cueCount: number;
    durationSeconds?: number;
    provider?: string | null;
    model?: string | null;
  },
  db: SubtitleDb = defaultDb
): Promise<void> {
  const now = new Date();
  await db
    .update(subtitleTracks)
    .set({
      status: "ready",
      progress: 100,
      cueCount: fields.cueCount,
      ...(fields.language ? { language: fields.language } : {}),
      ...(fields.durationSeconds !== undefined
        ? { durationSeconds: Math.max(0, Math.round(fields.durationSeconds)) }
        : {}),
      ...(fields.provider !== undefined ? { provider: fields.provider } : {}),
      ...(fields.model !== undefined ? { model: fields.model } : {}),
      failureCode: null,
      failureMessage: null,
      readyAt: now,
      updatedAt: now,
    })
    .where(eq(subtitleTracks.id, trackId));
}

/**
 * Record why a track will not appear.
 *
 * The message is shown to the user, so it has to be a sentence rather than a stack trace — the
 * callers pass one deliberately, and it is truncated here because a provider's error body can be
 * a page long and this column ends up in a tooltip.
 */
export async function markTrackFailed(
  trackId: string,
  failure: { code: string; message: string },
  db: SubtitleDb = defaultDb
): Promise<void> {
  await db
    .update(subtitleTracks)
    .set({
      status: "failed",
      failureCode: failure.code,
      failureMessage: failure.message.slice(0, 500),
      updatedAt: new Date(),
    })
    .where(eq(subtitleTracks.id, trackId));
}

/** Remove a track and, by cascade, every line of it. */
export async function deleteTrack(trackId: string, db: SubtitleDb = defaultDb): Promise<void> {
  await db.delete(subtitleTracks).where(eq(subtitleTracks.id, trackId));
}

/** Change a track's language without touching its lines. For a corrected auto-detection. */
export async function setTrackLanguage(
  trackId: string,
  language: string,
  db: SubtitleDb = defaultDb
): Promise<void> {
  await db
    .update(subtitleTracks)
    .set({ language, updatedAt: new Date() })
    .where(eq(subtitleTracks.id, trackId));
}
