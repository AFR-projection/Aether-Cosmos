# PHASE 2 — Graph Intelligence: Audit + Implementation Plan

**Date**: 2026-08-23
**Status**: 🛑 AWAITING APPROVAL — no PHASE 2 code written yet
**Blocking decision**: schema (see PART 3)

---

## PART 0: What PHASE 2 is NOT

This is not "turn every similar memory into a `memory_links` row". The audit below
shows why that specific move would break five other subsystems. PHASE 2 introduces a
**three-tier relationship model** where similarity is never promoted to fact:

| Tier | Who asserts it | Where it lives | Trust |
|------|----------------|----------------|-------|
| **explicit** | user / agent, via `brain_link_memory` | `memory_links` (unchanged) | asserted fact |
| **derived** | one algorithmic signal above its gate | new derived table | evidence, not fact |
| **inferred** | ≥2 independent signal families fused | new derived table, `origin='inferred'` | evidence + confidence |

Explicit rows are never rewritten, reclassified, or deleted by any PHASE 2 code path.

---

## PART 1: Audit findings

### 1.1 `memory_links` schema (`lib/db/schema.ts:1219`)

```
id, brainId, sourceMemoryId, targetType('memory'|'entity'),
targetMemoryId?, targetEntityId?, linkType(text, default 'relates_to'),
metadata(jsonb), createdBy, createdByAgent, createdAt
```

Indexes: `brain_idx`, `source_idx`, `target_memory_idx`, `target_entity_idx`,
two partial unique indexes on `(source, target, linkType)`, three CHECK constraints
(one-target, target-type-matches, no-self-link).

**Findings:**
- ❌ No `origin`, `confidence`, `weight`, `evidence`, `computedBy`, `status` columns.
- ❌ Uniqueness is **directional**: `A→B` and `B→A` are two legal rows with the same
  `linkType`. An undirected derived edge has no DB-level duplicate protection here.
- ❌ No `updatedAt` — a recomputed edge cannot record when it was last refreshed.
- ✅ Only provenance mechanism that exists: `metadata->>'derivedBy'` (JSONB).
- ✅ `createdBy`/`createdByAgent` are nullable, so a machine-written row is expressible.

### 1.2 `lib/brain/graph/relate.ts` — the scorer already exists and is good

541 lines, pure, synchronous, no DB. `relateMemories(inputs, options)` → `{ edges, candidates }`.

- ✅ **Not O(N²)**: builds an inverted index (`POSTING_MAX = 48` docs per term,
  `CANDIDATE_MAX = 250_000` pair budget). Only co-occurring pairs are ever scored.
- ✅ Already implements threshold (`minWeight 0.2`), top-K (`neighbours 6`),
  `maxDegree 12`, `maxEdges 4000`, and two greedy passes (connectivity → densification).
- ✅ Already canonicalizes edge direction: `const forward = first < second`.
- ✅ Four signal families with independent gates: `semantic` (TF-IDF cosine, requires
  `similarity ≥ 0.14` **and** ≥2 shared distinctive terms), `tag` (≥2 shared tags **or**
  one rare tag), `entity` (≥1 shared entity), `project` (bonus only, `PROJECT_BONUS 0.15`).
- ✅ Emits `reason` (≤90 chars) per edge.
- ❌ No persistence, no confidence (only `weight`), no structured `evidence`,
  no single-seed incremental mode — it only does whole-brain batches.
- ❌ Its only caller is `graph-snapshot.ts:190`, behind a per-process LRU
  (`DERIVE_CACHE_MAX = 8`, FNV-1a fingerprint) documented as "a latency cache,
  never a source of truth".

### 1.3 `lib/brain/graph/related-service.ts` — what `brain_related` actually does

`findRelatedMemories(db, brainId, seedMemoryId, maxResults=20, maxHops=2)`, 7 steps:
load seed → direct outgoing links → backlinks → graph proximity → retrieval fallback
→ load titles → sort+slice. Scores: direct `1.0`, proximity `1/(hops+1)`,
semantic `score*0.8`, combined with `Math.max`.

**Correction to `AUDIT-REPORT.md`**: it does **not** return empty without explicit
links. Step 4 calls `retrieveMemories({ query: seed.title, ... })`, so FTS + entity
overlap already produce results. The real defects:

- ❌ `RelatedMemory = { id, title, type, score, reason, linkType?, hops? }` — no
  `origin`, no `confidence`, no `evidence`, no `weight`. A caller **cannot distinguish
  an asserted fact from a guess**. This is the actual PHASE 2 problem.
- ❌ **Step 3 selects every `memory_links` row in the brain with no `LIMIT`**, then
  builds an in-memory undirected graph. O(brain edges) per call, on the read path.
- ❌ Fallback query is `seed.title` only — a handful of words, no summary/content/tags.
- ❌ Fallback passes `projectId: seed.projectId`, which **narrows** retrieval to one
  project instead of treating project as a boost.

### 1.4 Enrichment pipeline — the provenance precedent to copy

`lib/brain/enrich/enrich-service.ts` (537 lines) already writes **derived** links into
`memory_links`, but only `memory → entity` with `linkType = 'mentions'`:

```ts
metadata: { derivedBy: ENRICHMENT_VERSION, extractedBy: extraction.extractedBy }
```

and reclaims **only its own rows** before rewriting:

```ts
const ownedByEnrichment = and(
  eq(memoryLinks.sourceMemoryId, memory.id),
  eq(memoryLinks.targetType, "entity"),
  eq(memoryLinks.linkType, MENTION_LINK_TYPE),
  sql`${memoryLinks.metadata} ->> 'derivedBy' IS NOT NULL`
);
```

Insert uses `.onConflictDoNothing()` so a pre-existing human link always wins.

Three patterns to reuse verbatim in PHASE 2:
1. **Own only what you wrote** — reconcile by `computedBy`, never blanket-delete.
2. **Recompute, never increment** — `mentionCount` is recalculated from scratch, so
   repeated runs cannot drift.
3. **Idempotent by content hash** — `memoryContentHash()` = sha256 of
   `[ENRICHMENT_VERSION, EXTRACTOR_VERSION, type, title, summary, content]`;
   `enrichedHash` short-circuits a duplicate job into a no-op.

Its doc comment states the current contract explicitly: *"Memory↔memory relatedness is
NOT written here — it stays derived from the same shared model in
`lib/brain/graph/relate.ts`, so the local and global graph cannot disagree."*
PHASE 2 must keep that invariant: **one scorer, two entry points.**

### 1.5 Worker / queue system

- `lib/queue/index.ts`: `QUEUE_NAME = "storage-jobs"`, BullMQ + ioredis,
  `getQueue()` returns `null` when `REDIS_DISABLED === "true"`, `enqueueJob()` swallows
  errors and returns `false` (jobs are optional in dev).
  Defaults: `attempts 3`, exponential backoff 2000ms, `removeOnComplete 100`.
- `JobType` union has 10 members; `enrich_memory` / `enrich_brain` are the templates.
- `workers/index.ts`: `runEnrichMemory` rethrows on `failed` so BullMQ retries;
  `runEnrichBrain` re-queues itself with a 2s delay only while
  `remaining > 0 && ready + skipped > 0` (bounded, no infinite loop);
  `enrich_memory` requires **both** `brainId` and `memoryId` so a partial payload can
  never fall through to a brain-wide operation. Logs counts only, never memory text.
- ✅ Clean place to add `relate_memory` / `relate_brain`. Two new `JobType` members.

### 1.6 Deletion / update path — the trap

`lib/brain/memory-service.ts:440` `deleteMemory()` is a **soft delete**: it sets
`deletedAt` + `updatedAt`. It does **not** issue a `DELETE`.

**Consequence: `onDelete: "cascade"` never fires.** Every `memory_links` row pointing at
a soft-deleted memory survives. Today that is deliberate (`listOutgoingLinks` filters
dead ends at read time, "the row survives so restoring the memory restores the link").
For derived edges it means cleanup must be **explicit**, in the service, on:

| Event | Required action |
|-------|-----------------|
| created | enqueue `relate_memory` after enrichment succeeds |
| updated, `contentHash` changed | recompute this memory's derived edges |
| updated, hash unchanged | no-op (idempotent short-circuit) |
| soft-deleted | delete derived rows touching it (derived data is disposable) |
| restored (`restoreMemoryVersion`) | enqueue `relate_memory` |
| superseded (`supersededById` set) | recompute; validity is applied at **read** time by the existing validity multiplier, never baked into the stored weight |

