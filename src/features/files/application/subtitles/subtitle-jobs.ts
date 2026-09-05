import { eq } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { files } from "@/shared/infrastructure/db/schema";
import { publishToUser } from "@/shared/infrastructure/realtime/events";
import { enqueueJob } from "@/shared/infrastructure/queue";
import { recordSubtitleSeconds, SubtitleQuotaError } from "@/shared/lib/billing/subtitle-minutes";
import {
  ASR_AUDIO_TARGETS,
  buildSubtitleAudioArgs,
  chunkName,
  chunkPattern,
  parseSegmentList,
  totalSegmentSeconds,
  type AsrAudioTarget,
  type AudioSegment,
} from "@files/domain/services/subtitles/audio-extract";
import { mergeChunkTranscripts, normalizeCues } from "@files/domain/services/subtitles/cues";
import {
  findSubtitleLanguage,
  UNDETERMINED_LANGUAGE,
} from "@files/domain/services/subtitles/languages";
import {
  SUBTITLE_MAX_DURATION_SECONDS,
} from "@files/domain/services/subtitles/limits";
import { containerExtensionFor, isMissingAudioStreamError } from "@files/domain/services/media-edit";
import { loadSubtitleConfig, subtitleCapability } from "@files/infrastructure/subtitles/config";
import {
  OpenAiCompatibleTranscriber,
  SubtitleTranscriptionError,
} from "@files/infrastructure/subtitles/transcriber";
import {
  ChatCompletionTranslator,
  SubtitleTranslationError,
} from "@files/infrastructure/subtitles/translator";
import {
  claimTrack,
  getTrack,
  listCues,
  markTrackFailed,
  markTrackReady,
  replaceCues,
  setTrackLanguage,
  setTrackProgress,
  upsertTrack,
} from "@files/infrastructure/subtitles/tracks";
import { translateCues } from "./translate-cues";

/**
 * The two subtitle jobs, as the worker runs them.
 *
 * Thin on purpose. Everything with a decision in it has already been decided and tested somewhere
 * else — the ffmpeg argument list, the segment manifest, the chunk offsets, the hallucination
 * filter, the retry ladder, the quota window — and what is left here is the order things happen in
 * and what to write down when one of them fails. That split is deliberate: this is the layer that
 * needs a database, ffmpeg, R2 and a paid API to exercise, so as little judgement as possible
 * lives in it.
 *
 * Three properties hold across both jobs:
 *
 *  - **A job claims its track first.** `claimTrack` only moves a row out of `queued`/`processing`,
 *    so a duplicate BullMQ delivery, or a job for a track somebody deleted, does nothing at all.
 *    Nothing here is billed before that claim succeeds.
 *  - **A failure is written to the row, not just thrown.** The user is looking at a menu entry, so
 *    every path that gives up leaves a `failureCode` and a sentence behind. Errors are re-thrown
 *    afterwards only when a retry could plausibly help.
 *  - **Money is spent after the cheap refusals.** ffmpeg runs before the quota check because the
 *    real duration is not knowable until the audio is segmented, and ffmpeg time is this server's
 *    own. The first paid call happens after the account has been debited.
 */

type Deps = {
  /** Stream an R2 object to a local path without buffering it. */
  downloadToFile: (key: string, destination: string) => Promise<void>;
  /** Run ffmpeg with an argv array. Must reject with `{ stderr }` on a non-zero exit. */
  runFfmpeg: (args: string[]) => Promise<void>;
  /** A path inside the worker's temporary directory. */
  tmpPath: (name: string) => string;
  log: (message: string) => void;
};

/** How long the last chunk's tail carried into the next request may be. */
const CARRY_OVER_CHARS = 220;

/** Share of a transcription job's progress bar spent before the first API call. */
const PREPARE_PROGRESS = 8;

async function fs() {
  return import("fs/promises");
}

/**
 * Retry a provider call that failed in a way that might not fail again.
 *
 * Rate limits and 5xx are transient and are worth a wait; a 401, a 402 or a 400 are facts about
 * the configuration and are returned immediately, because retrying a dead key three times only
 * delays telling the user. The provider's own `Retry-After` is honoured where it sent one.
 */
