import { describe, it, expect } from "vitest";
import {
  clampLimit,
  decodeMemoryCursor,
  encodeMemoryCursor,
} from "@brain/domain/pagination";

const ID = "11111111-2222-4333-8444-555555555555";

describe("memory cursor codec", () => {
  it("round-trips a timestamp and id", () => {
    const createdAt = new Date("2026-08-20T10:11:12.345Z");
    const decoded = decodeMemoryCursor(encodeMemoryCursor({ createdAt, id: ID }));

    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe(ID);
    expect(decoded?.createdAt.toISOString()).toBe(createdAt.toISOString());
  });

  it("is URL-safe (no +, / or = to be mangled in a query string)", () => {
    const cursor = encodeMemoryCursor({
      createdAt: new Date("2026-01-02T03:04:05.678Z"),
      id: ID,
    });
    expect(cursor).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("rejects garbage instead of yielding an Invalid Date", () => {
    // Reaching SQL with `new Date("not-base64")` is a 500; a null here is a 400.
    for (const bad of ["", "not-base64!!", "e30", "%%%"]) {
      expect(decodeMemoryCursor(bad)).toBeNull();
    }
  });

  it("rejects a cursor whose id is not a uuid", () => {
    const forged = Buffer.from("2026-08-20T10:00:00.000Z|not-a-uuid", "utf8").toString(
      "base64url"
    );
    expect(decodeMemoryCursor(forged)).toBeNull();
  });

  it("rejects a cursor whose timestamp is unparseable", () => {
    const forged = Buffer.from(`totally-not-a-date|${ID}`, "utf8").toString("base64url");
    expect(decodeMemoryCursor(forged)).toBeNull();
  });

  it("rejects an absurdly long cursor without decoding it", () => {
    expect(decodeMemoryCursor("A".repeat(500))).toBeNull();
  });

  it("keeps the id intact when the payload contains extra separators", () => {
    const decoded = decodeMemoryCursor(
      Buffer.from(`2026-08-20T10:00:00.000Z|${ID}`, "utf8").toString("base64url")
    );
    expect(decoded?.id).toBe(ID);
  });
});

describe("clampLimit", () => {
  it("falls back for NaN, null and undefined rather than emitting LIMIT NaN", () => {
    expect(clampLimit(undefined, 20, 100)).toBe(20);
    expect(clampLimit(null, 20, 100)).toBe(20);
    expect(clampLimit("abc", 20, 100)).toBe(20);
    expect(clampLimit(Number.NaN, 20, 100)).toBe(20);
    expect(clampLimit(Number.POSITIVE_INFINITY, 20, 100)).toBe(20);
  });

  it("clamps to the [1, max] window", () => {
    expect(clampLimit(0, 20, 100)).toBe(1);
    expect(clampLimit(-5, 20, 100)).toBe(1);
    expect(clampLimit(1000, 20, 100)).toBe(100);
    expect(clampLimit(37, 20, 100)).toBe(37);
  });

  it("accepts numeric strings and truncates fractions", () => {
    expect(clampLimit("42", 20, 100)).toBe(42);
    expect(clampLimit(12.9, 20, 100)).toBe(12);
  });
});
