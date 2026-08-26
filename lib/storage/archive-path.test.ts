import { describe, it, expect } from "vitest";
import {
  archiveFileName,
  archiveSegment,
  uniqueArchivePath,
} from "@/lib/storage/archive-path";

/**
 * Entry names for server-built ZIP archives.
 *
 * `filename` is validated for length only, so `files.name` can hold `../`, a
 * backslash, or a control character. Written verbatim into a ZIP entry that is a
 * zip-slip payload for whoever extracts the archive — and in a shared folder the
 * uploader is not the person downloading. These tests pin the flattening.
 */

const NUL = String.fromCharCode(0);
const BELL = String.fromCharCode(7);
const DEL = String.fromCharCode(0x7f);

describe("archiveSegment", () => {
  it("leaves an ordinary name alone", () => {
    expect(archiveSegment("report 2026.pdf")).toBe("report 2026.pdf");
  });

  it("flattens a POSIX traversal path into one segment", () => {
    expect(archiveSegment("../../etc/passwd")).toBe(".._.._etc_passwd");
  });

  it("flattens a Windows traversal path too", () => {
    expect(archiveSegment("..\\..\\Windows\\System32\\evil.dll")).toBe(
      ".._.._Windows_System32_evil.dll"
    );
  });

  it("does not leave an absolute path absolute", () => {
    expect(archiveSegment("/etc/shadow").startsWith("/")).toBe(false);
    expect(archiveSegment("/etc/shadow")).toBe("_etc_shadow");
  });

  it("strips control characters and DEL", () => {
    expect(archiveSegment(`a${NUL}b${BELL}c${DEL}d`)).toBe("a_b_c_d");
    expect(archiveSegment("line\nbreak\ttab\r")).toBe("line_break_tab_");
  });

  it("never returns a name that means the current or parent directory", () => {
    expect(archiveSegment(".")).toBe("_");
    expect(archiveSegment("..")).toBe("_");
  });

  it("never returns an empty name", () => {
    expect(archiveSegment("")).toBe("_");
    expect(archiveSegment("   ")).toBe("_");
    expect(archiveSegment(NUL)).toBe("_");
  });

  it("keeps a leading dot when the name is a real dotfile", () => {
    expect(archiveSegment(".env")).toBe(".env");
    expect(archiveSegment("...")).toBe("...");
  });

  it("keeps non-ASCII names intact", () => {
    expect(archiveSegment("laporan-küche-日本語.txt")).toBe("laporan-küche-日本語.txt");
  });

  it("is idempotent — sanitizing twice changes nothing", () => {
    const once = archiveSegment("../a\\b\nc");
    expect(archiveSegment(once)).toBe(once);
  });
});

describe("archiveFileName", () => {
  it("appends .zip to a plain name", () => {
    expect(archiveFileName("Invoices")).toBe("Invoices.zip");
  });

  it("does not double the extension, whatever its case", () => {
    expect(archiveFileName("Invoices.zip")).toBe("Invoices.zip");
    expect(archiveFileName("Invoices.ZIP")).toBe("Invoices.zip");
  });

  it("sanitizes the folder name before using it", () => {
    expect(archiveFileName("../../etc")).toBe(".._.._etc.zip");
    expect(archiveFileName(`quarter${NUL}1`)).toBe("quarter_1.zip");
  });

  it("always yields a safe name, never an empty one", () => {
    // An unusable folder name becomes the placeholder segment, not "".
    expect(archiveFileName("")).toBe("_.zip");
    expect(archiveFileName("..")).toBe("_.zip");
    // Here the whole name IS the extension, so there is no base left to keep.
    expect(archiveFileName(".zip")).toBe("archive.zip");
  });
});

describe("uniqueArchivePath", () => {
  it("returns the first occurrence unchanged", () => {
    const used = new Map<string, number>();
    expect(uniqueArchivePath("a.txt", used)).toBe("a.txt");
  });

  it("suffixes repeats before the extension", () => {
    const used = new Map<string, number>();
    expect(uniqueArchivePath("a.txt", used)).toBe("a.txt");
    expect(uniqueArchivePath("a.txt", used)).toBe("a (1).txt");
    expect(uniqueArchivePath("a.txt", used)).toBe("a (2).txt");
  });

  it("suffixes at the end when there is no extension", () => {
    const used = new Map<string, number>();
    uniqueArchivePath("README", used);
    expect(uniqueArchivePath("README", used)).toBe("README (1)");
  });

  it("treats a dotfile as having no extension to split", () => {
    const used = new Map<string, number>();
    uniqueArchivePath(".env", used);
    expect(uniqueArchivePath(".env", used)).toBe(".env (1)");
  });

  it("keeps the parent directory of a nested path", () => {
    const used = new Map<string, number>();
    uniqueArchivePath("docs/spec.md", used);
    expect(uniqueArchivePath("docs/spec.md", used)).toBe("docs/spec (1).md");
  });

  it("counts each path independently", () => {
    const used = new Map<string, number>();
    uniqueArchivePath("a.txt", used);
    uniqueArchivePath("b.txt", used);
    expect(uniqueArchivePath("b.txt", used)).toBe("b (1).txt");
    expect(uniqueArchivePath("a.txt", used)).toBe("a (1).txt");
  });

  it("never collides across a run of identical names", () => {
    const used = new Map<string, number>();
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      seen.add(uniqueArchivePath("dup.bin", used));
    }
    expect(seen.size).toBe(50);
  });
});