async function withProviderRetry<T>(attempt: () => Promise<T>, log: Deps["log"]): Promise<T> {
  const maxAttempts = 3;
  for (let tries = 1; ; tries += 1) {
    try {
      return await attempt();
    } catch (error) {
      const status =
        error instanceof SubtitleTranscriptionError || error instanceof SubtitleTranslationError
          ? error.status
          : undefined;
      const transient = status === undefined || status === 429 || status >= 500;
      if (!transient || tries >= maxAttempts) throw error;

      const suggested =
        error instanceof SubtitleTranscriptionError || error instanceof SubtitleTranslationError
          ? error.retryAfterMs
          : undefined;
      const waitMs = Math.min(suggested ?? 2_000 * 2 ** (tries - 1), 60_000);
      log(`subtitles: provider said ${status ?? "no status"}, retrying in ${waitMs}ms`);
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

/** The English name of a language, for a prompt. `null` when the tag means nothing to us. */
function englishName(tag: string | null): string | null {
  if (!tag || tag === UNDETERMINED_LANGUAGE) return null;
  return findSubtitleLanguage(tag)?.english ?? null;
}

async function notify(
  fileId: string,
  trackId: string,
  language: string,
  ready: boolean
): Promise<void> {
  const [row] = await db.select({ userId: files.userId }).from(files).where(eq(files.id, fileId)).limit(1);
  if (!row) return;
  await publishToUser(row.userId, {
    type: ready ? "subtitle_ready" : "subtitle_failed",
    fileId,
    trackId,
    language,
  });
}

/**
 * Cut the audio into transcribable chunks, trying each encoding in turn.
 *
 * Returns the manifest and the encoding that produced it. A video with no audio track is a fact
 * about the file rather than a fault: the first encoder fails, every other one would fail the same
 * way, so the attempt stops instead of working through the ladder and then retrying the job.
 */
async function segmentAudio(
  input: { trackId: string; sourceKey: string; mimeType: string },
  deps: Deps
): Promise<
  | { ok: true; target: AsrAudioTarget; segments: AudioSegment[]; paths: string[]; cleanup: string[] }
  | { ok: false; reason: "no-audio" | "ffmpeg"; message: string; cleanup: string[] }
> {
  const nodeFs = await fs();
  const inputExtension = containerExtensionFor(input.mimeType) ?? "bin";
  const tmpIn = deps.tmpPath(`${input.trackId}-src.${inputExtension}`);
  const cleanup = [tmpIn];

  await deps.downloadToFile(input.sourceKey, tmpIn);

  let lastMessage = "ffmpeg produced no audio";
  for (const target of ASR_AUDIO_TARGETS) {
    const prefix = deps.tmpPath(input.trackId);
    const listPath = deps.tmpPath(`${input.trackId}-segments.csv`);
    cleanup.push(listPath);
    try {
      await deps.runFfmpeg(
        buildSubtitleAudioArgs({
          inputPath: tmpIn,
          outputPattern: chunkPattern(prefix, target.extension),
          listPath,
          target,
        })
      );
      const segments = parseSegmentList(await nodeFs.readFile(listPath, "utf8"));
      if (segments.length === 0) throw new Error("ffmpeg wrote no segments");
      // Paths are recomputed from the index rather than read out of the manifest — see
      // `chunkName` for why that is the safer of the two.
      const paths = segments.map((_, index) => chunkName(prefix, index, target.extension));
      return { ok: true, target, segments, paths, cleanup: [...cleanup, ...paths] };
    } catch (error) {
      const stderr = String((error as { stderr?: unknown }).stderr ?? "");
      if (isMissingAudioStreamError(stderr)) {
        return { ok: false, reason: "no-audio", message: "This video has no audio track.", cleanup };
      }
      lastMessage = stderr.slice(0, 400) || (error as Error).message || lastMessage;
    }
  }
  return { ok: false, reason: "ffmpeg", message: lastMessage, cleanup };
}

export type TranscribeMediaInput = {
  trackId: string;
  /** Languages the user asked to watch in. Any that match the detected audio are skipped. */
  targets: string[];
};

/**
 * Turn a video's audio into a transcript track, then queue the translations it was asked for.
 *
 * The translations are queued *here* rather than by the route because only this job knows what
 * language the audio turned out to be — asking for Indonesian subtitles on an Indonesian video
 * should produce one track, not a translation of a language into itself.
 */
export async function runTranscribeMedia(
  input: TranscribeMediaInput,
  deps: Deps
): Promise<void> {
  const track = await claimTrack(input.trackId);
  if (!track) {
    deps.log(`transcribe_media ${input.trackId}: not claimable, nothing to do`);
    return;
  }

  const [file] = await db
    .select({
      id: files.id,
      userId: files.userId,
      r2Key: files.r2Key,
      mimeType: files.mimeType,
      encrypted: files.encrypted,
      deletedAt: files.deletedAt,
    })
    .from(files)
    .where(eq(files.id, track.fileId))
    .limit(1);

  if (!file || file.deletedAt) {
    await markTrackFailed(input.trackId, {
      code: "FILE_GONE",
      message: "The video was removed before its subtitles were made.",
    });
    return;
  }
  // The route refuses this, so a job carrying it is stale rather than an attack.
  if (file.encrypted) {
    await markTrackFailed(input.trackId, {
      code: "ENCRYPTED",
      message: "This file is encrypted in the browser, so the server cannot read its audio.",
    });
    return;
  }

  const config = await loadSubtitleConfig(db, true);
  const capability = subtitleCapability(config);
  if (!capability.canTranscribe) {
    await markTrackFailed(input.trackId, {
      code: "NOT_CONFIGURED",
      message: "Subtitles are not configured on this server.",
    });
    await notify(track.fileId, track.id, track.language, false);
    return;
  }

  const nodeFs = await fs();
  let cleanup: string[] = [];

  try {
    await setTrackProgress(input.trackId, PREPARE_PROGRESS);

    const prepared = await segmentAudio(
      { trackId: input.trackId, sourceKey: file.r2Key, mimeType: file.mimeType },
      deps
    );
    cleanup = prepared.cleanup;
    if (!prepared.ok) {
      await markTrackFailed(input.trackId, {
        code: prepared.reason === "no-audio" ? "NO_AUDIO" : "AUDIO_FAILED",
        message:
          prepared.reason === "no-audio"
            ? prepared.message
            : "The video's audio could not be prepared for transcription.",
      });
      await notify(track.fileId, track.id, track.language, false);
      return;
    }

    const durationSeconds = totalSegmentSeconds(prepared.segments);
    if (durationSeconds > SUBTITLE_MAX_DURATION_SECONDS) {
      await markTrackFailed(input.trackId, {
        code: "TOO_LONG",
        message: `This video is longer than the ${Math.round(
          SUBTITLE_MAX_DURATION_SECONDS / 3600
        )}-hour limit for subtitles.`,
      });
      await notify(track.fileId, track.id, track.language, false);
      return;
    }

    // Debited before the first paid call, against the length that was actually measured.
    try {
      await recordSubtitleSeconds(file.userId, durationSeconds);
    } catch (error) {
      if (error instanceof SubtitleQuotaError) {
        await markTrackFailed(input.trackId, {
          code: "QUOTA_EXCEEDED",
          message: "This month's subtitle allowance is used up.",
        });
        await notify(track.fileId, track.id, track.language, false);
        return;
      }
      throw error;
    }

    const transcriber = new OpenAiCompatibleTranscriber({
      apiKey: config.apiKey!,
      baseUrl: config.baseUrl,
      model: config.model,
    });

    // A language the caller asserted wins over detection; `und` means nobody has said yet.
    const requested = track.language === UNDETERMINED_LANGUAGE ? null : track.language;
    let detected: string | null = requested;
    let carryOver = "";
    const chunks: { offsetMs: number; cues: Awaited<ReturnType<typeof listCues>> }[] = [];

    for (const [index, segment] of prepared.segments.entries()) {
      const bytes = await nodeFs.readFile(prepared.paths[index]);
      const result = await withProviderRetry(
        () =>
          transcriber.transcribe({
            audio: new Uint8Array(bytes),
            fileName: segment.file,
            mimeType: prepared.target.mimeType,
            language: requested,
            // What was just said, so a name keeps its spelling across the cut.
            prompt: carryOver,
          }),
        deps.log
      );

      if (!detected) detected = result.language;
      chunks.push({ offsetMs: Math.round(segment.startSeconds * 1000), cues: result.cues });
      carryOver = result.cues
        .slice(-3)
        .map((cue) => cue.text)
        .join(" ")
        .slice(-CARRY_OVER_CHARS);

      // The transcription half owns 8→85; translation takes it the rest of the way.
      const share = (index + 1) / prepared.segments.length;
      await setTrackProgress(input.trackId, PREPARE_PROGRESS + share * (85 - PREPARE_PROGRESS));
    }

    const cues = normalizeCues(mergeChunkTranscripts(chunks));
    await replaceCues(input.trackId, cues);

    const language = detected ?? UNDETERMINED_LANGUAGE;
    if (language !== track.language) await setTrackLanguage(input.trackId, language);
    await markTrackReady(input.trackId, {
      language,
      cueCount: cues.length,
      durationSeconds,
      provider: config.provider,
      model: config.model,
    });
    await notify(track.fileId, track.id, language, true);
    deps.log(
      `transcribe_media ${input.trackId}: ${cues.length} cues, ${Math.round(durationSeconds)}s, ${language}`
    );

    // Now that the source language is known, queue only the translations that mean something.
    const wanted = input.targets.filter((target) => target !== language);
    if (wanted.length > 0 && !capability.canTranslate) {
      deps.log(`transcribe_media ${input.trackId}: translation not configured, skipping targets`);
      return;
    }
    for (const target of wanted) {
      const translated = await upsertTrack({
        fileId: track.fileId,
        language: target,
        origin: "translated",
        translatedFromId: input.trackId,
        createdBy: track.createdBy,
      });
      const queued = await enqueueJob("translate_subtitles", { trackId: translated.id });
      if (!queued) {
        await markTrackFailed(translated.id, {
          code: "QUEUE_UNAVAILABLE",
          message: "The background worker could not be reached. Try again in a few minutes.",
        });
      }
    }
  } catch (error) {
    const message =
      error instanceof SubtitleTranscriptionError
        ? error.message
        : "Transcription failed unexpectedly.";
    await markTrackFailed(input.trackId, { code: "TRANSCRIBE_FAILED", message });
    await notify(track.fileId, track.id, track.language, false);
    // Re-thrown so BullMQ records the failure and applies its own backoff. The row already says
    // what happened, so a retry that succeeds simply overwrites it.
    throw error;
  } finally {
    for (const path of cleanup) {
      await nodeFs.unlink(path).catch(() => {});
    }
  }
}

/**
 * Translate one track into another language.
 *
 * Timings are copied from the source, never recomputed — the lines are the same lines, said at the
 * same moments. `normalizeCues` runs again afterwards because the *text* changed: a translation is
 * a different length, so how long it needs to be on screen to be readable is a different number.
 */
export async function runTranslateSubtitles(
  input: { trackId: string },
  deps: Deps
): Promise<void> {
  const track = await claimTrack(input.trackId);
  if (!track) {
    deps.log(`translate_subtitles ${input.trackId}: not claimable, nothing to do`);
    return;
  }

  const sourceId = track.translatedFromId;
  if (!sourceId) {
    await markTrackFailed(input.trackId, {
      code: "NO_SOURCE",
      message: "There is no transcript to translate from.",
    });
    return;
  }

  const source = await getTrack(sourceId);
  const sourceCues = source ? await listCues(sourceId) : [];
  if (!source || sourceCues.length === 0) {
    await markTrackFailed(input.trackId, {
      code: "SOURCE_EMPTY",
      message: "The transcript this would be translated from is missing or empty.",
    });
    await notify(track.fileId, track.id, track.language, false);
    return;
  }

  const config = await loadSubtitleConfig(db, true);
  if (!subtitleCapability(config).canTranslate) {
    await markTrackFailed(input.trackId, {
      code: "NOT_CONFIGURED",
      message: "Translation is not configured on this server.",
    });
    await notify(track.fileId, track.id, track.language, false);
    return;
  }

  const targetName = englishName(track.language);
  if (!targetName) {
    await markTrackFailed(input.trackId, {
      code: "UNKNOWN_LANGUAGE",
      message: "That language is not one this server can translate into.",
    });
    await notify(track.fileId, track.id, track.language, false);
    return;
  }

  const translator = new ChatCompletionTranslator({
    apiKey: config.translateApiKey!,
    baseUrl: config.translateBaseUrl,
    model: config.translateModel,
  });

  try {
    const result = await translateCues({
      cues: sourceCues,
      sourceLanguage: englishName(source.language),
      targetLanguage: targetName,
      // The retry ladder inside `translateCues` handles replies that do not parse; this wrapper
      // handles the transport failing. Keeping them separate is what lets the ladder treat a
      // throw as fatal.
      complete: (message) => withProviderRetry(() => translator.complete(message), deps.log),
      // Translation owns the back half of the bar the transcription left at 85.
      onProgress: (fraction) => setTrackProgress(input.trackId, 85 + fraction * 15),
    });

    const cues = normalizeCues(result.cues);
    await replaceCues(input.trackId, cues);
    await markTrackReady(input.trackId, {
      cueCount: cues.length,
      durationSeconds: source.durationSeconds,
      provider: "translate",
      model: config.translateModel,
    });
    await notify(track.fileId, track.id, track.language, true);
    deps.log(
      `translate_subtitles ${input.trackId}: ${cues.length} cues into ${track.language}` +
        `, glossary ${result.glossary.length}` +
        (result.degradedBatches > 0 ? `, ${result.degradedBatches} batches line-by-line` : "") +
        (result.untranslatedLines > 0 ? `, ${result.untranslatedLines} lines left as source` : "")
    );
  } catch (error) {
    const message =
      error instanceof SubtitleTranslationError ? error.message : "Translation failed unexpectedly.";
    await markTrackFailed(input.trackId, { code: "TRANSLATE_FAILED", message });
    await notify(track.fileId, track.id, track.language, false);
    throw error;
  }
}
