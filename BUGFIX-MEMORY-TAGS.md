# Bug Fix: Memory Card Tags Error

## Problem

Console error when rendering memory cards:
```
TypeError: Cannot read properties of undefined (reading 'slice')
at MemoryCard (components/brain/memory-card.tsx:78:22)
```

## Root Cause

The Brain dashboard endpoint (`GET /api/brain/[id]`) was querying the `memories` table directly using Drizzle ORM without joining tags:

```typescript
// ❌ Old code — no tags
const recentMemories = await db
  .select()
  .from(memories)
  .where(...)
  .orderBy(desc(memories.updatedAt))
  .limit(5);
```

This returned `Memory` objects without the `tags` field, but the `MemoryCard` component expected `MemoryWithTags` (which includes `tags: string[]`).

## Solution

Changed the dashboard endpoint to use `listMemories()` service method, which properly fetches tags:

```typescript
// ✅ New code — includes tags via withTags()
const recentResult = await listMemories({ 
  brainId, 
  archived: false, 
  limit: 5 
});
```

The `listMemories()` method internally calls `withTags()` which:
1. Fetches memories
2. Queries `memory_tags` and `memory_tag_map` in a single join
3. Groups tags by memory ID
4. Returns `MemoryWithTags[]` with `tags: string[]` (empty array if no tags)

## Changes Made

### `app/api/brain/[id]/route.ts`

**Before:**
```typescript
import { and, desc, eq, isNull } from "drizzle-orm";
import { db } from "@/lib/db";
import { memories } from "@/lib/db/schema";

const [stats, recentMemories] = await Promise.all([
  getBrainStats(brainId),
  db.select()
    .from(memories)
    .where(and(eq(memories.brainId, brainId), isNull(memories.deletedAt), isNull(memories.archivedAt)))
    .orderBy(desc(memories.updatedAt))
    .limit(5),
]);

return apiSuccess({ brain, stats: { ...stats, recentMemories } });
```

**After:**
```typescript
import { listMemories } from "@/lib/brain/memory-service";

const [stats, recentResult] = await Promise.all([
  getBrainStats(brainId),
  listMemories({ brainId, archived: false, limit: 5 }),
]);

return apiSuccess({ brain, stats: { ...stats, recentMemories: recentResult.memories } });
```

### `components/brain/memory-card.tsx`

Added optional chaining as defensive coding:

```typescript
// Before: memory.tags.slice(0, 4)
// After:  memory.tags?.slice(0, 4)

{memory.tags?.slice(0, 4).map((tag) => (
  <span key={tag} className="...">
    {tag}
  </span>
))}
{memory.tags && memory.tags.length > 4 && (
  <span>+{memory.tags.length - 4}</span>
)}
```

This prevents crashes if any future code path accidentally returns memories without tags.

## Architecture Principle Reinforced

This bug revealed an architectural violation:

**❌ Bad:** API routes directly querying tables with `db.select()`
**✅ Good:** API routes calling service layer methods

The service layer (`memory-service.ts`) encapsulates:
- Tag hydration via `withTags()`
- Authorization
- Pagination
- Search
- Versioning

Direct table queries bypass these concerns and cause bugs like this one.

## Testing

✅ **Build:** Successful (15.5s)
✅ **Tests:** 243/243 passing
✅ **Types:** No errors

## Prevention

Going forward:
1. Never query `memories` table directly in API routes
2. Always use `listMemories()`, `searchMemories()`, `getMemory()` from `memory-service.ts`
3. These methods guarantee `MemoryWithTags` type (includes `tags: string[]`)

## Related Files

- `app/api/brain/[id]/route.ts` — dashboard endpoint (fixed)
- `lib/brain/memory-service.ts` — service layer with `withTags()`
- `components/brain/memory-card.tsx` — UI component (defensive fix)
- `hooks/use-brain.ts` — type definitions

---

**Status:** ✅ Fixed and verified
**Date:** 2026-08-21
