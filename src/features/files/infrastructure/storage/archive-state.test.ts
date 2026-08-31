import { describe, expect, it } from "vitest";
import { assertArchiveTransition, canArchiveTransition, isArchiveAvailable } from "./archive-state";

describe("archive lifecycle", () => {
  it("allows only valid processing and completion paths", () => {
    expect(canArchiveTransition("created", "processing")).toBe(true);
    expect(canArchiveTransition("processing", "ready")).toBe(true);
    expect(canArchiveTransition("failed", "processing")).toBe(true);
    expect(canArchiveTransition("created", "ready")).toBe(false);
    expect(canArchiveTransition("expired", "ready")).toBe(false);
  });

  it("rejects arbitrary transitions", () => {
    expect(() => assertArchiveTransition("failed", "ready")).toThrow(/Invalid archive transition/);
  });

  it("makes only ready archives downloadable", () => {
    expect(isArchiveAvailable("ready")).toBe(true);
    expect(isArchiveAvailable("processing")).toBe(false);
    expect(isArchiveAvailable("failed")).toBe(false);
  });
});
