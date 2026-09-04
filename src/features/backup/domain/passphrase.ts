import { randomInt } from "node:crypto";
import { BITS_PER_WORD, PASSPHRASE_WORDLIST, WORDLIST_SIZE } from "./wordlist";

/**
 * Passphrase generation.
 *
 * System-generated only — there is no user-chosen option, and that is the whole
 * argument for brute-force resistance holding up. A user-chosen passphrase is the
 * one case where a three-strikes lockout would *also* have failed, because the
 * second guess lands. Nine words from a 512-word list is 81 bits, and Argon2id at
 * m=256 MiB, t=4 makes each of those guesses cost about a second on hardware an
 * attacker actually has.
 *
 * Design: docs/superpowers/specs/2026-09-01-backup-design.md §6.5.
 */

/** Nine words → 81 bits. */
export const PASSPHRASE_WORDS = 9;

export const PASSPHRASE_BITS = PASSPHRASE_WORDS * BITS_PER_WORD;

/**
 * `randomInt` is rejection-sampled inside Node, so the distribution is uniform
 * even though 512 divides 2^32 evenly and a naive modulo would also have been
 * fine here. Using it anyway means the list can grow to a non-power-of-two size
 * later without this function quietly becoming biased.
 */
export function generatePassphrase(words = PASSPHRASE_WORDS): string {
  const picked: string[] = [];
  for (let i = 0; i < words; i += 1) {
    picked.push(PASSPHRASE_WORDLIST[randomInt(WORDLIST_SIZE)]);
  }
  return picked.join(" ");
}

/**
 * Collapse whitespace and case before deriving a key.
 *
 * The user retypes this from a note they wrote at 3 a.m., so a double space or a
 * trailing newline must not be the reason a restore fails. Applied identically at
 * mint time and at derive time — that identity is the whole contract, and it is
 * why this function exists rather than a `.trim()` at each call site.
 */
export function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize("NFKD").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Not a validity check on a *typed* passphrase — a wrong passphrase is caught by
 * the GCM tag and nothing else. This only guards our own generator against a
 * refactor that silently shortens the output.
 */
export function isWellFormedPassphrase(passphrase: string): boolean {
  const words = normalizePassphrase(passphrase).split(" ");
  return (
    words.length >= PASSPHRASE_WORDS &&
    words.every((w) => PASSPHRASE_WORDLIST.includes(w))
  );
}
