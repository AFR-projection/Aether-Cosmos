import { describe, expect, it } from "vitest";
import {
  calculateMultipartPartCount,
  calculateMultipartPartSize,
  MULTIPART_MAX_PARTS,
  MULTIPART_MIN_PART_SIZE_BYTES,
  MULTIPART_MIN_SIZE_BYTES,
  shouldUseMultipart,
} from "./upload-service";

describe("upload planning", () => {
  it("keeps small files on a single PUT path", () => {
    expect(shouldUseMultipart(1)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_MIN_SIZE_BYTES - 1)).toBe(false);
    expect(shouldUseMultipart(MULTIPART_MIN_SIZE_BYTES)).toBe(true);
  });

  it("uses a bounded part count for very large objects", () => {
    const fiveTiB = 5 * 1024 ** 4;
    const partSize = calculateMultipartPartSize(fiveTiB);
    expect(partSize).toBeGreaterThanOrEqual(MULTIPART_MIN_PART_SIZE_BYTES);
    expect(calculateMultipartPartCount(fiveTiB, partSize)).toBeLessThanOrEqual(MULTIPART_MAX_PARTS);
  });

  it("rejects invalid part sizes", () => {
    expect(() => calculateMultipartPartCount(100, 0)).toThrow("part size");
    expect(() => calculateMultipartPartCount(1, 1)).not.toThrow();
  });
});
