import { describe, expect, it } from "vitest";
import { thumbnailCandidates } from "./thumbnail-keys";

describe("thumbnail candidates", () => {
  it("prefers the current version sibling before mutable legacy keys", () => {
    expect(
      thumbnailCandidates({
        fileId: "file-1",
        version: 7,
        size: 600,
        thumbnailKey: "thumbnails/file-1/v7/300.webp",
      }),
    ).toEqual([
      "thumbnails/file-1/v7/600.webp",
      "thumbnails/file-1/v7/300.webp",
      "thumbnails/file-1_600.webp",
      "thumbnails/file-1.jpg",
    ]);
  });

  it("does not derive siblings from another version pointer", () => {
    expect(
      thumbnailCandidates({
        fileId: "file-1",
        version: 8,
        size: 150,
        thumbnailKey: "thumbnails/file-1/v7/300.webp",
      }),
    ).toEqual([
      "thumbnails/file-1/v8/150.webp",
      "thumbnails/file-1/v7/300.webp",
      "thumbnails/file-1_150.webp",
      "thumbnails/file-1.jpg",
    ]);
  });
});
