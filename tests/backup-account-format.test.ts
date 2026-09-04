import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  AFRBAK_MAGIC,
  AFR_CHUNK_SIZE,
  AFR_FORMAT_VERSION,
  MAX_CHUNK_COUNT,
  MAX_HEADER_BYTES,
  MAX_PREVIEW_BYTES,
  MAX_SUMMARY_BYTES,
  NONCE_PREFIX_BYTES,
  PREAMBLE_BYTES,
  TRAILER_BYTES,
  chunkAad,
  chunkNonce,
  decodeHeader,
  decodePreamble,
  decodeTrailer,
  encodeHeader,
  encodePreamble,
  encodeTrailer,
  headerHmac,
  previewLength,
  sectionAad,
  splitGcm,
  trailerHmac,
  verifyHeaderHmac,
  verifyTrailerHmac,
  type AfrHeader,
  type AfrPreamble,
} from "@backup/account/domain/format";
import {
  AccountBackupError,
  AfrCorruptError,
  AfrVersionTooNewError,
  NotAnAfrBackupError,
} from "@backup/account/domain/errors";
import { canonicalBytes } from "@backup/account/domain/canonical";

/**
 * The `.afrbak` byte layout, read the way a stranger's file arrives.
 *
 * Two different jobs are tested here and they are not interchangeable. The encode
 * side is checked for determinism: the same value must always produce the same bytes,
 * because every HMAC in the format is taken over those bytes. The decode side is
 * checked for refusal: each test names one thing a crafted archive could claim —
 * a 4 GiB header, a domain byte of 9, a trailer describing a thousand chunks in a
 * twelve-byte payload — and asserts the parser says no before allocating anything.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.
 */

const PREAMBLE: AfrPreamble = {
  formatVersion: AFR_FORMAT_VERSION,
  domain: "files",
  headerLength: 512,
  summaryLength: 300,
  indexLength: 9_001,
  chunkSize: AFR_CHUNK_SIZE,
};

function header(overrides: Partial<AfrHeader> = {}): AfrHeader {
  return {
    backupId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
    createdAt: 1_772_500_000_000,
    keyId: "afrbak-2026-09",
    keyslot: [
      { alg: "AES-256-GCM", nonce: Buffer.alloc(12, 1), ct: Buffer.alloc(48, 2) },
      { alg: "AES-256-GCM", nonce: Buffer.alloc(12, 3), ct: Buffer.alloc(48, 4) },
    ],
    phraseSalt: Buffer.alloc(16, 5),
    argon2: { m: 262_144, t: 3, p: 1 },
    chunkNoncePrefix: Buffer.alloc(8, 6),
    summaryNonce: Buffer.alloc(12, 7),
    indexNonce: Buffer.alloc(12, 8),
    ...overrides,
  };
}

/** Unpadded, the way the format spells binary. */
function b64(bytes: Buffer): string {
  return bytes.toString("base64").replace(/=+$/, "");
}

/** `2^64 - 1`, spelled without a literal: the project targets ES2017. */
const U64_MAX = BigInt("0xffffffffffffffff");

/**
 * The `detail` of a refusal — the part that says what actually went wrong.
 *
 * `message` is deliberately uninformative: §12 gives every crypto and integrity
 * failure one shared sentence so that a stolen archive cannot be used as an oracle.
 * A test asserting on `message` would therefore be checking the sentence the user
 * reads, not the diagnosis the audit trail keeps.
 */
function detailOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof AccountBackupError) return error.detail;
    throw error;
  }
  return expect.unreachable("expected the archive to be refused");
}

/** A header spelled by hand, so a test can break one field without breaking the rest. */
function headerJson(mutate: (value: Record<string, unknown>) => void): Buffer {
  const parsed = JSON.parse(encodeHeader(header()).toString("utf8")) as Record<
    string,
    unknown
  >;
  mutate(parsed);
  return Buffer.from(JSON.stringify(parsed), "utf8");
}

describe("the preamble is 32 bytes or it is not a preamble", () => {
  it("round trips every field", () => {
    expect(decodePreamble(encodePreamble(PREAMBLE))).toEqual(PREAMBLE);
  });

  it("writes exactly 32 bytes, magic first, reserved flags zero", () => {
    const bytes = encodePreamble(PREAMBLE);

    expect(bytes).toHaveLength(PREAMBLE_BYTES);
    expect(bytes.subarray(0, 8)).toEqual(AFRBAK_MAGIC);
    expect(AFRBAK_MAGIC.toString("latin1")).toBe("AFRBAK1\0");
    expect(bytes.readUInt8(11)).toBe(0);
  });

  it("encodes the brain domain as 2 and files as 1", () => {
    expect(encodePreamble({ ...PREAMBLE, domain: "files" }).readUInt8(10)).toBe(1);
    expect(encodePreamble({ ...PREAMBLE, domain: "brain" }).readUInt8(10)).toBe(2);
    expect(decodePreamble(encodePreamble({ ...PREAMBLE, domain: "brain" })).domain).toBe(
      "brain"
    );
  });

  it("is deterministic", () => {
    expect(encodePreamble(PREAMBLE).equals(encodePreamble({ ...PREAMBLE }))).toBe(true);
  });
});

