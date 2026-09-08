import { describe, expect, it } from "vitest";
import {
  getShellTitleKey,
  isNavigationPathActive,
  isSharingPath,
} from "./navigation-route";

describe("sharing route matching", () => {
  it.each([
    ["/shares", true],
    ["/shared-with-me/folder-1", true],
    ["/shared-with-me", false],
    ["/files", false],
  ])("matches %s", (pathname, expected) => {
    expect(isSharingPath(pathname)).toBe(expected);
  });

  it("keeps the Sharing navigation item active on detail routes", () => {
    expect(isNavigationPathActive("/shares", "/shares?view=received")).toBe(true);
    expect(isNavigationPathActive("/shared-with-me/folder-1", "/shares?view=received")).toBe(true);
    expect(isNavigationPathActive("/files", "/shares?view=received")).toBe(false);
  });
});

describe("getShellTitleKey", () => {
  it.each([
    ["/dashboard", "nav.dashboard"],
    ["/files", "nav.files"],
    ["/recycle-bin", "nav.recycleBin"],
    ["/shares", "nav.sharing"],
    ["/shared-with-me/folder-1", "nav.sharing"],
    ["/admin/users", "nav.admin"],
    ["/unknown", null],
  ] as const)("resolves %s", (pathname, expected) => {
    expect(getShellTitleKey(pathname)).toBe(expected);
  });

  it("keeps Favorites inside My Files instead of a standalone title", () => {
    // `/favorites` now redirects into `/files?filter=favorites`, so the standalone
    // title mapping must be gone — Files owns that destination.
    expect(getShellTitleKey("/favorites")).toBeNull();
    expect(getShellTitleKey("/files")).toBe("nav.files");
  });
});
