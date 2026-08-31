import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  IMPORT_MAX_MEMBERS,
  parseBrainArchive,
  planImport,
  previewImport,
  type ParsedArchive,
} from "./import-service";
import { BRAIN_ARCHIVE_FORMAT, BRAIN_ARCHIVE_VERSION } from "./export-service";

/**
 * §37 — validation and the read-only preview. Everything here runs without a database
 * because that is the point: nothing on this path is allowed to write.
 */

type Members = Record<string, unknown[]>;

async function makeArchive(
  members: Members,
  manifestOverrides: Record<string, unknown> = {}
): Promise<Uint8Array> {
  const zip = new JSZip();
  const jsonl = (records: unknown[]) =>
    records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");

  zip.file(
    "manifest.json",
    JSON.stringify({
      format: BRAIN_ARCHIVE_FORMAT,
      formatVersion: BRAIN_ARCHIVE_VERSION,
      exportedAt: "2026-08-20T00:00:00.000Z",
      brain: { id: "source-brain", name: "Their Brain" },
      ...manifestOverrides,
    })
  );
  for (const [path, records] of Object.entries(members)) zip.file(path, jsonl(records));

  return zip.generateAsync({ type: "uint8array" });
}

const oneMemory = {
  id: "m1",
  type: "decision",
  title: "Use Postgres",
  content: "Every memory row lives in Postgres.",
  tags: ["infra", "INFRA", " infra "],
};

describe("parseBrainArchive", () => {
  it("reads a well-formed archive", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive({ "memories.jsonl": [oneMemory] })
    );

    expect(parsed.memories).toHaveLength(1);
    expect(parsed.memories[0].title).toBe("Use Postgres");
    expect(parsed.sourceBrainName).toBe("Their Brain");
    expect(parsed.formatVersion).toBe(BRAIN_ARCHIVE_VERSION);
  });

  it("strips every ownership field the archive tries to assert", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive({
        "memories.jsonl": [
          {
            ...oneMemory,
            brainId: "attacker-brain",
            createdBy: "attacker-user",
            createdByAgent: "attacker-agent",
            deletedAt: null,
          },
        ],
      })
    );

    const record = parsed.memories[0] as Record<string, unknown>;
    expect(record.brainId).toBeUndefined();
    expect(record.createdBy).toBeUndefined();
    expect(record.createdByAgent).toBeUndefined();
    expect(JSON.stringify(parsed)).not.toContain("attacker");
  });

  it("rejects a non-zip payload", async () => {
    await expect(parseBrainArchive(new TextEncoder().encode("not a zip"))).rejects.toThrow(
      /readable \.afrbrain archive/i
    );
  });

  it("rejects an archive with no manifest", async () => {
    const zip = new JSZip();
    zip.file("memories.jsonl", JSON.stringify(oneMemory) + "\n");
    await expect(parseBrainArchive(await zip.generateAsync({ type: "uint8array" }))).rejects.toThrow(
      /missing manifest/i
    );
  });

  it("rejects a manifest from a newer format version", async () => {
    await expect(
      parseBrainArchive(
        await makeArchive(
          { "memories.jsonl": [oneMemory] },
          { formatVersion: BRAIN_ARCHIVE_VERSION + 1 }
        )
      )
    ).rejects.toThrow(/newer than this server supports/i);
  });

  it("rejects an archive that declares a foreign format", async () => {
    await expect(
      parseBrainArchive(
        await makeArchive({ "memories.jsonl": [oneMemory] }, { format: "something-else" })
      )
    ).rejects.toThrow(/not a valid \.afrbrain manifest/i);
  });

  it("rejects an archive with nothing importable in it", async () => {
    await expect(parseBrainArchive(await makeArchive({ "memories.jsonl": [] }))).rejects.toThrow(
      /no memories or entities/i
    );
  });

  it("rejects too many members", async () => {
    const members: Members = { "memories.jsonl": [oneMemory] };
    for (let i = 0; i < IMPORT_MAX_MEMBERS + 2; i += 1) members[`extra-${i}.jsonl`] = [];
    await expect(parseBrainArchive(await makeArchive(members))).rejects.toThrow(/too many members/i);
  });

  it("skips malformed lines and unknown enum values instead of failing the import", async () => {
    const zip = new JSZip();
    zip.file(
      "manifest.json",
      JSON.stringify({ format: BRAIN_ARCHIVE_FORMAT, formatVersion: BRAIN_ARCHIVE_VERSION })
    );
    zip.file(
      "memories.jsonl",
      [
        JSON.stringify(oneMemory),
        "{ this is not json",
        JSON.stringify({ ...oneMemory, id: "m2", type: "not-a-real-type" }),
        JSON.stringify({ id: "m3", title: "", content: "empty title is invalid" }),
      ].join("\n")
    );

    const parsed = await parseBrainArchive(await zip.generateAsync({ type: "uint8array" }));
    expect(parsed.memories).toHaveLength(1);
    expect(parsed.warnings.join(" ")).toMatch(/skipped 3 invalid record/);
  });

  it("warns when a member checksum does not match the manifest", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive(
        { "memories.jsonl": [oneMemory] },
        { members: [{ path: "memories.jsonl", records: 1, sha256: "0".repeat(64) }] }
      )
    );
    expect(parsed.warnings.join(" ")).toMatch(/checksum does not match/i);
  });

  it("normalizes tag casing and whitespace", async () => {
    const parsed = await parseBrainArchive(
      await makeArchive({
        "memories.jsonl": [oneMemory],
        "tags.jsonl": [{ name: "Infra" }, { name: "infra" }],
      })
    );
    expect(planImport(parsed).tags).toEqual(["infra"]);
  });
});