describe("what the preamble refuses, before a key is touched", () => {
  function patched(write: (bytes: Buffer) => void): Buffer {
    const bytes = encodePreamble(PREAMBLE);
    write(bytes);
    return bytes;
  }

  it("calls a foreign file 'not an AFR backup' rather than 'damaged'", () => {
    // A JPEG dropped on the restore card is a user mistake, not corruption, and the
    // message the user gets depends on this distinction.
    const jpeg = Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      Buffer.alloc(24),
    ]);

    expect(() => decodePreamble(jpeg)).toThrow(NotAnAfrBackupError);
    expect(() => decodePreamble(Buffer.alloc(0))).toThrow(NotAnAfrBackupError);
    expect(() => decodePreamble(Buffer.alloc(7))).toThrow(NotAnAfrBackupError);
  });

  it("calls a truncated but genuine preamble damaged", () => {
    expect(() => decodePreamble(encodePreamble(PREAMBLE).subarray(0, 31))).toThrow(
      AfrCorruptError
    );
  });

  it("refuses a reserved flag bit, which is how a future version says 'compressed'", () => {
    expect(() => decodePreamble(patched((bytes) => bytes.writeUInt8(1, 11)))).toThrow(
      NotAnAfrBackupError
    );
    expect(detailOf(() => decodePreamble(patched((bytes) => bytes.writeUInt8(0x80, 11))))).toMatch(
      /flags/
    );
  });

  it("tells the user to upgrade when the archive is newer than this build", () => {
    const future = patched((bytes) => bytes.writeUInt16BE(AFR_FORMAT_VERSION + 1, 8));

    expect(() => decodePreamble(future)).toThrow(AfrVersionTooNewError);
    try {
      decodePreamble(future);
      expect.unreachable();
    } catch (error) {
      const versionError = error as AfrVersionTooNewError;
      expect(versionError.found).toBe(2);
      expect(versionError.supported).toBe(1);
      expect(versionError.reason).toBe(2);
      expect(versionError.status).toBe(422);
    }
  });

  it("refuses version zero, which no writer ever produced", () => {
    expect(() => decodePreamble(patched((b) => b.writeUInt16BE(0, 8)))).toThrow(
      AfrCorruptError
    );
  });

  it("refuses a domain byte that means nothing", () => {
    for (const byte of [0, 3, 9, 255]) {
      expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt8(byte, 10))))).toMatch(
        /domain byte/
      );
    }
  });

  it("refuses a header length outside its cap", () => {
    expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt32BE(0, 12))))).toMatch(
      /headerLength/
    );
    expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt32BE(1, 12))))).toMatch(
      /headerLength/
    );
    expect(detailOf(() =>
      decodePreamble(patched((b) => b.writeUInt32BE(MAX_HEADER_BYTES + 1, 12)))
    )).toMatch(/headerLength/);
    // A 4 GiB header claim is the reason the cap is read before anything allocates.
    expect(() =>
      decodePreamble(patched((b) => b.writeUInt32BE(0xffff_ffff, 12)))
    ).toThrow(AfrCorruptError);
    expect(
      decodePreamble(patched((b) => b.writeUInt32BE(MAX_HEADER_BYTES, 12))).headerLength
    ).toBe(MAX_HEADER_BYTES);
  });

  it("refuses a summary that is smaller than its own GCM tag, or past 64 KiB", () => {
    for (const length of [0, 15, 16]) {
      expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt32BE(length, 16))))).toMatch(
        /summaryLength/
      );
    }
    expect(detailOf(() =>
      decodePreamble(patched((b) => b.writeUInt32BE(MAX_SUMMARY_BYTES + 1, 16)))
    )).toMatch(/summaryLength/);
    expect(
      decodePreamble(patched((b) => b.writeUInt32BE(17, 16))).summaryLength
    ).toBe(17);
  });

  it("bounds the index only by what a number can hold, never by a policy cap", () => {
    // §5.4: INDEX is deliberately uncapped — a million-file account has a large index
    // and that is legal. The row caps of §9 are what stop an abusive one, and the
    // reader streams it rather than loading it.
    expect(
      decodePreamble(patched((b) => b.writeBigUInt64BE(BigInt(4_000_000_000), 20)))
        .indexLength
    ).toBe(4_000_000_000);
    expect(
      detailOf(() => decodePreamble(patched((b) => b.writeBigUInt64BE(BigInt(15), 20))))
    ).toMatch(/indexLength/);
    expect(
      detailOf(() =>
        decodePreamble(patched((b) => b.writeBigUInt64BE(U64_MAX, 20)))
      )
    ).toMatch(/indexLength/);
  });

  it("refuses a chunk size on either side of the window", () => {
    // Too large and a reader allocates against a stranger's number; too small and a
    // 1 GiB archive becomes a billion GCM operations.
    expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt32BE(4_096, 28))))).toMatch(
      /chunkSize/
    );
    expect(detailOf(() => decodePreamble(patched((b) => b.writeUInt32BE(0, 28))))).toMatch(
      /chunkSize/
    );
    expect(detailOf(() =>
      decodePreamble(patched((b) => b.writeUInt32BE(32 * 1024 * 1024, 28)))
    )).toMatch(/chunkSize/);
    expect(decodePreamble(patched((b) => b.writeUInt32BE(65_536, 28))).chunkSize).toBe(
      65_536
    );
  });
});

