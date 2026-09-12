/**
 * Preparing a video's soundtrack for speech recognition, in one ffmpeg call.
 *
 * Nothing about this is a re-encode for the user's benefit — the output is a temporary file a
 * transcription API reads and nobody ever listens to — so every choice here is made against
 * upload size and against the recogniser, not against fidelity:
 *
 *  - **Mono, 16 kHz.** Whisper and everything OpenAI-compatible resamples to exactly that
 *    internally. Sending 48 kHz stereo means paying to upload samples the model discards.
 *  - **Opus at 24 kbps.** Speech at 24 kbps is transparent enough that word error rate does
 *    not move, and it makes a two-hour film about 21 MB instead of 170. Chunking already keeps
 *    each request under any provider's ceiling; this keeps the whole job cheap on a small VPS's
 *    disk and uplink.
 *  - **`-segment_list`.** The reason this file exists at all. ffmpeg is asked to write down
 *    where each chunk actually starts and ends, because a chunk asked to be 600 seconds is
 *    600.02 — cuts land on packet boundaries — and a transcript assembled from assumed offsets
 *    drifts further out of sync with every chunk. It also means no `ffprobe` process is needed:
 *    one call produces both the audio and the timeline.
 *
 * The arg builders are pure and pinned by tests for the same reason `buildTrimArgs` in
 * `../media-edit.ts` is: an argument list that disagrees with what the worker expects produces
 * a file that is subtly wrong rather than a job that fails.
 */

/** Length of one transcription chunk. Long enough to give the model context, short enough that
 *  one failed request is a small retry and progress moves visibly on a feature-length film. */
export const ASR_CHUNK_SECONDS = 600;

/** What every Whisper-family model resamples to. Sending more is wasted upload. */
export const ASR_SAMPLE_RATE = 16_000;

/** One candidate encoding for the chunks: the encoder to ask for, and the file it produces. */
export type AsrAudioTarget = {
  /** Passed to ffmpeg's `-c:a`. */
  readonly encoder: string;
  /** Quality flags belonging to that encoder. */
  readonly encoderArgs: readonly string[];
  /** Also picks the segment muxer — ffmpeg chooses it from the output pattern's extension. */
  readonly extension: string;
  /** Sent as the multipart part's content type. */
  readonly mimeType: string;
};

/**
 * The encodings a job will try, best first.
 *
 * Opus first for size. libmp3lame second because a handful of ffmpeg builds ship without
 * libopus, and AAC last because that encoder is part of ffmpeg itself rather than an external
 * library, so it is the one that is always present — the same fallback ladder, and the same
 * reasoning, as `AUDIO_EXTRACT_TARGETS` in `../media-edit.ts`.
 *
 * Every container here is one an OpenAI-compatible `/audio/transcriptions` endpoint accepts.
 * That constraint is why raw ADTS (`.aac`) is not the AAC target even though it segments more
 * simply: the providers take `.m4a` and do not take `.aac`.
 */
export const ASR_AUDIO_TARGETS: readonly AsrAudioTarget[] = [
  {
    encoder: "libopus",
    // `voip` tunes the encoder for a single voice, which is what a dialogue track is.
    encoderArgs: ["-b:a", "24k", "-application", "voip"],
    extension: ".ogg",
    mimeType: "audio/ogg",
  },
  {
    encoder: "libmp3lame",
    // -q:a 7 is VBR around 48 kbps: well past what 16 kHz mono speech needs.
    encoderArgs: ["-q:a", "7"],
    extension: ".mp3",
    mimeType: "audio/mpeg",
  },
  {
    encoder: "aac",
    encoderArgs: ["-b:a", "48k"],
    extension: ".m4a",
    mimeType: "audio/mp4",
  },
];

/**
 * The ffmpeg invocation that turns a video into transcription-ready chunks plus a manifest.
 *
 * `-map 0:a:0` rather than a bare `-vn`: it takes exactly one track, so a film with a
 * commentary track does not produce a doubled transcript, and — more usefully — it *fails* on a
 * video with no audio instead of writing silent chunks that cost money to transcribe into
 * nothing. `isMissingAudioStreamError` in `../media-edit.ts` recognises that failure.
 *
 * `-reset_timestamps 1` makes every chunk start its clock at zero, which is what each chunk is
 * transcribed as. The offsets to add back come from the segment list, never from `chunkSeconds`.
 */
