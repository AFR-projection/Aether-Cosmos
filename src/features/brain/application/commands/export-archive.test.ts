import { describe, expect, it } from "vitest";
import {
  BRAIN_ARCHIVE_FORMAT,
  BRAIN_ARCHIVE_VERSION,
  archiveFileName,
  buildArchiveMembers,
  type BrainArchiveData,
} from "./export-service";

/** §36 — the manifest and member layout, which is the part importers depend on. */

const brain = { id: "b1", name: "My Second Brain", description: null };

function emptyData(): BrainArchiveData {
  return {
    memories: [],
    memoryVersions: [],
    tags: [],
    projects: [],
    entities: [],
    relationships: [],
    memoryLinks: [],
  } as unknown as BrainArchiveData;
}

describe("buildArchiveMembers", () => {
  it("declares the format and every expected member", () => {
    const { manifest, members } = buildArchiveMembers(brain, emptyData());

    expect(manifest.format).toBe(BRAIN_ARCHIVE_FORMAT);
    expect(manifest.formatVersion).toBe(BRAIN_ARCHIVE_VERSION);
    expect(members.map((member) => member.path)).toEqual([
      "memories.jsonl",
      "memory_versions.jsonl",
      "memory_links.jsonl",
      "tags.jsonl",
      "projects.jsonl",
      "entities.jsonl",
      "relationships.jsonl",
    ]);
    expect(Object.keys(manifest.counts)).toContain("memory_links");
  });

  it("checksums each member so truncation is detectable", () => {
    const data = emptyData();
    (data.memories as unknown[]).push({ id: "m1", title: "One" });
    const first = buildArchiveMembers(brain, data);

    (data.memories as unknown[]).push({ id: "m2", title: "Two" });
    const second = buildArchiveMembers(brain, data);

    const hashOf = (result: typeof first) =>
      result.manifest.members.find((member) => member.path === "memories.jsonl")!.sha256;

    expect(hashOf(first)).not.toBe(hashOf(second));
    expect(hashOf(first)).toMatch(/^[0-9a-f]{64}$/);
    expect(
      second.manifest.members.find((member) => member.path === "memories.jsonl")!.records
    ).toBe(2);
  });

  it("carries no credentials and says so", () => {
    const { manifest } = buildArchiveMembers(brain, emptyData());
    const serialized = JSON.stringify(manifest).toLowerCase();

    expect(manifest.notice).toMatch(/no passwords/i);
    for (const forbidden of ["password", "secret", "cookie", "token", "email"]) {
      // The notice is the only place these words may appear.
      const withoutNotice = JSON.stringify({ ...manifest, notice: "" }).toLowerCase();
      expect(withoutNotice).not.toContain(forbidden);
    }
    expect(serialized).toContain("afrbrain");
  });

  it("only reports the brain's own identity fields", () => {
    const { manifest } = buildArchiveMembers(
      { id: "b1", name: "Work", description: "Notes" },
      emptyData()
    );
    expect(Object.keys(manifest.brain).sort()).toEqual(["description", "id", "name"]);
  });
});

describe("archiveFileName", () => {
  it("slugifies the brain name and dates the file", () => {
    const at = new Date("2026-08-21T10:00:00.000Z");
    expect(archiveFileName("My Second Brain", at)).toBe("my-second-brain-2026-08-21.afrbrain");
  });

  it("survives a name with nothing usable in it", () => {
    expect(archiveFileName("!!! ???", new Date("2026-01-02T00:00:00.000Z"))).toBe(
      "brain-2026-01-02.afrbrain"
    );
  });

  it("cannot produce a path or a traversal", () => {
    const name = archiveFileName("../../etc/passwd", new Date("2026-01-02T00:00:00.000Z"));
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
  });
});
