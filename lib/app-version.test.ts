import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_VERSION, APP_VERSION_LABEL } from "./app-version";

/**
 * `APP_VERSION` is a literal so the browser bundle never has to carry
 * `package.json`. That trade only holds if drift is impossible, which is what
 * this test enforces: bump `package.json` and this fails until the constant
 * follows.
 */
describe("APP_VERSION", () => {
  it("matches the version declared in package.json", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { version: string };

    expect(APP_VERSION).toBe(manifest.version);
  });

  it("is a plain semver triple", () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("exposes a display label", () => {
    expect(APP_VERSION_LABEL).toBe(`v${APP_VERSION}`);
  });
});
