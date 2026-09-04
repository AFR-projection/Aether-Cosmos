import { z } from "zod";

/**
 * What a folder or file may be called.
 *
 * A name is not just a label here. Folder names are concatenated into
 * `materialized_path` (`/parent/child/`), and that string is what every subtree
 * query matches on — rename, move, trash, restore, and the paste/copy walk all
 * select by path prefix. A name containing `/` therefore forges a path: a folder
 * called `a/b` at the root produces `/a/b/`, which is indistinguishable from a
 * genuine `b` inside a genuine `a`, so trashing one sweeps rows belonging to the
 * other. The same names are also the entry paths inside a ZIP export, where a
 * separator escapes the directory it was supposed to be written into.
 *
 * So the rules below are about keeping a name a name. They are deliberately not a
 * full Windows charset: `:`, `*`, `?`, `"`, `<`, `>` and `|` are illegal on
 * Windows but harmless in the database, in R2 and in a ZIP, and refusing them
 * would reject names people already use. What is rejected is what breaks the
 * tree, breaks the export, or lies about itself on screen.
 */

/** `.` and `..` are how a path says "here" and "up one" — never a folder. */
const RELATIVE_SEGMENTS = new Set([".", ".."]);

/**
 * Bidirectional overrides and invisible marks, written as escapes so this file
 * stays readable in an editor that would otherwise honour them.
 *
 * U+202E (right-to-left override) is the filename-spoofing character: a name
 * ending `<U+202E>gnp.exe` renders as `exe.png` in the file list and on every
 * share page, so a download button can describe itself as an image while handing
 * over a program. U+200B and U+FEFF are here for a duller reason — a zero-width
 * space makes two rows look identical while sorting and matching treat them apart.
 *
 * U+200C and U+200D are deliberately absent: the zero-width non-joiner and joiner
 * are load-bearing in Arabic, Persian and Indic scripts and in emoji sequences, so
 * banning them would reject legitimate names.
 */
const INVISIBLE_OR_BIDI = new RegExp(
  "[\\u200B\\u200E\\u200F\\u202A-\\u202E\\u2066-\\u2069\\uFEFF]"
);

/** Includes NUL, which Postgres answers with a 500 rather than a 400. */
// eslint-disable-next-line no-control-regex -- control characters are the subject
const CONTROL_CHARS = new RegExp("[\\u0000-\\u001F\\u007F]");

export const ENTITY_NAME_MAX = 255;

export type EntityNameCheck = { ok: true; name: string } | { ok: false; reason: string };

/**
 * Trim first, then judge — Explorer does the same, and a trailing space is a slip
 * rather than an intention. It also collapses the trailing-whitespace case into
 * one rule, leaving only the trailing dot to test for below.
 */
export function checkEntityName(raw: string): EntityNameCheck {
  const name = raw.trim();

  if (!name) {
    return { ok: false, reason: "Name can't be empty." };
  }
  if (name.length > ENTITY_NAME_MAX) {
    return { ok: false, reason: `Name can't be longer than ${ENTITY_NAME_MAX} characters.` };
  }
  if (name.includes("/") || name.includes("\\")) {
    return { ok: false, reason: "Name can't contain a slash or backslash." };
  }
  if (CONTROL_CHARS.test(name)) {
    return { ok: false, reason: "Name can't contain control characters." };
  }
  if (INVISIBLE_OR_BIDI.test(name)) {
    return { ok: false, reason: "Name can't contain invisible or text-direction characters." };
  }
  if (RELATIVE_SEGMENTS.has(name)) {
    return { ok: false, reason: 'Name can\'t be "." or "..".' };
  }
  // Windows silently drops a trailing dot, so `notes.` and `notes` unzip into the
  // same entry and one of the two is lost on extraction.
  if (name.endsWith(".")) {
    return { ok: false, reason: "Name can't end with a dot." };
  }

  return { ok: true, name };
}

/**
 * The same rules as a Zod field, so a route gets the trimmed value and a 400
 * without an extra branch. Routes holding a name their schema cannot type (a
 * PATCH whose `name` is only required for the rename action) call
 * `checkEntityName` directly instead.
 */
export const entityNameSchema = z
  .string()
  .min(1)
  // Room for surrounding whitespace that trims away, not for a longer name:
  // `checkEntityName` applies ENTITY_NAME_MAX after the trim.
  .max(ENTITY_NAME_MAX * 2)
  .transform((value) => value.trim())
  .superRefine((value, ctx) => {
    const result = checkEntityName(value);
    if (!result.ok) {
      ctx.addIssue({ code: "custom", message: result.reason });
    }
  });
