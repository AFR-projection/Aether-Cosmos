import { createHash } from "node:crypto";
import JSZip from "jszip";
import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { memories, memoryVersions, type Brain, type MemoryVersion } from "@/shared/infrastructure/db/schema";
import { exportGraph } from "@brain/application/queries/graph-service";
import { exportMemoryLinks } from "./link-service";
import { exportMemories, listBrainTags } from "./memory-service";
import { exportProjects } from "./project-service";

/**
 * The `.afrbrain` archive (§36) — a portable, self-describing zip of one brain.
 *
 * The point of the format is the promise in the spec: the Brain outlives the app.
 * So every member is plain JSON Lines (greppable, streamable, diffable), the manifest
 * carries a format version plus a sha256 per member so an importer can tell
 * truncation from tampering, and nothing that is not brain content goes in — no
 * credentials, no session data, no owner email, no API keys (§36, §103.9).
 *
 * The generated tsvector column is stripped: it is derived data that Postgres
 * rebuilds on insert, and shipping it would double the archive for nothing.
 */

export const BRAIN_ARCHIVE_FORMAT = "afrbrain";

/** Bump only for a breaking change to member names or record shapes. */
export const BRAIN_ARCHIVE_VERSION = 1;

export type BrainArchiveManifest = {
  format: typeof BRAIN_ARCHIVE_FORMAT;
  formatVersion: number;
  exportedAt: string;
  generator: string;
  brain: { id: string; name: string; description: string | null };
  members: { path: string; records: number; sha256: string }[];
  counts: Record<string, number>;
  notice: string;
};

type Member = { path: string; records: unknown[] };

/** Versions of every live memory in the brain, joined so the filter stays brain-scoped. */
export async function exportMemoryVersions(brainId: string): Promise<MemoryVersion[]> {
  const rows = await db
    .select({ version: memoryVersions })
    .from(memoryVersions)
    .innerJoin(memories, eq(memories.id, memoryVersions.memoryId))
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt)))
    .orderBy(asc(memoryVersions.memoryId), asc(memoryVersions.versionNumber));
  return rows.map((row) => row.version);
}

function jsonl(records: unknown[]): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Read every brain-scoped table once. Split out from the zip step so the same
 * collection can back a JSON response, a test, or a future streaming writer.
 */
export async function collectBrainArchive(brainId: string) {
  const [memoryRows, versions, tags, projects, graph, links] = await Promise.all([
    exportMemories(brainId),
    exportMemoryVersions(brainId),
    listBrainTags(brainId),
    exportProjects(brainId),
    exportGraph(brainId),
    exportMemoryLinks(brainId),
  ]);

  // searchVector is a generated tsvector — derived, huge, and rebuilt on import.
  const cleanMemories = memoryRows.map((row) => {
    const rest: Record<string, unknown> = { ...row };
    delete rest.searchVector;
    return rest;
  });

  return {
    memories: cleanMemories,
    memoryVersions: versions,
    tags,
    projects,
    entities: graph.entities,
    relationships: graph.relationships,
    memoryLinks: links,
  };
}

export type BrainArchiveData = Awaited<ReturnType<typeof collectBrainArchive>>;

/** Turn collected data into the manifest + ordered member list. */
export function buildArchiveMembers(
  brain: Pick<Brain, "id" | "name" | "description">,
  data: BrainArchiveData
): { manifest: BrainArchiveManifest; members: Member[] } {
  const members: Member[] = [
    { path: "memories.jsonl", records: data.memories },
    { path: "memory_versions.jsonl", records: data.memoryVersions },
    { path: "memory_links.jsonl", records: data.memoryLinks },
    { path: "tags.jsonl", records: data.tags },
    { path: "projects.jsonl", records: data.projects },
    { path: "entities.jsonl", records: data.entities },
    { path: "relationships.jsonl", records: data.relationships },
  ];

  const manifest: BrainArchiveManifest = {
    format: BRAIN_ARCHIVE_FORMAT,
    formatVersion: BRAIN_ARCHIVE_VERSION,
    exportedAt: new Date().toISOString(),
    generator: "aether-cosmos-byafr/second-brain",
    brain: { id: brain.id, name: brain.name, description: brain.description ?? null },
    members: members.map((member) => ({
      path: member.path,
      records: member.records.length,
      sha256: sha256(jsonl(member.records)),
    })),
    counts: Object.fromEntries(
      members.map((member) => [member.path.replace(/\.jsonl$/, ""), member.records.length])
    ),
    notice:
      "Brain content only. Contains no passwords, API secrets, session cookies, or account credentials.",
  };

  return { manifest, members };
}

/** A filesystem-safe archive name derived from the brain's own name. */
export function archiveFileName(brainName: string, at = new Date()): string {
  const slug =
    brainName
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "brain";
  return `${slug}-${at.toISOString().slice(0, 10)}.afrbrain`;
}

/**
 * Build the whole archive in memory. Brains are text — a very large one is single-digit
 * megabytes — so buffering is the right trade for a correct zip central directory here;
 * if that ever stops being true this is the one function to replace.
 */
export async function buildBrainArchive(
  brain: Pick<Brain, "id" | "name" | "description">
): Promise<{ filename: string; manifest: BrainArchiveManifest; bytes: Uint8Array }> {
  const data = await collectBrainArchive(brain.id);
  const { manifest, members } = buildArchiveMembers(brain, data);

  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify(manifest, null, 2));
  for (const member of members) zip.file(member.path, jsonl(member.records));

  const bytes = await zip.generateAsync({
    type: "uint8array",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });

  return { filename: archiveFileName(brain.name), manifest, bytes };
}
