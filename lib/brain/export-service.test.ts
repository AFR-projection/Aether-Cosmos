import { describe, it, expect, beforeEach, vi } from "vitest";
import { createHash } from "node:crypto";
import JSZip from "jszip";
import { getTableName } from "drizzle-orm";
import * as schema from "@/lib/db/schema";

/**
 * Reading a whole brain out of Postgres and into an `.afrbrain` zip.
 *
 * The promise of the format is that the brain outlives the app, so what matters here
 * is that the archive is complete, self-describing and honest: every brain-scoped
 * table is read once, the generated tsvector is stripped (derived data Postgres
 * rebuilds on import), every member is plain JSON Lines, and the manifest's per-member
 * sha256 matches the bytes actually written — otherwise an importer cannot tell
 * truncation from tampering.
 *
 * The version read is the one query this module owns, and it is joined through
 * `memories` so the brain filter still applies to a table that has no brain_id of its
 * own. `export-archive.test.ts` covers the pure manifest and filename helpers.
 */

type ReadCall = { table: string; join: unknown; where: unknown; order: unknown };

/** Flatten a Drizzle predicate into a searchable string (columns hold circular refs). */
function describeSql(node: unknown): string {
  const parts: string[] = [];
  const seen = new Set<unknown>();

  const walk = (value: unknown): void => {
    if (value === null || value === undefined) return;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      parts.push(String(value));
      return;
    }
    if (typeof value !== "object" || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    const record = value as Record<string, unknown>;
    if ("queryChunks" in record) walk(record.queryChunks);
    if ("value" in record) walk(record.value);
    else if (typeof record.name === "string") parts.push(record.name);
  };

  walk(node);
  return parts.join(" ");
}

const reads: ReadCall[] = [];
let versionRows: unknown[] = [];

function selectChain() {
  const call: ReadCall = { table: "", join: null, where: null, order: null };
  const chain = {
    from(table: unknown) {
      call.table = getTableName(table as never);
      return chain;
    },
    innerJoin(_table: unknown, condition: unknown) {
      call.join = condition;
      return chain;
    },
    where(condition: unknown) {
      call.where = condition;
      return chain;
    },
    orderBy(...args: unknown[]) {
      call.order = args;
      return chain;
    },
    then<T>(resolve: (value: unknown[]) => T) {
      reads.push(call);
      return Promise.resolve(versionRows).then(resolve);
    },
  };
  return chain;
}

vi.mock("@/lib/db", () => ({ db: { select: () => selectChain() } }));
const exportMemories = vi.fn();
const listBrainTags = vi.fn();
const exportProjects = vi.fn();
const exportGraph = vi.fn();
const exportMemoryLinks = vi.fn();

vi.mock("./memory-service", () => ({
  exportMemories: (...args: unknown[]) => exportMemories(...args),
  listBrainTags: (...args: unknown[]) => listBrainTags(...args),
}));
vi.mock("./project-service", () => ({
  exportProjects: (...args: unknown[]) => exportProjects(...args),
}));
vi.mock("./graph-service", () => ({
  exportGraph: (...args: unknown[]) => exportGraph(...args),
}));
vi.mock("./link-service", () => ({
  exportMemoryLinks: (...args: unknown[]) => exportMemoryLinks(...args),
}));

const {
  exportMemoryVersions,
  collectBrainArchive,
  buildBrainArchive,
  BRAIN_ARCHIVE_FORMAT,
  BRAIN_ARCHIVE_VERSION,
} = await import("./export-service");

const BRAIN = "11111111-1111-4111-8111-111111111111";
const OTHER_BRAIN = "99999999-9999-4999-8999-999999999999";
const VERSION_TABLE = getTableName(schema.memoryVersions);

const brain = { id: BRAIN, name: "Second Brain 2.0", description: "the real one" };

const MEMBERS = [
  "memories.jsonl",
  "memory_versions.jsonl",
  "memory_links.jsonl",
  "tags.jsonl",
  "projects.jsonl",
  "entities.jsonl",
  "relationships.jsonl",
];

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

beforeEach(() => {
  reads.length = 0;
  versionRows = [];
  exportMemories.mockReset().mockResolvedValue([]);
  listBrainTags.mockReset().mockResolvedValue([]);
  exportProjects.mockReset().mockResolvedValue([]);
  exportGraph.mockReset().mockResolvedValue({ entities: [], relationships: [] });
  exportMemoryLinks.mockReset().mockResolvedValue([]);
});

describe("exportMemoryVersions", () => {
  it("keeps the brain filter on a table that has no brain_id, by joining through memories", async () => {
    versionRows = [
      { version: { id: "v1", memoryId: "m1", versionNumber: 1 } },
      { version: { id: "v2", memoryId: "m1", versionNumber: 2 } },
    ];

    const versions = await exportMemoryVersions(BRAIN);

    expect(versions).toEqual([
      { id: "v1", memoryId: "m1", versionNumber: 1 },
      { id: "v2", memoryId: "m1", versionNumber: 2 },
    ]);
    const read = reads[0];
    expect(read.table).toBe(VERSION_TABLE);
    expect(describeSql(read.join)).toContain("memory_id");
    const predicate = describeSql(read.where);
    expect(predicate).toContain(BRAIN);
    expect(predicate).not.toContain(OTHER_BRAIN);
  });

  it("leaves out the history of deleted memories, and reads it in replay order", async () => {
    await exportMemoryVersions(BRAIN);

    expect(describeSql(reads[0].where)).toContain("deleted_at");
    const order = describeSql(reads[0].order);
    expect(order).toContain("memory_id");
    expect(order).toContain("version_number");
  });
});

