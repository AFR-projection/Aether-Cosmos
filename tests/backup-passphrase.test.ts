import { describe, expect, it } from "vitest";
import {
  PASSPHRASE_BITS,
  PASSPHRASE_WORDS,
  generatePassphrase,
  isWellFormedPassphrase,
  normalizePassphrase,
} from "@backup/domain/passphrase";
import { PASSPHRASE_WORDLIST } from "@backup/domain/wordlist";

/**
 * The nine words, and the normalisation that has to survive being hand-copied.
 *
 * The contract this file exists to pin down is one identity: **the normalisation applied
 * when a recovery phrase is minted is the same one applied when a key is derived.** If
 * they ever diverge, every `.afrbak` written before the divergence stops opening under
 * its phrase, and nothing else in the system notices — the GCM tag simply fails and the
 * user is told their phrase is wrong.
 *
 * No key derivation happens here, deliberately: `tests/backup-account-keyslots.test.ts`
 * owns that half, where Argon2id runs at a cost a suite can afford and the round trip is
 * asserted end to end. This file is the other end of the same identity — that what the
 * generator emits is already in the form the deriver will normalise it to.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.2, §4.3.
 */

describe("a generated passphrase is the only kind there is", () => {
  it("is nine words from the list, and says so in bits", () => {
    const phrase = generatePassphrase();
    const words = phrase.split(" ");

    expect(PASSPHRASE_WORDS).toBe(9);
    expect(PASSPHRASE_BITS).toBe(81);
    expect(words).toHaveLength(9);
    for (const word of words) expect(PASSPHRASE_WORDLIST).toContain(word);
    // Single spaces and nothing else, because that is what gets hashed.
    expect(phrase).toBe(normalizePassphrase(phrase));
  });

  it("does not repeat itself across a hundred mints", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generatePassphrase()));

    // 81 bits: a collision here is not "unlikely", it is a broken generator.
    expect(seen.size).toBe(100);
  });

  it("draws from the whole list rather than a corner of it", () => {
    const drawn = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      for (const word of generatePassphrase().split(" ")) drawn.add(word);
    }

    // 3600 draws from 512 words: seeing fewer than 400 distinct ones would mean the
    // index draw is clamped or biased. The expected count is ~511.
    expect(drawn.size).toBeGreaterThan(400);
  });

  it("can be asked for a different length without changing the default", () => {
    expect(generatePassphrase(3).split(" ")).toHaveLength(3);
    expect(generatePassphrase().split(" ")).toHaveLength(PASSPHRASE_WORDS);
    // A short phrase is not well-formed, which is what stops a refactor shortening the
    // generator and nothing failing.
    expect(isWellFormedPassphrase(generatePassphrase(3))).toBe(false);
    expect(isWellFormedPassphrase(generatePassphrase())).toBe(true);
  });
});

describe("normalisation forgives the retyping, and only the retyping", () => {
  const phrase = "able about above acid acorn acre actor adapt adopt";

  it("collapses the damage a note taken by hand does", () => {
    for (const typed of [
      "  able about above acid acorn acre actor adapt adopt  ",
      "able  about   above acid acorn acre actor adapt adopt",
      "ABLE About above ACID acorn acre actor adapt adopt",
      "able\tabout above acid acorn acre actor adapt adopt\n",
      "able\nabout above acid acorn acre actor adapt adopt",
    ]) {
      expect(normalizePassphrase(typed)).toBe(phrase);
    }
  });

  it("is idempotent, which is what lets it run at both ends", () => {
    // Mint normalises, then derive normalises again. A non-idempotent function would
    // make the second pass produce a different key from the first.
    expect(normalizePassphrase(normalizePassphrase(phrase))).toBe(phrase);
  });

  it("does not forgive a different word", () => {
    expect(normalizePassphrase("able about above acid acorn acre actor adapt adult")).not.toBe(
      phrase
    );
    expect(isWellFormedPassphrase("able about above acid acorn acre actor adapt frobnicate")).toBe(
      false
    );
  });

  it("leaves an empty answer empty rather than inventing one", () => {
    expect(normalizePassphrase("   ")).toBe("");
    expect(isWellFormedPassphrase("")).toBe(false);
  });
});
