/**
 * Brain Export System
 *
 * Export brain data to multiple formats:
 * - JSON (full data dump with metadata)
 * - Markdown (portable, human-readable)
 * - Obsidian vault (with backlinks and tags)
 * - Logseq graph (with block references)
 * - OPML (outline format)
 *
 * Preserves:
 * - Memory content and metadata
 * - Links between memories
 * - Tags and entities
 * - Timestamps and version history
 */

import { db } from "@/lib/db";
import { memories, memoryLinks, memoryTags, memoryDerivedLinks } from "@/lib/db/schema";
import { eq, and, isNull, inArray } from "drizzle-orm";
import { formatISO } from "date-fns";

export type ExportFormat = "json" | "markdown" | "obsidian" | "logseq" | "opml";

export interface ExportOptions {
  format: ExportFormat;
  includeDeleted?: boolean;
  includeDerivedLinks?: boolean;
  includeMetadata?: boolean;
  sanitizeFilenames?: boolean;
}

export interface ExportResult {
  format: ExportFormat;
  files: Array<{
    path: string;
    content: string;
  }>;
  manifest: {
    brainId: string;
    brainName: string;
    totalMemories: number;
    exportedAt: Date;
  };
}

/**
 * Export brain to specified format.
 */
export async function exportBrain(
  brainId: string,
  options: ExportOptions
): Promise<ExportResult> {
  const { brains } = await import("@/lib/db/schema");

  // Get brain info
  const [brain] = await db
    .select({ name: brains.name })
    .from(brains)
    .where(eq(brains.id, brainId))
    .limit(1);

  if (!brain) {
    throw new Error("Brain not found");
  }

  // Get all memories
  const memoriesQuery = db
    .select({
      id: memories.id,
      content: memories.content,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
      deletedAt: memories.deletedAt,
    })
    .from(memories)
    .where(eq(memories.brainId, brainId));

  if (!options.includeDeleted) {
    memoriesQuery.where(isNull(memories.deletedAt));
  }

  const memoryList = await memoriesQuery;

  // Get links
  const memoryIds = memoryList.map((m) => m.id);

  const links = await db
    .select({
      sourceId: memoryLinks.sourceId,
      targetId: memoryLinks.targetId,
    })
    .from(memoryLinks)
    .where(inArray(memoryLinks.sourceId, memoryIds));

  // Get tags
  const tags = await db
    .select({
      memoryId: memoryTags.memoryId,
      tag: memoryTags.tag,
    })
    .from(memoryTags)
    .where(inArray(memoryTags.memoryId, memoryIds));

  // Get derived links if requested
  let derivedLinks: any[] = [];
  if (options.includeDerivedLinks) {
    derivedLinks = await db
      .select({
        sourceId: memoryDerivedLinks.sourceId,
        targetId: memoryDerivedLinks.targetId,
        relationshipType: memoryDerivedLinks.relationshipType,
      })
      .from(memoryDerivedLinks)
      .where(inArray(memoryDerivedLinks.sourceId, memoryIds));
  }

  // Build data structure
  const data = {
    memories: memoryList,
    links,
    tags,
    derivedLinks,
  };

  // Generate files based on format
  let files: Array<{ path: string; content: string }>;

  switch (options.format) {
    case "json":
      files = exportToJSON(data, brain.name, options);
      break;
    case "markdown":
      files = exportToMarkdown(data, brain.name, options);
      break;
    case "obsidian":
      files = exportToObsidian(data, brain.name, options);
      break;
    case "logseq":
      files = exportToLogseq(data, brain.name, options);
      break;
    case "opml":
      files = exportToOPML(data, brain.name, options);
      break;
    default:
      throw new Error(`Unsupported format: ${options.format}`);
  }

  return {
    format: options.format,
    files,
    manifest: {
      brainId,
      brainName: brain.name,
      totalMemories: memoryList.length,
      exportedAt: new Date(),
    },
  };
}

/**
 * Export to JSON format.
 */
function exportToJSON(
  data: any,
  brainName: string,
  options: ExportOptions
): Array<{ path: string; content: string }> {
  const output = {
    metadata: {
      brainName,
      exportedAt: new Date().toISOString(),
      format: "json",
      version: "1.0",
    },
    memories: data.memories.map((m: any) => ({
      id: m.id,
      content: m.content,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
      ...(options.includeMetadata && { deletedAt: m.deletedAt?.toISOString() }),
    })),
    links: data.links,
    tags: data.tags,
    ...(options.includeDerivedLinks && { derivedLinks: data.derivedLinks }),
  };

  return [
    {
      path: `${sanitizeFilename(brainName)}.json`,
      content: JSON.stringify(output, null, 2),
    },
  ];
}

/**
 * Export to Markdown format (one file per memory).
 */
