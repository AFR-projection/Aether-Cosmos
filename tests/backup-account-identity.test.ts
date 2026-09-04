import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_BACKUP_ID_BYTES,
  ACCOUNT_BACKUP_ID_CHARS,
  ACCOUNT_BACKUP_ID_RE,
  ACCOUNT_IDENTITY_SOURCES,
  ACCOUNT_OWNER_PREFIX,
  accountOwnerKey,
  decodeAccountBackupId,
  encodeAccountBackupId,
  formatAccountBackupId,
  isAccountIdentitySource,
  isBoundIdentity,
  newAccountBackupId,
  normalizeAccountBackupId,
  parseAccountOwnerKey,
  shortAccountBackupId,
  tryNormalizeAccountBackupId,
} from "@backup/account/domain/identity";
import { AccountBackupError, AfrCorruptError } from "@backup/account/domain/errors";
import { BackupValidationError } from "@backup/domain/errors";
import { parseOwnerKey } from "@backup/domain/naming";

/**
 * The identity an archive is addressed to.
 *
 * The tests here are about one property with two faces: an identity has exactly one
 * spelling, and a human may type any of several. Everything that reaches the database
 * or the encrypted summary must be the canonical 52 characters, and everything a person
 * might paste — the display form, lowercase, a stray space, an `O` where a zero belongs
 * — must arrive at that same value or at `null`.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §3.
 */

const USER_ID = "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60";

/**
 * The specific reason, which lives in `detail` and never in `message`.
 *
 * Every refusal in this feature carries one generic sentence for the user and the
 * technical reason in `detail`. A test that asserted on `message` would pass for any
 * refusal at all, which is the opposite of what it was written to check.
 */
function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

describe("32 bytes, spelled one way", () => {
  it("mints 52 canonical characters", () => {
    const id = newAccountBackupId();

    expect(id).toHaveLength(ACCOUNT_BACKUP_ID_CHARS);
    expect(id).toMatch(ACCOUNT_BACKUP_ID_RE);
  });

  it("mints a different one every time", () => {
    const minted = new Set(Array.from({ length: 500 }, () => newAccountBackupId()));

    expect(minted.size).toBe(500);
  });

  it("survives a byte-for-byte round trip", () => {
    for (let i = 0; i < 200; i += 1) {
      const bytes = randomBytes(ACCOUNT_BACKUP_ID_BYTES);
      expect(decodeAccountBackupId(encodeAccountBackupId(bytes)).equals(bytes)).toBe(true);
    }
  });

  it("never uses the four letters a human misreads", () => {
    const alphabet = new Set(
      Array.from({ length: 300 }, () => newAccountBackupId()).join("").split("")
    );

    for (const confusable of ["I", "L", "O", "U"]) {
      expect(alphabet.has(confusable)).toBe(false);
    }
  });

  it("ends on a character whose padding bits are zero", () => {
    // 256 bits do not fill 52 base32 characters. The last one carries a single data bit,
    // so exactly two spellings are canonical there, and every other one is malleability.
    for (let i = 0; i < 200; i += 1) {
      expect(["0", "G"]).toContain(newAccountBackupId().slice(-1));
    }
  });

  it("refuses the wrong number of bytes rather than encoding them", () => {
    expect(() => encodeAccountBackupId(randomBytes(31))).toThrow(AfrCorruptError);
    expect(detailOf(() => encodeAccountBackupId(randomBytes(33)))).toContain("needs 32");
  });

  it("encodes the two ends of the range to known text", () => {
    expect(encodeAccountBackupId(Buffer.alloc(32, 0))).toBe("0".repeat(52));
    // 255 of the 256 bits fill 51 `Z`s; the 256th is the one data bit of the last
    // character, shifted up past four zero padding bits, which is index 16.
    expect(encodeAccountBackupId(Buffer.alloc(32, 0xff))).toBe(`${"Z".repeat(51)}G`);
  });
});

describe("what a human may type, and what it must become", () => {
  const id = newAccountBackupId();

  it("takes the display form back to canonical", () => {
    expect(normalizeAccountBackupId(formatAccountBackupId(id))).toBe(id);
  });

  it("takes lowercase, spaces, and a copy-pasted line break", () => {
    expect(tryNormalizeAccountBackupId(id.toLowerCase())).toBe(id);
    expect(tryNormalizeAccountBackupId(`  ${id}\n`)).toBe(id);
    expect(tryNormalizeAccountBackupId(id.replace(/(.{4})/g, "$1 "))).toBe(id);
    expect(tryNormalizeAccountBackupId(`AFR ${id}`)).toBe(id);
  });

  it("folds the letters Crockford folds", () => {
    // A `0` read aloud as "oh" and typed as `O` has to land on the same identity.
    const typed = id.replace(/0/g, "O").replace(/1/g, "l");

    expect(tryNormalizeAccountBackupId(typed)).toBe(id);
  });

  it("refuses a spelling that is not canonical after folding", () => {
    expect(tryNormalizeAccountBackupId("")).toBeNull();
    expect(tryNormalizeAccountBackupId(id.slice(0, 51))).toBeNull();
    expect(tryNormalizeAccountBackupId(`${id}0`)).toBeNull();
    // `U` is not in the alphabet and is not folded onto anything.
    expect(tryNormalizeAccountBackupId(`U${id.slice(1)}`)).toBeNull();
  });

  it("refuses a final character carrying non-zero padding bits", () => {
    const malleable = `${id.slice(0, 51)}1`;

    expect(malleable).toMatch(ACCOUNT_BACKUP_ID_RE);
    expect(tryNormalizeAccountBackupId(malleable)).toBeNull();
  });

  it("throws on the archive path, where a bad value is a damaged file", () => {
    expect(() => normalizeAccountBackupId("not-an-id")).toThrow(AfrCorruptError);
    expect(detailOf(() => normalizeAccountBackupId("not-an-id"))).toContain(
      "52 canonical base32"
    );
  });

  it("groups the display form into thirteen fours behind the prefix", () => {
    const display = formatAccountBackupId(id);

    expect(display.startsWith("AFR-")).toBe(true);
    expect(display.split("-")).toHaveLength(14);
    expect(display.split("-").slice(1).every((group) => group.length === 4)).toBe(true);
    expect(display.replace(/-/g, "")).toBe(`AFR${id}`);
  });

  it("shortens to something recognisable but not retypable", () => {
    expect(shortAccountBackupId(id)).toBe(`AFR-${id.slice(0, 4)}-${id.slice(4, 8)}…`);
    expect(shortAccountBackupId(id)).toHaveLength(14);
  });
});

