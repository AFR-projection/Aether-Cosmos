import { describe, expect, it } from "vitest";
import {
  AFR_BRAIN_ROW_CAP,
  AFR_FILE_ROW_CAP,
  AFR_FOLDER_ROW_CAP,
  MAX_APP_VERSION_CHARS,
  MAX_EMAIL_CHARS,
  MAX_SUMMARY_PLAINTEXT_BYTES,
  assertWithinRowCaps,
  decodeSummary,
  encodeSummary,
  rowCap,
  type AfrSummary,
} from "@backup/account/domain/summary";
import {
  AccountBackupError,
  AfrCorruptError,
  AfrTooLargeError,
} from "@backup/account/domain/errors";
import {
  formatAccountBackupId,
  newAccountBackupId,
} from "@backup/account/domain/identity";
import { MAX_SUMMARY_BYTES } from "@backup/account/domain/format";
import { GCM_TAG_BYTES } from "@backup/domain/types";

/**
 * SUMMARY — the preview, and the two numbers the cheap refusals are read from.
 *
 * The tests here defend three properties. The bytes are canonical, because the same
 * summary must always encode identically or the AAD it participates in stops matching.
 * Every field is re-derived from hostile bytes on the way back in, because a decoded
 * summary is the first thing a restore acts on. And the caps are policy, not shape: an
 * oversized count is refusal #8 with its two numbers, not #7 "damaged".
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.4, §11.
 */

/** Canonical: 32 zero bytes, whose base32 is 52 zeros. Fixed so bytes can be asserted. */
const FIXED_ID = "0".repeat(52);

function baseSummary(overrides: Partial<AfrSummary> = {}): AfrSummary {
  return {
    accountBackupId: FIXED_ID,
    appVersion: "1.4.2",
    counts: { folders: 12, files: 40, memories: 0, rows: 52 },
    schemaVersion: 27,
    sourceInstanceId: "afr-vps-1",
    totalBytes: 1_048_576,
    ...overrides,
  };
}

/** The refusal's reason, which lives in `detail`; `message` is one fixed sentence. */
function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error.detail;
    throw error;
  }
  throw new Error("expected a refusal, got a value");
}

/** Decoding something our own writer would never produce. */
function decodeRaw(value: unknown): AfrSummary {
  return decodeSummary(Buffer.from(JSON.stringify(value), "utf8"));
}

function rawSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...(JSON.parse(JSON.stringify(baseSummary())) as object), ...overrides };
}

describe("one summary, one spelling", () => {
  it("writes exactly these bytes for a known summary", () => {
    // A regression lock on canonical order. The SUMMARY's bytes are what its GCM tag
    // covers, so a reordering here would not be a cosmetic change — it would make every
    // archive written afterwards unreadable by the build that wrote the ones before.
    expect(encodeSummary(baseSummary()).toString("utf8")).toBe(
      `{"accountBackupId":"${FIXED_ID}","appVersion":"1.4.2","counts":{"files":40,` +
        `"folders":12,"memories":0,"rows":52},"schemaVersion":27,` +
        `"sourceInstanceId":"afr-vps-1","totalBytes":1048576}`
    );
  });

  it("round trips a files summary", () => {
    expect(decodeSummary(encodeSummary(baseSummary()))).toEqual(baseSummary());
  });

  it("round trips a brain summary carrying both optional fields", () => {
    const summary = baseSummary({
      counts: { folders: 0, files: 0, memories: 900, rows: 2_400 },
      dateRange: { from: 1_700_000_000_000, to: 1_770_000_000_000 },
      email: "someone@example.com",
    });

    expect(decodeSummary(encodeSummary(summary))).toEqual(summary);
  });

  it("leaves no trace of an optional field that has no value", () => {
    // Not `null`: absent. Otherwise "no address on file" and "an address that is empty"
    // would be two spellings of one state, and only one of them round trips.
    const text = encodeSummary(baseSummary()).toString("utf8");

    expect(text).not.toContain("dateRange");
    expect(text).not.toContain("email");
  });

  it("normalises the identity on the way in, so a pasted display form still lands", () => {
    const id = newAccountBackupId();
    const summary = baseSummary({ accountBackupId: formatAccountBackupId(id) });

    expect(decodeSummary(encodeSummary(summary)).accountBackupId).toBe(id);
  });

  it("caps its own output at the encrypted region's ceiling, minus the tag", () => {
    expect(MAX_SUMMARY_PLAINTEXT_BYTES).toBe(MAX_SUMMARY_BYTES - GCM_TAG_BYTES);
    expect(detailOf(() => encodeSummary(baseSummary({ email: "x".repeat(70_000) })))).toContain(
      `cap ${MAX_SUMMARY_PLAINTEXT_BYTES}`
    );
  });
});