function parsed(overrides: Partial<ParsedArchive> = {}): ParsedArchive {
  return {
    sourceBrainName: "Their Brain",
    exportedAt: null,
    formatVersion: BRAIN_ARCHIVE_VERSION,
    memories: [],
    memoryVersions: [],
    memoryLinks: [],
    tags: [],
    projects: [],
    entities: [],
    relationships: [],
    warnings: [],
    ...overrides,
  } as ParsedArchive;
}

const memoryA = { id: "m1", title: "A", content: "a" };
const memoryB = { id: "m2", title: "B", content: "b" };

describe("planImport", () => {
  it("drops versions whose memory is not in the archive", () => {
    const plan = planImport(
      parsed({
        memories: [memoryA] as ParsedArchive["memories"],
        memoryVersions: [
          { memoryId: "m1", versionNumber: 1, title: "A", content: "old" },
          { memoryId: "ghost", versionNumber: 1, title: "?", content: "old" },
        ] as ParsedArchive["memoryVersions"],
      })
    );

    expect(plan.memoryVersions).toHaveLength(1);
    expect(plan.dropped.versionsWithoutMemory).toBe(1);
  });

  it("drops links pointing at something the archive never contained", () => {
    const plan = planImport(
      parsed({
        memories: [memoryA, memoryB] as ParsedArchive["memories"],
        entities: [{ id: "e1", name: "Postgres" }] as ParsedArchive["entities"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "m2" },
          { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "ghost" },
          { sourceMemoryId: "ghost", targetType: "memory", targetMemoryId: "m2" },
          { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "e1" },
          { sourceMemoryId: "m1", targetType: "entity", targetEntityId: "ghost" },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(plan.memoryLinks).toHaveLength(2);
    expect(plan.dropped.linksWithMissingEnd).toBe(3);
  });

  it("never keeps a self-link", () => {
    const plan = planImport(
      parsed({
        memories: [memoryA] as ParsedArchive["memories"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "m1" },
        ] as ParsedArchive["memoryLinks"],
      })
    );

    expect(plan.memoryLinks).toEqual([]);
  });

  it("drops relationships with a missing or self endpoint", () => {
    const plan = planImport(
      parsed({
        memories: [memoryA] as ParsedArchive["memories"],
        entities: [
          { id: "e1", name: "Postgres" },
          { id: "e2", name: "Supabase" },
        ] as ParsedArchive["entities"],
        relationships: [
          { sourceEntityId: "e1", targetEntityId: "e2", relationshipType: "hosted_by" },
          { sourceEntityId: "e1", targetEntityId: "ghost", relationshipType: "hosted_by" },
          { sourceEntityId: "e1", targetEntityId: "e1", relationshipType: "hosted_by" },
        ] as ParsedArchive["relationships"],
      })
    );

    expect(plan.relationships).toHaveLength(1);
    expect(plan.dropped.relationshipsWithMissingEnd).toBe(2);
  });

  it("clears a project reference the archive did not carry", () => {
    const plan = planImport(
      parsed({
        memories: [{ ...memoryA, projectId: "p-ghost" }] as ParsedArchive["memories"],
      })
    );

    expect(plan.memories[0].projectId).toBeNull();
    expect(plan.dropped.projectRefsCleared).toBe(1);
  });

  it("keeps a project reference the archive does carry", () => {
    const plan = planImport(
      parsed({
        memories: [{ ...memoryA, projectId: "p1" }] as ParsedArchive["memories"],
        projects: [{ id: "p1", name: "Storage" }] as ParsedArchive["projects"],
      })
    );

    expect(plan.memories[0].projectId).toBe("p1");
    expect(plan.dropped.projectRefsCleared).toBe(0);
  });

  it("collects tags from the tag member and from each memory", () => {
    const plan = planImport(
      parsed({
        memories: [{ ...memoryA, tags: ["Infra", "db"] }] as ParsedArchive["memories"],
        tags: ["infra", "ops"],
      })
    );

    // normalizeTags dedupes case-insensitively; order follows first appearance.
    expect([...plan.tags].sort()).toEqual(["db", "infra", "ops"]);
  });
});

describe("previewImport", () => {
  it("reports counts and drops without touching the database", () => {
    const preview = previewImport(
      parsed({
        memories: [memoryA, memoryB] as ParsedArchive["memories"],
        memoryLinks: [
          { sourceMemoryId: "m1", targetType: "memory", targetMemoryId: "ghost" },
        ] as ParsedArchive["memoryLinks"],
        warnings: ["memories.jsonl: skipped 1 invalid record(s)"],
      })
    );

    expect(preview.counts.memories).toBe(2);
    expect(preview.counts.memoryLinks).toBe(0);
    expect(preview.dropped.linksWithMissingEnd).toBe(1);
    expect(preview.warnings).toHaveLength(1);
    expect(preview.sourceBrainName).toBe("Their Brain");
  });
});