describe("the preview budget does not depend on how big the account is", () => {
  it("costs 81,984 bytes at worst, for one file or a million", () => {
    expect(MAX_PREVIEW_BYTES).toBe(81_984);
    expect(MAX_PREVIEW_BYTES).toBe(32 + 16 * 1024 + 32 + 64 * 1024);
  });

  it("asks for exactly the four regions the preview reads", () => {
    expect(previewLength(PREAMBLE)).toBe(32 + 512 + 32 + 300);
    expect(previewLength({ ...PREAMBLE, indexLength: 900_000_000 })).toBe(
      previewLength(PREAMBLE)
    );
    expect(
      previewLength({
        ...PREAMBLE,
        headerLength: MAX_HEADER_BYTES,
        summaryLength: MAX_SUMMARY_BYTES,
      })
    ).toBe(MAX_PREVIEW_BYTES);
  });
});

describe("the header survives the trip out and back", () => {
  it("round trips every field, bytes included", () => {
    const decoded = decodeHeader(encodeHeader(header()));

    expect(decoded).toEqual(header());
    expect(decoded.chunkNoncePrefix).toHaveLength(NONCE_PREFIX_BYTES);
    expect(decoded.keyslot[1].ct.equals(Buffer.alloc(48, 4))).toBe(true);
  });

  it("writes the same bytes twice, whatever order the object was built in", () => {
    const base = header();
    const straight = encodeHeader(base);
    const shuffled = encodeHeader({
      indexNonce: base.indexNonce,
      summaryNonce: base.summaryNonce,
      chunkNoncePrefix: base.chunkNoncePrefix,
      argon2: { p: base.argon2.p, t: base.argon2.t, m: base.argon2.m },
      phraseSalt: base.phraseSalt,
      keyslot: base.keyslot,
      keyId: base.keyId,
      createdAt: base.createdAt,
      backupId: base.backupId,
    });

    expect(shuffled.equals(straight)).toBe(true);
    expect(straight.toString("utf8").startsWith('{"argon2"')).toBe(true);
    expect(straight.toString("utf8")).not.toMatch(/\s/);
  });

  it("keeps a real header far under its cap", () => {
    expect(encodeHeader(header()).length).toBeLessThan(1_024);
  });

  it("refuses to write a header past 16 KiB", () => {
    expect(detailOf(() => encodeHeader(header({ keyId: "k".repeat(20_000) })))).toMatch(
      /cap 16384/
    );
  });

  it("is not JSON-shaped when it is not JSON", () => {
    expect(detailOf(() => decodeHeader(Buffer.from("not json at all", "utf8")))).toMatch(
      /not JSON/
    );
    expect(detailOf(() => decodeHeader(Buffer.from("[]", "utf8")))).toMatch(/not an object/);
    expect(detailOf(() => decodeHeader(Buffer.from("null", "utf8")))).toMatch(/not an object/);
    expect(detailOf(() => decodeHeader(Buffer.from("12", "utf8")))).toMatch(/not an object/);
  });
});

