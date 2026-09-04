import { createHmac } from "node:crypto";

import { PASSPHRASE_BITS, PASSPHRASE_WORDS } from "@backup/domain/passphrase";
import { PASSPHRASE_WORDLIST, WORDLIST_SIZE } from "@backup/domain/wordlist";
import { KDF_SALT_BYTES, KEY_BYTES } from "@backup/domain/types";
import { AccountBackupNotConfiguredError } from "./errors";

/**
 * One recovery phrase per archive, derived rather than stored.
 *
 * ```
 * BACKUP_MASTER_KEY ──HMAC──▶ nine words  ──Argon2id──▶ RWK ──▶ keyslot[1]
 *      + ticketId       └────▶ phraseSalt ──────┘                    │
 *                                   └── written into the header ─────┘
 * ```
 *
 * **Why derived and not random.** The phrase has to be shown in a dialog *before* the download
 * starts — a phrase revealed after the bytes are already in the Downloads folder is a phrase the
 * user has no reason to write down, which is the failure this design exists to prevent. But the
 * download is a separate GET (a browser navigation), so something has to survive between the two
 * requests. Storing it would mean a row, or a Redis key, and both are a place where key material
 * lives at rest for the express purpose of being read back. Deriving it means the second request
 * recomputes the same nine words from two things it already has: this server's master key, and
 * the `ticketId` the ticket carries in plain sight.
 *
 * **Why `BACKUP_MASTER_KEY` is the right secret to derive from.** The phrase exists so an archive
 * outlives this server. Someone who holds the master key can already open keyslot 0 of every
 * archive it wrote, so being able to recompute keyslot 1's phrase as well grants them nothing
 * they did not have. Deriving from `SESSION_SECRET` instead would be strictly worse: it rotates
 * casually (§4.1), and a leaked app secret plus an nginx access log full of ticket URLs would
 * become a way into archives whose master key never leaked.
 *
 * **Every archive gets different words.** `ticketId` is a fresh uuid per `prepare`, so two
 * downloads are two phrases even for the same account on the same day. Nothing is shared between
 * archives, and losing one phrase costs exactly one file — which is the whole reason this replaced
 * the single per-account phrase that could only ever be shown once.
 *
 * **The same ticket derives the same phrase, on purpose.** A ticket is valid for 90 seconds and is
 * not single-use (`domain/ticket.ts` says so and explains why that is safe). So a download that
 * dies at 90% and is re-navigated within the window produces a second archive — different DEK,
 * different nonces — whose keyslot 1 still opens with the words already written down. A one-time
 * carrier would have turned that retry into a file nobody can open.
 *
 * Nothing here touches the database, the environment, or the network: the master key arrives as a
 * parameter so a test can pin every byte, and the same inputs always give the same nine words.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §4.3, §6.2.
 */

/** Distinct labels so the words and the salt cannot ever be the same bytes. */
const PHRASE_LABEL = "afrbak-per-file-phrase:v1";
const SALT_LABEL = "afrbak-per-file-salt:v1";

/**
 * The largest multiple of the wordlist size that fits in 16 bits.
 *
 * With 512 words this is 65536 exactly, so no draw is ever rejected and the loop below runs
 * `PASSPHRASE_WORDS` times. It is written as a rejection bound anyway because the wordlist is
 * allowed to grow: at 500 words a bare `% 500` would quietly favour the first 36 entries, and a
 * biased passphrase generator is the kind of bug that never fails a test.
 */
const REJECT_AT = Math.floor(0x1_0000 / WORDLIST_SIZE) * WORDLIST_SIZE;

export interface PerFileRecoveryPhrase {
  /** The nine words, single-spaced. Shown once, in a dialog, before the download begins. */
  phrase: string;
  /** Argon2id salt for {@link deriveRecoveryWrappingKey}; travels in the archive header. */
  phraseSalt: Buffer;
  /** Metadata for the dialog. Never a gate. */
  words: number;
  bits: number;
}

/**
 * An unbounded byte stream from one (key, label, ticketId), in HMAC counter mode.
 *
 * A single HMAC-SHA256 block is 32 bytes, which already covers nine 16-bit draws and a 16-byte
 * salt, so in practice the counter never advances past 0. It exists so raising
 * `PASSPHRASE_WORDS` is a one-line change rather than a silent truncation.
 */
function prfReader(masterKey: Buffer, label: string, ticketId: string): (n: number) => Buffer {
  let pending = Buffer.alloc(0);
  let counter = 0;
  return (n) => {
    while (pending.length < n) {
      const block = createHmac("sha256", masterKey)
        .update(`${label}:${counter}:${ticketId}`, "utf8")
        .digest();
      pending = Buffer.concat([pending, block]);
      counter += 1;
    }
    const out = Buffer.from(pending.subarray(0, n));
    pending = pending.subarray(n);
    return out;
  };
}

/**
 * The nine words and the salt this archive's keyslot 1 is built from.
 *
 * `masterKey` is `ring.active.key` — the *active* entry, never a retired one, because this is a
 * write path and an archive must not be sealed under a key that is already being phased out.
 * Callers pass `payload.ticketId` on the download side and the id they are about to mint the
 * ticket with on the prepare side; those two being the same string is what makes the dialog and
 * the file agree.
 */
export function derivePerFilePhrase(masterKey: Buffer, ticketId: string): PerFileRecoveryPhrase {
  // Both are programming errors rather than operator errors — `parseMasterKeyRing` has already
  // rejected a short key and `mintTakeoutTicket` always sets a uuid — so they are guarded here
  // only so a refactor cannot turn either into a silently weaker phrase.
  if (masterKey.length !== KEY_BYTES) {
    throw new AccountBackupNotConfiguredError(
      `per-file phrase needs a ${KEY_BYTES}-byte master key, got ${masterKey.length}`
    );
  }
  if (ticketId.length === 0) {
    throw new AccountBackupNotConfiguredError("per-file phrase needs a ticketId");
  }

  const readWordBytes = prfReader(masterKey, PHRASE_LABEL, ticketId);
  const picked: string[] = [];
  while (picked.length < PASSPHRASE_WORDS) {
    const draw = readWordBytes(2).readUInt16BE(0);
    if (draw >= REJECT_AT) continue;
    picked.push(PASSPHRASE_WORDLIST[draw % WORDLIST_SIZE]);
  }

  return {
    phrase: picked.join(" "),
    phraseSalt: prfReader(masterKey, SALT_LABEL, ticketId)(KDF_SALT_BYTES),
    words: PASSPHRASE_WORDS,
    bits: PASSPHRASE_BITS,
  };
}