describe("reading a summary a stranger wrote", () => {
  it("refuses bytes that are not JSON", () => {
    expect(() => decodeSummary(Buffer.from("not json", "utf8"))).toThrow(AfrCorruptError);
    expect(detailOf(() => decodeSummary(Buffer.from("[]", "utf8")))).toContain("not an object");
  });

  it("refuses a field this format does not have", () => {
    expect(detailOf(() => decodeRaw(rawSummary({ restoreTo: "other-user" })))).toContain(
      "restoreTo is not a field"
    );
  });

  it("never quotes an unknown key back into the audit trail", () => {
    // `detail` reaches `activity_logs`, and the key came out of the file. A newline in it
    // would otherwise write a line of its own.
    const detail = detailOf(() => decodeRaw(rawSummary({ "\n2026 admin deleted all": 1 })));

    expect(detail).not.toContain("\n");
    expect(detail).toContain("?2026?admin?deleted?all");
  });

  it("refuses a required field that is missing", () => {
    const raw = rawSummary();
    delete raw.totalBytes;

    expect(detailOf(() => decodeRaw(raw))).toContain("totalBytes is missing");
  });

  it("treats an optional field present as null as damage, not as absence", () => {
    expect(() => decodeRaw(rawSummary({ dateRange: null }))).toThrow(AfrCorruptError);
    expect(() => decodeRaw(rawSummary({ email: null }))).toThrow(AfrCorruptError);
  });

  it("refuses an identity that is well-formed but not canonical", () => {
    // Passes the character-class regex and still fails: the last character carries
    // padding bits that must be zero, so this is a second spelling of one identity.
    const malleable = `${"0".repeat(51)}1`;

    expect(detailOf(() => decodeRaw(rawSummary({ accountBackupId: malleable })))).toContain(
      "52 canonical base32"
    );
  });

  it("refuses an instance id outside its character class", () => {
    expect(() => decodeRaw(rawSummary({ sourceInstanceId: "afr vps 1" }))).toThrow(AfrCorruptError);
    expect(() => decodeRaw(rawSummary({ sourceInstanceId: "" }))).toThrow(AfrCorruptError);
    expect(() => decodeRaw(rawSummary({ sourceInstanceId: "x".repeat(65) }))).toThrow(
      AfrCorruptError
    );
  });

  it("bounds the two free-text fields by length, not by charset", () => {
    // A version string and an address hold whatever they hold; what is refused is a
    // length that no legitimate writer produces.
    expect(decodeRaw(rawSummary({ email: "ünïcode@example.com" })).email).toBe(
      "ünïcode@example.com"
    );
    expect(() => decodeRaw(rawSummary({ email: "x".repeat(MAX_EMAIL_CHARS + 1) }))).toThrow(
      AfrCorruptError
    );
    expect(() =>
      decodeRaw(rawSummary({ appVersion: "x".repeat(MAX_APP_VERSION_CHARS + 1) }))
    ).toThrow(AfrCorruptError);
  });

  it("refuses control and direction characters in free text", () => {
    const rtlOverride = String.fromCharCode(0x202e);

    expect(detailOf(() => decodeRaw(rawSummary({ appVersion: `1.4${rtlOverride}2` })))).toContain(
      "control or direction"
    );
    // NUL is the one Postgres answers with a 500 rather than a 400.
    const nul = String.fromCharCode(0);
    expect(() => decodeRaw(rawSummary({ email: `a${nul}b@example.com` }))).toThrow(
      AfrCorruptError
    );
    // A space, though, is content: a version string holds one and this is not a charset.
    expect(decodeRaw(rawSummary({ appVersion: "1.4.2 (build 9)" })).appVersion).toBe(
      "1.4.2 (build 9)"
    );
  });
});