describe("the header takes exactly the nine fields of the format", () => {
  it("refuses an extra field, however harmless it looks", () => {
    expect(detailOf(() => decodeHeader(headerJson((h) => (h.compression = "zstd"))))).toMatch(
      /10 keys, expected 9/
    );
  });

  it("refuses a missing field", () => {
    expect(detailOf(() => decodeHeader(headerJson((h) => delete h.phraseSalt)))).toMatch(
      /8 keys, expected 9/
    );
  });

  it("flattens a field name before it can write its own audit line", () => {
    // The detail string reaches activity_logs. A key named with a newline is a
    // log-injection attempt, not a typo.
    const injected = headerJson((h) => {
      delete h.keyId;
      h["\n2026-09-03 backup_restore_replace ok"] = "x";
    });

    try {
      decodeHeader(injected);
      expect.unreachable();
    } catch (error) {
      const detail = (error as AfrCorruptError).detail;
      expect(detail).not.toContain("\n");
      expect(detail).toMatch(/^header\.\?2026-09-03\?backup_restore/);
      expect(detail).toContain("is not a field of this format");
      // Whatever the file called it, only 32 sanitized characters of it survive.
      expect(detail.split(" ")[0]).toHaveLength("header.".length + 32);
    }
  });

  it("refuses a keyslot that is not a pair", () => {
    expect(detailOf(() => decodeHeader(headerJson((h) => (h.keyslot = []))))).toMatch(/not a pair/);
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.keyslot = [(h.keyslot as unknown[])[0]])))
    )).toMatch(/not a pair/);
    expect(detailOf(() => decodeHeader(headerJson((h) => (h.keyslot = {}))))).toMatch(
      /not a pair/
    );
  });
});

describe("every header field is held to its own shape", () => {
  it("refuses a backupId that is not a lowercase UUID", () => {
    for (const value of [
      "9C1F6A3E-0D2B-4A77-9F0E-1B2C3D4E5F60",
      "9c1f6a3e0d2b4a779f0e1b2c3d4e5f60",
      "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f6",
      "../../etc/passwd",
      "",
      42,
    ]) {
      expect(detailOf(() => decodeHeader(headerJson((h) => (h.backupId = value))))).toMatch(
        /backupId is not a well-formed value/
      );
    }
  });

  it("holds keyId to a charset, because it lands in audit rows and logs", () => {
    expect(decodeHeader(headerJson((h) => (h.keyId = "k1"))).keyId).toBe("k1");
    for (const value of ["", "k".repeat(65), "key id", "key\nid", "key/../id", 7]) {
      expect(detailOf(() => decodeHeader(headerJson((h) => (h.keyId = value))))).toMatch(
        /keyId is not a well-formed value/
      );
    }
  });

  it("refuses a createdAt that is not a plausible instant", () => {
    for (const value of [0, -1, 1.5, 253_402_300_800_000, "2026-09-03", null]) {
      expect(() => decodeHeader(headerJson((h) => (h.createdAt = value)))).toThrow(
        AfrCorruptError
      );
    }
  });

  it("refuses a keyslot whose algorithm is not the one the format defines", () => {
    expect(detailOf(() =>
      decodeHeader(
        headerJson((h) => {
          (h.keyslot as Record<string, unknown>[])[0].alg = "AES-128-GCM";
        })
      )
    )).toMatch(/keyslot\[0\]\.alg/);
  });

  it("refuses a wrapped key that is not 32 bytes plus a tag", () => {
    for (const length of [47, 49, 32, 0]) {
      expect(detailOf(() =>
        decodeHeader(
          headerJson((h) => {
            (h.keyslot as Record<string, unknown>[])[1].ct = Buffer.alloc(length, 1)
              .toString("base64")
              .replace(/=+$/, "");
          })
        )
      )).toMatch(/keyslot\[1\]\.ct is \d+ bytes, expected 48/);
    }
  });

  it("refuses a nonce that is not 12 bytes, anywhere it appears", () => {
    for (const field of ["summaryNonce", "indexNonce"]) {
      expect(detailOf(() =>
        decodeHeader(headerJson((h) => (h[field] = b64(Buffer.alloc(16, 1)))))
      )).toMatch(new RegExp(`${field} is \\d+ bytes, expected 12`));
    }
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.chunkNoncePrefix = b64(Buffer.alloc(12, 1)))))
    )).toMatch(/chunkNoncePrefix is 12 bytes, expected 8/);
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.phraseSalt = b64(Buffer.alloc(8, 1)))))
    )).toMatch(/phraseSalt is 8 bytes, expected 16/);
  });

  it("refuses base64 that is padded, spaced, or otherwise non-canonical", () => {
    // Node's decoder would accept all of these and hand back bytes that re-encode
    // differently, which is exactly what the canonical check at the end forbids.
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.phraseSalt = Buffer.alloc(16, 5).toString("base64"))))
    )).toMatch(/phraseSalt is not canonical base64/);
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.summaryNonce = `${b64(Buffer.alloc(12, 7))} `)))
    )).toMatch(/summaryNonce is not canonical base64/);
    expect(detailOf(() => decodeHeader(headerJson((h) => (h.indexNonce = "!!!!"))))).toMatch(
      /indexNonce is not canonical base64/
    );
    expect(detailOf(() => decodeHeader(headerJson((h) => (h.indexNonce = 12))))).toMatch(
      /indexNonce is not a base64 string/
    );
  });

  it("keeps Argon2 parameters inside what a 2 GB VPS can survive", () => {
    // These three numbers are executed on the recovery path, using values from a file
    // the server did not write. 64 GiB of memory cost would be a one-line outage.
    const bad = [
      { m: 4 * 1024, t: 3, p: 1 },
      { m: 1024 * 1024, t: 3, p: 1 },
      { m: 262_144, t: 0, p: 1 },
      { m: 262_144, t: 9, p: 1 },
      { m: 262_144, t: 3, p: 0 },
      { m: 262_144, t: 3, p: 5 },
    ];
    for (const argon2 of bad) {
      expect(detailOf(() => decodeHeader(headerJson((h) => (h.argon2 = argon2))))).toMatch(
        /header\.argon2\./
      );
    }
    expect(detailOf(() =>
      decodeHeader(headerJson((h) => (h.argon2 = { m: 262_144, t: 3, p: 1, v: 19 })))
    )).toMatch(/header\.argon2 has 4 keys/);
  });

  it("refuses a header that parses correctly but was not written canonically", () => {
    const parsed = JSON.parse(encodeHeader(header()).toString("utf8")) as Record<
      string,
      unknown
    >;

    // Same fields, same values, different bytes. HDR_HMAC covers the raw bytes so
    // neither of these breaks verification — they break the day a reader re-derives
    // the header from its parsed form and gets a different 32 bytes.
    expect(detailOf(() => decodeHeader(Buffer.from(JSON.stringify(parsed, null, 1))))).toMatch(
      /not canonically serialized/
    );
    expect(detailOf(() =>
      decodeHeader(
        Buffer.from(JSON.stringify({ backupId: parsed.backupId, ...parsed }), "utf8")
      )
    )).toMatch(/not canonically serialized/);
  });
});

