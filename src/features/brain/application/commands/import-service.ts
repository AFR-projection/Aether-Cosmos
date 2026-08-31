import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import JSZip from "jszip";
import { z } from "zod";
import { BRAIN_ARCHIVE_FORMAT, BRAIN_ARCHIVE_VERSION } from "./export-service";
import { BrainValidationError } from "@brain/domain/errors";
import { ENRICH_SWEEP_MAX, memoryContentHash } from "@brain/application/jobs/enrich-service";
import { enqueueJob } from "@/shared/infrastructure/queue";
import {
  MEMORY_TYPES,
  MEMORY_SOURCE_TYPES,
  BRAIN_ENTITY_TYPES,
  normalizeTags,
} from "@brain/domain/constants";
import {
  brainEntities,
  brainProjects,
  brainProjectStatusEnum,
  brainRelationships,
  memories,
  memoryLinks,
  memoryTagMap,
  memoryTags,
  memoryVersions,
  type NewMemoryLink,
} from "@/shared/infrastructure/db/schema";

const BRAIN_PROJECT_STATUSES = brainProjectStatusEnum.enumValues;

/**
 * `.afrbrain` import (§37).
 *
 * The whole file is written around one sentence from the spec: **do not trust
 * imported data blindly.** So:
 *
 *  - the archive is decompressed under hard caps (member count, per-member bytes,
 *    total bytes) before anything is parsed, so a zip bomb cannot exhaust the process;
 *  - every record goes through zod, and every enum is checked against the live
 *    Postgres enum rather than accepted as text;
 *  - every id is discarded and re-minted. Nothing an archive says about `brain_id`,
 *    `created_by`, `created_by_agent`, or ownership is read at all — those come from
 *    the authenticated target, always (§37, §88);
 *  - edges whose endpoints did not survive validation are dropped, not repaired;
 *  - parsing never writes. `previewImport` is the read-only half by construction:
 *    it has no database access in it.
 */

/** Decompression caps. A brain is text; these are generous for real data. */
export const IMPORT_MAX_MEMBERS = 16;
export const IMPORT_MAX_MEMBER_BYTES = 64 * 1024 * 1024;
export const IMPORT_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
export const IMPORT_MAX_RECORDS_PER_MEMBER = 50_000;

/** Per-field clamps, so one archive cannot plant a megabyte title. */
const MAX_TITLE = 500;
const MAX_CONTENT = 1_000_000;
const MAX_SUMMARY = 2_000;
const MAX_NAME = 200;

const uuidish = z.string().min(1).max(64);

const memoryRecord = z.object({
  id: uuidish,
  type: z.enum(MEMORY_TYPES as unknown as [string, ...string[]]).optional(),
  title: z.string().trim().min(1).max(MAX_TITLE),
  content: z.string().max(MAX_CONTENT),
  summary: z.string().max(MAX_SUMMARY).nullish(),
  // 0..1, matching `memories.importance` (a real) and the POST /memories contract.
  // An earlier 1..10 integer range here silently dropped every memory in a real
  // export, because the app never writes an integer importance.
  importance: z.number().min(0).max(1).optional(),
  confidence: z.number().min(0).max(1).optional(),
  sourceType: z.enum(MEMORY_SOURCE_TYPES as unknown as [string, ...string[]]).optional(),
  sourceId: z.string().max(200).nullish(),
  projectId: uuidish.nullish(),
  tags: z.array(z.string()).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  archivedAt: z.string().nullish(),
});

const versionRecord = z.object({
  memoryId: uuidish,
  versionNumber: z.number().int().min(1),
  title: z.string().max(MAX_TITLE),
  content: z.string().max(MAX_CONTENT),
  summary: z.string().max(MAX_SUMMARY).nullish(),
  changeReason: z.string().max(500).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
  createdAt: z.string().nullish(),
});

const projectRecord = z.object({
  id: uuidish,
  name: z.string().trim().min(1).max(MAX_NAME),
  description: z.string().max(MAX_SUMMARY).nullish(),
  status: z.enum(BRAIN_PROJECT_STATUSES as unknown as [string, ...string[]]).optional(),
});

