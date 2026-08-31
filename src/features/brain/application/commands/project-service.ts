import { and, asc, count, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { brainProjects, memories, type BrainProject } from "@/shared/infrastructure/db/schema";
import {
  BrainConflictError,
  BrainProjectNotFoundError,
  BrainValidationError,
} from "@brain/domain/errors";

/**
 * Projects group the memories of one piece of work.
 *
 * Agents mostly operate around a project rather than around isolated notes, so a
 * project is the unit `brain_recall` can be narrowed to. Deleting a project sets
 * `memories.project_id` to NULL rather than cascading — the work ends, the
 * knowledge stays.
 */

export const MAX_PROJECTS_PER_BRAIN = 200;

export type BrainProjectWithCount = BrainProject & { memoryCount: number };

export async function listProjects(params: {
  brainId: string;
  status?: BrainProject["status"];
}): Promise<BrainProjectWithCount[]> {
  const conditions = [eq(brainProjects.brainId, params.brainId)];
  if (params.status) conditions.push(eq(brainProjects.status, params.status));

  // One grouped join instead of a count per project.
  const rows = await db
    .select({
      project: brainProjects,
      memoryCount: sql<number>`count(${memories.id})::int`,
    })
    .from(brainProjects)
    .leftJoin(
      memories,
      and(eq(memories.projectId, brainProjects.id), isNull(memories.deletedAt))
    )
    .where(and(...conditions))
    .groupBy(brainProjects.id)
    .orderBy(asc(brainProjects.status), desc(brainProjects.updatedAt));

  return rows.map((row) => ({ ...row.project, memoryCount: row.memoryCount }));
}

export async function requireProject(brainId: string, projectId: string): Promise<BrainProject> {
  const [project] = await db
    .select()
    .from(brainProjects)
    .where(and(eq(brainProjects.id, projectId), eq(brainProjects.brainId, brainId)))
    .limit(1);
  if (!project) throw new BrainProjectNotFoundError();
  return project;
}

export async function createProject(params: {
  brainId: string;
  name: string;
  description?: string | null;
  status?: BrainProject["status"];
}): Promise<BrainProject> {
  const name = params.name.trim();
  if (!name) throw new BrainValidationError("Project name is required");

  const [existing] = await db
    .select({ total: count() })
    .from(brainProjects)
    .where(eq(brainProjects.brainId, params.brainId));
  if ((existing?.total ?? 0) >= MAX_PROJECTS_PER_BRAIN) {
    throw new BrainConflictError(`Maximum ${MAX_PROJECTS_PER_BRAIN} projects per brain`);
  }

  const [project] = await db
    .insert(brainProjects)
    .values({
      brainId: params.brainId,
      name,
      description: params.description?.trim() || null,
      status: params.status ?? "active",
    })
    .returning();
  return project;
}

export async function updateProject(params: {
  brainId: string;
  projectId: string;
  data: {
    name?: string;
    description?: string | null;
    status?: BrainProject["status"];
  };
}): Promise<BrainProject> {
  await requireProject(params.brainId, params.projectId);

  const patch: Record<string, unknown> = { updatedAt: new Date() };
  if (params.data.name !== undefined) {
    const name = params.data.name.trim();
    if (!name) throw new BrainValidationError("Project name cannot be empty");
    patch.name = name;
  }
  if (params.data.description !== undefined) {
    patch.description = params.data.description?.trim() || null;
  }
  if (params.data.status !== undefined) patch.status = params.data.status;

  if (Object.keys(patch).length === 1) {
    throw new BrainValidationError("No fields to update");
  }

  const [updated] = await db
    .update(brainProjects)
    .set(patch)
    .where(
      and(eq(brainProjects.id, params.projectId), eq(brainProjects.brainId, params.brainId))
    )
    .returning();

  if (!updated) throw new BrainProjectNotFoundError();
  return updated;
}

/** Removes the project; its memories survive with project_id set to NULL. */
export async function deleteProject(brainId: string, projectId: string): Promise<boolean> {
  const removed = await db
    .delete(brainProjects)
    .where(and(eq(brainProjects.id, projectId), eq(brainProjects.brainId, brainId)))
    .returning({ id: brainProjects.id });
  return removed.length > 0;
}

/** Projects for the export route. */
export async function exportProjects(brainId: string): Promise<BrainProject[]> {
  return db
    .select()
    .from(brainProjects)
    .where(eq(brainProjects.brainId, brainId))
    .orderBy(asc(brainProjects.createdAt));
}
