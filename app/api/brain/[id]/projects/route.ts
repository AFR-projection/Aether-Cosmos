import { NextRequest } from "next/server";
import { z } from "zod";
import { apiSuccess, apiError, handleApiError } from "@/shared/api/response";
import { validateCsrf } from "@/shared/lib/security";
import { requireBrainContext } from "@brain/infrastructure/access";
import { enforceBrainRateLimit, requireUuid } from "@brain/infrastructure/http";
import { logBrainAudit } from "@brain/infrastructure/audit";
import {
  createProject,
  listProjects,
  MAX_PROJECTS_PER_BRAIN,
} from "@brain/application/commands/project-service";

type RouteParams = { params: Promise<{ id: string }> };

const PROJECT_STATUSES = ["active", "paused", "done", "archived"] as const;

const listSchema = z.object({
  status: z.enum(PROJECT_STATUSES).optional(),
});

/** GET /api/brain/[id]/projects — projects with their live memory counts. */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const brainId = requireUuid((await params).id, "id");
    await requireBrainContext(request, brainId, ["brain.read"]);

    const query = listSchema.parse(Object.fromEntries(request.nextUrl.searchParams));
    const projects = await listProjects({ brainId, status: query.status });

    return apiSuccess({ projects, statuses: PROJECT_STATUSES, maxProjects: MAX_PROJECTS_PER_BRAIN });
  } catch (error) {
    return handleApiError(error);
  }
}

const createSchema = z.object({
  name: z.string().trim().min(1).max(150),
  description: z.string().trim().max(1000).nullable().optional(),
  status: z.enum(PROJECT_STATUSES).optional(),
});

/** POST /api/brain/[id]/projects */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    if (!(await validateCsrf(request))) return apiError("Invalid CSRF token", 403);

    const brainId = requireUuid((await params).id, "id");
    const { userId, principal } = await requireBrainContext(
      request,
      brainId,
      ["brain.write"],
      { write: true }
    );
    await enforceBrainRateLimit(userId, "write");

    const body = createSchema.parse(await request.json());
    const project = await createProject({ brainId, ...body });

    await logBrainAudit({
      brainId,
      principalType: principal.type,
      principalId: principal.id,
      operation: "project.create",
      resourceType: "brain_project",
      resourceId: project.id,
      metadata: { name: project.name },
    });

    return apiSuccess({ project }, 201);
  } catch (error) {
    return handleApiError(error);
  }
}
