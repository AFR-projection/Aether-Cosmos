import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";

import { openArchive, writeArchive, type AfrWriteInput } from "@backup/account/domain/archive";
import { AccountBackupNotConfiguredError } from "@backup/account/domain/errors";
import { type AfrArgon2Params } from "@backup/account/domain/format";
import { newAccountBackupId } from "@backup/account/domain/identity";
import {
  deriveRecoveryWrappingKey,
  newDek,
  parseMasterKeyRing,
  type AfrKeyRing,
} from "@backup/account/domain/keys";
import { encodeFilesEntry } from "@backup/account/domain/index-entries";
import { derivePerFilePhrase } from "@backup/account/domain/per-file-phrase";
import type { AfrSummary } from "@backup/account/domain/summary";
import { isWellFormedPassphrase, PASSPHRASE_WORDS } from "@backup/domain/passphrase";
import { PASSPHRASE_WORDLIST } from "@backup/domain/wordlist";
import { KDF_SALT_BYTES } from "@backup/domain/types";

/**
 * One phrase per archive, derived from the master key and the download's ticket.
 *
 * The suite exists because two separate HTTP requests have to agree on nine words with nothing
 * stored between them: `prepare` shows them in a dialog, and the download — a browser navigation
 * seconds later — has to seal keyslot 1 under the same ones. Three properties make that safe, and
 * each is a test below.
 *
 * **Determinism, but only for the same ticket.** The same `(masterKey, ticketId)` always gives the
 * same words, which is what lets a download that died at 90% be re-navigated inside the ticket's
 * 90-second window and still open with the phrase already written down. A different ticket, or a
 * different master key, gives unrelated words — so no two archives share a phrase, and losing one
 * costs exactly one file.
 *
 * **The words are real words.** A derivation that silently produced eight of them, or drew outside
 * the wordlist, would be a weaker phrase that no other test would notice: the archive would still
 * write, and the user would still be handed something to copy down.
 *
 * **It opens the file with no server state at all.** The last test is the disaster this feature is
 * for — a rebuilt VPS with a fresh `BACKUP_MASTER_KEY`, a ring that has never held the archive's
 * key, and the nine words as the only way in.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.3, §6.2.
 */

/** The format's Argon2 floor. Production pays a second per guess; this suite pays milliseconds. */
const CHEAP_ARGON2: AfrArgon2Params = { m: 8 * 1024, t: 1, p: 1 };

/**
 * Two pinned master keys.
 *
 * A digest rather than `Buffer.alloc(32, 0xa1)`, because `parseMasterKeyRing` refuses a constant
 * byte sequence outright — it is guarding operators against a hand-typed key, and a test that
 * dodged the guard would be building rings no real server could hold. Pinned rather than random so
 * that "the same inputs give the same nine words" is a claim about the derivation and not about
 * this file.
 */
function pinnedKey(seed: string): Buffer {
  return createHash("sha256").update(seed).digest();
}

const MASTER_A = pinnedKey("afrbak-per-file-phrase-test:master-a");
const MASTER_B = pinnedKey("afrbak-per-file-phrase-test:master-b");
const TICKET_A = "6f1c8e10-0000-4000-8000-000000000001";
const TICKET_B = "6f1c8e10-0000-4000-8000-000000000002";

function ringOf(active: Buffer): AfrKeyRing {
  return parseMasterKeyRing({ BACKUP_MASTER_KEY: active.toString("base64") });
}

describe("the same ticket derives the same phrase", () => {
  it("gives identical words and salt for one (master key, ticketId)", () => {
    const first = derivePerFilePhrase(MASTER_A, TICKET_A);
    const second = derivePerFilePhrase(MASTER_A, TICKET_A);

    // This is the retry path: `prepare` computed the first, the download the second.
    expect(second.phrase).toBe(first.phrase);
    expect(second.phraseSalt.equals(first.phraseSalt)).toBe(true);
  });

  it("gives unrelated words for a different ticket", () => {
    const first = derivePerFilePhrase(MASTER_A, TICKET_A);
    const second = derivePerFilePhrase(MASTER_A, TICKET_B);

    expect(second.phrase).not.toBe(first.phrase);
    expect(second.phraseSalt.equals(first.phraseSalt)).toBe(false);
  });

  it("gives unrelated words for a different master key", () => {
    const here = derivePerFilePhrase(MASTER_A, TICKET_A);
    const elsewhere = derivePerFilePhrase(MASTER_B, TICKET_A);

    // Two instances that happened to mint the same ticket id must not agree on a phrase.
    expect(elsewhere.phrase).not.toBe(here.phrase);
    expect(elsewhere.phraseSalt.equals(here.phraseSalt)).toBe(false);
  });

  it("never reuses the word stream as the salt", () => {
    // Separate HMAC labels, so a nine-word phrase and a 16-byte salt cannot be the same bytes.
    const { phrase, phraseSalt } = derivePerFilePhrase(MASTER_A, TICKET_A);
    const fromWords = Buffer.from(phrase, "utf8").subarray(0, KDF_SALT_BYTES);

    expect(phraseSalt.equals(fromWords)).toBe(false);
  });

  it("spreads across the wordlist over many tickets", () => {
    // A stuck counter or a constant-folded HMAC would show up here as a handful of words.
    const drawn = new Set<string>();
    for (let i = 0; i < 60; i += 1) {
      for (const word of derivePerFilePhrase(MASTER_A, randomUUID()).phrase.split(" ")) {
        drawn.add(word);
      }
    }

    expect(drawn.size).toBeGreaterThan(200);
  });
});

