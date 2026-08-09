import { describe, expect, it } from "vitest";
import { assertDeletionTransition, canDeletionTransition } from "./deletion-state";

describe("deletion lifecycle", () => {
  it("allows retryable processing transitions", () => {
    expect(canDeletionTransition("created", "processing")).toBe(true);
    expect(canDeletionTransition("processing", "completed")).toBe(true);
    expect(canDeletionTransition("failed", "processing")).toBe(true);
    expect(canDeletionTransition("completed", "processing")).toBe(false);
  });

  it("rejects completed deletion being marked failed", () => {
    expect(() => assertDeletionTransition("completed", "failed")).toThrow(/Invalid deletion transition/);
  });
});
