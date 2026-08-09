import { and, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { deletionJobItems, deletionJobs, files, folders, type DeletionJob } from "@/lib/db/schema";
import { enqueueJob } from "@/lib/queue";

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export async function createFolderDeletionJob(
  userId: string,
  folderId: string,
  idempotencyKey: string
): Promise<{ job: DeletionJob; queued: boolean } | null> {
  const [existing] = await db
    .select()
    .from(deletionJobs)
    .where(and(eq(deletionJobs.userId, userId), eq(deletionJobs.idempotencyKey, idempotencyKey)))
    .limit(1);
  if (existing) {
    if (existing.status !== "failed") return { job: existing, queued: true };
    const queued = await enqueueJob("process_deletion", { deletionJobId: existing.id }, { jobId: `deletion:${existing.id}:retry:${Date.now()}` });
    return { job: existing, queued };
  }

  const [folder] = await db.select().from(folders).where(eq(folders.id, folderId)).limit(1);
  if (!folder || folder.userId !== userId) return null;

  const subtree = await db
    .select({ id: files.id, objectKey: files.r2Key, thumbnailKey: files.thumbnailKey })
    .from(files)
    .innerJoin(folders, eq(files.folderId, folders.id))
    .where(and(
      eq(files.userId, userId),
      sql`${folders.materializedPath} LIKE ${`${escapeLike(folder.materializedPath)}%`} ESCAPE '\\'`
    ));

  const uniqueItems = [...new Map(subtree.map((item) => [item.objectKey, item])).values()];
  const now = new Date();
  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    userId,
    folderId,
    idempotencyKey,
    status: "created" as const,
    totalItems: uniqueItems.length,
    processedItems: 0,
    expiresAt: new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000),
    createdAt: now,
    updatedAt: now,
  };

  await db.transaction(async (tx) => {
    await tx.insert(deletionJobs).values(job);
    for (let offset = 0; offset < uniqueItems.length; offset += 500) {
      await tx.insert(deletionJobItems).values(
        uniqueItems.slice(offset, offset + 500).map((item) => ({
          deletionJobId: jobId,
          fileId: item.id,
          objectKey: item.objectKey || "pending",
          thumbnailKey: item.thumbnailKey,
        }))
      );
    }
    // Hide the subtree immediately and prevent new writes into it while the
    // durable object deletion is running. The worker later removes only the
    // snapshotted object/metadata rows.
    await tx.execute(sql`
      UPDATE ${files}
      SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
      WHERE folder_id IN (
        SELECT id FROM ${folders}
        WHERE user_id = ${userId}
          AND materialized_path LIKE ${`${escapeLike(folder.materializedPath)}%`} ESCAPE '\\'
      )
    `);
    await tx.execute(sql`
      UPDATE ${folders}
      SET deleted_at = COALESCE(deleted_at, NOW()), updated_at = NOW()
      WHERE user_id = ${userId}
        AND materialized_path LIKE ${`${escapeLike(folder.materializedPath)}%`} ESCAPE '\\'
    `);
  });

  const queued = await enqueueJob("process_deletion", { deletionJobId: jobId }, { jobId: `deletion:${jobId}` });
  if (!queued) {
    await db.update(deletionJobs).set({
      status: "failed",
      errorCode: "QUEUE_UNAVAILABLE",
      errorMessage: "Deletion worker queue is unavailable",
      updatedAt: new Date(),
    }).where(and(eq(deletionJobs.id, jobId), eq(deletionJobs.status, "created")));
  }
  const [created] = await db.select().from(deletionJobs).where(eq(deletionJobs.id, jobId)).limit(1);
  return created ? { job: created, queued } : null;
}