describe("HDR_HMAC authenticates the preamble and the header together", () => {
  const MASTER = Buffer.alloc(32, 0xa1);
  const HEADER_BYTES = encodeHeader(header());
  const PREAMBLE_BYTES_OF = encodePreamble({
    ...PREAMBLE,
    headerLength: HEADER_BYTES.length,
  });

  it("is 32 bytes of HMAC-SHA256 over the concatenation, in that order", () => {
    const mac = headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES);

    expect(mac).toHaveLength(32);
    expect(
      mac.equals(
        createHmac("sha256", MASTER)
          .update(Buffer.concat([PREAMBLE_BYTES_OF, HEADER_BYTES]))
          .digest()
      )
    ).toBe(true);
    expect(verifyHeaderHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES, mac)).toBe(true);
  });

  it("makes the lengths and the domain unforgeable", () => {
    const mac = headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES);
    for (const offset of [10, 12, 16, 20, 28]) {
      const tampered = Buffer.from(PREAMBLE_BYTES_OF);
      tampered.writeUInt8(tampered.readUInt8(offset) ^ 0x01, offset);

      expect(verifyHeaderHmac(MASTER, tampered, HEADER_BYTES, mac)).toBe(false);
    }
  });

  it("notices a single flipped bit anywhere in the header", () => {
    const mac = headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES);
    for (const offset of [0, 40, HEADER_BYTES.length - 1]) {
      const tampered = Buffer.from(HEADER_BYTES);
      tampered.writeUInt8(tampered.readUInt8(offset) ^ 0x01, offset);

      expect(verifyHeaderHmac(MASTER, PREAMBLE_BYTES_OF, tampered, mac)).toBe(false);
    }
  });

  it("fails under the wrong key rather than reporting damage", () => {
    const mac = headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES);

    expect(
      verifyHeaderHmac(Buffer.alloc(32, 0xa2), PREAMBLE_BYTES_OF, HEADER_BYTES, mac)
    ).toBe(false);
  });

  it("returns false for a mac of the wrong length instead of throwing", () => {
    // `timingSafeEqual` throws on a length mismatch, and an exception here would be a
    // different observable outcome than a mismatch — an oracle, in other words.
    const mac = headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES);

    expect(
      verifyHeaderHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES, mac.subarray(0, 31))
    ).toBe(false);
    expect(
      verifyHeaderHmac(
        MASTER,
        PREAMBLE_BYTES_OF,
        HEADER_BYTES,
        Buffer.concat([mac, Buffer.alloc(1)])
      )
    ).toBe(false);
    expect(verifyHeaderHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES, Buffer.alloc(0))).toBe(
      false
    );
  });

  it("does not confuse a preamble/header boundary shift for the same input", () => {
    // Feeding the two regions separately must not be equivalent to sliding a byte
    // across the boundary: HMAC over a concatenation is only safe here because both
    // lengths are themselves authenticated.
    const shifted = headerHmac(
      MASTER,
      Buffer.concat([PREAMBLE_BYTES_OF, HEADER_BYTES.subarray(0, 1)]),
      HEADER_BYTES.subarray(1)
    );

    expect(shifted.equals(headerHmac(MASTER, PREAMBLE_BYTES_OF, HEADER_BYTES))).toBe(true);
    expect(decodePreamble(PREAMBLE_BYTES_OF).headerLength).toBe(HEADER_BYTES.length);
  });
});