export function buildSubtitleAudioArgs(input: {
  inputPath: string;
  /** printf-style, e.g. `/tmp/abc-%03d.ogg`. Its extension picks the muxer. */
  outputPattern: string;
  /** Where ffmpeg writes the CSV manifest that {@link parseSegmentList} reads back. */
  listPath: string;
  target: AsrAudioTarget;
  chunkSeconds?: number;
}): string[] {
  const chunk = Math.max(30, Math.round(input.chunkSeconds ?? ASR_CHUNK_SECONDS));
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-i",
    input.inputPath,
    "-vn",
    "-sn",
    "-dn",
    "-map",
    "0:a:0",
    "-ac",
    "1",
    "-ar",
    String(ASR_SAMPLE_RATE),
    "-c:a",
    input.target.encoder,
    ...input.target.encoderArgs,
    "-f",
    "segment",
    "-segment_time",
    String(chunk),
    "-reset_timestamps",
    "1",
    "-segment_list",
    input.listPath,
    "-segment_list_type",
    "csv",
    "-y",
    input.outputPattern,
  ];
}

/** One chunk, and where it sits on the original media's timeline. */
export type AudioSegment = {
  /** As ffmpeg wrote it: the bare filename, without the directory. */
  readonly file: string;
  readonly startSeconds: number;
  readonly endSeconds: number;
};

/**
 * ffmpeg's CSV segment manifest, read back.
 *
 * Each line is `filename,start,end` with the times in seconds. A line that is not that shape is
 * skipped rather than treated as a failure: the manifest is machine-written, so a malformed line
 * means a truncated write, and recovering the chunks that ARE described is better than
 * abandoning a transcription that has already been paid for in ffmpeg time.
 */
export function parseSegmentList(csv: string): AudioSegment[] {
  const segments: AudioSegment[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const parts = line.trim().split(",");
    if (parts.length < 3) continue;
    const file = parts[0].trim();
    const startSeconds = Number(parts[1]);
    const endSeconds = Number(parts[2]);
    if (file.length === 0) continue;
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds)) continue;
    segments.push({ file, startSeconds, endSeconds });
  }
  return segments;
}

/** The media's length, taken from where the last chunk ended. `0` when there are no chunks. */
export function totalSegmentSeconds(segments: readonly AudioSegment[]): number {
  return segments.reduce((longest, segment) => Math.max(longest, segment.endSeconds), 0);
}

/** Zero-padding width in the output pattern. Four digits is 10,000 chunks — 69 days of audio. */
const CHUNK_INDEX_DIGITS = 4;

/**
 * Each prepare work item (one 600-second range) yields at most a handful of ffmpeg segments,
 * and audio-chunk rows must stay unique per `(run, ordinal)`. Segment ordinals are therefore
 * `workItemOrdinal * AUDIO_CHUNK_ORDINAL_SCALE + segmentIndex`.
 */
export const AUDIO_CHUNK_ORDINAL_SCALE = 1000;

/**
 * The printf-style pattern ffmpeg writes its chunks to.
 *
 * `%04d` and nothing else: the segment muxer substitutes the index, and the extension is what
 * chooses the muxer, so both halves of the filename are load-bearing.
 */
export function chunkPattern(prefix: string, extension: string): string {
  return `${prefix}-%0${CHUNK_INDEX_DIGITS}d${extension}`;
}

/**
 * The name {@link chunkPattern} produces for one index.
 *
 * The worker reconstructs each chunk's path from its position rather than reading it out of the
 * manifest, because whether the manifest records an absolute path or a bare filename depends on
 * the pattern it was handed — and parsing that back is guesswork where recomputing it is not. The
 * two functions are therefore pinned against each other by `audio-extract.test.ts`.
 */
export function chunkName(prefix: string, index: number, extension: string): string {
  return `${prefix}-${String(index).padStart(CHUNK_INDEX_DIGITS, "0")}${extension}`;
}
