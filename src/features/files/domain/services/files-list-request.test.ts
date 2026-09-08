import { describe, expect, it } from "vitest";
import { buildFilesListRequest } from "./files-list-request";

describe("buildFilesListRequest", () => {
  it("loads all favorites from the files endpoint", () => {
    expect(
      buildFilesListRequest({
        filter: "favorites",
        folderId: null,
        search: "",
        limit: 100,
      })
    ).toBe("/api/files?limit=100&favorites=true");
  });

  it("keeps search within favorites", () => {
    expect(
      buildFilesListRequest({
        filter: "favorites",
        folderId: null,
        search: "roadmap",
        limit: 100,
        page: 2,
      })
    ).toBe("/api/search?q=roadmap&limit=100&favorites=true&page=2");
  });

  it("keeps regular folder searches unchanged", () => {
    expect(
      buildFilesListRequest({
        filter: "image",
        folderId: "91f96f68-f8cc-47df-902c-127f6a51eea3",
        search: "cover art",
        limit: 100,
      })
    ).toBe(
      "/api/search?q=cover+art&limit=100&folderId=91f96f68-f8cc-47df-902c-127f6a51eea3"
    );
  });
});
