import type { SubtitleCue } from "./vtt";

/**
 * Turning accurate timings into readable ones.
 *
 * Speech recognition is good at *when* words were said and has no opinion about how long a
 * line should sit on screen. Those are different questions, and the gap between them is what
 * separates subtitles that work from subtitles that merely exist: a one-word answer gets a
 * 300 ms cue nobody can read, a pause gets a thirty-second cue that stops being about
 * anything, and the same sentence appears twice where two audio chunks met.
 *
 * **A cue's start is never moved.** It is the one number tying text to sound, so every
 * adjustment in this file is made by trimming or extending an end. A pass that shifted starts
 * to resolve a collision would fix one cue and desynchronise every cue after it — which is
 * why the overlap rule below trims the *earlier* cue rather than delaying the later one.
 */

/** Shortest a cue may hold the screen. Below this it reads as a flash rather than a line. */
export const MIN_CUE_MS = 700;

/**
 * Longest a single cue may hold the screen.
 *
 * Whisper emits one long cue across silence fairly often. Left alone it leaves a sentence
 * sitting over a scene it has nothing to do with, which is worse than no subtitle at all.
 */
export const MAX_CUE_MS = 7_000;

/** Gap left between neighbouring cues so a change of line is visible as a change. */
export const MIN_GAP_MS = 40;

/** Characters a viewer gets through per second. The industry figure is 17–21; this is the middle. */
export const READING_CPS = 20;

/** Widest line worth rendering. Longer and the eye has to travel instead of read. */
export const MAX_CHARS_PER_LINE = 42;

/**
 * How close two identical lines have to be before they are one line said once.
 *
 * The carry-over prompt tells each audio chunk what was said just before it, and Whisper
 * sometimes opens by repeating it. It also repeats a line over silence. Both look the same
 * from here — the same text, back to back, with no real pause — and both should be one cue.
 * A repetition after a genuine pause is dialogue and is left alone.
 */
const REPEAT_GAP_MS = 1_500;

/** Whitespace-insensitive identity, which is what "the same line" means in practice. */
function repeatKey(text: string): string {
  return text.trim().replace(/\s+/g, " ");
}

function safeMs(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

/**
 * Cues made watchable: in order, non-overlapping, each on screen long enough to read and no
 * longer than it has any business being.
 *
 * The single forward pass is deliberate. Each cue's end is decided against three things at
 * once — how much text it holds, the ceiling, and where the next cue starts — and the next
 * cue's start is already fixed, so nothing here can cascade. Runs after
 * {@link mergeChunkTranscripts} and after any translation, because a translated line has a
 * different length and therefore needs a different amount of time.
 */
export function normalizeCues(cues: readonly SubtitleCue[]): SubtitleCue[] {
  const cleaned = cues
    .map((cue) => ({
      startMs: safeMs(cue.startMs),
      endMs: safeMs(cue.endMs),
      text: cue.text.trim(),
    }))
    .filter((cue) => cue.text.length > 0)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  return cleaned.map((cue, index) => {
    // The time this much text needs, which is the floor for how long it stays up.
    const needed = Math.max(MIN_CUE_MS, Math.ceil((cue.text.length / READING_CPS) * 1_000));
    let endMs = Math.max(cue.endMs, cue.startMs + needed);
    endMs = Math.min(endMs, cue.startMs + MAX_CUE_MS);

    const next = cleaned[index + 1];
    if (next) {
      // The earlier cue gives way. Never below a millisecond, so a pair sharing a start
      // still produces two cues rather than one zero-length one.
      endMs = Math.min(endMs, Math.max(cue.startMs + 1, next.startMs - MIN_GAP_MS));
    }
    endMs = Math.max(endMs, cue.startMs + 1);

    return { idx: index, startMs: cue.startMs, endMs, text: cue.text };
  });
}

/** One transcribed audio chunk, and where in the original media it began. */
export type TranscriptChunk = {
  offsetMs: number;
  cues: readonly SubtitleCue[];
};

/**
 * One transcript from several chunks.
 *
 * Each chunk was transcribed on its own and so counts from zero; `offsetMs` is where it
 * really started, measured from the chunk file rather than assumed from the requested segment
 * length — segment boundaries land on packets, not on round seconds, and an assumed offset
 * drifts a little further out with every chunk.
 *
 * Timings are left exactly as they arrive apart from the offset. Readability is
 * {@link normalizeCues}' job, and doing it here would mean doing it twice for a translated
 * track.
 */
export function mergeChunkTranscripts(chunks: readonly TranscriptChunk[]): SubtitleCue[] {
  const merged: SubtitleCue[] = [];
  for (const chunk of chunks) {
    const offset = safeMs(chunk.offsetMs);
    for (const cue of chunk.cues) {
      const startMs = offset + safeMs(cue.startMs);
      const endMs = offset + safeMs(cue.endMs);
      const text = cue.text.trim();
      if (text.length === 0) continue;

      const previous = merged[merged.length - 1];
      if (
        previous &&
        repeatKey(previous.text) === repeatKey(text) &&
        startMs - previous.endMs <= REPEAT_GAP_MS
      ) {
        // Said once, transcribed twice. Keep the span, drop the duplicate.
        previous.endMs = Math.max(previous.endMs, endMs);
        continue;
      }

      merged.push({ idx: merged.length, startMs, endMs, text });
    }
  }
  return merged;
}

/** Greedy fill, for text too long to sit on two lines however it is broken. */
function greedyWrap(words: readonly string[], limit: number): string[] {
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    if (current.length === 0) current = word;
    else if (current.length + 1 + word.length <= limit) current = `${current} ${word}`;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * One line broken into two of roughly equal length.
 *
 * Balanced rather than greedy because greedy produces a full line and a stub, and a stub
 * reads as a mistake. The break lands on the word boundary nearest the middle; a script that
 * does not separate words (Chinese, Japanese) is broken at the middle character instead,
 * which is what those scripts do anyway.
 */
function balanceTwoLines(text: string): string[] {
  const middle = Math.floor(text.length / 2);
  const boundaries: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === " ") boundaries.push(i);
  }
  if (boundaries.length === 0) {
    return [text.slice(0, middle), text.slice(middle)];
  }
  const at = boundaries.reduce((best, position) =>
    Math.abs(position - middle) < Math.abs(best - middle) ? position : best
  );
  return [text.slice(0, at), text.slice(at + 1)];
}

