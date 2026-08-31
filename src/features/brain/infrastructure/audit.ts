import { and, desc, eq, lt } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { brainAuditLogs, type BrainAuditLog } from "@/shared/infrastructure/db/schema";

/**
 * Append-only trail of every write (and every agent read) against a brain.
 *
 * NOTE: the insert is awaited. Drizzle query builders are lazy thenables — the
 * statement only runs when it is awaited, so the previous `void db.insert(...)`
 * built a query and threw it away, leaving this table permanently empty.
 *
 * Failures are swallowed: an audit write must never turn a successful memory
 * write into a 500.
 */
export async function logBrainAudit(params: {
  brainId: string;
  principalType: "user" | "agent";
  principalId: string;
  operation: string;
  resourceType?: string;
  resourceId?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await db.insert(brainAuditLogs).values({
      brainId: params.brainId,
      principalType: params.principalType,
      principalId: params.principalId,
      operation: params.operation,
      resourceType: params.resourceType,
      resourceId: params.resourceId,
      metadata: params.metadata,
    });
  } catch (error) {
    console.error("brain audit log failed", error);
  }
}

export async function listBrainAudit(params: {
  brainId: string;
  limit: number;
  before?: Date;
}): Promise<BrainAuditLog[]> {
  const conditions = [eq(brainAuditLogs.brainId, params.brainId)];
  if (params.before) conditions.push(lt(brainAuditLogs.createdAt, params.before));

  return db
    .select()
    .from(brainAuditLogs)
    .where(and(...conditions))
    .orderBy(desc(brainAuditLogs.createdAt))
    .limit(params.limit);
}