`requestEnrichment()` is fire-and-forget (`void enqueueJob(...).catch(() => {})`) with
no `jobId` dedupe — PHASE 2 should pass `jobId` so a burst of writes collapses.

### 1.7 Existing indexes relevant to candidate generation

All bounded probes PHASE 2 needs already have an index:

| Probe | Index | Table |
|-------|-------|-------|
| FTS / lexical | `memories_search_vector_idx` (GIN on generated tsvector) | `memories` |
| shared entities | `memory_mentions_entity_idx (brainId, entityId)` | `memory_mentions` |
| entity resolution | unique `(brainId, name, type)` + `aliases[]` | `brain_entities` |
| project | `memories_brain_keyset_idx` | `memories` |
| graph proximity | `memory_links_source_idx`, `memory_links_target_memory_idx` | `memory_links` |
| validity filter | `memories_brain_validity_idx` | `memories` |

❌ **Missing — confirmed**: `memory_tag_map` has `primaryKey(memoryId, tagId)` and **no
other index**. "Which memories share tag X" (`WHERE tag_id IN (...)`) cannot use that PK,
whose leading column is `memory_id`. So a tag *probe* has no supporting index today,
while "what tags does this candidate have" (`WHERE memory_id IN (...)`) is fully covered.
→ See §4.2: tags become a **scoring** signal rather than a candidate-generation probe,
unless you approve the one-line additive index in §3.1b.
✅ `brain_relationships` (entity↔entity) already has `confidence real NOT NULL DEFAULT 0.9`
— a confidence column is established precedent in this schema.
✅ `brain_review_items` already has `dedupeKey` (unique per brain), `reason`,
`evidence jsonb`, `priority`, and an `open|dismissed|resolved` status — the SUGGEST
queue pattern already exists. But `brain_review_kind` enum has **no `suggested_link`
value**, so routing suggestions there needs an `ALTER TYPE ... ADD VALUE` migration.

---

## PART 2: Why derived edges must NOT go into `memory_links`

This is the audit's most important result. **11 non-test files read `memory_links`.**
Five of them would change behaviour silently the moment derived rows appear:

| File | What it does with `memory_links` | Damage if derived rows land there |
|------|----------------------------------|-----------------------------------|
| `graph/path-service.ts` | Full-brain scan, BFS shortest path. Doc: *"does not invent edges (semantic similarity, shared entities) — only stored `memory_links` rows"* | **Contract broken.** Paths become chains of guesses presented as reasoning. Also already **unbounded**. |
| `health-service.ts` | `linkCount`, `avgLinksPerMemory`, orphan + weak-cluster detection via `buildUndirectedGraph` | **Health becomes a lie.** `orphanCount` collapses toward 0 because every memory gets ≥1 derived edge; the brain reports itself healthy while nothing was actually curated. Also **unbounded** (no `LIMIT`). |
| `graph/related-service.ts` | Steps 2/2b/3 treat every row as explicit, score `1.0` | Derived edges score as **direct assertions** — the exact confusion PHASE 2 exists to prevent. |
| `export-service.ts` / `import-service.ts` | Dumps `memory_links.jsonl` into `.afrbrain`, re-imports it | Algorithmic output ships as **user data**; re-import resurrects stale edges computed by an old scorer version. |
| `context-engine.ts` | `relationships` block in the context pack (bounded by `GRAPH_EDGE_MAX`) | Agents receive similarity as **stated relationships** inside their context window. |
| `link-service.ts` | `MEMORY_LINK_MAX = 100` sanity bound; `listOutgoingLinks` renders "Related to" | Derived edges fill the user's link list and consume the 100-row budget. |
| `link-service.ts` `linkMemory()` | `onConflictDoUpdate({ set: { metadata } })` on `(source, target, linkType)` | If a user links a pair that already has a derived row **with the same `linkType`**, the derived metadata is silently overwritten — or the explicit intent is lost. |

Only `provenance-service.ts` is safe, because it whitelists
`['derived_from','consolidated_from','extracted_from']`.

