import { describe, expect, it } from "vitest";
import {
  CanonicalError,
  canonicalBytes,
  canonicalString,
  fromUnpaddedBase64,
  toUnpaddedBase64,
  type CanonicalValue,
} from "@backup/account/domain/canonical";

/**
 * The serializer every `.afrbak` HMAC rests on.
 *
 * These tests are not about JSON aesthetics. Each one names a way two runs of the
 * same code could produce different bytes for the same value — key order, a float's
 * printed form, a lenient base64 decode — because any of those turns the format's
 * integrity check into a coin toss that lands wrong once in a while and reports
 * "backup rusak" for a file that is perfectly fine.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §5.2.
 */

describe("key order is the writer's, never the object's", () => {
  it("sorts by UTF-16 code unit regardless of insertion order", () => {
    expect(canonicalString({ b: 1, a: 2, C: 3, _: 4 })).toBe(
      '{"C":3,"_":4,"a":2,"b":1}'
    );
  });

  it("gives two objects that differ only in key order the same bytes", () => {
    const one: CanonicalValue = { domain: "files", backupId: "x", chunkIndex: 7 };
    const other: CanonicalValue = { chunkIndex: 7, backupId: "x", domain: "files" };

    expect(canonicalBytes(one).equals(canonicalBytes(other))).toBe(true);
  });

  it("sorts nested objects too", () => {
    expect(canonicalString({ z: { b: 1, a: 2 }, a: [{ d: 1, c: 2 }] })).toBe(
      '{"a":[{"c":2,"d":1}],"z":{"a":2,"b":1}}'
    );
  });

  it("emits no whitespace", () => {
    expect(canonicalString({ a: [1, 2], b: { c: "d" } })).not.toMatch(/\s/);
  });
});

describe("absent means absent", () => {
  it("drops undefined and null keys instead of writing them", () => {
    expect(canonicalString({ a: 1, b: undefined, c: null, d: 2 })).toBe('{"a":1,"d":2}');
  });

  it("drops them at every level", () => {
    expect(canonicalString({ outer: { keep: 1, gone: null } })).toBe(
      '{"outer":{"keep":1}}'
    );
  });

  it("writes an empty object when every key was absent", () => {
    expect(canonicalString({ a: undefined, b: null })).toBe("{}");
  });

  it("refuses a hole in an array, where dropping would renumber the rest", () => {
    expect(() => canonicalString([1, null, 3] as unknown as CanonicalValue)).toThrow(
      CanonicalError
    );
    expect(() =>
      canonicalString([1, undefined, 3] as unknown as CanonicalValue)
    ).toThrow(/\[1\] is undefined/);
  });
});

describe("numbers are integers or they are refused", () => {
  it("writes integers as plain decimal", () => {
    expect(canonicalString({ n: 0, p: 42, m: -7 })).toBe('{"m":-7,"n":0,"p":42}');
  });

  it("writes negative zero as zero, so both spellings agree", () => {
    expect(canonicalString(-0)).toBe("0");
    expect(canonicalString(0)).toBe("0");
  });

  it("refuses a float, whose printed form is engine detail", () => {
    expect(() => canonicalString(1.5)).toThrow(/not an integer/);
    expect(() => canonicalString(0.1 + 0.2)).toThrow(CanonicalError);
  });

  it("refuses NaN and the infinities", () => {
    expect(() => canonicalString(Number.NaN)).toThrow(/not an integer/);
    expect(() => canonicalString(Number.POSITIVE_INFINITY)).toThrow(/not an integer/);
    expect(() => canonicalString(Number.NEGATIVE_INFINITY)).toThrow(/not an integer/);
  });

  it("refuses an integer past 2^53-1", () => {
    expect(() => canonicalString(Number.MAX_SAFE_INTEGER + 2)).toThrow(/beyond 2\^53-1/);
  });

  it("writes a bigint as decimal and refuses one JSON.parse could not read back", () => {
    // Spelled `BigInt(…)` and not `123n` throughout: the project targets ES2017, where
    // the literal form does not compile.
    expect(canonicalString(BigInt("9007199254740991"))).toBe("9007199254740991");
    expect(canonicalString(BigInt(-5))).toBe("-5");
    expect(() => canonicalString(BigInt("9007199254740992"))).toThrow(/exceeds 2\^53-1/);
  });

  it("agrees with itself across number and bigint spellings of one value", () => {
    expect(canonicalString(1234)).toBe(canonicalString(BigInt(1234)));
  });
});

