import { describe, expect, it } from "vitest";
import {
  FILES_FAVORITES_HREF,
  buildFilesFilterHref,
  matchesFileFilter,
  resolveFilesFilter,
} from "./file-filter";

describe("resolveFilesFilter", () => {
  it("keeps every supported filter as a stable deep link value", () => {
    expect(resolveFilesFilter("all")).toBe("all");
    expect(resolveFilesFilter("image")).toBe("image");
    expect(resolveFilesFilter("video")).toBe("video");
    expect(resolveFilesFilter("audio")).toBe("audio");
    expect(resolveFilesFilter("document")).toBe("document");
    expect(resolveFilesFilter("archive")).toBe("archive");
    expect(resolveFilesFilter("favorites")).toBe("favorites");
  });

  it.each([undefined, null, "", "unknown", ["favorites"]] as const)(
    "defaults malformed value %j to all",
    (value) => {
      expect(resolveFilesFilter(value)).toBe("all");
    }
  );

  it("publishes the canonical favorites destination", () => {
    expect(FILES_FAVORITES_HREF).toBe("/files?filter=favorites");
  });

  it("builds canonical URLs for filter changes", () => {
    expect(buildFilesFilterHref("favorites")).toBe(FILES_FAVORITES_HREF);
    expect(buildFilesFilterHref("image")).toBe("/files?filter=image");
    expect(buildFilesFilterHref("all")).toBe("/files");
  });
});

describe("matchesFileFilter", () => {
  const image = { mimeType: "image/png", isFavorite: false };
  const favoriteDocument = { mimeType: "application/pdf", isFavorite: true };

  it("matches favorites by the stored favorite flag instead of MIME type", () => {
    expect(matchesFileFilter(image, "favorites")).toBe(false);
    expect(matchesFileFilter(favoriteDocument, "favorites")).toBe(true);
  });

  it("preserves MIME category matching", () => {
    expect(matchesFileFilter(image, "image")).toBe(true);
    expect(matchesFileFilter(favoriteDocument, "document")).toBe(true);
    expect(matchesFileFilter(image, "archive")).toBe(false);
  });
});
