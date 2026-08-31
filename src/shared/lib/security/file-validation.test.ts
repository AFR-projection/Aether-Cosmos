import { describe, it, expect } from "vitest";
import {
  validateFileMagicBytes,
  detectMimeType,
} from "@/shared/lib/security/file-validation";

/** Build an ArrayBuffer from a list of byte values (padded so length >= 4). */
function buf(...bytes: number[]): ArrayBuffer {
  const arr = new Uint8Array(Math.max(bytes.length, 4));
  arr.set(bytes);
  return arr.buffer;
}

const JPEG = [0xff, 0xd8, 0xff, 0xe0];
const PNG = [0x89, 0x50, 0x4e, 0x47];
const PDF = [0x25, 0x50, 0x44, 0x46];
const ZIP = [0x50, 0x4b, 0x03, 0x04];

describe("detectMimeType", () => {
  it("detects JPEG / PNG / PDF / ZIP from magic bytes", () => {
    expect(detectMimeType(buf(...JPEG))).toBe("image/jpeg");
    expect(detectMimeType(buf(...PNG))).toBe("image/png");
    expect(detectMimeType(buf(...PDF))).toBe("application/pdf");
    expect(detectMimeType(buf(...ZIP))).toBe("application/zip");
  });

  it("returns null for unrecognized bytes", () => {
    expect(detectMimeType(buf(0x01, 0x02, 0x03, 0x04))).toBeNull();
  });
});

describe("validateFileMagicBytes", () => {
  it("passes when content matches the claimed MIME type", () => {
    const r = validateFileMagicBytes(buf(...PNG), "image/png");
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBe("image/png");
    expect(r.warning).toBeUndefined();
  });

  it("treats ZIP content claimed as a docx/xlsx as a match (Office XML is ZIP-based)", () => {
    const r = validateFileMagicBytes(
      buf(...ZIP),
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
    expect(r.valid).toBe(true);
    expect(r.warning).toBeUndefined();
  });

  it("flags a MIME mismatch with a warning but still allows it (documented behavior)", () => {
    // Claims PDF, but the bytes are actually PNG.
    const r = validateFileMagicBytes(buf(...PNG), "application/pdf");
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBe("image/png");
    expect(r.warning).toBeDefined();
    expect(r.warning).toContain("image/png");
  });

  it("skips validation for very small buffers (<4 bytes)", () => {
    const arr = new Uint8Array([0xff, 0xd8]); // 2 bytes
    const r = validateFileMagicBytes(arr.buffer, "image/jpeg");
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBeNull();
  });

  it("accepts text-like types without magic-byte checks", () => {
    const r = validateFileMagicBytes(buf(0x68, 0x69, 0x0a, 0x0a), "text/plain");
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBe("text/plain");
  });

  it("passes undetectable binary content through as valid with null mime", () => {
    const r = validateFileMagicBytes(
      buf(0x01, 0x02, 0x03, 0x04),
      "application/octet-stream"
    );
    expect(r.valid).toBe(true);
    expect(r.detectedMime).toBeNull();
  });
});