describe("the trailer is 48 fixed bytes and has to agree with the chunk size", () => {
  const SHA = Buffer.alloc(32, 0xbb);
  const TRAILER = {
    chunkCount: 3,
    payloadSha256: SHA,
    totalPlaintextBytes: 2 * AFR_CHUNK_SIZE + 17,
  };

  it("round trips at a fixed width, so it can be found by seeking from the end", () => {
    const bytes = encodeTrailer(TRAILER);

    expect(bytes).toHaveLength(TRAILER_BYTES);
    expect(bytes).toHaveLength(48);
    expect(decodeTrailer(bytes, AFR_CHUNK_SIZE)).toEqual(TRAILER);
    expect(bytes.readBigUInt64BE(0)).toBe(BigInt(3));
    expect(bytes.subarray(8, 40).equals(SHA)).toBe(true);
  });

  it("is deterministic, because TRL_HMAC is taken over it", () => {
    expect(encodeTrailer(TRAILER).equals(encodeTrailer({ ...TRAILER }))).toBe(true);
  });

  it("refuses to write a digest that is not SHA-256 sized", () => {
    expect(detailOf(() =>
      encodeTrailer({ ...TRAILER, payloadSha256: Buffer.alloc(20, 1) })
    )).toMatch(/payloadSha256 is 20 bytes/);
  });

  it("refuses a trailer of the wrong size", () => {
    expect(detailOf(() => decodeTrailer(Buffer.alloc(47), AFR_CHUNK_SIZE))).toMatch(
      /trailer is 47 bytes/
    );
    expect(() => decodeTrailer(Buffer.alloc(49), AFR_CHUNK_SIZE)).toThrow(AfrCorruptError);
  });

  it("accepts an empty archive, and only an empty one, at zero chunks", () => {
    const empty = encodeTrailer({
      chunkCount: 0,
      payloadSha256: SHA,
      totalPlaintextBytes: 0,
    });

    expect(decodeTrailer(empty, AFR_CHUNK_SIZE).chunkCount).toBe(0);
    const lying = encodeTrailer({
      chunkCount: 0,
      payloadSha256: SHA,
      totalPlaintextBytes: 1,
    });
    expect(detailOf(() => decodeTrailer(lying, AFR_CHUNK_SIZE))).toMatch(/cannot be 0 chunks/);
  });

  it("pins the plaintext size to one interval per chunk count", () => {
    // Every chunk but the last is exactly chunkSize, so 3 chunks means "more than 2
    // chunks' worth, no more than 3". An archive claiming 1,000 chunks and 12 bytes is
    // refused here instead of after 999 useless reads.
    const at = (chunkCount: number, totalPlaintextBytes: number): (() => unknown) => () =>
      decodeTrailer(
        encodeTrailer({ chunkCount, payloadSha256: SHA, totalPlaintextBytes }),
        AFR_CHUNK_SIZE
      );

    expect(at(3, 2 * AFR_CHUNK_SIZE + 1)()).toMatchObject({ chunkCount: 3 });
    expect(at(3, 3 * AFR_CHUNK_SIZE)()).toMatchObject({ chunkCount: 3 });
    expect(at(1, 1)()).toMatchObject({ totalPlaintextBytes: 1 });
    expect(at(3, 3 * AFR_CHUNK_SIZE + 1)).toThrow(AfrCorruptError);
    expect(detailOf(at(3, 2 * AFR_CHUNK_SIZE))).toMatch(/cannot be 3 chunks/);
    expect(detailOf(at(1_000, 12))).toMatch(/12 plaintext bytes cannot be 1000 chunks/);
    expect(at(1, 0)).toThrow(AfrCorruptError);
  });

  it("reads the interval against the chunk size it was given, not a default", () => {
    const small = encodeTrailer({
      chunkCount: 2,
      payloadSha256: SHA,
      totalPlaintextBytes: 65_536 + 5,
    });

    expect(decodeTrailer(small, 65_536).totalPlaintextBytes).toBe(65_541);
    expect(() => decodeTrailer(small, AFR_CHUNK_SIZE)).toThrow(AfrCorruptError);
  });

  it("refuses counters no reader could represent", () => {
    const past = Buffer.alloc(TRAILER_BYTES);
    past.writeBigUInt64BE(BigInt(MAX_CHUNK_COUNT + 1), 0);
    expect(detailOf(() => decodeTrailer(past, AFR_CHUNK_SIZE))).toMatch(/chunkCount/);

    const huge = Buffer.alloc(TRAILER_BYTES);
    huge.writeBigUInt64BE(BigInt(1), 0);
    huge.writeBigUInt64BE(U64_MAX, 40);
    expect(detailOf(() => decodeTrailer(huge, AFR_CHUNK_SIZE))).toMatch(/totalPlaintextBytes/);
  });

  it("hands back a copy of the digest, not a window onto the caller's buffer", () => {
    const bytes = encodeTrailer(TRAILER);
    const decoded = decodeTrailer(bytes, AFR_CHUNK_SIZE);
    bytes.fill(0xff);

    expect(decoded.payloadSha256.equals(SHA)).toBe(true);
  });
});