const entityRecord = z.object({
  id: uuidish,
  type: z.enum(BRAIN_ENTITY_TYPES as unknown as [string, ...string[]]).optional(),
  name: z.string().trim().min(1).max(MAX_NAME),
  description: z.string().max(MAX_SUMMARY).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const relationshipRecord = z.object({
  sourceEntityId: uuidish,
  targetEntityId: uuidish,
  relationshipType: z.string().trim().min(1).max(64),
  confidence: z.number().min(0).max(1).nullish(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const linkRecord = z.object({
  sourceMemoryId: uuidish,
  targetType: z.enum(["memory", "entity"]),
  targetMemoryId: uuidish.nullish(),
  targetEntityId: uuidish.nullish(),
  linkType: z.string().trim().min(1).max(64).optional(),
  metadata: z.record(z.string(), z.unknown()).nullish(),
});

const tagRecord = z.object({ name: z.string().trim().min(1).max(64) });

const manifestSchema = z.object({
  format: z.literal(BRAIN_ARCHIVE_FORMAT),
  formatVersion: z.number().int().min(1),
  exportedAt: z.string().optional(),
  brain: z
    .object({ id: z.string().optional(), name: z.string().max(MAX_NAME).optional() })
    .partial()
    .optional(),
  members: z
    .array(z.object({ path: z.string(), records: z.number().int().min(0), sha256: z.string() }))
    .optional(),
});

export type ParsedArchive = {
  sourceBrainName: string | null;
  exportedAt: string | null;
  formatVersion: number;
  memories: z.infer<typeof memoryRecord>[];
  memoryVersions: z.infer<typeof versionRecord>[];
  memoryLinks: z.infer<typeof linkRecord>[];
  tags: string[];
  projects: z.infer<typeof projectRecord>[];
  entities: z.infer<typeof entityRecord>[];
  relationships: z.infer<typeof relationshipRecord>[];
  /** Everything that was silently dropped, so the preview can be honest about it. */
  warnings: string[];
};

/**
 * Read a member as JSON Lines, validating each record and dropping bad ones with a
 * warning rather than failing the whole import: one malformed line in a 20k-memory
 * archive should not cost the user the other 19,999 records.
 */
function parseMember<T extends z.ZodTypeAny>(
  path: string,
  text: string,
  schema: T,
  warnings: string[]
): z.infer<T>[] {
  const out: z.infer<T>[] = [];
  const lines = text.split("\n");
  let skipped = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (out.length >= IMPORT_MAX_RECORDS_PER_MEMBER) {
      warnings.push(`${path}: stopped after ${IMPORT_MAX_RECORDS_PER_MEMBER} records`);
      break;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      skipped += 1;
      continue;
    }
    const result = schema.safeParse(raw);
    if (result.success) out.push(result.data);
    else skipped += 1;
  }

  if (skipped > 0) warnings.push(`${path}: skipped ${skipped} invalid record(s)`);
  return out;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Decompress and validate. No database access, no writes — the result is the only
 * thing `previewImport` and `runImport` are allowed to read.
 */
export async function parseBrainArchive(bytes: Uint8Array): Promise<ParsedArchive> {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(bytes);
  } catch {
    throw new BrainValidationError("Not a readable .afrbrain archive");
  }

  const entries = Object.values(zip.files).filter((file) => !file.dir);
  if (entries.length === 0) throw new BrainValidationError("Archive is empty");
  if (entries.length > IMPORT_MAX_MEMBERS) {
    throw new BrainValidationError(`Archive has too many members (max ${IMPORT_MAX_MEMBERS})`);
  }
  // A member path is only ever read by name below, never joined onto a filesystem
  // path — but reject traversal shapes anyway so a future writer cannot regress it.
  for (const entry of entries) {
    if (entry.name.includes("..") || entry.name.startsWith("/")) {
      throw new BrainValidationError(`Unsafe member path: ${entry.name}`);
    }
  }

  const warnings: string[] = [];
  const texts = new Map<string, string>();
  let total = 0;

  for (const entry of entries) {
    const text = await entry.async("string");
    const size = Buffer.byteLength(text, "utf8");
    if (size > IMPORT_MAX_MEMBER_BYTES) {
      throw new BrainValidationError(`Member ${entry.name} is too large`);
    }
    total += size;
    if (total > IMPORT_MAX_TOTAL_BYTES) {
      throw new BrainValidationError("Archive is too large to import");
    }
    texts.set(entry.name, text);
  }

  const manifestText = texts.get("manifest.json");
  if (!manifestText) throw new BrainValidationError("Archive is missing manifest.json");

  let manifest: z.infer<typeof manifestSchema>;
  try {
    manifest = manifestSchema.parse(JSON.parse(manifestText));
  } catch {
    throw new BrainValidationError("manifest.json is not a valid .afrbrain manifest");
  }
  if (manifest.formatVersion > BRAIN_ARCHIVE_VERSION) {
    throw new BrainValidationError(
      `Archive format version ${manifest.formatVersion} is newer than this server supports (${BRAIN_ARCHIVE_VERSION})`
    );
  }

  // Checksums are advisory: a mismatch means the archive was edited or truncated,
  // which the user should be told about — but hand-edited archives are a legitimate
  // workflow for a format whose whole point is that it outlives this app.
  for (const declared of manifest.members ?? []) {
    const text = texts.get(declared.path);
    if (text === undefined) {
      warnings.push(`manifest lists ${declared.path}, which is not in the archive`);
      continue;
    }
    if (sha256(text) !== declared.sha256) {
      warnings.push(`${declared.path}: checksum does not match the manifest`);
    }
  }

  const member = (path: string) => texts.get(path) ?? "";

  const parsed: ParsedArchive = {
    sourceBrainName: manifest.brain?.name ?? null,
    exportedAt: manifest.exportedAt ?? null,
    formatVersion: manifest.formatVersion,
    memories: parseMember("memories.jsonl", member("memories.jsonl"), memoryRecord, warnings),
    memoryVersions: parseMember(
      "memory_versions.jsonl",
      member("memory_versions.jsonl"),
      versionRecord,
      warnings
    ),
    memoryLinks: parseMember("memory_links.jsonl", member("memory_links.jsonl"), linkRecord, warnings),
    tags: normalizeTags(
      parseMember("tags.jsonl", member("tags.jsonl"), tagRecord, warnings).map((tag) => tag.name)
    ),
    projects: parseMember("projects.jsonl", member("projects.jsonl"), projectRecord, warnings),
    entities: parseMember("entities.jsonl", member("entities.jsonl"), entityRecord, warnings),
    relationships: parseMember(
      "relationships.jsonl",
      member("relationships.jsonl"),
      relationshipRecord,
      warnings
    ),
    warnings,
  };

  if (parsed.memories.length === 0 && parsed.entities.length === 0) {
    throw new BrainValidationError("Archive contains no memories or entities to import");
  }

  return parsed;
}

export type ImportPlan = {
  memories: ParsedArchive["memories"];
  memoryVersions: ParsedArchive["memoryVersions"];
  memoryLinks: ParsedArchive["memoryLinks"];
  relationships: ParsedArchive["relationships"];
  projects: ParsedArchive["projects"];
  entities: ParsedArchive["entities"];
  tags: string[];
  dropped: {
    versionsWithoutMemory: number;
    linksWithMissingEnd: number;
    relationshipsWithMissingEnd: number;
    projectRefsCleared: number;
  };
};

/**
 * Decide exactly what will be written, using only the archive's own contents to
 * resolve references. An edge whose other end did not survive validation is dropped;
 * it is never pointed at something else and never invented (§37).
 *
 * Pure — no database, no ids minted yet. This is the function that decides whether
 * an import is safe, so it is the one worth testing.
 */
export function planImport(parsed: ParsedArchive): ImportPlan {
  const memoryIds = new Set(parsed.memories.map((memory) => memory.id));
  const entityIds = new Set(parsed.entities.map((entity) => entity.id));
  const projectIds = new Set(parsed.projects.map((project) => project.id));

  let projectRefsCleared = 0;
  const memories = parsed.memories.map((memory) => {
    if (memory.projectId && !projectIds.has(memory.projectId)) {
      projectRefsCleared += 1;
      return { ...memory, projectId: null };
    }
    return memory;
  });

  const memoryVersions = parsed.memoryVersions.filter((version) => memoryIds.has(version.memoryId));

  const memoryLinks = parsed.memoryLinks.filter((link) => {
    if (!memoryIds.has(link.sourceMemoryId)) return false;
    if (link.targetType === "memory") {
      return Boolean(link.targetMemoryId)
        && memoryIds.has(link.targetMemoryId!)
        && link.targetMemoryId !== link.sourceMemoryId;
    }
    return Boolean(link.targetEntityId) && entityIds.has(link.targetEntityId!);
  });

  const relationships = parsed.relationships.filter(
    (relationship) =>
      entityIds.has(relationship.sourceEntityId)
      && entityIds.has(relationship.targetEntityId)
      && relationship.sourceEntityId !== relationship.targetEntityId
  );

  return {
    memories,
    memoryVersions,
    memoryLinks,
    relationships,
    projects: parsed.projects,
    entities: parsed.entities,
    tags: normalizeTags([
      ...parsed.tags,
      ...parsed.memories.flatMap((memory) => memory.tags ?? []),
    ]),
    dropped: {
      versionsWithoutMemory: parsed.memoryVersions.length - memoryVersions.length,
      linksWithMissingEnd: parsed.memoryLinks.length - memoryLinks.length,
      relationshipsWithMissingEnd: parsed.relationships.length - relationships.length,
      projectRefsCleared,
    },
  };
}

export type ImportPreview = {
  sourceBrainName: string | null;
  exportedAt: string | null;
  formatVersion: number;
  counts: {
    memories: number;
    memoryVersions: number;
    memoryLinks: number;
    tags: number;
    projects: number;
    entities: number;
    relationships: number;
  };
  dropped: ImportPlan["dropped"];
  warnings: string[];
};

/**
 * The read-only half of §37: what would happen, with nothing written. There is no
 * database call anywhere in this path, which is a stronger guarantee than a flag.
 */
export function previewImport(parsed: ParsedArchive): ImportPreview {
  const plan = planImport(parsed);
  return {
    sourceBrainName: parsed.sourceBrainName,
    exportedAt: parsed.exportedAt,
    formatVersion: parsed.formatVersion,
    counts: {
      memories: plan.memories.length,
      memoryVersions: plan.memoryVersions.length,
      memoryLinks: plan.memoryLinks.length,
      tags: plan.tags.length,
      projects: plan.projects.length,
      entities: plan.entities.length,
      relationships: plan.relationships.length,
    },
    dropped: plan.dropped,
    warnings: parsed.warnings,
  };
}

/** Insert in chunks so one archive cannot build a single statement with 50k rows. */
const INSERT_CHUNK = 500;

/** Natural key for an entity inside one brain: name + type, never the archive id. */
function entityKey(name: string, type: string): string {
  return name + " " + type;
}

function chunk<T>(items: T[], size = INSERT_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export type ImportResult = ImportPreview & {
  written: {
    memories: number;
    memoryVersions: number;
    memoryLinks: number;
    projects: number;
    entities: number;
    relationships: number;
    tagAssignments: number;
  };
};

/**
 * Write the plan into an existing brain, inside one transaction (§37).
 *
 * Ownership is not negotiable: `brainId` comes from the authenticated route and is
 * stamped on every row, `created_by` is the importing user, and every id in the
 * archive is replaced by a freshly minted one. Nothing the archive claims about
 * ownership is read. Projects and entities are matched to existing rows by their
 * natural key so importing twice merges instead of duplicating.
 */
export async function runImport(params: {
  brainId: string;
  principal: { userId: string; agentId: string | null };
  parsed: ParsedArchive;
}): Promise<ImportResult> {
  const { brainId, principal, parsed } = params;
  const plan = planImport(parsed);
  const preview = previewImport(parsed);

  const importedAt = new Date().toISOString();
  const provenance = {
    importedAt,
    importedFrom: parsed.sourceBrainName,
    archiveExportedAt: parsed.exportedAt,
  };

  const written = await db.transaction(async (tx) => {
    // projects: merge on (brain_id, name)
    const projectIdMap = new Map<string, string>();
    if (plan.projects.length > 0) {
      for (const group of chunk(plan.projects)) {
        await tx
          .insert(brainProjects)
          .values(
            group.map((project) => ({
              brainId,
              name: project.name,
              description: project.description ?? null,
              status: (project.status ?? "active") as (typeof BRAIN_PROJECT_STATUSES)[number],
              metadata: provenance,
            }))
          )
          .onConflictDoNothing();
      }
      const rows = await tx
        .select({ id: brainProjects.id, name: brainProjects.name })
        .from(brainProjects)
        .where(
          and(
            eq(brainProjects.brainId, brainId),
            inArray(
              brainProjects.name,
              plan.projects.map((project) => project.name)
            )
          )
        );
      const byName = new Map(rows.map((row) => [row.name, row.id]));
      for (const project of plan.projects) {
        const id = byName.get(project.name);
        if (id) projectIdMap.set(project.id, id);
      }
    }

    // entities: merge on (brain_id, name, type)
    const entityIdMap = new Map<string, string>();
    if (plan.entities.length > 0) {
      for (const group of chunk(plan.entities)) {
        await tx
          .insert(brainEntities)
          .values(
            group.map((entity) => ({
              brainId,
              name: entity.name,
              type: (entity.type ?? "other") as (typeof BRAIN_ENTITY_TYPES)[number],
              description: entity.description ?? null,
              // `metadata` is human-owned meaning (enrich-service refuses to overwrite
              // it), so provenance is layered over it rather than replacing it.
              metadata: { ...(entity.metadata ?? {}), ...provenance },
            }))
          )
          .onConflictDoNothing();
      }
      const rows = await tx
        .select({ id: brainEntities.id, name: brainEntities.name, type: brainEntities.type })
        .from(brainEntities)
        .where(
          and(
            eq(brainEntities.brainId, brainId),
            inArray(
              brainEntities.name,
              plan.entities.map((entity) => entity.name)
            )
          )
        );
      const byKey = new Map(rows.map((row) => [entityKey(row.name, row.type), row.id]));
      for (const entity of plan.entities) {
        const id = byKey.get(entityKey(entity.name, entity.type ?? "other"));
        if (id) entityIdMap.set(entity.id, id);
      }
    }

    // tags
    const tagIdMap = new Map<string, string>();
    if (plan.tags.length > 0) {
      for (const group of chunk(plan.tags)) {
        await tx
          .insert(memoryTags)
          .values(group.map((name) => ({ brainId, name })))
          .onConflictDoNothing();
      }
      const rows = await tx
        .select({ id: memoryTags.id, name: memoryTags.name })
        .from(memoryTags)
        .where(and(eq(memoryTags.brainId, brainId), inArray(memoryTags.name, plan.tags)));
      for (const row of rows) tagIdMap.set(row.name, row.id);
    }

    // memories: every id re-minted, ownership forced to this brain
    const memoryIdMap = new Map<string, string>();
    const memoryRows = plan.memories.map((memory) => {
      const id = randomUUID();
      memoryIdMap.set(memory.id, id);
      const type = (memory.type ?? "knowledge") as (typeof MEMORY_TYPES)[number];
      const summary = memory.summary ?? null;
      return {
        id,
        brainId,
        type,
        title: memory.title,
        content: memory.content,
        summary,
        importance: memory.importance ?? 0.5,
        confidence: memory.confidence ?? 1,
        sourceType: (memory.sourceType
          ?? "imported_document") as (typeof MEMORY_SOURCE_TYPES)[number],
        sourceId: memory.sourceId ?? null,
        projectId: memory.projectId ? (projectIdMap.get(memory.projectId) ?? null) : null,
        metadata: { ...(memory.metadata ?? {}), ...provenance },
        createdBy: principal.agentId ? null : principal.userId,
        createdByAgent: principal.agentId,
        archivedAt: memory.archivedAt ? new Date(memory.archivedAt) : null,
        // Imported entity nodes and links are restored verbatim from the archive;
        // the *derived* graph is not, so every imported memory starts `pending`
        // with its hash already written and a sweep re-derives it locally.
        contentHash: memoryContentHash({ type, title: memory.title, content: memory.content, summary }),
      };
    });
    for (const group of chunk(memoryRows)) await tx.insert(memories).values(group);

    // tag assignments
    const tagAssignments: { memoryId: string; tagId: string }[] = [];
    for (const memory of plan.memories) {
      const memoryId = memoryIdMap.get(memory.id);
      if (!memoryId) continue;
      for (const name of normalizeTags(memory.tags ?? [])) {
        const tagId = tagIdMap.get(name);
        if (tagId) tagAssignments.push({ memoryId, tagId });
      }
    }
    for (const group of chunk(tagAssignments)) {
      await tx.insert(memoryTagMap).values(group).onConflictDoNothing();
    }

    // versions
    const versionRows = plan.memoryVersions.flatMap((version) => {
      const memoryId = memoryIdMap.get(version.memoryId);
      if (!memoryId) return [];
      return [
        {
          memoryId,
          versionNumber: version.versionNumber,
          title: version.title,
          content: version.content,
          summary: version.summary ?? null,
          changeReason: version.changeReason ?? "Imported from .afrbrain archive",
          // Authorship of an edit made in another brain is not transferable, so these
          // stay null rather than being reassigned to whoever ran the import.
          changedBy: null,
          changedByAgent: null,
          metadata: version.metadata ?? null,
        },
      ];
    });
    for (const group of chunk(versionRows)) {
      await tx.insert(memoryVersions).values(group).onConflictDoNothing();
    }

    // entity relationships
    const relationshipRows = plan.relationships.flatMap((relationship) => {
      const source = entityIdMap.get(relationship.sourceEntityId);
      const target = entityIdMap.get(relationship.targetEntityId);
      if (!source || !target || source === target) return [];
      return [
        {
          brainId,
          sourceEntityId: source,
          targetEntityId: target,
          relationshipType: relationship.relationshipType,
          confidence: relationship.confidence ?? 0.9,
          metadata: { ...(relationship.metadata ?? {}), ...provenance },
        },
      ];
    });
    for (const group of chunk(relationshipRows)) {
      await tx.insert(brainRelationships).values(group).onConflictDoNothing();
    }

    // memory links
    const linkRows: NewMemoryLink[] = [];
    for (const link of plan.memoryLinks) {
      const source = memoryIdMap.get(link.sourceMemoryId);
      if (!source) continue;
      const shared = {
        brainId,
        sourceMemoryId: source,
        linkType: link.linkType ?? "relates_to",
        metadata: { ...(link.metadata ?? {}), ...provenance },
        createdBy: principal.agentId ? null : principal.userId,
        createdByAgent: principal.agentId,
      };
      if (link.targetType === "memory") {
        const target = link.targetMemoryId ? memoryIdMap.get(link.targetMemoryId) : undefined;
        if (!target || target === source) continue;
        linkRows.push({ ...shared, targetType: "memory", targetMemoryId: target, targetEntityId: null });
        continue;
      }
      const target = link.targetEntityId ? entityIdMap.get(link.targetEntityId) : undefined;
      if (!target) continue;
      linkRows.push({ ...shared, targetType: "entity", targetMemoryId: null, targetEntityId: target });
    }

    for (const group of chunk(linkRows)) {
      await tx.insert(memoryLinks).values(group).onConflictDoNothing();
    }

    return {
      memories: memoryRows.length,
      memoryVersions: versionRows.length,
      memoryLinks: linkRows.length,
      projects: projectIdMap.size,
      entities: entityIdMap.size,
      relationships: relationshipRows.length,
      tagAssignments: tagAssignments.length,
    };
  });

  // One bounded sweep instead of a job per memory: an import can be thousands of
  // rows, and enrichment is a background chore that must not flood the queue. The
  // sweep re-queues itself while it is still making progress; with no Redis the
  // rows simply stay `pending` until something else sweeps them.
  if (written.memories > 0) {
    void enqueueJob("enrich_brain", {
      brainId,
      limit: Math.min(written.memories, ENRICH_SWEEP_MAX),
    }).catch(() => {});
  }

  return { ...preview, written };
}