**The no-migration option therefore costs 6+ coordinated filter changes across files
that currently have no reason to filter, and one missed filter is a silent correctness
bug — not a crash.** It also cannot express `confidence`/`weight` as indexable,
range-checked columns, cannot give undirected edges DB-level uniqueness (the existing
unique index is directional), and cannot record `updatedAt`.

**Recommendation: a separate table.** Derived knowledge gets its own store, so every
existing reader keeps its current meaning with **zero changes**, and readers that *want*
derived edges opt in explicitly.

---

## PART 3: 🛑 STOP — schema change proposal (needs your decision)

Per your instruction, nothing is migrated until you approve. Here is the full picture.

### 3.1 Proposed new table

```ts
export const memoryRelationOriginEnum = pgEnum("memory_relation_origin", [
  "derived",   // one signal family passed its gate
  "inferred",  // >= 2 independent signal families agreed
]);

export const memoryRelationStatusEnum = pgEnum("memory_relation_status", [
  "applied",     // readable by brain_related
  "suggested",   // scored, awaiting policy/human APPLY — invisible by default
]);

export const memoryDerivedLinks = pgTable("memory_derived_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  brainId: uuid("brain_id").notNull().references(() => brains.id, { onDelete: "cascade" }),
  /** Canonical undirected pair: memoryAId < memoryBId, enforced by CHECK. */
  memoryAId: uuid("memory_a_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  memoryBId: uuid("memory_b_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  origin: memoryRelationOriginEnum("origin").notNull(),
  status: memoryRelationStatusEnum("status").notNull().default("applied"),
  /** Dominant signal family: semantic | tag | entity | project. */
  relation: text("relation").notNull(),
  /** Edge strength 0..1, from relate.ts. */
  weight: real("weight").notNull(),
  /** Belief 0..1 — a function of how many signal families agreed. NOT the weight. */
  confidence: real("confidence").notNull(),
  /** Bounded, no full content: { signals, sharedTerms[], sharedTags[], sharedEntityIds[], similarity }. */
  evidence: jsonb("evidence"),
  /** Human-readable, <= 90 chars, from relate.ts. */
  reason: text("reason").notNull(),
  /** Scorer version, e.g. "relate-v1". Reconciliation only ever touches its own rows. */
  computedBy: text("computed_by").notNull(),
  /** memories.contentHash of each endpoint at compute time → cheap staleness detection. */
  sourceHashA: text("source_hash_a"),
  sourceHashB: text("source_hash_b"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("memory_derived_links_pair_unique").on(table.brainId, table.memoryAId, table.memoryBId),
  index("memory_derived_links_a_idx").on(table.brainId, table.memoryAId, table.status, table.weight),
  index("memory_derived_links_b_idx").on(table.brainId, table.memoryBId, table.status, table.weight),
  index("memory_derived_links_version_idx").on(table.brainId, table.computedBy),
  check("memory_derived_links_canonical", sql`"memory_a_id" < "memory_b_id"`),
  check("memory_derived_links_weight", sql`"weight" >= 0 AND "weight" <= 1`),
  check("memory_derived_links_confidence", sql`"confidence" >= 0 AND "confidence" <= 1`),
]);
```

### 3.2 Why each piece is needed

- **Separate table** — the only way the 11 existing `memory_links` readers keep their
  current meaning without edits. Explicit can never *become* derived, because they are
  not the same rows in the same store.
- **`memoryAId < memoryBId` CHECK + unique pair** — duplicate prevention for an
  undirected edge at the **database** level. `memory_links`'s unique index is
  directional and cannot do this.
- **`origin` enum** — the derived/inferred distinction you asked for, as a queryable,
  constrained column instead of a JSONB string.
- **`weight` + `confidence` as separate reals** — strength and belief are different
  things. Both indexable, both CHECK-bounded to `0..1`. Pruning by weight becomes an
  index scan instead of a JSONB cast.
- **`status`** — the SUGGEST half of DETECT → SCORE → SUGGEST/APPLY, without needing a
  new `brain_review_kind` enum value.
- **`computedBy`** — the "own only what you wrote" reconciliation key, exactly as
  enrichment uses `metadata->>'derivedBy'`.
