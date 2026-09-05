import { describe, it, expect } from "vitest";
import { EXTRACT_AUDIO_SOURCE_MAX_BYTES } from "@files/domain/services/edit-limits";
import {
  SUBTITLE_REFUSAL_KEYS,
  canGenerateSubtitles,
  subtitleRefusalFor,
  supportsSubtitles,
} from "@files/domain/services/subtitles/eligibility";

/**
 * Every clause here mirrors a refusal the route will answer with, which is the whole point: a
 * CC button that appears on a file the server would refuse is a button whose only possible
 * outcome is an error. The same function decides whether the control renders and whether the
 * request is accepted, so the two cannot drift.
 *
 * The refusals are named rather than described, and the wording is looked up at render — the
 * reason `media-edit.ts` does the same. This module runs in the browser, in a route handler and
 * in the worker, and only the first of those knows which language the reader chose.
 */

const video = {
  mimeType: "video/mp4",
  encrypted: false,
  isNote: false,
  sizeBytes: 50_000_000,
};

describe("subtitleRefusalFor", () => {
  it("accepts an ordinary video", () => {
    expect(subtitleRefusalFor(video)).toBeNull();
  });

  it("accepts every container the app can actually play", () => {
    for (const mimeType of ["video/mp4", "video/webm", "video/x-matroska", "video/quicktime"]) {
      expect(subtitleRefusalFor({ ...video, mimeType }), mimeType).toBeNull();
    }
  });

  it("ignores a charset parameter and the case of the type", () => {
    expect(subtitleRefusalFor({ ...video, mimeType: "VIDEO/MP4" })).toBeNull();
    expect(subtitleRefusalFor({ ...video, mimeType: "video/mp4; codecs=avc1" })).toBeNull();
  });

  it("refuses anything that is not a video", () => {
    for (const mimeType of ["audio/mpeg", "image/png", "application/pdf", "text/plain", ""]) {
      expect(subtitleRefusalFor({ ...video, mimeType }), mimeType).toBe("mime");
    }
  });

  it("refuses an end-to-end encrypted file, because the server holds only ciphertext", () => {
    expect(subtitleRefusalFor({ ...video, encrypted: true })).toBe("encrypted");
  });

  it("refuses a note, which has no stored object to read", () => {
    expect(subtitleRefusalFor({ ...video, isNote: true })).toBe("note");
  });

  it("refuses a video larger than the worker will pull out of storage", () => {
    expect(subtitleRefusalFor({ ...video, sizeBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES + 1 })).toBe(
      "tooLarge"
    );
    expect(subtitleRefusalFor({ ...video, sizeBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES })).toBeNull();
  });

  it("accepts the size as the string a bigint column arrives as", () => {
    expect(subtitleRefusalFor({ ...video, sizeBytes: "50000000" })).toBeNull();
  });

  it("treats an unreadable size as too large rather than guessing small", () => {
    // Guessing small trades a hidden button for a 413 after the user has already waited.
    expect(subtitleRefusalFor({ ...video, sizeBytes: Number.NaN })).toBe("tooLarge");
    expect(subtitleRefusalFor({ ...video, sizeBytes: "not a number" })).toBe("tooLarge");
  });

  it("reports encryption before size, since that one can never be fixed by the user", () => {
    expect(
      subtitleRefusalFor({ ...video, encrypted: true, sizeBytes: EXTRACT_AUDIO_SOURCE_MAX_BYTES + 1 })
    ).toBe("encrypted");
  });
});

describe("supportsSubtitles", () => {
  it("is the same answer as no refusal", () => {
    expect(supportsSubtitles(video)).toBe(true);
    expect(supportsSubtitles({ ...video, encrypted: true })).toBe(false);
  });
});

describe("canGenerateSubtitles", () => {
  it("needs write permission, because generating one writes rows and spends money", () => {
    expect(canGenerateSubtitles({ ...video, canEdit: true })).toBe(true);
    expect(canGenerateSubtitles({ ...video, canEdit: false })).toBe(false);
  });

  it("still refuses a file that could never be transcribed, permission or not", () => {
    expect(canGenerateSubtitles({ ...video, canEdit: true, encrypted: true })).toBe(false);
  });
});

describe("SUBTITLE_REFUSAL_KEYS", () => {
  it("has a sentence for every refusal the checker can return", () => {
    for (const reason of ["mime", "encrypted", "note", "tooLarge"] as const) {
      expect(SUBTITLE_REFUSAL_KEYS[reason], reason).toMatch(/^files\.subtitles\./);
    }
  });
});
