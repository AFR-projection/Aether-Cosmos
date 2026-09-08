import { publishToUser } from "@/shared/infrastructure/realtime/events";
import type { BrainPrincipal } from "@brain/infrastructure/access";
import { logBrainAudit } from "@brain/infrastructure/audit";
import { invalidateBrainCache } from "@brain/infrastructure/mcp/cache";
import {
  candidatesFromTurns,
  ingestCandidates,
  type IngestOptions,
  type IngestReport,
} from "@brain/application/commands/ingest";
import type { ConversationTurn, IngestCandidate } from "@brain/domain/ingest/candidate";

/**
 * Run the writeback pipeline and deal with the consequences.
 *
 * `ingestCandidates` deliberately knows nothing about caches, audit rows or websockets —
 * it decides and it writes, exactly like `rememberMemory`. Something still has to do the
 * three things a write implies, and there are three callers that would otherwise each do
 * them slightly differently (`session/end`, `POST /ingest`, and the `brain_ingest` tool).
 * This is that one place.
 *
 * The three consequences, in order of how badly getting them wrong hurts:
 *
 * 1. **Cache invalidation.** Standing instructions ride in the MCP handshake and are
 *    cached per brain for a minute. Write a new rule without invalidating and the next
 *    session begins under the old rules — a stale cache here silently un-does the feature.
 * 2. **Audit.** One row per committed ingest call, even when every candidate is rejected:
 *    the interesting fact is that a conversation was harvested and what came out of it.
 * 3. **Realtime.** So an open /brain tab shows memories appearing as they are written.
 *
 * Preview calls skip all three. Committed no-write calls still audit the attempt, but do
 * not invalidate caches or publish events because no visible state changed.
 */
export async function runBrainIngest(params: {
  brainId: string;
  userId: string;
  principal: BrainPrincipal;
  operation: "memory.ingest" | "session.end";
  turns?: readonly ConversationTurn[] | null;
  candidates?: readonly IngestCandidate[] | null;
  options?: IngestOptions;
  /** Merged into the audit row — `{ transport: "mcp", via: "brain_ingest" }` and the like. */
  auditMetadata?: Record<string, unknown>;
}): Promise<IngestReport> {
  const { brainId, userId, principal } = params;

  const report = await ingestCandidates({
    brainId,
    principal: { userId, agentId: principal.agentId, agentName: principal.agentName },
    candidates: [
      ...candidatesFromTurns(params.turns ?? []),
      ...((params.candidates ?? []) as IngestCandidate[]),
    ],
    options: params.options,
  });

  if (!report.committed) return report;

  const wroteMemory = report.created + report.merged > 0;
  if (wroteMemory) invalidateBrainCache(brainId);

  await logBrainAudit({
    brainId,
    principalType: principal.type,
    principalId: principal.id,
    operation: params.operation,
    resourceType: "session",
    resourceId: report.sessionId ?? undefined,
    metadata: {
      ...params.auditMetadata,
      agent: principal.agentName,
      created: report.created,
      merged: report.merged,
      skipped: report.skipped,
      reviewNeeded: report.reviewNeeded,
      memoryIds: report.results.flatMap((item) =>
        item.memoryId && (item.disposition === "created" || item.disposition === "merged")
          ? [item.memoryId]
          : []
      ),
    },
  });

  for (const item of report.results) {
    if (!item.memoryId) continue;
    if (item.disposition === "created") {
      await publishToUser(userId, {
        type: "brain_memory_created",
        brainId,
        memoryId: item.memoryId,
        title: item.title,
      });
    } else if (item.disposition === "merged") {
      await publishToUser(userId, {
        type: "brain_memory_updated",
        brainId,
        memoryId: item.memoryId,
      });
    }
  }

  return report;
}
