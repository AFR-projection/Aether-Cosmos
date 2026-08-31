import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/shared/infrastructure/db";
import { memories } from "@/shared/infrastructure/db/schema";
import { ftsMatchOn, ftsRankOn } from "@/shared/lib/search/fts";
import { createMemory, updateMemory, type MemoryWithTags } from "./memory-service";
import { normalizeTags, type MemorySourceType, type MemoryType } from "@brain/domain/constants";

/**
 * brain_remember — the write side of the agent memory protocol.
 *
 * The brain must not become a garbage dump (§100), so this does duplicate
 * detection before inserting:
 *
 *  - EXACT: same normalized title + same type already exists → update that memory
 *    (which snapshots a version, so nothing is lost) instead of adding a twin.
 *  - NEAR: full-text neighbours are reported back as `possibleDuplicates` but do
 *    NOT block the write. Deciding that two differently-titled memories are the
 *    same thing needs judgement we do not have here; surfacing them lets the agent
 *    (or a later consolidation pass) decide.
 */

const NEAR_DUPLICATE_LIMIT = 3;

export type RememberOutcome = {
  mode: "created" | "updated";
  memory: MemoryWithTags;
  possibleDuplicates: { id: string; title: string; type: string }[];
};

export type RememberInput = {
  title: string;
  content: string;
  type?: MemoryType;
  summary?: string | null;
  importance?: number;
  confidence?: number;
  sourceType?: MemorySourceType;
  sourceId?: string | null;
  tags?: string[];
  metadata?: Record<string, unknown> | null;
};

export async function rememberMemory(params: {
  brainId: string;
  principal: { userId: string; agentId: string | null };
  data: RememberInput;
  changeReason?: string;
}): Promise<RememberOutcome> {
  const { brainId, principal, data } = params;
  const title = data.title.trim();
  const type = data.type ?? "fact";

  const exact = await findByTitle(brainId, title, type);
  const possibleDuplicates = await findNearDuplicates(brainId, title, exact?.id);

  if (exact) {
    const memory = await updateMemory({
      brainId,
      memoryId: exact.id,
      principal,
      data: {
        content: data.content,
        summary: data.summary ?? undefined,
        importance: data.importance,
        confidence: data.confidence,
        metadata: data.metadata ?? undefined,
        tags: data.tags ? normalizeTags(data.tags) : undefined,
      },
      changeReason:
        params.changeReason ?? "Updated by brain_remember (existing memory with same title)",
    });
    return { mode: "updated", memory, possibleDuplicates };
  }

  const memory = await createMemory({
    brainId,
    principal,
    data: { ...data, title, type },
  });
  return { mode: "created", memory, possibleDuplicates };
}

/** Case-insensitive, whitespace-insensitive title match within the same type. */
async function findByTitle(
  brainId: string,
  title: string,
  type: MemoryType
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: memories.id })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        eq(memories.type, type),
        isNull(memories.deletedAt),
        sql`lower(regexp_replace(${memories.title}, '[[:space:]]+', ' ', 'g')) = lower(regexp_replace(${title}, '[[:space:]]+', ' ', 'g'))`
      )
    )
    .orderBy(desc(memories.updatedAt))
    .limit(1);
  return row ?? null;
}

async function findNearDuplicates(
  brainId: string,
  title: string,
  excludeId?: string
): Promise<{ id: string; title: string; type: string }[]> {
  const rows = await db
    .select({ id: memories.id, title: memories.title, type: memories.type })
    .from(memories)
    .where(
      and(
        eq(memories.brainId, brainId),
        isNull(memories.deletedAt),
        ftsMatchOn(memories.searchVector, title)
      )
    )
    .orderBy(desc(ftsRankOn(memories.searchVector, title)))
    .limit(NEAR_DUPLICATE_LIMIT + 1);

  return rows.filter((row) => row.id !== excludeId).slice(0, NEAR_DUPLICATE_LIMIT);
}