describe("binary travels as unpadded base64", () => {
  it("writes bytes as base64 with the padding stripped", () => {
    expect(canonicalString(Uint8Array.from([0x41]))).toBe('"QQ"');
    expect(canonicalString({ nonce: Buffer.from("hello") })).toBe('{"nonce":"aGVsbG8"}');
  });

  it("writes an empty buffer as an empty string", () => {
    expect(canonicalString(Buffer.alloc(0))).toBe('""');
  });

  it("survives a byte-for-byte round trip through the strict decoder", () => {
    for (const length of [1, 12, 16, 31, 32, 64, 255]) {
      const bytes = Buffer.alloc(length, length % 256);
      expect(fromUnpaddedBase64(toUnpaddedBase64(bytes)).equals(bytes)).toBe(true);
    }
  });

  it("reads a view of a larger buffer without dragging its neighbours in", () => {
    const backing = Buffer.from([1, 2, 3, 4, 5, 6]);
    expect(toUnpaddedBase64(backing.subarray(2, 4))).toBe(
      toUnpaddedBase64(Buffer.from([3, 4]))
    );
  });

  it("refuses padded, junked, and non-canonical spellings", () => {
    // Node's lenient decoder maps all three of these onto bytes it would re-encode
    // differently — the malleability the strict inverse exists to close.
    expect(() => fromUnpaddedBase64("QQ==")).toThrow(CanonicalError);
    expect(() => fromUnpaddedBase64("QQ ")).toThrow(/canonical unpadded base64/);
    expect(() => fromUnpaddedBase64("QR")).toThrow(CanonicalError);
    expect(() => fromUnpaddedBase64("!!!!")).toThrow(CanonicalError);
    expect(() => fromUnpaddedBase64("aGVsbG8=", "header.nonce")).toThrow(/header\.nonce/);
  });
});

describe("strings escape the same way every time", () => {
  it("escapes quotes, backslashes and control characters", () => {
    expect(canonicalString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(canonicalString(`${String.fromCharCode(1)}\n\t`)).toBe('"\\u0001\\n\\t"');
  });

  it("escapes a lone surrogate rather than emitting invalid UTF-8", () => {
    const text = canonicalString("\ud800");

    expect(text).toBe('"\\ud800"');
    expect(canonicalBytes("\ud800").includes(0xef)).toBe(false);
  });

  it("keeps non-ASCII as itself, encoded once as UTF-8", () => {
    expect(canonicalString("naïve — 目录")).toBe('"naïve — 目录"');
    expect(canonicalBytes("é")).toEqual(Buffer.from([0x22, 0xc3, 0xa9, 0x22]));
  });
});

describe("only the types the format defines get through", () => {
  it("refuses the values that have more than one reasonable serialization", () => {
    expect(() => canonicalString(new Date() as unknown as CanonicalValue)).toThrow(
      /not a plain object/
    );
    expect(() => canonicalString(new Map() as unknown as CanonicalValue)).toThrow(
      CanonicalError
    );
    expect(() => canonicalString(new Set() as unknown as CanonicalValue)).toThrow(
      CanonicalError
    );
    expect(() => canonicalString((() => 1) as unknown as CanonicalValue)).toThrow(
      /function .* is not serializable/
    );
    expect(() => canonicalString(Symbol("x") as unknown as CanonicalValue)).toThrow(
      /symbol/
    );
  });

  it("accepts a null-prototype object, which is still a plain bag of keys", () => {
    const bag = Object.create(null) as Record<string, number>;
    bag.b = 1;
    bag.a = 2;

    expect(canonicalString(bag)).toBe('{"a":2,"b":1}');
  });

  it("names the path it gave up on", () => {
    expect(() => canonicalString({ header: { keyslot: [{ nonce: 1.5 }] } })).toThrow(
      /header\.keyslot\[0\]\.nonce/
    );
  });

  it("reports a cycle instead of overflowing the stack", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;

    expect(() => canonicalString(loop as CanonicalValue)).toThrow(/deeper than 32/);
  });
});

describe("the round trip the verifier depends on", () => {
  it("re-canonicalizes parsed output to the identical bytes", () => {
    const header = {
      backupId: "9c1f6a3e-0d2b-4a77-9f0e-1b2c3d4e5f60",
      createdAt: 1_772_500_000_000,
      keyId: "k1",
      keyslot: [
        { alg: "AES-256-GCM", nonce: Buffer.alloc(12, 7), ct: Buffer.alloc(48, 9) },
        { alg: "AES-256-GCM", nonce: Buffer.alloc(12, 8), ct: Buffer.alloc(48, 10) },
      ],
      phraseSalt: Buffer.alloc(16, 3),
      argon2: { m: 262_144, t: 4, p: 1 },
      summaryNonce: Buffer.alloc(12, 1),
      indexNonce: Buffer.alloc(12, 2),
      omitted: undefined,
    };

    const first = canonicalString(header);
    const second = canonicalString(JSON.parse(first) as CanonicalValue);

    expect(second).toBe(first);
  });

  it("gets the binary back out of the parsed form", () => {
    const parsed = JSON.parse(canonicalString({ nonce: Buffer.alloc(12, 5) })) as {
      nonce: string;
    };

    expect(fromUnpaddedBase64(parsed.nonce).equals(Buffer.alloc(12, 5))).toBe(true);
  });
});
