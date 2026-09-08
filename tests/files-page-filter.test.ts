import { describe, expect, it, vi } from "vitest";

vi.mock("@files/presentation/components/files/file-browser", () => ({
  FileBrowser: vi.fn(() => null),
}));

const { default: FilesPage } = await import("@/app/files/(browser)/page");

describe("files page filter deep link", () => {
  it("passes the canonical favorites filter to the browser", async () => {
    const element = await FilesPage({
      searchParams: Promise.resolve({ filter: "favorites" }),
    });

    expect(element.props.filter).toBe("favorites");
  });

  it.each([undefined, "unknown", ["favorites"]] as const)(
    "falls back to all for malformed filter %j",
    async (filter) => {
      const element = await FilesPage({
        searchParams: Promise.resolve({ filter }),
      });

      expect(element.props.filter).toBe("all");
    }
  );
});