- **`sourceHashA/B`** — detect a stale edge without recomputing it. Enables a cheap
  DETECT sweep and makes recompute idempotent.
- **Two directional indexes, one row** — an undirected neighbour lookup is a `UNION` of
  two index scans. Storing both directions would double writes and reintroduce the
  duplicate problem.

### 3.1b Optional second migration line: the tag probe index

```ts
index("memory_tag_map_tag_idx").on(table.tagId, table.memoryId)
```

Purely additive, no data change. Without it, the tag probe in §4.2 is dropped and tags
contribute to scoring only. **This is a separate yes/no from §3.1** — PHASE 2 works
either way, with slightly lower recall for tag-only relationships if you decline.

### 3.3 Alternative WITHOUT migration (and its real cost)
Write derived edges into `memory_links` with a distinct `linkType = "derived_relates_to"`
plus `metadata = { derivedBy, origin, weight, confidence, evidence, reason }`, following
the existing enrichment precedent.

| | Migration (new table) | No migration (`memory_links` + JSONB) |
|---|---|---|
| Existing readers | **0 changes** | **6+ files must add a `linkType` filter**; a missed one is a silent bug |
| Undirected dedupe | DB-enforced CHECK + unique | application-only discipline; a bug writes both A→B and B→A |
| Prune by weight | indexed `real` column | `(metadata->>'weight')::real` — cast per row, expensive to index |
| Range validation | CHECK 0..1 | none; a bad write is undetectable |
| `health_score` / orphan count | unaffected | must be taught to exclude derived, or it lies |
| `path-service` | unaffected | must be taught, or it "invents edges" against its own doc |
| export / import | unaffected | ships algorithmic output as user data |
| `linkMemory()` conflict | impossible | possible if a user picks the same `linkType` |
| Recompute cost | `DELETE WHERE computedBy=… AND (a=id OR b=id)` | `DELETE` with a JSONB predicate, no supporting index |
| `updatedAt` | present | absent — cannot express "refreshed" |
| Migration risk | one additive migration, no backfill, no existing-data rewrite | zero |
| Rollback | `DROP TABLE` — nothing else references it | derived rows are interleaved with user rows; cleanup is a data-surgery query |

**Verdict**: the migration is *additive only* — new table, new enums, no change to any
existing column, no backfill, and dropping it is a one-line rollback. The no-migration
path is cheaper today and more expensive every week after. I recommend the migration,
**but you own migrations**, so PHASE 2 will not run it — I will write the schema + the
generated SQL and stop for you to apply.

If you prefer zero migration, PHASE 2 is still implementable: the derived store becomes
an interface with two backends, and I implement the `memory_links` backend plus all six
reader filters. Say which and I proceed accordingly.

---

## PART 4: Architecture

### 4.1 One scorer, two entry points

`relate.ts` stays the single source of relatedness truth, so the local (one memory) and
global (whole brain) graphs can never disagree — the invariant enrichment already
documents. Two new functions are added to it, both pure:

```
relateMemories(inputs, options)            // EXISTING: whole brain, inverted index
relateOne(seed, candidates, options)       // NEW: seed vs a bounded candidate set
scoreRelation(a, b, idf, options)          // NEW: extracted pairwise core, shared by both
```

`relateOne` reuses `scoreRelation` and the same constants, so a pair scored by the sweep
and the same pair scored incrementally produce **byte-identical** weight, reason, and
evidence. That is the determinism guarantee, enforced by a test.

### 4.2 Candidate generation — bounded, never O(N²)

For a single seed, five independent probes, each index-backed and each capped:

| # | Probe | Query | Cap |
|---|-------|-------|-----|
| 1 | shared entities | `memory_mentions` where `entityId IN seed.entityIds`, group by memory, order by shared count desc | 40 |
| 2 | shared tags | memories sharing ≥1 tag, rare tags first (`df ≤ 5%` or `df ≤ 4`) | 30 |
| 3 | same project | `projectId = seed.projectId`, keyset order | 20 |
| 4 | FTS / rare terms | `processQuery(title + summary)` from PHASE 1 → `searchVector` match, ranked | 40 |
| 5 | graph proximity | 1-hop **explicit** neighbours of seed from `memory_links` | 20 |