describe("collectBrainArchive", () => {
  it("reads every brain-scoped table once, all for the same brain", async () => {
    await collectBrainArchive(BRAIN);

    for (const exporter of [exportMemories, listBrainTags, exportProjects, exportGraph, exportMemoryLinks]) {
      expect(exporter).toHaveBeenCalledOnce();
      expect(exporter).toHaveBeenCalledWith(BRAIN);
    }
    expect(reads).toHaveLength(1);
  });

  it("strips the generated tsvector and keeps everything else", async () => {
    // searchVector is derived data Postgres rebuilds on insert; shipping it would
    // roughly double the archive for nothing.
    exportMemories.mockResolvedValue([
      { id: "m1", title: "Deploy notes", content: "body", searchVector: "'deploy':1 'notes':2" },
    ]);

    const data = await collectBrainArchive(BRAIN);

    expect(data.memories).toEqual([{ id: "m1", title: "Deploy notes", content: "body" }]);
    expect(JSON.stringify(data)).not.toContain("searchVector");
  });

  it("splits the graph into its two members", async () => {
    exportGraph.mockResolvedValue({
      entities: [{ id: "e1", name: "Redis" }],
      relationships: [{ id: "r1", sourceEntityId: "e1", targetEntityId: "e2" }],
    });

    const data = await collectBrainArchive(BRAIN);

    expect(data.entities).toEqual([{ id: "e1", name: "Redis" }]);
    expect(data.relationships).toEqual([{ id: "r1", sourceEntityId: "e1", targetEntityId: "e2" }]);
  });
});

describe("buildBrainArchive", () => {
  it("writes a manifest and one member per table, and nothing else", async () => {
    const { bytes, filename } = await buildBrainArchive(brain);

    const zip = await JSZip.loadAsync(bytes);
    expect(Object.keys(zip.files).sort()).toEqual(["manifest.json", ...MEMBERS].sort());
    expect(filename).toBe(`second-brain-2-0-${new Date().toISOString().slice(0, 10)}.afrbrain`);
  });

  it("declares the format and the brain it came from", async () => {
    const { manifest, bytes } = await buildBrainArchive(brain);

    const zip = await JSZip.loadAsync(bytes);
    const written = JSON.parse(await zip.file("manifest.json")!.async("string"));
    expect(written).toEqual(manifest);
    expect(manifest.format).toBe(BRAIN_ARCHIVE_FORMAT);
    expect(manifest.formatVersion).toBe(BRAIN_ARCHIVE_VERSION);
    expect(manifest.brain).toEqual(brain);
  });

  it("checksums what it actually wrote, so a truncated member is detectable", async () => {
    exportMemories.mockResolvedValue([
      { id: "m1", title: "Deploy notes", searchVector: "'deploy':1" },
      { id: "m2", title: "Redis" },
    ]);
    exportGraph.mockResolvedValue({ entities: [{ id: "e1" }], relationships: [] });

    const { manifest, bytes } = await buildBrainArchive(brain);
    const zip = await JSZip.loadAsync(bytes);

    for (const member of manifest.members) {
      const content = await zip.file(member.path)!.async("string");
      expect(sha256(content), member.path).toBe(member.sha256);
      expect(content.split("\n").filter(Boolean)).toHaveLength(member.records);
    }
    expect(manifest.counts).toMatchObject({ memories: 2, entities: 1, relationships: 0 });
  });

  it("writes one JSON object per line, with the tsvector gone", async () => {
    exportMemories.mockResolvedValue([
      { id: "m1", title: "Deploy notes", searchVector: "'deploy':1" },
      { id: "m2", title: "Redis" },
    ]);

    const { bytes } = await buildBrainArchive(brain);
    const zip = await JSZip.loadAsync(bytes);
    const content = await zip.file("memories.jsonl")!.async("string");

    expect(content.endsWith("\n")).toBe(true);
    expect(content).not.toContain("searchVector");
    expect(content.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      { id: "m1", title: "Deploy notes" },
      { id: "m2", title: "Redis" },
    ]);
  });

  it("leaves an empty member empty rather than writing a stray newline", async () => {
    const { manifest, bytes } = await buildBrainArchive(brain);
    const zip = await JSZip.loadAsync(bytes);

    expect(await zip.file("tags.jsonl")!.async("string")).toBe("");
    expect(manifest.members.every((member) => member.records === 0)).toBe(true);
    expect(manifest.members.every((member) => member.sha256 === sha256(""))).toBe(true);
  });

  it("says in the archive itself that it holds no credentials", async () => {
    const { manifest } = await buildBrainArchive(brain);

    expect(manifest.notice).toContain("no passwords");
    // Everything except the disclaimer itself, which is allowed to name the things
    // it promises are absent.
    const serialized = JSON.stringify(manifest, (key, value) =>
      key === "notice" ? undefined : value
    ).toLowerCase();
    for (const forbidden of ["ownerid", "owneruserid", "apikey", "secret", "session", "email"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });
});