describe("numbers that must agree with each other", () => {
  it("refuses a total below its own parts", () => {
    // The one arithmetic lie worth catching: `rows` is what the caps and the quota are
    // read from, so a `rows` smaller than the counts it summarises means the two numbers
    // did not come from the same walk over the same tables.
    const detail = detailOf(() =>
      decodeRaw(rawSummary({ counts: { files: 40, folders: 12, memories: 0, rows: 51 } }))
    );

    expect(detail).toContain("below its own parts 52");
  });

  it("allows a total above its parts, which is normal", () => {
    // A brain archive's `rows` counts tags, links and agents too, and a files archive's
    // counts nothing extra — so equal or greater are both legitimate.
    const counts = { files: 0, folders: 0, memories: 900, rows: 2_400 };

    expect(decodeRaw(rawSummary({ counts })).counts).toEqual(counts);
  });

  it("refuses a count that is negative, fractional, or not a number", () => {
    for (const rows of [-1, 1.5, "52", null]) {
      expect(() =>
        decodeRaw(rawSummary({ counts: { files: 0, folders: 0, memories: 0, rows } }))
      ).toThrow(AfrCorruptError);
    }
  });

  it("refuses a counts object with a field it does not have", () => {
    expect(detailOf(() =>
      decodeRaw(rawSummary({ counts: { files: 40, folders: 12, memories: 0, rows: 52, tags: 3 } }))
    )).toContain("5 keys, expected 4");
  });

  it("refuses a date range that runs backwards", () => {
    expect(detailOf(() =>
      decodeRaw(rawSummary({ dateRange: { from: 1_770_000_000_000, to: 1_700_000_000_000 } }))
    )).toContain("runs backwards");
  });

  it("refuses a timestamp beyond the year 9999", () => {
    expect(() =>
      decodeRaw(rawSummary({ dateRange: { from: 1, to: 253_402_300_800_000 } }))
    ).toThrow(AfrCorruptError);
  });
});

describe("refusal #8, measured against a claim", () => {
  function counts(overrides: Partial<AfrSummary["counts"]> = {}): AfrSummary["counts"] {
    return { files: 0, folders: 0, memories: 0, rows: 0, ...overrides };
  }

  it("states the caps the spec names", () => {
    expect(AFR_FILE_ROW_CAP).toBe(200_000);
    expect(AFR_FOLDER_ROW_CAP).toBe(50_000);
    expect(AFR_BRAIN_ROW_CAP).toBe(500_000);
  });

  it("counts a files archive's two kinds together for the total", () => {
    expect(rowCap("files")).toBe(AFR_FILE_ROW_CAP + AFR_FOLDER_ROW_CAP);
    expect(rowCap("brain")).toBe(AFR_BRAIN_ROW_CAP);
  });

  it("admits an archive that sits exactly on every cap", () => {
    const atCap = counts({
      files: AFR_FILE_ROW_CAP,
      folders: AFR_FOLDER_ROW_CAP,
      rows: AFR_FILE_ROW_CAP + AFR_FOLDER_ROW_CAP,
    });

    expect(() => assertWithinRowCaps("files", atCap)).not.toThrow();
    expect(() =>
      assertWithinRowCaps("brain", counts({ memories: 400_000, rows: AFR_BRAIN_ROW_CAP }))
    ).not.toThrow();
  });

  it("refuses one row past a per-kind cap even when the total would fit", () => {
    // 200,001 files and no folders is under the 250,000 total, and is still refused: the
    // kinds are not interchangeable, because every file row also carries an R2 object.
    const overFiles = counts({ files: AFR_FILE_ROW_CAP + 1, rows: AFR_FILE_ROW_CAP + 1 });

    expect(() => assertWithinRowCaps("files", overFiles)).toThrow(AfrTooLargeError);
    const overFolders = counts({ folders: AFR_FOLDER_ROW_CAP + 1, rows: AFR_FOLDER_ROW_CAP + 1 });
    expect(() => assertWithinRowCaps("files", overFolders)).toThrow(AfrTooLargeError);
  });

  it("carries the two numbers the audit row records", () => {
    try {
      assertWithinRowCaps("brain", counts({ memories: 900_000, rows: 900_000 }));
      throw new Error("expected a refusal");
    } catch (error) {
      expect(error).toBeInstanceOf(AfrTooLargeError);
      const refusal = error as AfrTooLargeError;
      expect(refusal.rows).toBe(900_000);
      expect(refusal.cap).toBe(AFR_BRAIN_ROW_CAP);
      expect(refusal.reason).toBe(8);
      expect(refusal.detail).toBe(`claims 900000 rows, cap ${AFR_BRAIN_ROW_CAP}`);
    }
  });

  it("does not apply the files caps to a brain archive", () => {
    // 300,000 memories is over the file cap and well under the brain cap.
    expect(() =>
      assertWithinRowCaps("brain", counts({ memories: 300_000, rows: 300_000 }))
    ).not.toThrow();
  });
});