Probe 2 requires the §3.1b index. If you decline it, probe 2 is dropped and tags still
feed **scoring** — candidate tags are loaded with `WHERE memory_id IN (...)`, which the
existing `memory_tag_map` PK covers.

Union → dedupe → drop the seed → drop soft-deleted → cap at
`RELATE_CANDIDATE_MAX = 120`, ordered deterministically (probe order, then id asc).
Cost is **O(candidates)**, independent of brain size. Worst case 6 DB queries + 1 row
load per `relate_memory` job.

The whole-brain `relate_brain` sweep keeps using the existing inverted index
(`POSTING_MAX 48`, `CANDIDATE_MAX 250_000`), which is already sub-quadratic.

### 4.3 Multi-signal scoring → derived vs inferred

Per candidate, `scoreRelation` returns the signal set that fired:

```
signals: { semantic?: {similarity, sharedTerms}, tag?: {sharedTags, rare},
           entity?: {sharedEntityIds}, project?: true }
weight  : existing relate.ts blend, capped at DERIVED_MAX 0.95
```

Then:

```
families = count of independent families that fired (project is a bonus, not a family)
origin   = families >= 2 ? "inferred" : "derived"
confidence = clamp(BASE[origin] + FAMILY_BONUS * (families - 1) + evidenceStrength, 0, 1)
```

Proposed constants (tunable, all in one block):
`CONF_BASE_DERIVED 0.45`, `CONF_BASE_INFERRED 0.65`, `CONF_FAMILY_BONUS 0.12`,
`CONF_APPLY_MIN 0.55`, `CONF_SUGGEST_MIN 0.40`.

**Similarity is never a fact**: `confidence` is capped strictly below 1.0, and no derived
row is ever readable as `origin: "explicit"`.

### 4.4 Pruning — no hairball

Four gates, applied in order, reusing `RELATE_DEFAULTS`:

1. **Threshold** — drop `weight < minWeight (0.2)`; drop `confidence < CONF_SUGGEST_MIN`.
2. **Top-K** — keep the best `neighbours (6)` per memory.
3. **Max degree** — hard ceiling `maxDegree (12)` derived edges per memory, counting both
   index directions. Enforced in the reconcile transaction, not just in memory.
4. **Global cap** — `maxEdges (4000)` derived rows per brain; the existing two-pass greedy
   (connectivity pass, then densification pass) decides which survive.

Explicit edges do **not** count toward these budgets and are never pruned.

### 4.5 DETECT → SCORE → SUGGEST/APPLY

```
DETECT   sweep finds memories whose derived edges are missing or stale
         (no rows for the memory, or sourceHashA/B != current contentHash,
          or computedBy != RELATE_VERSION)
SCORE    relateOne over bounded candidates → weight, confidence, origin, evidence
APPLY    confidence >= CONF_APPLY_MIN (0.55)  → status 'applied'   (visible)
SUGGEST  CONF_SUGGEST_MIN..CONF_APPLY_MIN     → status 'suggested' (hidden by default)
DROP     confidence < CONF_SUGGEST_MIN        → not stored at all
```

Policy lives in one exported constant block (`RELATE_POLICY`) — no schema, no per-brain
config in PHASE 2. `brain_related` reads `status = 'applied'` unless a caller explicitly
asks to include suggestions. **No memory is ever auto-deleted**; the only automatic
deletion is of derived *edge* rows this code wrote itself.

### 4.6 Invalidation & recompute

Reconciliation is one transaction per seed, mirroring enrichment:

```sql
DELETE FROM memory_derived_links
 WHERE brain_id = $brain AND computed_by = $version
   AND (memory_a_id = $seed OR memory_b_id = $seed);
INSERT ... (survivors)  -- ON CONFLICT (brain_id, a, b) DO UPDATE
```

- Rows written by a **different** `computedBy` are left alone (safe scorer rollout).
- Explicit `memory_links` rows are never touched.
- Recomputing an unchanged memory is a no-op: hashes match → the DETECT sweep skips it,
  and if it runs anyway the output is identical (determinism).
- Soft delete → `deleteDerivedFor(memoryId)` removes derived rows in both directions,
  since FK cascade does not fire on a soft delete.