describe("what it hands the dialog", () => {
  it("is nine words, all from the wordlist", () => {
    const { phrase, words, bits } = derivePerFilePhrase(MASTER_A, TICKET_A);
    const split = phrase.split(" ");

    expect(split).toHaveLength(PASSPHRASE_WORDS);
    expect(split.every((word) => PASSPHRASE_WORDLIST.includes(word))).toBe(true);
    expect(isWellFormedPassphrase(phrase)).toBe(true);
    // Metadata for the dialog's "9 words / 81 bits" line, never a gate.
    expect(words).toBe(PASSPHRASE_WORDS);
    expect(bits).toBe(81);
  });

  it("is a salt of exactly the length the header reserves", () => {
    expect(derivePerFilePhrase(MASTER_A, TICKET_A).phraseSalt).toHaveLength(KDF_SALT_BYTES);
  });

  it("refuses a master key of the wrong length", () => {
    // `parseMasterKeyRing` has already rejected this, so it is a refactor guard rather than an
    // operator error — but a 16-byte key silently halving the phrase's strength is worth a throw.
    expect(() => derivePerFilePhrase(randomBytes(16), TICKET_A)).toThrow(
      AccountBackupNotConfiguredError
    );
  });

  it("refuses an empty ticketId", () => {
    expect(() => derivePerFilePhrase(MASTER_A, "")).toThrow(AccountBackupNotConfiguredError);
  });
});

describe("the archive it seals opens on a rebuilt server", () => {
  it("gets the payload back from the nine words alone", async () => {
    const ticketId = randomUUID();
    const recovery = derivePerFilePhrase(MASTER_A, ticketId);
    const payload = randomBytes(4096);
    const index = encodeFilesEntry({
      kind: "file",
      path: "photos/2026/beach.jpg",
      size: payload.length,
      sha256: createHash("sha256").update(payload).digest(),
      mime: "image/jpeg",
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_500_000,
    });
    const summary: AfrSummary = {
      accountBackupId: newAccountBackupId(),
      appVersion: "1.4.2",
      counts: { folders: 0, files: 1, memories: 0, rows: 1 },
      schemaVersion: 28,
      sourceInstanceId: "afr-vps-1",
      totalBytes: payload.length,
    };

    // Exactly what `GET /api/backup/takeout/[ticket]` builds, with the cost dialled down.
    const input: AfrWriteInput = {
      domain: "files",
      backupId: randomUUID(),
      createdAt: 1_772_000_000_000,
      masterKey: ringOf(MASTER_A).active,
      dek: newDek(),
      recoveryWrappingKey: await deriveRecoveryWrappingKey(
        recovery.phrase,
        recovery.phraseSalt,
        CHEAP_ARGON2
      ),
      phraseSalt: recovery.phraseSalt,
      argon2: CHEAP_ARGON2,
      summary,
      index,
      payload: [payload],
      chunkSize: 64 * 1024,
    };

    const written: Buffer[] = [];
    const gen = writeArchive(input);
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      written.push(step.value);
    }

    // A ring that has never held `MASTER_A`: new VPS, new install, empty database.
    const stranger = ringOf(MASTER_B);
    const reader = await openArchive({
      source: [Buffer.concat(written)],
      ring: stranger,
      expectedDomain: "files",
      phrase: recovery.phrase,
    });

    expect(reader.via).toBe("phrase");
    await reader.skipIndex();
    const chunks: Buffer[] = [];
    for await (const chunk of reader.readPayload()) chunks.push(chunk);
    await reader.finish();
    expect(Buffer.concat(chunks).equals(payload)).toBe(true);
  });

  it("refuses the phrase from another ticket", async () => {
    const mine = derivePerFilePhrase(MASTER_A, TICKET_A);
    const theirs = derivePerFilePhrase(MASTER_A, TICKET_B);
    const payload = randomBytes(1024);
    const input: AfrWriteInput = {
      domain: "files",
      backupId: randomUUID(),
      createdAt: 1_772_000_000_000,
      masterKey: ringOf(MASTER_A).active,
      dek: newDek(),
      recoveryWrappingKey: await deriveRecoveryWrappingKey(
        mine.phrase,
        mine.phraseSalt,
        CHEAP_ARGON2
      ),
      phraseSalt: mine.phraseSalt,
      argon2: CHEAP_ARGON2,
      summary: {
        accountBackupId: newAccountBackupId(),
        appVersion: "1.4.2",
        counts: { folders: 0, files: 0, memories: 0, rows: 0 },
        schemaVersion: 28,
        sourceInstanceId: "afr-vps-1",
        totalBytes: payload.length,
      },
      index: Buffer.alloc(0),
      payload: [payload],
      chunkSize: 64 * 1024,
    };

    const written: Buffer[] = [];
    const gen = writeArchive(input);
    for (;;) {
      const step = await gen.next();
      if (step.done) break;
      written.push(step.value);
    }

    // Nine words from the wordlist, and wrong — the GCM tag on keyslot 1 is what says so.
    await expect(
      openArchive({
        source: [Buffer.concat(written)],
        ring: ringOf(MASTER_B),
        expectedDomain: "files",
        phrase: theirs.phrase,
      })
    ).rejects.toThrow();
  });
});
