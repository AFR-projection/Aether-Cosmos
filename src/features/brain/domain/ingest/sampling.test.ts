import { describe, expect, it } from "vitest";
import {
  DEFAULT_SAMPLE_RATE,
  hash32,
  hashFraction,
  normalizeSampleRate,
  passesSampling,
} from "./sampling";

describe("deterministic ingest sampling", () => {
  it("returns stable hashes and fractions", () => {
    expect(hash32("same input")).toBe(hash32("same input"));
    expect(hash32("same input")).not.toBe(hash32("different input"));
    expect(hashFraction("candidate")).toBeGreaterThanOrEqual(0);
    expect(hashFraction("candidate")).toBeLessThan(1);
  });

  it("makes repeatable decisions for a session and candidate", () => {
    const decisions = Array.from({ length: 10 }, () =>
      passesSampling("Keep this durable decision", "session-1", 0.37)
    );

    expect(new Set(decisions).size).toBe(1);
  });

  it("honors edge rates", () => {
    expect(passesSampling("anything", "session", 0)).toBe(false);
    expect(passesSampling("anything", "session", -1)).toBe(false);
    expect(passesSampling("anything", "session", 1)).toBe(true);
    expect(passesSampling("anything", "session", 2)).toBe(true);
  });

  it("clamps caller values and falls back for non-numbers", () => {
    expect(normalizeSampleRate(-2)).toBe(0);
    expect(normalizeSampleRate(2)).toBe(1);
    expect(normalizeSampleRate("0.25")).toBe(0.25);
    expect(normalizeSampleRate("invalid")).toBe(DEFAULT_SAMPLE_RATE);
  });
});