- Supersession → recompute; validity is applied at read time by the existing validity
  multiplier, never baked into stored `weight`.
- Tenant isolation → `brainId` in every WHERE clause, including the DELETE.

### 4.7 `brain_related` after PHASE 2

`RelatedMemory` gains provenance:

```ts
{ id, title, type, score, reason,
  origin: "explicit" | "inferred" | "derived" | "retrieved",
  confidence: number, weight?: number, evidence?: {...},
  linkType?: string, hops?: number }
```

Merge order (highest trust wins on `Math.max`, but `origin` is taken from the **most
trusted** contributor, never upgraded): explicit → inferred → derived → retrieved.
Fixes shipped with it:
- Step 3's unbounded `memory_links` scan gets a `LIMIT` (same as `GRAPH_EDGE_LIMIT`).
- Fallback query widens to `processQuery(title + summary)` instead of bare title.
- `projectId` becomes a **boost**, not a filter.

---

## PART 5: Implementation steps

Each step ends green (tsc + lint + full suite) before the next begins.

| Step | Work | Files | Risk |
|------|------|-------|------|
| 2.0 | Schema + generated SQL, **not applied** | `lib/db/schema.ts` (additive), `drizzle/*.sql` | 🛑 needs your approval |
| 2.1 | Extract `scoreRelation`, add `relateOne`, add `signals`/`confidence`/structured `evidence` to the edge type. Pure, no DB. | `lib/brain/graph/relate.ts` | Low — existing tests pin current behaviour |
| 2.2 | Candidate generation: 5 bounded probes | `lib/brain/graph/relate-candidates.ts` (new) | Medium — needs the tag-index check from §1.7 |
| 2.3 | Persistence + reconcile transaction + policy constants | `lib/brain/graph/derived-link-service.ts` (new) | Medium |
| 2.4 | Job types `relate_memory` / `relate_brain` + worker handlers with bounded self-requeue | `lib/queue/index.ts`, `workers/index.ts` | Low |
| 2.5 | Lifecycle hooks: create/update/delete/restore → enqueue with `jobId` dedupe; chain after enrichment | `lib/brain/memory-service.ts`, `lib/brain/enrich/enrich-service.ts` | Medium — must stay fire-and-forget |
| 2.6 | `brain_related` rewrite: read derived store, add provenance, bound Step 3, widen fallback | `lib/brain/graph/related-service.ts` | Medium |
| 2.7 | MCP surface: `origin`/`confidence`/`evidence` in `brain_related` output; update tool description + server instructions | `lib/brain/mcp/tools.ts`, `lib/brain/mcp/server.ts` | Low |
| 2.8 | Tests (PART 6) | 3 new test files | — |
| 2.9 | Benchmark script + measured report (PART 7) | `scripts/bench-relate.ts` (new) | — |

Explicitly **out of scope** for PHASE 2: teaching `health-service` / `path-service` /
`context-engine` about derived edges (they stay explicit-only by design — that is the
point of the separate table), and fixing their unbounded scans beyond `related-service`.
I will file those as follow-ups rather than widen this phase.

---

## PART 6: Test plan

### 6.1 The 18 regression scenarios you listed

`tests/brain-derived-links.test.ts` — pure scorer + policy, no DB (fake db builder stub,
same pattern as `retrieve.test.ts`):

1. `brain_related` without any explicit link → non-empty, every row `origin != "explicit"`
2. shared entity only → edge with `relation: "entity"`, `origin: "derived"`
3. shared tag only → `relation: "tag"`; rare tag alone passes, one common tag does not
4. TF-IDF similarity only → `relation: "semantic"`, requires ≥2 shared distinctive terms
5. project match alone → **no edge** (bonus, not a family)
6. multi-signal → `origin: "inferred"`, confidence > any single-signal pair
7. confidence threshold → below `CONF_SUGGEST_MIN` is not stored; mid band is `suggested`
8. top-K → a memory with 20 qualifying candidates keeps exactly `neighbours` (6)
9. max degree → incoming + outgoing derived edges never exceed `maxDegree` (12)
10. duplicate prevention → scoring (A,B) and (B,A) yields one canonical row, `a < b`
11. explicit edge priority → explicit + derived on the same pair returns `origin: "explicit"`, score 1.0
12. derived edge provenance → every row has `origin`, `confidence`, `weight`, `evidence`, `reason`, `computedBy`
13. deletion cleanup → soft-deleting A removes derived rows in **both** directions; explicit rows survive
14. memory update → changed `contentHash` triggers recompute; unchanged is a no-op with identical output
15. brain isolation → a candidate in another brain is never scored; every statement carries `brainId`
16. deterministic output → two runs over shuffled input give identical weight/confidence/order
17. empty graph → one memory, no candidates → `[]`, no writes, bounded query count
18. unrelated memories → below-threshold pairs produce **zero** rows (not weak rows)

