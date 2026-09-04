import { describe, expect, it } from "vitest";
import {
  BITS_PER_WORD,
  PASSPHRASE_WORDLIST,
  WORDLIST_SIZE,
} from "@backup/domain/wordlist";

/**
 * The wordlist, checked for the properties its own comment claims.
 *
 * Every assertion here guards a silent failure. A duplicate word costs entropy and
 * nothing throws. A 501st word makes `randomInt(512)` unable to reach it and quietly
 * biases nothing — but a 511-word list would make one index unreachable and the "9
 * bits per word" claim false. A shared four-letter prefix breaks the promise that a
 * human can disambiguate a smudged transcription against this file. None of these
 * would fail a build, a lint or a round-trip test; they fail here or nowhere.
 *
 * Design: docs/superpowers/specs/2026-09-01-backup-design.md §6.5.
 */

const words = [...PASSPHRASE_WORDLIST];

describe("the list is exactly the size the entropy claim needs", () => {
  it("has 512 words, which is 2^9", () => {
    expect(words).toHaveLength(512);
    expect(WORDLIST_SIZE).toBe(512);
    expect(BITS_PER_WORD).toBe(9);
    // The constant and the array must not drift: `randomInt(WORDLIST_SIZE)` indexes
    // this array, so a smaller constant silently makes the tail unreachable and a
    // larger one returns `undefined` inside a passphrase.
    expect(2 ** BITS_PER_WORD).toBe(words.length);
    expect(WORDLIST_SIZE).toBe(PASSPHRASE_WORDLIST.length);
  });

  it("contains no word twice", () => {
    const seen = new Map<string, number>();
    for (const word of words) seen.set(word, (seen.get(word) ?? 0) + 1);

    // A duplicate is the one defect that costs real entropy while leaving every other
    // test in this repository green.
    expect([...seen].filter(([, count]) => count > 1)).toEqual([]);
    expect(new Set(words).size).toBe(512);
  });
});

describe("every word survives being written down at 3 a.m. and read back later", () => {
  it("is four to eight lowercase ASCII letters", () => {
    // No hyphens, no accents, no capitals: the passphrase is normalised to lowercase
    // before derivation, and a word that changes under NFKD would derive a different
    // key from the one the user was shown.
    expect(words.filter((word) => !/^[a-z]{4,8}$/.test(word))).toEqual([]);
    for (const word of words) {
      expect(word.normalize("NFKD")).toBe(word);
      expect(word.trim()).toBe(word);
    }
  });

  it("is identifiable from its first four letters alone", () => {
    const byPrefix = new Map<string, string[]>();
    for (const word of words) {
      const prefix = word.slice(0, 4);
      byPrefix.set(prefix, [...(byPrefix.get(prefix) ?? []), word]);
    }

    // The property a recovery depends on: "walr…" can only be `walrus`, so a
    // transcription that lost its tail is still unambiguous against this file.
    expect([...byPrefix.values()].filter((group) => group.length > 1)).toEqual([]);
    expect(byPrefix.size).toBe(512);
  });

  it("holds no word that is another word plus an s", () => {
    const set = new Set(words);

    // `beam`/`beams` in one list turns a misremembered plural into a valid-looking
    // passphrase that derives the wrong key.
    expect(words.filter((word) => set.has(`${word}s`))).toEqual([]);
  });

  it("is in ascending order, so it can be checked by eye", () => {
    expect(words).toEqual([...words].sort());
    expect(words[0]).toBe("able");
    expect(words[words.length - 1]).toBe("zipper");
  });

  it("spreads across the alphabet rather than clustering", () => {
    const initials = new Set(words.map((word) => word[0]));

    // Not a correctness property, but a list of 512 words beginning with four letters
    // would make a passphrase look wrong to the person holding it.
    expect(initials.size).toBeGreaterThanOrEqual(20);
  });
});
