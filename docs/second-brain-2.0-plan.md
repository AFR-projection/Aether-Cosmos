# Second Brain 2.0 — Architecture Plan

Target: turn AFR Second Brain from a memory store with a graph view into an
**agent-native knowledge operating system** — persistent, semantic, temporal,
graph-aware, provenance-aware, context-aware, token-efficient.

**Status: PLAN ONLY. No implementation has started.** Nothing in this document is
built yet unless it appears under [Phase 0 § A](#a-what-actually-exists-verified).

## Audit baseline

Measured on the current working tree, not from documentation:

| Metric | Value |
|---|---|
| Test suite | 35 files / **313 tests passing** (`npm test`, exit 0) |
| `lib/brain/` | 46 files, ~9,482 lines |
| Brain API routes | 26 route files under `app/api/brain/` |
| MCP tools | 17 registered |
| Brain tables | 12 |
| Brain migrations | `0013_second_brain.sql`, `0014_brain_projects.sql`, `0015_brain_memory_links.sql` |
| DB driver | `postgres` (postgres.js) over TCP, pool max 10 — **not** the Neon HTTP driver |
| Drizzle | 0.45.2 (exports `vector` / `halfvec` / `sparsevec` + HNSW index builders) |
| Queue | BullMQ `storage-jobs`, 8 job types, **0 brain jobs** |
| Worker image | `node:20-alpine` (musl libc) |

Documentation note: the audit list in the request named four files that do not
exist. `SECOND-BRAIN-COMPLETE.md`, `docs/SECOND-BRAIN-IMPLEMENTATION.md` and
`docs/MCP.md` were removed or renamed during the docs reorganisation; their
content now lives in `docs/second-brain-architecture.md` and
`docs/second-brain-mcp.md`. `docs/SECOND-BRAIN.md` and `docs/second-brain.md` are
the same file (case-insensitive filesystem). Audit was performed against the
actual source instead.

---

# Phase 0 — Architecture Audit

## A. What actually exists (verified)

**Data model — 12 tables.** `brains`, `brain_agents`, `brain_access`,
`memories`, `memory_versions`, `memory_tags`, `memory_tag_map`,
`brain_projects`, `brain_entities`, `brain_relationships`, `memory_links`,
`brain_audit_logs`.

`memories` already carries more than a text document:
`type` (13-value enum), `title`, `content`, `summary`, `importance`,
`confidence`, `sourceType` (7-value enum), `sourceId`, `createdBy`,
`createdByAgent`, `projectId`, `metadata` (jsonb), `version`, `archivedAt`,
`lastAccessedAt`, `deletedAt`, `searchVector`, timestamps. Eight indexes
including a keyset index matching the list query and a GIN index on the FTS
vector.

`memory_links` is a genuinely well-built edge table: memory→memory and
memory→entity in one table, partial unique indexes per target shape, and three
**database-level CHECK constraints** (exactly one target, target type matches,
no self-link). Integrity does not depend on the service layer.

**Retrieval.** PostgreSQL FTS via a generated `tsvector` column, `setweight`
A on title / B on content, prefix `to_tsquery` built entirely inside SQL so the
user string stays a bound parameter (`lib/search/fts.ts`). `searchMemories()`
ranks by `ts_rank` → `importance` → `createdAt`.

**A context engine already exists.** `lib/brain/recall.ts` (`brain_recall`)
assembles a five-section package — standing directives, query-relevant,
important, recent, matching graph entities with their edges — deduplicated
across sections, each section row-capped, snippets truncated to 400 chars, whole
package trimmed to a 6,000-character budget, and rendered as prompt-ready text.

**A write protocol already exists.** `lib/brain/remember.ts` (`brain_remember`)
does exact-title+type dedup (updates instead of twinning, snapshotting a version)
and reports FTS near-duplicates without blocking the write.

**Consolidation exists and is more capable than the docs suggest.**
`consolidation-service.ts` finds duplicate groups and detects conflicts via a
negation-marker + Jaccard-overlap heuristic. With `apply: true` it links
`supersedes` and `contradicts`, archives duplicates, and snapshots versions —
idempotently, group by group, so a partial failure is safe. This is currently
**the only code path that writes `memory_links` automatically**.

**Derived relationships.** `lib/brain/graph/relate.ts` is a real information-
retrieval implementation: TF-IDF cosine over title (weight 3) + content, four
tiers (shared entity / shared tag / lexical similarity / same project), per-tier
gates, inverted-index candidate generation so scoring is linear in real overlaps
rather than O(n²), then three-way pruning (weight floor, per-node top-K, hard
degree ceiling) in two deterministic greedy passes. Bilingual ID/EN stopword
list. Every edge carries a `reason` string. Pure and synchronous, so it is unit
testable.

**Graph model.** `graph-snapshot.ts` builds one bounded snapshot (nodes
2,500 default / 6,000 max; edges 6,000 / 20,000) with an FNV-1a fingerprint
cache keyed on exactly the derivation inputs. `graph/model.ts` builds CSR
adjacency in typed arrays and computes `degree`, `maxDegree`, and `strength`
(summed edge weight) per node. Explicit edges always outrank derived ones;
derived edges are never emitted for a pair that already has an explicit one.

**Graph UI — browser-verified this cycle.** Global graph, local graph at depths
1–6, edge-tier filters, up to 12 colour groups, per-brain persisted settings
(`brain-graph-settings-v3:<brainId>`), pop-out workspace at `/graph-workspace`
with cross-window settings propagation and create-sync measured at 1–2 ms,
context menu, double-click recentring, timelapse animation.

**Backlinks UI exists.** `components/brain/memory-links-panel.tsx` renders both
"Related to" (outgoing, removable here) and "Referenced by" (incoming), and
`listBacklinks()` / `brain_get_backlinks` back it.

**Security.** One authorization choke point (`lib/brain/access.ts`) with three
entry points: `requireBrainContext`, `requireBrainOwnerContext` (refuses agents),
`requireBrainOwner`. Agent callers are constrained **twice** — the API key's
`brain.*` scopes AND the `brain_access` row for that specific brain, intersected.
Destructive and bulk scopes (`delete`, `export`, `import`, `consolidate`) are
never granted by default. `brain.*` is a separate namespace from storage scopes,
so a pre-existing `full` storage key gains nothing. MCP rejects OAuth tokens and
requires `sk_`. `tests/brain-isolation.test.ts` enforces eight of these
properties by **static analysis of the source** (22 tests), including "no route
reads `brainId` from a parsed body".

**Audit trail.** `brain_audit_logs` with brain+time and principal indexes, written
through `lib/brain/audit.ts`.

## B. What is superficial (exists in name, thin in substance)

1. **"Semantic" edges are lexical.** The graph legend and docs say *semantic*;
   `relate.ts` computes TF-IDF cosine over shared surface terms. Its own header
   comment is honest about it: *"There is no embedding column and no pgvector in
   this schema, so tier 3 is lexical, not vector-semantic."* Ceiling: `deploy
   VPS` and `server production` can never connect.

2. **The entity graph is inert.** Nothing in the application extracts entities.
   `brain_entities` rows appear only from an explicit `POST /entities`,
   `brain_link`, or `brain_link_memory` call. Verified consequence on live data:
   `edgeStats { explicit: 0, semantic: 5, tag: 10, entity: 0, project: 0 }` —
   two of five edge tiers are structurally empty, and the strongest derived
   signal (shared entity co-mention) never fires.

3. **Explicit links are unused in practice.** The table, constraints, service,
   MCP tools and UI panel are all present and correct; the live brain has zero
   rows because creating a link is a manual multi-step UI action and no automatic
   producer exists outside `consolidate --apply`.

4. **`recall` is section-based, not relevance-ranked.** Sections are independent
   queries stitched together. There is no unified score, no semantic leg, no
   graph-proximity leg, no recency decay, and the budget is **characters, not
   tokens**. It cannot answer "spend 4,000 tokens optimally".

5. **Graph intelligence stops at degree.** `degree` and `strength` exist, client-
   side only, computed per snapshot. No PageRank, no community detection, no
   bridge/articulation detection, no shortest path, no knowledge-gap analysis.
   Node size uses degree and importance; nothing else feeds visual encoding.

6. **Temporal signal is one unused column.** `lastAccessedAt` is stamped by
   `getMemory({touch})` and then read by nothing — it affects no ranking. There
   is no `recallCount`, no confirmation count, no decay, no validity interval, no
   superseded state on the row.

7. **Contradiction detection has no surface.** `findConflictCandidates` works
   and is tested, but there is no UI. The only caller is a React hook
   (`use-brain.ts:617`) with no page wired to it, plus the MCP tool. A brain that
   can detect its own inconsistency but never mentions it is not
   contradiction-aware in any useful sense.

8. **Provenance is columns, not a chain.** `createdBy`, `createdByAgent`,
   `sourceType`, `sourceId` and `memory_versions` record *who and when* for a
   single row. There is no derivation graph, so "why does the brain believe
   this?" is unanswerable — no `derived_from`, no `supported_by` traversal, no
   `brain_provenance`.

9. **Observability is four counters.** The dashboard shows memories, archived,
   projects, agents. No graph metrics, no health, no latency, no cache hit rate.

10. **MCP is CRUD-shaped.** Of 17 tools, 12 are read/write/list primitives.
    `brain_recall` is the only composed one. No `brain_context`, `brain_path`,
    `brain_neighbors`, `brain_health`, `brain_provenance`.

11. **FTS has no stemming.** `'simple'` config, chosen deliberately for mixed
    Indonesian/English content. Correct trade-off, but it means `deploying` does
    not match `deploy`, which caps lexical recall.

## C. What genuinely does not exist

- Vector embeddings — no column, no extension, no provider, no index.
- `EmbeddingProvider` abstraction.
- Hybrid scoring function combining lexical + semantic + importance + recency +
  graph + confidence.
- Enrichment pipeline of any kind, and any observable enrichment status.
- Any brain-related background job. The BullMQ queue has 8 job types, all
  storage/media/webhook; brain writes are fully synchronous in the request path.
- Entity extraction, alias extraction, mention detection, unlinked mentions.
- `aliases` on memories or entities.
- Graph algorithms: PageRank, community/cluster detection, bridge detection,
  knowledge gaps, shortest path, bounded multi-hop traversal.
- Temporal reasoning: recall count, reinforcement, confidence decay, freshness,
  validity interval, superseded/stale state.
- Knowledge-health report and review queue.
- Provenance chain and `brain_provenance`.
- Token-aware context packing, token counting, or any retrieval benchmark
  (naive-search tokens vs `brain_context` tokens, relevance@token).
- Nested/hierarchical tags.
- Retrieval, semantic, graph-algorithm, MCP-behaviour, performance, context-budget
  and provenance test categories. Current brain tests cover isolation (static),
  graph model/view/query/groups/camera/simulation, relation derivation,
  consolidation, import/export, pagination, MCP grants.

## D. Schema that needs extending

Every item below is **additive** — new nullable columns, new tables, new enum
values appended. No renames, no drops, no type changes on existing columns.

**`memories` — new columns**

| Column | Type | Purpose |
|---|---|---|
| `embedding` | `vector(384)` nullable | semantic retrieval |
| `embeddingModel` | `text` nullable | which model produced it (re-embed detection) |
| `embeddingUpdatedAt` | `timestamp` nullable | staleness of the vector vs content |
| `enrichmentStatus` | enum `pending/processing/ready/failed/skipped` default `pending` | observable pipeline state |
| `enrichmentError` | `text` nullable | last failure reason, no content echo |
| `enrichedAt` | `timestamp` nullable | when enrichment last completed |
| `recallCount` | `integer` default 0 | reinforcement signal |
| `lastRecalledAt` | `timestamp` nullable | distinct from `lastAccessedAt` (UI view ≠ agent recall) |
| `confirmationCount` | `integer` default 0 | how many times re-asserted |
| `validFrom` / `validUntil` | `timestamp` nullable | temporal validity interval |
| `validityState` | enum `active/superseded/stale/retracted` default `active` | lifecycle, never a delete |
| `supersededById` | uuid → `memories.id` nullable | fast "what replaced this" |
| `aliases` | `text[]` default `{}` | alternate names for mention detection |

`lastAccessedAt` stays as-is and keeps its current meaning. Adding
`lastRecalledAt` rather than repurposing it avoids changing existing behaviour.

**`brain_entities` — new columns**: `aliases text[]`, `embedding vector(384)`,
`mentionCount integer`, `firstSeenAt` / `lastSeenAt`, plus
`extractionConfidence real` and `extractedBy text` so machine-created entities are
distinguishable from human-created ones (rule 9: no fake data pretending to be
authoritative).

**New enum values.** `memory_type` += `task`, `hypothesis`, `source`,
`evidence`. Postgres `ALTER TYPE ... ADD VALUE` is non-destructive but **cannot
run inside a transaction block** on older servers — the migration must isolate it.

**New link kinds** on `memory_links.linkType`: `derived_from`, `supported_by`,
`refutes`, `mentions`, `alias_of`. `supersedes` and `contradicts` already exist.

**New tables**

- `memory_mentions` — detected but unlinked mentions (memory × entity ×
  offset × confidence × `resolvedAt`). This is what makes Obsidian's "unlinked
  mentions" possible without polluting `memory_links` with guesses.
- `brain_graph_metrics` — per-brain, per-node cached PageRank / cluster id /
  bridge flag / component id, with `computedAt` and an input fingerprint so
  staleness is detectable. Cache, not source of truth; safe to truncate.
- `brain_health_snapshots` — one row per health computation: counters, orphan
  count, cluster count, average degree, conflict count, stale count. Gives the
  dashboard history instead of a single live number.
- `brain_retrieval_events` — optional, sampled: query hash (never the query
  text), latency, candidate counts, token totals. Needed for § Performance
  benchmarks. Must store no memory content (standing rule: brain content stays
  out of logs and analytics).

## E. API and MCP that need extending

**New REST routes** (all under `app/api/brain/[id]/`, all through
`requireBrainContext` with an explicit scope):

| Route | Scope | Notes |
|---|---|---|
| `POST /context` | `brain.search` | the token-budgeted context package |
| `GET /health` | `brain.read` | knowledge-health report |
| `GET /memories/[mid]/provenance` | `brain.read` | derivation chain, bounded depth |
| `GET /memories/[mid]/neighbors` | `brain.read` | graph neighbourhood, bounded |
| `GET /path` | `brain.read` | shortest path between two nodes |
| `GET /graph/metrics` | `brain.read` | PageRank / clusters / bridges |
| `GET /mentions` | `brain.read` | unlinked mentions review queue |
| `POST /memories/[mid]/reinforce` | `brain.write` | recall reinforcement |
| `POST /memories/[mid]/supersede` | `brain.write` | lifecycle transition, never a delete |
| `POST /enrich` | `brain.write` | manual re-enqueue (idempotent) |

**New MCP tools**, grouped rather than appended flat (P12): `brain_context`,
`brain_neighbors`, `brain_path`, `brain_health`, `brain_provenance`,
`brain_reinforce`, `brain_supersede`. All 17 existing tools keep their names,
arguments and response shapes — compatibility is not negotiable (rule 2).
`brain_recall` stays and becomes a thin wrapper over the new engine at a
compact budget, so existing agent prompts keep working.

**One divergence to fix.** `lib/brain/mcp/principal.ts:165` checks
`grant.scopes.includes(scope)`, while `lib/brain/access.ts:138` uses
`brainScopeSatisfied(...)`. So the `brain.write → brain.link` implication and
`brain.full` are honoured on REST but **not** on MCP. It currently fails closed
(MCP is stricter) and `DEFAULT_BRAIN_AGENT_SCOPES` lists `brain.link`
explicitly, so nothing is broken today — but two authorization
implementations will drift. Fix: have MCP call the same helper. This is a
one-line change plus a test, and it is the only security-relevant change in the
whole plan.

## F. Worker / background processing needed

Today brain writes are fully synchronous and the queue has zero brain jobs. The
enrichment pipeline must not enter the request path (P3: *"jangan membuat request
utama lambat"*). Four new job types on the existing `storage-jobs` queue:

| Job | Trigger | Work |
|---|---|---|
| `brain-enrich-memory` | after create/update | normalize → extract entities & aliases → detect mentions → embed → find semantic neighbours → flag duplicates/conflicts → suggest links → mark `ready` |
| `brain-embed-batch` | backfill / model change | embed N memories per job, resumable by keyset |
| `brain-graph-metrics` | debounced after edge changes | PageRank, components, clusters, bridges → `brain_graph_metrics` |
| `brain-health-scan` | scheduled per brain | health snapshot + review queue refresh |

**Idempotency contract** (rule 6). Every job is keyed
`brain-enrich:<memoryId>:<contentHash>` so a duplicate enqueue is a no-op. Each
step is individually re-runnable: entity upsert is by `(brainId, name)`,
mentions are unique by `(memoryId, entityId, offset)`, suggested links are
written as suggestions, never as accepted edges. Retry uses the existing
`attempts: 3` + exponential backoff. A failed job sets `enrichmentStatus =
'failed'` with a short reason and leaves the memory fully usable — enrichment is
strictly additive to a memory that already works.

**`REDIS_DISABLED=true` must keep working.** `enqueueJob` already returns `false`
when Redis is off. In that mode memories stay `enrichmentStatus = 'pending'`,
retrieval silently falls back to lexical-only, and nothing errors. A degraded
brain is acceptable; a broken brain is not.

**Deployment constraint discovered in the audit.** `docker/Dockerfile.worker` is
`node:20-alpine` (musl libc). `onnxruntime-node` publishes no musl prebuild, so
the obvious local-embedding runtime **cannot be dropped in as-is**. See
§ Embedding strategy — this is decided in the plan, not assumed away.

## G. Index and search infrastructure needed

- **`CREATE EXTENSION IF NOT EXISTS vector;`** on Neon. Neon supports pgvector;
  the user owns migrations, so this is an explicit prerequisite, not something
  the app will attempt at runtime.
- **HNSW index** on `memories.embedding` using `vector_cosine_ops`,
  `m = 16`, `ef_construction = 64`. Built with `CONCURRENTLY` so it does not lock
  writes. Drizzle 0.45.2 already exposes the index builder, so no new dependency.
- **Partial index** on `enrichmentStatus` where status ∈ (`pending`,`failed`) — the
  worker's queue-refill query.
- **`memories.validityState`** index, since every retrieval path will filter it.
- **GIN index on `aliases`** for mention detection.
- **Keep the FTS GIN index and the `'simple'` config.** Hybrid retrieval needs
  both legs; the plan adds a vector leg, it does not replace the lexical one
  (P2: *"Jangan menghapus PostgreSQL FTS"*). Stemming stays off — instead recall
  is recovered via the semantic leg, which is the correct fix for
  `deploy`/`deploying` in a bilingual corpus.
- **Every vector query must be brain-scoped in the same WHERE clause as the ANN
  ordering**, not filtered after. Wrong: `ORDER BY embedding <=> $1 LIMIT 20`
  then filter by brain. Right: `WHERE brain_id = $1 AND deleted_at IS NULL ORDER
  BY embedding <=> $2 LIMIT 20`. This is both a correctness and a leakage issue
  and gets a dedicated test.

## H. Migration risk

| Risk | Severity | Mitigation |
|---|---|---|
| `CREATE EXTENSION vector` unavailable or refused | **blocks P2 only** | Detect at boot, expose `semanticAvailable: false`, run hybrid with the semantic leg weighted 0. Everything else in the plan ships without it. |
| `ALTER TYPE ... ADD VALUE` cannot run in a transaction | medium | Isolate enum changes in their own migration file, ahead of table changes. |
| `db:push` on a rename would drop data | **high, pre-existing** | The plan contains **zero renames**. Documented in `docs/deployment.md`: apply to Neon first, then redeploy. |
| Adding a `vector(384)` column to a large table | low | Nullable, no default, no rewrite. Backfill is a resumable job, not a migration. |
| HNSW build time on a large table | medium | `CREATE INDEX CONCURRENTLY`, after backfill, off-peak. |
| Backwards compatibility of existing rows | low | Every new column is nullable or defaulted. Pre-existing memories are `enrichmentStatus = 'pending'` and behave exactly as today until a worker touches them. |
| Rollback | — | Each migration's inverse is a `DROP COLUMN`/`DROP TABLE` of objects nothing else references. `brain_graph_metrics` and `brain_health_snapshots` are caches and can be truncated freely. |

Ordering: `0016` enum additions → `0017` memory columns + indexes → `0018`
entity columns → `0019` new tables → `0020` vector column + HNSW (last, and the
only one gated on the extension).

## I. Performance risk

| Risk | Where | Mitigation |
|---|---|---|
| Embedding latency in the request path | `POST /memories` | Never embed synchronously. Enqueue only. Measured target: write path unchanged from today. |
| ANN recall vs exactness | hybrid search | HNSW `ef_search` tuned per query size; overfetch k=50 then rescore, return 10. |
| PageRank on every graph load | graph snapshot | Precomputed in a worker into `brain_graph_metrics`, keyed by the same FNV-1a fingerprint style already used by `graph-snapshot.ts`. Never computed in a request. |
| Snapshot cost at 100k memories | `graph-snapshot.ts` | The existing node/edge caps (2,500/6,000 default) already bound this. Above ~20k memories the global graph becomes a sampled view by importance + PageRank, and that sampling must be visible in the UI, not silent. |
| Context generation latency | `brain_context` | Budget-bounded by construction: fixed candidate caps per leg, one round of rescoring, no N+1. Target p95 < 400 ms at 10k memories. |
| Enrichment queue backlog | worker | `concurrency: 2` today; embedding is CPU-bound, so brain jobs get their own concurrency setting and batch size rather than competing with thumbnails. |
| DB pool exhaustion | postgres.js max 10 | Batch jobs use one connection and keyset pagination; no fan-out per memory. |
| Token counting cost | context packing | Cheap approximation first (chars/4 by script class), exact tokenizer only if a real tokenizer can be added without a heavy dependency. The approximation must be **conservative** — under-fill rather than blow the budget. |

Benchmark corpus sizes to measure, per P17: 100 / 1,000 / 10,000 / 100,000
memories, generated synthetically, measuring ingestion, embedding throughput,
FTS, vector search, hybrid search, graph traversal, context generation,
enrichment queue drain, and DB query counts. Rendering benchmarks alone do not
count.

## J. Security and privacy risk

| Risk | Assessment | Control |
|---|---|---|
| Cross-brain leakage via ANN | **new attack surface** | `brain_id` in the same WHERE clause as the ANN ordering; static test asserting no vector query lacks a brain predicate, in the style of the existing `brain-isolation.test.ts`. |
| Embedding leakage | new | Embeddings are derived content and are treated as content: never returned by any API, never logged, excluded from export unless the owner explicitly asks. |
| Graph traversal leakage | new | Every traversal starts from an authorized brain and every hop stays inside it. `brain_path` and `brain_neighbors` take a `brainId` from the authorized context, never from the body — matching the existing static rule. |
| Provenance leakage | new | The chain may cross memories the agent cannot read. Redact those nodes to `{ id, type, "not accessible" }` rather than omitting them silently, so the chain is honest without leaking. |
| Context leakage | new | `brain_context` reuses `requireBrainContext`; it is a composition of authorized reads, never a privileged path. |
| Agent scope escalation | existing, strong | Two-layer intersection stays. New tools map to existing scopes only — **no new scope is introduced**, so no existing key silently gains power. `brain.consolidate`, `delete`, `export`, `import` stay off by default. |
| REST/MCP authorization drift | **real, found in audit** | `principal.ts` must use `brainScopeSatisfied`; add a test asserting both paths agree for every scope pair. |
| Third-party model download at runtime | new | Unacceptable. Model weights are baked into the image or mounted; the worker makes no outbound call to fetch them, and no memory content ever leaves the server (P2). |
| Content in logs | existing, respected | Enrichment errors log ids and reasons, never content. `brain_retrieval_events` stores a query **hash**, not the query. |

New security tests required (P16): ANN brain scoping, traversal containment,
provenance redaction, context tool scope enforcement, REST/MCP scope parity,
embedding absent from export and from all API responses.

---

# Second Brain 2.0 — the plan

## Current architecture

```
Agent ──MCP (sk_ key)──┐
User ──session────────┐│
                      ▼▼
            lib/brain/access.ts          ← single authorization choke point
                      │                    (key scopes ∩ brain_access grant)
                      ▼
      app/api/brain/**  (26 routes)
                      │
   ┌──────────────────┼───────────────────┬─────────────────┐
   ▼                  ▼                   ▼                 ▼
memory-service   recall.ts          link-service     consolidation-service
 (FTS search)   (5 sections,        (memory_links)   (dupes + conflicts,
                 6000 chars)                          only auto link writer)
   │                  │                   │                 │
   └──────────────────┴─────────┬─────────┴─────────────────┘
                                ▼
                          Neon PostgreSQL
                    (12 tables, tsvector GIN)
                                │
                                ▼
                     graph-snapshot.ts (server, cached)
                                │
                     graph/relate.ts (TF-IDF, pure)
                                │
                     graph/model.ts (CSR, client)
                                ▼
                     Graph UI + /graph-workspace
```

Everything is synchronous. The worker exists but knows nothing about the brain.

## Target architecture

```
Agent ──MCP 2.0 (grouped tools)──┐
User ──session──────────────────┐│
                                ▼▼
                    lib/brain/access.ts          ← unchanged, still the only gate
                                │
                    app/api/brain/**
                                │
        ┌───────────────────────┼────────────────────────┐
        ▼                       ▼                        ▼
  WRITE PATH              RETRIEVAL PATH           INTELLIGENCE PATH
  remember/update    ┌── retrieval/hybrid.ts ──┐   health-service
        │            │   lexical (FTS)         │   provenance-service
        │            │   semantic (pgvector)   │   graph-metrics (read cache)
        │            │   graph proximity       │
        │            │   importance/confidence │
        │            │   recency/decay         │
        │            └──────────┬──────────────┘
        │                       ▼
        │            context-engine.ts  ← token budget, packing, dedup,
        │                       │          explainable scoring
        │                       ▼
        │              brain_context / brain_recall
        ▼
   enqueue brain-enrich-memory  (never blocks the response)
        │
        ▼
   BullMQ storage-jobs ──► worker
        │                    normalize → entities → aliases → mentions →
        │                    embed → neighbours → dupes → conflicts →
        │                    suggest links → graph metrics → health
        ▼
   Neon PostgreSQL + pgvector + FTS + graph metric cache
```

Three principles carried through every phase:

1. **The write path never gets slower.** All intelligence is derived
   asynchronously and is always optional.
2. **Every derived fact carries its reason.** `relate.ts` already does this; the
   enrichment pipeline, health report and context engine all inherit the rule.
   No unexplained edges, no unexplained rankings (rules 9, 10).
3. **Degradation is graceful and visible.** No pgvector, no Redis, no model — the
   brain still works at today's capability and says so.

## Database changes

See [§ D](#d-schema-that-needs-extending). Summary: 14 additive columns on
`memories`, 6 on `brain_entities`, 4 new enum values, 5 new link types, 4 new
tables, 5 new indexes. Zero renames, zero drops, zero type changes.

## New services (`lib/brain/`)

| Service | Responsibility | Pure? |
|---|---|---|
| `embedding/provider.ts` | `EmbeddingProvider` interface: `embed(texts) → Float32Array[]`, `dimensions`, `model`, `available()` | no |
| `embedding/local.ts` | the default local implementation | no |
| `embedding/null.ts` | no-op provider so everything runs with semantics off | yes |
| `retrieval/score.ts` | the hybrid scoring function — inputs in, score + explanation out | **yes** |
| `retrieval/hybrid.ts` | candidate generation from all legs, rescoring, ordering | no |
| `context-engine.ts` | token budgeting, section allocation, packing, dedup, compression | mostly |
| `tokens.ts` | token estimation, deliberately conservative | **yes** |
| `enrich/pipeline.ts` | the 10 steps, each independently idempotent | no |
| `enrich/entities.ts` | entity + alias extraction (deterministic, no LLM) | **yes** |
| `enrich/mentions.ts` | mention detection over names + aliases | **yes** |
| `graph/algorithms.ts` | PageRank, connected components, Louvain-style clustering, bridges, shortest path | **yes** |
| `temporal.ts` | decay, freshness, reinforcement formulas | **yes** |
| `health-service.ts` | the knowledge-health report | no |
| `provenance-service.ts` | bounded derivation-chain traversal | no |

The pure modules are where the intelligence actually lives, which is what makes
rule 8 (*"semua scoring harus testable"*) satisfiable — the same reason
`relate.ts` is testable today.

## New workers

Four job types, as specified in [§ F](#f-worker--background-processing-needed).
They go on the **existing** `storage-jobs` queue with a dedicated concurrency
setting, so no new infrastructure and no new Redis connection.

## New MCP tools

Grouped presentation, additive registration:

- **WRITE** — `brain_remember`, `brain_update`, `brain_link`, `brain_link_memory`,
  `brain_reinforce`*, `brain_supersede`*
- **RETRIEVAL** — `brain_search`, `brain_recall`, `brain_context`*,
  `brain_neighbors`*, `brain_path`*, `brain_get_related`, `brain_get_backlinks`
- **INTELLIGENCE** — `brain_health`*, `brain_provenance`*
- **MANAGEMENT** — `brain_delete`, `brain_restore`, `brain_consolidate`,
  `brain_list_brains`, `brain_list_projects`, `brain_list_tags`,
  `brain_read`, `brain_get_recent`, `brain_get_memory_history`,
  `brain_get_entity`

`*` = new. Nothing is removed or renamed. Grouping is descriptive metadata plus
tool-description wording, so it costs no compatibility.

## Retrieval architecture

Candidate generation from four independent legs, then one rescoring pass:

```
query ──┬─► FTS leg        (existing prefixTsQuery, top 50)
        ├─► vector leg     (HNSW cosine, top 50, brain-scoped in the same WHERE)
        ├─► graph leg      (1–2 hops from seeds already matched, top 30)
        └─► structural leg (importance ≥ threshold, standing directives, top 20)
                     │
                     ▼
              union, dedup by id
                     │
                     ▼
        score.ts — one function, six weighted terms
                     │
                     ▼
          ordered results + per-result explanation
```

```
score = w_lex  · lexicalRank          // ts_rank, normalized
      + w_sem  · cosineSimilarity     // 0 when no embedding
      + w_imp  · importance           // existing column
      + w_conf · effectiveConfidence  // confidence after temporal decay
      + w_rec  · recencyBoost         // exp decay on updatedAt
      + w_gph  · graphProximity       // PageRank + hop distance from seeds
      − p_stale · stalePenalty        // validityState, never a filter
```

Non-negotiable properties: the weights are named constants in one file;
`score.ts` is pure and unit tested; every returned row carries the term
breakdown that produced it; `validityState = 'superseded' | 'stale'` **lowers
rank but never removes a row** (P5); and when `semanticAvailable` is false,
`w_sem` is 0 and results degrade to today's behaviour rather than erroring.

Ranking is deterministic: ties break on `importance`, then `updatedAt`, then
`id`, so the same query on the same corpus always returns the same order.

## Graph intelligence

Computed in `graph/algorithms.ts` (pure, over the CSR model that already exists),
cached in `brain_graph_metrics`, and exposed on `GraphSnapshotNode`:

| Metric | Algorithm | Feeds |
|---|---|---|
| degree, weighted degree | already in `model.ts` | node size |
| PageRank | power iteration, 20 iters, d=0.85, on the undirected weighted graph | node size, retrieval graph leg |
| components | union-find | orphan detection |
| clusters | label propagation (deterministic tie-break by node id) | colour groups |
| bridges | high betweenness approximation on cluster boundaries, or articulation points via DFS lowlink | highlight ring |
| shortest path | bidirectional BFS, hop cap 6, node-visit cap | `brain_path` |
| knowledge gaps | high-importance nodes with degree 0–1, or clusters connected by exactly one edge | health report |

Visual encoding (P4), all reusing existing tokens from `app/globals.css`:
important/high-PageRank → larger; high confidence → thicker link; bridge →
highlight ring; stale → faded; contradiction → warning colour. Orphans stay
visible — they are the knowledge gaps, not noise to hide.

**Determinism requirement.** Label propagation and PageRank must produce the same
output for the same input every run, otherwise cluster colours flicker between
loads. All iteration orders are by node index, all ties break by id.

## Context engine (highest priority — P8)

`brain_context({ task, tokenBudget, mode })` with three preset budgets: compact
1,000 / detailed 4,000 / deep 12,000.

Allocation is proportional and explicit, e.g. at 4,000 tokens:

| Section | Share | Content |
|---|---|---|
| standing directives | 10% | always first, never dropped |
| directly relevant | 35% | hybrid retrieval on the task text |
| semantic neighbours | 15% | vector-nearest to the top relevant items |
| important concepts / entities | 15% | high PageRank + high importance in scope |
| recent decisions | 10% | type ∈ decision/instruction, recency-ordered |
| contradictions & staleness | 10% | flagged, never auto-resolved (rule 11) |
| provenance pointers | 5% | ids and one-line reasons, not full chains |

Packing rules: unused share from an empty section is redistributed to the next
section by priority, never wasted; every item is truncated at a sentence boundary
with a marker rather than mid-word; duplicates and near-duplicates collapse to
one entry that notes the other ids; the final package is verified against the
budget **before** returning, and a package that would exceed it drops the
lowest-scored item and re-verifies.

Output is a structured object *plus* the rendered text — so agents can consume
either — and it always includes `{ tokenEstimate, sections, droppedCount,
semanticAvailable, explanation }`. Deterministic and explainable, per the
directive.

`brain_recall` is reimplemented on top of this at the compact budget, keeping its
current output shape so no existing agent breaks.

## Embedding strategy

Requirements, from the user's constraints: local/self-hosted, no memory content
leaving the server, no external AI API, no per-token cost, deterministic,
runs in the worker, and **no LLM API dependency in the core brain** (rule 4).

The abstraction comes first and is what the rest of the system depends on:

```ts
interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  available(): Promise<boolean>;
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

Nothing outside `lib/brain/embedding/` may import a specific implementation. The
default in a fresh install is `NullEmbeddingProvider` — semantics off, everything
else on.

**The compatibility problem, stated plainly.** Both Docker images are
`node:20-alpine` (musl libc). `onnxruntime-node` — which `@xenova/transformers`
and `@huggingface/transformers` use for their fast path — ships no musl prebuild.
So the default local runtime does not work on the current worker image without a
change. Three viable options, to be decided before P2 begins:

| Option | Change required | Cost | Verdict |
|---|---|---|---|
| **A. `node:20-slim` for the worker** | one-line base image change in `docker/Dockerfile.worker`, re-add `ffmpeg` via apt | image ~120 MB larger; must re-verify `sharp`, `@node-rs/argon2`, `@napi-rs/canvas` on glibc | **recommended** — smallest architectural change, native speed |
| **B. WASM backend on alpine** | force the WASM execution provider | 3–10× slower embedding; acceptable because it is a background job | fallback if A destabilises the worker |
| **C. separate embedding sidecar** | new container, new internal contract | most isolation, most moving parts, new failure mode | only if A and B both fail |

Model: a small multilingual sentence encoder at **384 dimensions**
(`paraphrase-multilingual-MiniLM-L12-v2` class) — Indonesian and English in one
model, which the bilingual corpus needs. Weights are baked into the image or
mounted; the worker performs **no runtime download**.

Embedded text = `title` repeated for weight + `summary` + first ~1,500 chars of
`content`, matching what `relate.ts` already uses so lexical and semantic legs see
the same document. Batch size 16–32. Re-embed only when the content hash or
`embeddingModel` changes, so a model upgrade is a resumable backfill rather than a
migration.

`vector(384)` at 100k memories ≈ 154 MB of vector data before index overhead —
fine for Neon. If dimensions ever change, that is a new column plus a backfill,
never an in-place type change.

## Migration strategy

Five migrations, in this order, each shippable alone:

1. `0016_brain_enum_extensions.sql` — new `memory_type` values, new link types.
   Isolated because `ALTER TYPE ... ADD VALUE` may not run in a transaction.
2. `0017_brain_memory_2.sql` — the additive `memories` columns + their indexes.
3. `0018_brain_entity_2.sql` — entity aliases, mention counters, extraction
   provenance.
4. `0019_brain_intelligence_tables.sql` — `memory_mentions`,
   `brain_graph_metrics`, `brain_health_snapshots`, `brain_retrieval_events`.
5. `0020_brain_vector.sql` — **gated**: `CREATE EXTENSION vector`, the
   `embedding` columns, the HNSW index built `CONCURRENTLY`.

Rules for all five: additive only; every column nullable or defaulted; the app
must run correctly against a database where migration *n+1* has not yet been
applied (feature detection, not version assumptions); the user applies to Neon
first and redeploys after, per the existing `db:push` guidance in
`docs/deployment.md`.

Backfill is **not** part of any migration. It is `brain-embed-batch` and
`brain-enrich-memory` jobs, resumable by keyset, safe to stop and restart, and
observable via `enrichmentStatus` counts.

## Testing strategy

Existing 313 tests must stay green at every step — that is the acceptance gate for
each phase, not just the end (P18).

New test categories, matching the ones the audit found missing:

| Category | Examples |
|---|---|
| **retrieval** | hybrid ordering is deterministic; each leg contributes; semantic-off degrades to lexical-only; ties break by importance → updatedAt → id |
| **semantic** | `score.ts` term weights; cosine normalization; `NullEmbeddingProvider` path; re-embed triggers on content hash change |
| **graph algorithms** | PageRank on known small graphs with hand-computed expected values; components on disconnected input; clustering determinism across runs; shortest path hop cap; bridge detection on a barbell graph |
| **temporal** | decay monotonic in age; reinforcement raises effective confidence; decay never deletes; superseded rows still retrievable |
| **context budget** | never exceeds the budget; directives never dropped; redistribution of unused share; identical input → byte-identical output; `droppedCount` accurate |
| **provenance** | chain depth bounded; cycles terminate; inaccessible nodes redacted not omitted |
| **enrichment idempotency** | running the pipeline twice produces one set of entities/mentions/suggestions; a failed step leaves the memory usable |
| **MCP behaviour** | every new tool enforces its scope; REST and MCP agree on scope satisfaction for all scope pairs; no new scope granted by default |
| **security / isolation** | extend `tests/brain-isolation.test.ts`: static assertion that no vector query lacks a brain predicate; embeddings absent from every API response and from export; traversal never crosses brains |
| **performance** | synthetic corpora at 1k/10k; assert p95 bounds rather than absolute times, so CI stays stable |

Unit tests stay pure and DB-free wherever the module is pure — which is why the
pure/impure split in § New services matters. Integration tests that need
Postgres are marked and skipped when `DATABASE_URL` is absent, matching how the
suite already behaves.

## Performance strategy

- **Measure before claiming.** The P10 token benchmark is a real deliverable: for
  a fixed set of tasks, compare tokens consumed by naive `brain_search` +
  full-document reads against `brain_context`, and report relevance@token. No
  "more efficient" claim ships without those numbers in the docs.
- **Everything expensive is precomputed or capped.** Embeddings and graph metrics
  are worker-side; snapshot node/edge caps already exist; retrieval legs have
  fixed candidate caps; traversal has hop and visit caps.
- **Instrument the seven latencies** P15 asks for: retrieval, embedding,
  enrichment, context generation, graph metrics, health scan, cache hit rate.
  Sampled into `brain_retrieval_events`, surfaced on the dashboard alongside the
  graph counters that are missing today.
- **Budget the write path explicitly.** `POST /memories` p95 must not regress
  measurably versus today. That is a test, not a hope.

## Phased implementation order

Ordered by dependency, and by "intelligence before cosmetics" (rule 14). Scope is
in files-touched and new-test count, not calendar time.

| # | Phase | Impact | Complexity | Risk | Depends on | Scope |
|---|---|---|---|---|---|---|
| **1** | **Foundations** — additive schema (migrations 0016–0019), `tokens.ts`, `score.ts` skeleton, `EmbeddingProvider` + Null impl, MCP/REST scope-parity fix | high (unblocks all) | low | **low** — additive only, no behaviour change | — | ~10 files, +25 tests |
| **2** | **Enrichment pipeline** — 4 job types, entity + alias extraction, mention detection, status tracking, dashboard status counters | high — fills the two empty edge tiers | medium | medium — first async brain path; idempotency is the crux | 1 | ~14 files, +35 tests |
| **3** | **Context engine** — `context-engine.ts`, `brain_context`, token budgeting, `brain_recall` rebuilt on top | **highest** (P8) | medium | low — pure logic over existing retrieval | 1 | ~8 files, +30 tests |
| **4** | **Temporal memory** — decay, reinforcement, recall counters, validity, supersession, lifecycle transitions | high | low | low — additive scoring, never deletes | 1 | ~7 files, +20 tests |
| **5** | **Graph intelligence** — `algorithms.ts`, metrics cache, snapshot fields, visual encoding | high | medium | medium — determinism and snapshot compatibility | 1, 2 | ~12 files, +30 tests |
| **6** | **Semantic memory** — worker base-image decision, local provider, `0020` vector migration, HNSW, hybrid retrieval with the semantic leg live | high | **high** | **highest** — Docker/musl, extension availability, model weights, ANN scoping | 1, 2, 3, deployment decision | ~12 files, +25 tests |
| **7** | **Knowledge health & contradiction surface** — `health-service.ts`, `brain_health`, review-queue UI, consolidation UI (which exists in the hook but has no page) | high — makes existing detection visible | low | low — read-only reporting, no auto-resolve | 2, 4, 5 | ~9 files, +20 tests |
| **8** | **Provenance & multi-hop** — link kinds in use, `provenance-service.ts`, `brain_provenance`, `brain_path`, `brain_neighbors` | medium-high | medium | medium — traversal bounds and redaction | 1, 2, 5 | ~9 files, +25 tests |
| **9** | **Token efficiency & benchmarks** — packing refinement, compression, the naive-vs-context measurement | medium — proves the thesis | low | low | 3, 6 | ~5 files, +12 tests |
| **10** | **Obsidian parity gaps** — unlinked mentions UI, aliases UI, remaining graph controls, nested tags | medium (UX) | medium | low | 2, 5 | ~10 files, +15 tests |
| **11** | **Observability** — the 14 metrics, dashboard panels, latency sampling | medium | low | low | 2, 3, 5, 6 | ~7 files, +10 tests |
| **12** | **Performance hardening & docs** — synthetic corpora, benchmark suite, documentation rewritten from the actual implementation | medium | medium | low | all | ~8 files, +15 tests |

Phases 1–5, 7 and 8 all ship **without pgvector**. Only phase 6 depends on the
extension and the base-image change, so the risky work is isolated and late
rather than foundational. If phase 6 were abandoned entirely, phases 1–5 and
7–12 would still deliver temporal reasoning, graph intelligence, a token-aware
context engine, health reporting, provenance and multi-hop traversal.

## Open decisions — needed before phase 6, not before phase 1

1. **Worker base image.** Recommendation: option A, `node:20-slim`. It requires
   re-verifying `sharp`, `@node-rs/argon2` and `@napi-rs/canvas` on glibc, which
   is a contained change to `docker/Dockerfile.worker`.
2. **`CREATE EXTENSION vector` on Neon.** Migrations are the user's to apply.
   Until it exists, `semanticAvailable` is false and the plan proceeds.
3. **Model weights in the image vs a mounted volume.** In-image is simpler and
   guarantees no runtime download; it adds ~120 MB to the worker image.
4. **Does a local sentence encoder satisfy rule 4?** Reading of the rule: the ban
   is on *LLM API* dependencies — network calls, per-token cost, content leaving
   the server. A local deterministic encoder violates none of those. Confirmation
   requested before phase 6 begins.

## What this plan deliberately does not do

- No rewrite of `relate.ts`, `graph-snapshot.ts`, `recall.ts`, `access.ts` or the
  graph UI. They are extended; the lexical tier stays as a retrieval leg even
  after vectors land.
- No removal or renaming of any table, column, route, MCP tool or scope.
- No LLM API anywhere in the brain.
- No auto-resolution of contradictions.
- No synthetic edges to make the graph look populated. The empty entity tier gets
  filled by real extraction or stays empty.
- No deletion of knowledge by decay — only rank suppression.
- No "production ready" claim until `npm test`, `npm run lint` and
  `npm run build` all pass on the finished work.