### 6.2 Integration scenario (yours, verbatim)

`tests/brain-phase2-integration.test.ts`:

```
A: "User prefers communication in Indonesian."
B: "User requests answers using Indonesian and a casual style."
C: "Server uses PostgreSQL for the database."
Q: "Check user identity and communication preferences."
```

Assertions:
- retrieval for Q returns A and B; C is absent or scores materially lower
- `brain_related(A)` finds B with **no** explicit `memory_link` A→B
- that result is labelled `origin: "derived"` or `"inferred"` — **never** `"explicit"`
- `brain_related(A)` does not surface C
- adding an explicit A→B link flips `origin` to `"explicit"` and leaves the derived row intact

Note on A↔B: they share "indonesian" and "communication/answers" but the semantic gate
needs ≥2 shared *distinctive* terms. If the gate does not fire on strings this short, the
honest fix is a documented short-text path — **not** lowering `SEMANTIC_MIN` globally,
which would hairball every larger brain. I will report the measured similarity rather
than tune constants until the test passes.

---

## PART 7: Benchmark plan

"Tests pass" is not the definition of done. `scripts/bench-relate.ts` generates synthetic
brains (deterministic seed, bilingual filler so TF-IDF behaves realistically) and reports:

| Metric | 100 memories | 1K | 10K |
|--------|--------------|-----|-----|
| `remember` + enrichment latency (p50 / p95) | | | |
| `relate_memory` latency (p50 / p95) | | | |
| `relate_brain` full sweep wall time | | | |
| `brain_related` latency (p50 / p95) | | | |
| DB queries per `relate_memory` | | | |
| candidates considered per seed | | | |
| derived edges created (total / avg degree) | | | |
| suggested vs applied ratio | | | |

Pass criteria I will hold myself to:
- `relate_memory` ≤ 7 DB queries, **independent of brain size**
- candidates per seed ≤ `RELATE_CANDIDATE_MAX` (120) at every scale
- `brain_related` p95 does not regress vs the pre-PHASE-2 baseline (measured first)
- avg derived degree ≤ `neighbours` (6); max ≤ `maxDegree` (12) at every scale
- 10K run reported as skipped-with-reason if the environment cannot host it, not silently omitted

Baseline is measured **before** step 2.1 so the comparison is real.

---

## PART 8: PHASE 1 verification (was pending — now done)

- `npx tsc --noEmit` → **clean, 0 errors**
- `npm run lint` → 0 errors, 98 pre-existing warnings; the one PHASE 1 warning
  (unused `PHRASE_BREAKERS` in `query-understanding.ts`) is **removed**
- `tests/brain-query-understanding.test.ts` (51) + `retrieval/retrieve.test.ts` (25)
  → **76 passed**
- `AUDIT-REPORT.md` corrected in three places: `brain_related` is shallow and
  un-labelled, not empty

---

## PART 9: What I need from you before coding

1. **Schema decision (blocking)** — new `memory_derived_links` table (recommended), or
   the no-migration `memory_links` + JSONB backend?
2. **Tag index (§3.1b)** — add `memory_tag_map (tag_id, memory_id)`, or drop the tag probe
   and keep tags as a scoring-only signal?
3. If the new table: I write `lib/db/schema.ts` + the generated migration SQL and stop.
   **You run the migration** — per standing agreement, I do not touch the DB or push.
4. Confirm the policy thresholds in §4.3/§4.5 are acceptable as starting values, or give
   your own.

Nothing in PART 5 starts until (1) is answered.
