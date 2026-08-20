import { NextRequest } from "next/server";
import { apiSuccess, handleApiError } from "@/lib/api/response";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { exportGraph } from "@/lib/brain/graph-service";
import { exportMemories, listBrainTags } from "@/lib/brain/memory-service";
import { exportProjects } from "@/lib/brain/project-service";
import { exportMemoryLinks } from "@/lib/brain/link-service";
import { buildBrainArchive } from "@/lib/brain/export-service";

type RouteParams = { params: Promise<{ id: string }> };

/**
 * GET /api/brain/[id]/export — the whole brain.
 *
 * `?format=afrbrain` returns the portable `.afrbrain` package (§36): a zip of JSON
 * Lines members plus a manifest with a sha256 per member. Anything else returns the
 * same content as one JSON document, which is what the UI and existing clients read.
 *
 * Either way this is bulk extraction, so it sits behind its own brain.export scope
 * and is always written to the audit trail.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    const { userId, brain, principal } = await requireBrainContext(request, brainId, [
      "brain.export",
    ]);
    await enforceBrainRateLimit(userId, "export");

    if (request.nextUrl.searchParams.get("format") === "afrbrain") {
      const archive = await buildBrainArchive(brain);

      await logBrainAudit({
        brainId,
        principalType: principal.type,
        principalId: principal.id,
        operation: "brain.export",
        resourceType: "brain",
        resourceId: brainId,
        metadata: {
          format: "afrbrain",
          formatVersion: archive.manifest.formatVersion,
          counts: archive.manifest.counts,
          agent: principal.agentName,
        },
      });

      // Uint8Array, not the JSZip stream: the body is already fully built, and a
      // fixed Content-Length lets the browser show real download progress.
      return new Response(archive.bytes as unknown as BodyInit, {
        status: 200,
        headers: {
          "Content-Type": "application/zip",
          "Content-Disposition": `attachment; filename="${archive.filename}"`,
          "Content-Length": String(archive.bytes.byteLength),
          "Cache-Control": "no-store",
        },
      });
    }

    const [memories, tags, projects, graph, links] = await Promise.all([
      exportMemories(brainId),
      listBrainTags(brainId),
      exportProjects(brainId),
      exportGraph(brainId),
      exportMemoryLinks(brainId),
    ]);

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "brain.export",
      resourceType: "brain",
      resourceId: brainId,
      metadata: { memoryCount: memories.length, agent: principal.agentName },
    });

    return apiSuccess({
      exportedAt: new Date().toISOString(),
      brain,
      memories,
      tags: tags.map((tag) => tag.name),
      projects,
      entities: graph.entities,
      relationships: graph.relationships,
      memoryLinks: links,
    });
  } catch (error) {
    return handleApiError(error);
  }
}