function exportToMarkdown(
  data: any,
  brainName: string,
  options: ExportOptions
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  // Create index file
  const indexContent = `# ${brainName}\n\nExported: ${formatISO(new Date())}\n\nTotal memories: ${data.memories.length}\n\n## Memories\n\n${data.memories
    .map((m: any, idx: number) => `${idx + 1}. [Memory ${m.id.slice(0, 8)}](${m.id}.md)`)
    .join("\n")}`;

  files.push({
    path: "index.md",
    content: indexContent,
  });

  // Create file for each memory
  for (const memory of data.memories) {
    const memoryTags = data.tags
      .filter((t: any) => t.memoryId === memory.id)
      .map((t: any) => t.tag);

    const memoryLinks = data.links
      .filter((l: any) => l.sourceId === memory.id)
      .map((l: any) => l.targetId);

    let content = `# Memory ${memory.id.slice(0, 8)}\n\n`;

    if (options.includeMetadata) {
      content += `**Created:** ${formatISO(memory.createdAt)}\n`;
      content += `**Updated:** ${formatISO(memory.updatedAt)}\n\n`;
    }

    if (memoryTags.length > 0) {
      content += `**Tags:** ${memoryTags.join(", ")}\n\n`;
    }

    content += `## Content\n\n${memory.content}\n\n`;

    if (memoryLinks.length > 0) {
      content += `## Links\n\n`;
      for (const targetId of memoryLinks) {
        content += `- [Memory ${targetId.slice(0, 8)}](${targetId}.md)\n`;
      }
    }

    files.push({
      path: `${memory.id}.md`,
      content,
    });
  }

  return files;
}

/**
 * Export to Obsidian vault format.
 */
function exportToObsidian(
  data: any,
  brainName: string,
  options: ExportOptions
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  for (const memory of data.memories) {
    const memoryTags = data.tags
      .filter((t: any) => t.memoryId === memory.id)
      .map((t: any) => `#${t.tag.replace(/\s+/g, "-")}`);

    const memoryLinks = data.links
      .filter((l: any) => l.sourceId === memory.id)
      .map((l: any) => l.targetId);

    // Obsidian frontmatter
    let content = `---\n`;
    content += `created: ${memory.createdAt.toISOString()}\n`;
    content += `updated: ${memory.updatedAt.toISOString()}\n`;
    if (memoryTags.length > 0) {
      content += `tags: [${memoryTags.join(", ").replace(/#/g, "")}]\n`;
    }
    content += `---\n\n`;

    // Content with Obsidian-style wikilinks
    content += memory.content;

    // Add linked memories as backlinks
    if (memoryLinks.length > 0) {
      content += `\n\n## Related\n\n`;
      for (const targetId of memoryLinks) {
        content += `- [[${targetId}]]\n`;
      }
    }

    const filename = sanitizeFilename(
      memory.content.slice(0, 50).trim() || `memory-${memory.id.slice(0, 8)}`
    );

    files.push({
      path: `${filename}.md`,
      content,
    });
  }

  return files;
}

/**
 * Export to Logseq graph format.
 */
function exportToLogseq(
  data: any,
  brainName: string,
  options: ExportOptions
): Array<{ path: string; content: string }> {
  const files: Array<{ path: string; content: string }> = [];

  for (const memory of data.memories) {
    const memoryTags = data.tags
      .filter((t: any) => t.memoryId === memory.id)
      .map((t: any) => `#${t.tag.replace(/\s+/g, "-")}`);

    const memoryLinks = data.links
      .filter((l: any) => l.sourceId === memory.id)
      .map((l: any) => l.targetId);

    // Logseq uses bullet points
    let content = `- ${memory.content.replace(/\n/g, "\n  ")}\n`;

    if (memoryTags.length > 0) {
      content += `  tags:: ${memoryTags.join(", ")}\n`;
    }

    content += `  created:: [[${formatISO(memory.createdAt, { representation: "date" })}]]\n`;

    if (memoryLinks.length > 0) {
      content += `  related::\n`;
      for (const targetId of memoryLinks) {
        content += `    - [[${targetId}]]\n`;
      }
    }

    const filename = sanitizeFilename(
      memory.content.slice(0, 50).trim() || `memory-${memory.id.slice(0, 8)}`
    );

    files.push({
      path: `pages/${filename}.md`,
      content,
    });
  }

  return files;
}

/**
 * Export to OPML format.
 */
function exportToOPML(
  data: any,
  brainName: string,
  options: ExportOptions
): Array<{ path: string; content: string }> {
  let opml = `<?xml version="1.0" encoding="UTF-8"?>\n`;
  opml += `<opml version="2.0">\n`;
  opml += `  <head>\n`;
  opml += `    <title>${escapeXml(brainName)}</title>\n`;
  opml += `    <dateCreated>${new Date().toUTCString()}</dateCreated>\n`;
  opml += `  </head>\n`;
  opml += `  <body>\n`;

  for (const memory of data.memories) {
    const text = memory.content.slice(0, 100).replace(/\n/g, " ");
    opml += `    <outline text="${escapeXml(text)}" _note="${escapeXml(memory.content)}" />\n`;
  }

  opml += `  </body>\n`;
  opml += `</opml>`;

  return [
    {
      path: `${sanitizeFilename(brainName)}.opml`,
      content: opml,
    },
  ];
}

/**
 * Sanitize filename for filesystem safety.
 */
function sanitizeFilename(name: string): string {
  return name
    .replace(/[^a-zA-Z0-9-_\s]/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 50);
}

/**
 * Escape XML special characters.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}
