import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/lib/api/response";
import { validateCsrf } from "@/lib/security";
import { requireBrainContext } from "@/lib/brain/access";
import { enforceBrainRateLimit, requireUuid } from "@/lib/brain/http";
import { logBrainAudit } from "@/lib/brain/audit";
import { listMemories } from "@/lib/brain/memory-service";
import { deleteProject, requireProject, updateProject } from "@/lib/brain/project-service";

type RouteParams = { params: Promise<{ id: string; projectId: string }> };

const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;

async function ids(params: RouteParams["params"]) {
  const { id, projectId } = await params;
  return {
    brainId: requireUuid(id, "id"),
    projectId: requireUuid(projectId, "projectId"),
  };
}

/** GET — the project plus its most recent memories. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { brainId, projectId } = await ids(params);
    await requireBrainContext(request, brainId, ["brain.read"]);

    const [project, page] = await Promise.all([
      requireProject(brainId, projectId),
      listMemories({ brainId, projectId, limit: 20 }),
    ]);

    return apiSuccess({ project, memories: page.memories, nextCursor: page.nextCursor });
  } catch (error) {
    return handleApiError(error);
  }
}

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(150).optional(),
    description: z.string().trim().max(1000).nullable().optional(),
    status: z.enum(PROJECT_STATUSES).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: "Provide at least one field to update",
  });

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, projectId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write");

    const body = patchSchema.parse(await request.json());
    const project = await updateProject({ brainId, projectId, data: body });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "project.update",
      resourceType: "brain_project",
      resourceId: projectId,
      metadata: { fields: Object.keys(body) },
    });

    return apiSuccess({ project });
  } catch (error) {
    return handleApiError(error);
  }
}

/** DELETE — removes the project. Its memories survive, unassigned. */
export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const { brainId, projectId } = await ids(params);
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.delete"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write");

    const deleted = await deleteProject(brainId, projectId);
    if (!deleted) {
      return apiError("Project not found", 404, { code: "BRAIN_PROJECT_NOT_FOUND" });
    }

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "project.delete",
      resourceType: "brain_project",
      resourceId: projectId,
    });

    return apiSuccess({ deleted: true });
  } catch (error) {
    return handleApiError(error);
  }
}