describe("two backup features, one primary key, no collision", () => {
  it("spells an account row afrbak:user:<uuid>", () => {
    expect(ACCOUNT_OWNER_PREFIX).toBe("afrbak:user:");
    expect(accountOwnerKey(USER_ID)).toBe(`${ACCOUNT_OWNER_PREFIX}${USER_ID}`);
  });

  it("lowercases the uuid, so one account cannot hold two rows", () => {
    expect(accountOwnerKey(USER_ID.toUpperCase())).toBe(accountOwnerKey(USER_ID));
  });

  it("refuses a value that is not a uuid instead of building a key from it", () => {
    expect(() => accountOwnerKey("")).toThrow(AfrCorruptError);
    expect(() => accountOwnerKey("9c1f6a3e0d2b4a779f0e1b2c3d4e5f60")).toThrow(AfrCorruptError);
    expect(() => accountOwnerKey(`${USER_ID} `)).toThrow(AfrCorruptError);
    expect(detailOf(() => accountOwnerKey("nope"))).toContain("needs a uuid");
  });

  it("says how long the rejected value was and never what it said", () => {
    const detail = detailOf(() => accountOwnerKey("drop table users"));

    expect(detail).not.toContain("drop table users");
    expect(detail).toContain("16 characters");
  });

  it("round trips back to the user id", () => {
    expect(parseAccountOwnerKey(accountOwnerKey(USER_ID))).toBe(USER_ID);
    expect(parseAccountOwnerKey(`${ACCOUNT_OWNER_PREFIX}${USER_ID.toUpperCase()}`)).toBe(USER_ID);
  });

  it("returns null for a key that belongs to the other namespace", () => {
    expect(parseAccountOwnerKey(`user:${USER_ID}`)).toBeNull();
    expect(parseAccountOwnerKey("system")).toBeNull();
    expect(parseAccountOwnerKey(`${ACCOUNT_OWNER_PREFIX}not-a-uuid`)).toBeNull();
    expect(parseAccountOwnerKey("")).toBeNull();
  });

  it("is refused outright by the whole-instance backup's parser", () => {
    // What the distinct prefix buys. If an account-backup row ever reached the system
    // backup's repository, it would throw rather than be mistaken for one of its own —
    // and the two features seal their secrets under different keys, so a silent match
    // would look like "the recovery phrase stopped working".
    expect(() => parseOwnerKey(accountOwnerKey(USER_ID))).toThrow(BackupValidationError);
    // And the reverse direction: the system backup's own per-user spelling is not ours.
    expect(parseOwnerKey(`user:${USER_ID}`).userId).toBe(USER_ID);
  });
});

describe("how an identity came to be bound", () => {
  it("names exactly generated and adopted", () => {
    expect(ACCOUNT_IDENTITY_SOURCES).toEqual(["generated", "adopted"]);
  });

  it("recognises those two and nothing else", () => {
    for (const source of ACCOUNT_IDENTITY_SOURCES) {
      expect(isAccountIdentitySource(source)).toBe(true);
    }
    for (const other of ["GENERATED", "Adopted", "imported", "system", ""]) {
      expect(isAccountIdentitySource(other)).toBe(false);
    }
  });
});

describe("does this archive already belong to the caller", () => {
  const mine = newAccountBackupId();
  const adopted = newAccountBackupId();
  const bound = [{ accountBackupId: mine }, { accountBackupId: adopted }];

  it("finds either of the ids this account has bound", () => {
    expect(isBoundIdentity(mine, bound)).toBe(true);
    expect(isBoundIdentity(adopted, bound)).toBe(true);
  });

  it("compares canonically, so a pasted display form still matches", () => {
    expect(isBoundIdentity(formatAccountBackupId(mine), bound)).toBe(true);
    expect(isBoundIdentity(`  ${mine.toLowerCase()}  `, bound)).toBe(true);
  });

  it("says no to a stranger's archive, which is what demands the phrase", () => {
    expect(isBoundIdentity(newAccountBackupId(), bound)).toBe(false);
    expect(isBoundIdentity(mine, [])).toBe(false);
  });

  it("treats a bound row that will not normalise as a miss, not a wildcard", () => {
    // A hand-edited database row must not match everything. It fails to normalise, so
    // it fails to match, and the restore falls through to the typed recovery phrase.
    expect(isBoundIdentity(mine, [{ accountBackupId: `${mine.slice(0, 51)}1` }])).toBe(false);
    expect(isBoundIdentity(mine, [{ accountBackupId: "" }])).toBe(false);
    expect(isBoundIdentity(mine, [{ accountBackupId: mine.slice(0, 51) }])).toBe(false);
  });

  it("throws when the archive's own id is not an identity at all", () => {
    // This side came out of a decrypted summary: a bad value there is damage, not a typo.
    expect(() => isBoundIdentity("not-an-id", bound)).toThrow(AfrCorruptError);
  });
});
