import { describe, expect, it } from "vitest";
import {
  assertFileUploadTransition,
  assertUploadPartTransition,
  assertUploadSessionTransition,
  canTransitionFileUpload,
  InvalidUploadStateTransitionError,
  isFileAvailable,
} from "./upload-state";

describe("file upload state machine", () => {
  it("allows only the verified path to READY", () => {
    expect(() => assertFileUploadTransition("created", "ready")).toThrow(
      InvalidUploadStateTransitionError
    );
    expect(() => assertFileUploadTransition("uploading", "ready")).toThrow(
      InvalidUploadStateTransitionError
    );
    expect(() => assertFileUploadTransition("verifying", "ready")).not.toThrow();
  });

  it("supports failure, retry, cancellation, and deletion transitions", () => {
    expect(canTransitionFileUpload("uploading", "failed")).toBe(true);
    expect(canTransitionFileUpload("failed", "uploading")).toBe(true);
    expect(canTransitionFileUpload("uploading", "cancelled")).toBe(true);
    expect(canTransitionFileUpload("ready", "deleting")).toBe(true);
    expect(canTransitionFileUpload("ready", "inconsistent")).toBe(true);
    expect(canTransitionFileUpload("inconsistent", "verifying")).toBe(true);
    expect(canTransitionFileUpload("created", "deleting")).toBe(false);
    expect(canTransitionFileUpload("cancelled", "ready")).toBe(false);
  });

  it("treats only READY as available", () => {
    expect(isFileAvailable("ready")).toBe(true);
    expect(isFileAvailable("verifying")).toBe(false);
    expect(isFileAvailable("failed")).toBe(false);
    expect(isFileAvailable("legacy_unverified")).toBe(false);
  });

  it("does not allow a session to complete without verification", () => {
    expect(() => assertUploadSessionTransition("uploading", "completed")).toThrow(
      InvalidUploadStateTransitionError
    );
    expect(() => assertUploadSessionTransition("verifying", "completed")).not.toThrow();
  });

  it("allows failed parts to be retried", () => {
    expect(() => assertUploadPartTransition("pending", "uploaded")).not.toThrow();
    expect(() => assertUploadPartTransition("uploaded", "failed")).not.toThrow();
    expect(() => assertUploadPartTransition("failed", "pending")).not.toThrow();
  });
});