/**
 * A cue's text laid out for the overlay.
 *
 * Breaks the writer already put in are kept — a two-speaker cue means those two lines — and
 * each of them is laid out on its own. A single word longer than a whole line is emitted
 * over-long rather than broken or dropped: a URL or a compound noun cut in half is unreadable
 * in a different and worse way, and losing part of it is not on the table.
 */
export function wrapCueText(text: string, limit: number = MAX_CHARS_PER_LINE): string {
  return text
    .split("\n")
    .flatMap((line) => {
      const trimmed = line.trim();
      if (trimmed.length <= limit) return [trimmed];
      if (trimmed.length <= limit * 2) return balanceTwoLines(trimmed);
      const words = trimmed.split(/[ \t]+/).filter((word) => word.length > 0);
      return words.length > 1 ? greedyWrap(words, limit) : [trimmed];
    })
    .join("\n");
}

/**
 * Which cue covers this instant, or `-1`.
 *
 * Half-open on purpose: a cue owns its start and releases the screen at its end, so two
 * neighbours a millisecond apart never both claim to be showing. Used by the editor to follow
 * the playhead — the player's own `cuechange` event drives the overlay.
 */
export function activeCueIndex(cues: readonly SubtitleCue[], atMs: number): number {
  if (!Number.isFinite(atMs)) return -1;
  let low = 0;
  let high = cues.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const cue = cues[mid];
    if (atMs < cue.startMs) high = mid - 1;
    else if (atMs >= cue.endMs) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Every cue moved by the same amount, for a track whose sync is uniformly off.
 *
 * This is the one operation that DOES move starts, and it is the exception that proves the
 * rule: the user is telling us the whole track is early or late, which is the only case where
 * moving a start makes it more correct rather than less. A cue dragged before the beginning
 * stops at zero rather than going negative, and never inverts.
 */
export function shiftCues(cues: readonly SubtitleCue[], deltaMs: number): SubtitleCue[] {
  const delta = Number.isFinite(deltaMs) ? Math.round(deltaMs) : 0;
  return cues.map((cue, index) => {
    const startMs = Math.max(0, cue.startMs + delta);
    return {
      idx: index,
      startMs,
      endMs: Math.max(startMs + 1, cue.endMs + delta),
      text: cue.text,
    };
  });
}
