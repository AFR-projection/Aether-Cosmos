/**
 * WebVTT and SubRip, read and written — the only two shapes timed text reaches this app in.
 *
 * A `<track>` element accepts WebVTT and nothing else, so everything served to a player
 * leaves through {@link cuesToVtt}. Files a user attaches arrive as either format, often
 * written by a tool that disagrees with the spec in some small way, so everything coming in
 * enters through {@link parseSubtitleFile}. The two have to agree: a `.vtt` exported from
 * here must be re-importable here, which `vtt.test.ts` pins as a round trip.
 *
 * Three properties of the formats drive nearly every decision below, and none of them is
 * obvious from the file you are looking at:
 *
 *  - **A blank line ends a cue.** In both formats. So cue text cannot contain one, and
 *    writing a cue whose text does would silently split it in two. They are collapsed.
 *  - **`-->` on a line makes it a timing line.** A cue whose text contained one would end
 *    the cue early and turn the rest of the sentence into a parse error. Escaping `>` as
 *    `&gt;` removes the possibility entirely and is lossless, which is why the writer
 *    escapes unconditionally rather than looking for the sequence.
 *  - **`&` and `<` open markup.** WebVTT reads `<i>` as italics and `&amp;` as an entity,
 *    so unescaped text would lose characters rather than merely look wrong.
 *
 * Parsing is deliberately generous and writing is deliberately strict: a file somebody else
 * produced is read for whatever can be recovered from it, and a file this app produces is
 * written so that no reader has to be generous.
 */

/**
 * One line of timed text.
 *
 * `idx` is the cue's position in its track, zero-based, and is always assigned by whoever
 * built the list — a file's own numbering is discarded on the way in, because a file that
 * numbers its cues 7 and 9 is describing its own history, not this track's order.
 */
export type SubtitleCue = {
  idx: number;
  startMs: number;
  endMs: number;
  text: string;
};

/** `83456` → `"00:01:23.456"`. Hours are always written: some parsers require the field. */
export function formatVttTimestamp(ms: number): string {
  const total = Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return (
    `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:` +
    `${String(seconds).padStart(2, "0")}.${String(millis).padStart(3, "0")}`
  );
}

/**
 * Both formats' timestamps, in milliseconds, or `null` for anything that is not one.
 *
 * The comma is SubRip's decimal separator and the full stop is WebVTT's; a file that mixes
 * them is common enough that treating them as the same character is the only workable rule.
 * The hours field is optional in WebVTT, and the fraction is padded rather than assumed to
 * be three digits — `00:00:01.5` means one and a half seconds, not one and five thousandths.
 */
export function parseTimestamp(value: string): number | null {
  const match = /^(?:(\d+):)?([0-5]?\d):([0-5]?\d)(?:[.,](\d{1,3}))?$/.exec(value.trim());
  if (!match) return null;
  const [, hours, minutes, seconds, fraction] = match;
  const millis = fraction ? Number(fraction.padEnd(3, "0")) : 0;
  return (
    Number(hours ?? 0) * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + millis
  );
}

/**
 * Entity references back to the characters they stand for.
 *
 * `&amp;` is undone LAST, which is what makes the pass reversible: text that literally read
 * `&lt;` was written as `&amp;lt;`, and undoing `&amp;` first would turn it into `<`.
 */
function unescapeCueText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&lrm;/g, "‎")
    .replace(/&rlm;/g, "‏")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

/** The inverse, with `&` first for the same reason. */
function escapeCueText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** A file split into blocks, with the line-ending and BOM differences already gone. */
function toBlocks(source: string): string[][] {
  const normalized = source
    // A BOM on the first line would otherwise make `WEBVTT` not match, and a leading
    // sequence number not parse as a number.
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n");
  return normalized
    .split(/\n[ \t]*\n+/)
    .map((block) => block.split("\n"))
    .filter((lines) => lines.some((line) => line.trim().length > 0));
}

/** Blocks that carry no dialogue, whatever else is in them. */
const METADATA_BLOCK = /^(NOTE|STYLE|REGION)\b/;

/**
 * Cues from a list of blocks, ignoring everything that is not one.
 *
 * A block's timing line is found rather than assumed to be first, because the line before
 * it may be a WebVTT cue identifier or a SubRip sequence number and there is no reliable way
 * to tell those apart — nor any reason to, since neither is kept. Everything after the
 * timing line is the text; a block with no timing line, or with no text, is not a cue.
 */
function cuesFromBlocks(blocks: string[][]): SubtitleCue[] {
  const cues: SubtitleCue[] = [];
  for (const lines of blocks) {
    if (METADATA_BLOCK.test(lines[0].trim())) continue;

    const timingAt = lines.findIndex((line) => line.includes("-->"));
    if (timingAt === -1) continue;

    const [rawStart, rawRest] = lines[timingAt].split("-->");
    if (rawRest === undefined) continue;
    const startMs = parseTimestamp(rawStart);
    // Cue settings (`line:90% align:center`) follow the end timestamp on the same line and
    // are dropped: this app positions its own text, so honouring them would fight the
    // overlay rather than help it.
    const endMs = parseTimestamp(rawRest.trim().split(/[ \t]+/)[0] ?? "");
    if (startMs === null || endMs === null) continue;

    const text = lines
      .slice(timingAt + 1)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    // A cue with no text shows as a blank flash over the picture, which reads as a bug.
    if (text.length === 0) continue;

    cues.push({ idx: cues.length, startMs, endMs, text: unescapeCueText(text) });
  }
  return cues;
}

/** Cues from a WebVTT file. The header block is skipped; `NOTE`/`STYLE`/`REGION` are not cues. */
export function parseVtt(source: string): SubtitleCue[] {
  const blocks = toBlocks(source);
  const body = blocks.length > 0 && /^WEBVTT\b/.test(blocks[0][0].trim()) ? blocks.slice(1) : blocks;
  return cuesFromBlocks(body);
}

/** Cues from a SubRip file. Sequence numbers are read and discarded, never trusted as order. */
export function parseSrt(source: string): SubtitleCue[] {
  return cuesFromBlocks(toBlocks(source));
}

/**
 * Cues from whichever of the two formats this text is.
 *
 * The `WEBVTT` header is the only difference that matters at this level — the block parser
 * already accepts either decimal separator and either numbering convention — so the check is
 * for the header and the fallback is SubRip.
 */
export function parseSubtitleFile(source: string): SubtitleCue[] {
  return /^﻿?WEBVTT\b/.test(source) ? parseVtt(source) : parseSrt(source);
}

/**
 * A WebVTT file for a `<track>` element.
 *
 * Cues are numbered from one, as both formats conventionally do, so a served file reads the
 * same as one a person would write. The text is escaped and its blank lines collapsed, which
 * together make it impossible for cue content to be read as structure — see the note at the
 * top of this file for why that is not paranoia.
 */
export function cuesToVtt(cues: readonly SubtitleCue[]): string {
  const blocks = cues.map((cue, position) => {
    const text = escapeCueText(cue.text)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");
    return [
      String(position + 1),
      `${formatVttTimestamp(cue.startMs)} --> ${formatVttTimestamp(cue.endMs)}`,
      text,
      "",
    ].join("\n");
  });
  return `WEBVTT\n${blocks.length > 0 ? "\n" : ""}${blocks.join("\n")}`;
}