describe("TRL_HMAC is keyed by the DEK, so recovery can still finish", () => {
  const DEK = Buffer.alloc(32, 0xc3);
  const HDR_MAC = Buffer.alloc(32, 0xd4);
  const TRAILER = encodeTrailer({
    chunkCount: 1,
    payloadSha256: Buffer.alloc(32, 0xee),
    totalPlaintextBytes: 10,
  });

  it("uses the DEK and nothing else, so a different BACKUP_MASTER_KEY is irrelevant", () => {
    // The recovery path takes the DEK out of keyslot 1 on a machine whose master key is
    // different, or gone. If this HMAC touched the master key, that path could never
    // verify the archive it just decrypted.
    const mac = trailerHmac(DEK, HDR_MAC, TRAILER);

    expect(
      mac.equals(
        createHmac("sha256", DEK).update(Buffer.concat([HDR_MAC, TRAILER])).digest()
      )
    ).toBe(true);
    expect(verifyTrailerHmac(DEK, HDR_MAC, TRAILER, mac)).toBe(true);
    expect(verifyTrailerHmac(Buffer.alloc(32, 0xc4), HDR_MAC, TRAILER, mac)).toBe(false);
  });

  it("binds the trailer to one specific header", () => {
    // Without HDR_HMAC in the input, a trailer lifted from another archive of the same
    // account would verify against this one.
    const mac = trailerHmac(DEK, HDR_MAC, TRAILER);

    expect(verifyTrailerHmac(DEK, Buffer.alloc(32, 0xd5), TRAILER, mac)).toBe(false);
  });

  it("notices a changed chunk count or digest", () => {
    const mac = trailerHmac(DEK, HDR_MAC, TRAILER);
    for (const offset of [7, 8, 39, 47]) {
      const tampered = Buffer.from(TRAILER);
      tampered.writeUInt8(tampered.readUInt8(offset) ^ 0x01, offset);

      expect(verifyTrailerHmac(DEK, HDR_MAC, tampered, mac)).toBe(false);
    }
  });

  it("returns false for a wrong-length mac instead of throwing", () => {
    const mac = trailerHmac(DEK, HDR_MAC, TRAILER);

    expect(verifyTrailerHmac(DEK, HDR_MAC, TRAILER, mac.subarray(0, 16))).toBe(false);
  });
});

describe("chunk nonces are a prefix plus a counter", () => {
  const PREFIX = randomBytes(NONCE_PREFIX_BYTES);

  it("is 12 bytes: the archive's 8 random bytes then u32BE(index)", () => {
    const nonce = chunkNonce(PREFIX, 258);

    expect(nonce).toHaveLength(12);
    expect(nonce.subarray(0, 8).equals(PREFIX)).toBe(true);
    expect(nonce.readUInt32BE(8)).toBe(258);
    expect(nonce.subarray(8).equals(Buffer.from([0x00, 0x00, 0x01, 0x02]))).toBe(true);
  });

  it("gives every index in an archive a different nonce", () => {
    const seen = new Set<string>();
    for (const index of [0, 1, 2, 255, 256, 65_535, 16_777_216, MAX_CHUNK_COUNT - 1]) {
      seen.add(chunkNonce(PREFIX, index).toString("hex"));
    }

    expect(seen.size).toBe(8);
  });

  it("separates two archives even at the same index", () => {
    // GCM needs (key, nonce) to be unique. Two archives share neither the DEK nor the
    // prefix, so index 0 colliding across archives is harmless — but the prefix is what
    // makes it structurally impossible rather than merely unlikely.
    expect(
      chunkNonce(PREFIX, 0).equals(chunkNonce(randomBytes(NONCE_PREFIX_BYTES), 0))
    ).toBe(false);
  });

  it("refuses a prefix of the wrong length and an index with no nonce", () => {
    expect(detailOf(() => chunkNonce(Buffer.alloc(7), 0))).toMatch(/chunkNoncePrefix is 7 bytes/);
    expect(() => chunkNonce(Buffer.alloc(12), 0)).toThrow(AfrCorruptError);
    expect(detailOf(() => chunkNonce(PREFIX, -1))).toMatch(/chunkIndex/);
    expect(detailOf(() => chunkNonce(PREFIX, 1.5))).toMatch(/chunkIndex/);
    expect(detailOf(() => chunkNonce(PREFIX, MAX_CHUNK_COUNT))).toMatch(/chunkIndex/);
    expect(detailOf(() => chunkNonce(PREFIX, Number.NaN))).toMatch(/chunkIndex/);
  });

  it("does not alias the prefix it was handed", () => {
    const prefix = Buffer.alloc(NONCE_PREFIX_BYTES, 9);
    const nonce = chunkNonce(prefix, 4);
    prefix.fill(0);

    expect(nonce.subarray(0, 8).equals(Buffer.alloc(8, 9))).toBe(true);
  });
});

describe("AAD binds every encrypted region to its place in the archive", () => {
  const CONTEXT = {
    backupId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
    domain: "files",
    formatVersion: 1,
  } as const;

  it("is the canonical form of exactly the four fields the spec names", () => {
    expect(chunkAad(CONTEXT, 7).toString("utf8")).toBe(
      '{"backupId":"9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60","chunkIndex":7,' +
        '"domain":"files","formatVersion":1}'
    );
    expect(
      chunkAad(CONTEXT, 7).equals(
        canonicalBytes({
          formatVersion: 1,
          domain: "files",
          chunkIndex: 7,
          backupId: CONTEXT.backupId,
        })
      )
    ).toBe(true);
  });

  it("changes with the index, so chunks cannot be swapped or replayed", () => {
    // The reader decrypting position 3 authenticates against chunkIndex 3. A chunk
    // written as 7 fails its tag rather than being quietly accepted.
    expect(chunkAad(CONTEXT, 3).equals(chunkAad(CONTEXT, 7))).toBe(false);
    expect(chunkAad(CONTEXT, 0).equals(chunkAad(CONTEXT, 1))).toBe(false);
  });

  it("changes with the archive and the domain, so chunks cannot cross files", () => {
    expect(
      chunkAad(CONTEXT, 1).equals(chunkAad({ ...CONTEXT, domain: "brain" }, 1))
    ).toBe(false);
    expect(
      chunkAad(CONTEXT, 1).equals(
        chunkAad({ ...CONTEXT, backupId: "0c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60" }, 1)
      )
    ).toBe(false);
    expect(
      chunkAad(CONTEXT, 1).equals(chunkAad({ ...CONTEXT, formatVersion: 2 }, 1))
    ).toBe(false);
  });

  it("keeps the two singleton sections apart", () => {
    // SUMMARY and INDEX have no index to bind. Without `section` their AAD would be
    // identical and a SUMMARY ciphertext could be served in the INDEX's place with a
    // tag that verifies.
    expect(sectionAad(CONTEXT, "summary").equals(sectionAad(CONTEXT, "index"))).toBe(
      false
    );
    expect(sectionAad(CONTEXT, "summary").toString("utf8")).toContain('"section":"summary"');
    expect(sectionAad(CONTEXT, "index").toString("utf8")).not.toContain("chunkIndex");
  });

  it("never lets a section AAD collide with a chunk AAD", () => {
    const sections = [sectionAad(CONTEXT, "summary"), sectionAad(CONTEXT, "index")];
    for (const index of [0, 1, 2, 1_000]) {
      for (const section of sections) {
        expect(section.equals(chunkAad(CONTEXT, index))).toBe(false);
      }
    }
  });
});

describe("every encrypted region is ciphertext then tag", () => {
  it("splits the tag off the end", () => {
    const bytes = Buffer.concat([Buffer.alloc(84, 1), Buffer.alloc(16, 2)]);
    const { ct, tag } = splitGcm(bytes, "summary");

    expect(ct).toHaveLength(84);
    expect(tag).toHaveLength(16);
    expect(tag.equals(Buffer.alloc(16, 2))).toBe(true);
  });

  it("accepts a region that is nothing but a tag, which is how empty encrypts", () => {
    const { ct, tag } = splitGcm(Buffer.alloc(16, 3), "index");

    expect(ct).toHaveLength(0);
    expect(tag).toHaveLength(16);
  });

  it("refuses a region too short to hold a tag, and says which one", () => {
    expect(detailOf(() => splitGcm(Buffer.alloc(15), "summary"))).toMatch(
      /summary is 15 bytes, below one GCM tag/
    );
    expect(detailOf(() => splitGcm(Buffer.alloc(0), "chunk 4"))).toMatch(/chunk 4 is 0 bytes/);
  });

  it("copies, so a reused read buffer cannot corrupt what it returned", () => {
    const bytes = Buffer.concat([Buffer.alloc(4, 1), Buffer.alloc(16, 2)]);
    const { ct, tag } = splitGcm(bytes, "summary");
    bytes.fill(0xff);

    expect(ct.equals(Buffer.alloc(4, 1))).toBe(true);
    expect(tag.equals(Buffer.alloc(16, 2))).toBe(true);
  });
});
