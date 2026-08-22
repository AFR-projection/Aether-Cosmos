# Intelligence Layer (Second Brain 2.0)

Hybrid retrieval, context engine, enrichment, health monitoring, provenance tracking,
feedback loops, and consolidation — the intelligence layer built on top of the 1.0
memory store.

---

## What's new in 2.0

| Component | What it does |
|-----------|--------------|
| **Hybrid retrieval** | Lexical (PostgreSQL FTS) + entity (shared entities) + graph (PageRank walk) + semantic (embeddings, abstains by default) → fused ranked list |
| **Pure scorer** | Combines 7 voting signals into one score per memory, with a quality cap and bounded validity multiplier |
| **Context engine** | `retrieve → load → filter redundancy → pack to token budget → explain` in one call |
| **Enrichment** | Idempotent extraction of entity mentions from memory content, stored in `memory_mentions` |
| **Temporal service** | Date-range slices and recency scoring |
| **Provenance service** | Track derivation chains (memory A was inferred from B and C) |
| **Health service** | Periodic snapshots: completeness, quality, connections, recency |
| **Review queue** | Durable warnings from enrichment (low confidence, conflicting sources) |
| **Feedback loop** | Counters on `memories` + event log in `brain_retrieval_events` — no second multiplier applied yet |
| **Graph algorithms** | PageRank, connected components, bridges, label propagation, Dijkstra paths |
| **Consolidation** | Non-destructive preview or apply: merge duplicate entities, reconcile naming conflicts |

All of this is reachable **through MCP only** — no web UI yet except for the
consolidation preview at `/api/brain/[id]/consolidate`.

---

## Retrieval (`retrieve-v1`)

`lib/brain/retrieval/hybrid.ts`

Four retrieval legs run in parallel, each returning up to `perLeg` candidates
(default 20):

| Leg | How it works | When it abstains |
|-----|--------------|------------------|
| **Lexical** | PostgreSQL `ts_rank_cd` over `memories.search_vector` (title weight A, content weight B) | Query is empty or all stopwords |
| **Entity** | Memories that mention entities named in the query, ranked by mention count | No recognized entities in the query |
| **Graph** | PageRank random walk from entities in the query, traverse memory↔entity edges | No entities or the graph is empty |
| **Semantic** | Embedding cosine similarity (requires `BRAIN_EMBEDDING_PROVIDER` != `none`) | Provider is `none` (the default) |

A leg that abstains contributes zero candidates rather than random noise. The four
lists are fused with Reciprocal Rank Fusion (RRF, k=60), deduplicated, and returned
as one ranked list.

**Tested:** 34 unit tests in `lib/brain/retrieval/hybrid.test.ts`, covering
abstention, deduplication, multi-leg fusion, and the scoring math.

---

## Scoring (`scorer-v1`)

`lib/brain/retrieval/scorer.ts`

The pure scorer takes a memory and a retrieval context (query + focus + recency
window + feedback stats) and returns a score in [0, 1]. No side effects, no database
calls — it's a weighted mean over 7 voting signals, each scaled to [0, 1]:

| Signal | Weight | What it measures |
|--------|--------|------------------|
| Retrieval rank | 0.25 | Where this memory landed in the fused retrieval list |
| Importance | 0.20 | `memories.importance` (user/agent-set) |
| Confidence | 0.15 | `memories.confidence` |
| Recency | 0.15 | Exponential decay from `updatedAt` |
| Feedback | 0.10 | How often this memory was retrieved, scored >0.5, and selected in past queries |
| Entity overlap | 0.10 | Shared entities between memory and query |
| Graph centrality | 0.05 | PageRank score from `brain_graph_metrics` |

The weighted mean is capped by a **quality gate**: if `importance < 0.3` or
`confidence < 0.3`, the final score is multiplied by `max(importance, confidence)`.
This prevents low-quality memories from ranking high on recency alone.

A **validity multiplier** bounds how much recency can lift a stale memory: memories
older than 180 days get a factor in [0.5, 1.0] based on age.

**Tested:** 28 unit tests in `lib/brain/retrieval/scorer.test.ts`, covering each
signal in isolation, the quality cap, validity decay, and score stability (same
input → same output).

---

## Context engine (`context-v1`)

`lib/brain/context-engine.ts`

One call: `buildContext(brainId, query, options)` → packed context object.

Pipeline:

1. **Retrieve** — hybrid retrieval with the query
2. **Load** — fetch full memory rows for the top *N* candidates (default 50)
3. **Score** — pure scorer over each memory
4. **Filter** — redundancy filter (cosine similarity over TF-IDF vectors; if two
   memories are >0.85 similar, keep the higher-scored one)
5. **Pack** — greedily pack memories into the token budget (default 6000), highest
   score first, using `heuristic-bpe-v1` token counter
6. **Explain** — for each selected memory, record why it was chosen (which signals
   contributed, what the final score was)

Returns: `{ memories: Memory[], explanation: string, tokensUsed: number, stats: {...} }`.

The MCP tool `brain_context` calls this and formats the result for the agent.

**Tested:** 19 integration tests in `lib/brain/context-engine.test.ts`, covering
query parsing, multi-leg fusion, redundancy filtering, token packing, and
explanation generation.

---

## Enrichment (`enrich-v1`)

`lib/brain/enrich/orchestrator.ts` + `lib/brain/enrich/extract.ts`

**Idempotent** extraction of entity mentions from memory content. On every memory
write, the enrichment job:

1. Hashes `title + content + memoryType`.
2. If `memories.enriched_hash` matches, skip — already done.
3. Run the **deterministic extractor** (`deterministic-v1`): 6 ranked rules
   (capitalized phrases, quoted strings, `@mentions`, `#tags`, known entity names,
   noun phrases) with evidence spans.
4. Write mentions to `memory_mentions`, overwriting old ones for this memory.
5. Write quality warnings to `brain_review_items` if confidence < 0.5 or conflicting
   sources detected.
6. Update `memories.enriched_hash` and `enriched_at`.

The hash makes enrichment idempotent: re-running the job on unchanged content is a
no-op. Changing the content invalidates the hash, so mentions are re-extracted.

**No LLM calls** — the extractor is rule-based and deterministic, so two runs over
the same text return identical mentions.

**Tested:** 47 unit tests across `extract.test.ts`, `orchestrator.test.ts`, and
`enrich-service.test.ts`, covering rule priority, span extraction, idempotency, and
the review-queue write.

---

## Temporal service

`lib/brain/temporal-service.ts`

Two exports:

- `getMemoriesInDateRange(brainId, start, end, limit)` — memories created or updated
  in `[start, end]`, newest first.
- `scoreRecency(updatedAt, now)` — exponential decay: `exp(-days / 90)`, so a
  memory updated today scores 1.0, 90 days ago scores ~0.37, 180 days scores ~0.14.

The MCP tool `brain_timeline` calls the first; the scorer calls the second.

**Tested:** 12 tests in `temporal-service.test.ts`.

---

## Provenance service

`lib/brain/provenance-service.ts`

Tracks derivation: memory A was created from memories B and C. The service writes to
a `memory_provenance` join table (not yet in the schema — placeholder for now) and
exposes:

- `recordDerivation(derivedId, sourceIds[])`
- `getProvenance(memoryId)` → ancestor chain
- `getDerivedMemories(memoryId)` → descendants

**Status:** service layer exists, schema table is not migrated yet, so the functions
are stubs. Calls succeed but writes are no-ops. Tracked as a post-2.0 addition.

**Tested:** 8 tests in `provenance-service.test.ts`, all passing (testing the stub
behavior).

---

## Health service

`lib/brain/health-service.ts`

Computes a health snapshot for a brain:

| Dimension | What it measures | Score formula |
|-----------|------------------|---------------|
| **Completeness** | Memories with non-empty content | `(filled / total)` |
| **Quality** | Average importance × confidence | `mean(importance * confidence)` |
| **Connections** | Memories with at least one edge | `(connected / total)` |
| **Recency** | Memories updated in the last 90 days | `(recent / total)` |

Overall score is the mean of the four dimensions, in [0, 1].

Snapshots are written to `brain_health_snapshots` (one row per run) and served by
the MCP tool `brain_health`. The service is **read-only** — it observes the brain,
never mutates it.

**Tested:** 15 tests in `health-service.test.ts`.

---

## Review queue

`brain_review_items` table, written by enrichment, consolidation, and (eventually)
the scoring feedback loop when it detects anomalies.

Each item:
- `item_type`: `low_confidence`, `conflicting_sources`, `duplicate_entity`, `stale_memory`
- `severity`: `info`, `warning`, `error`
- `context`: JSON blob with the memory id, entity name, conflicting ids, etc.
- `resolved_at`: null until a human or agent acts on it

**No auto-resolution** — the queue is write-only for now. A future UI will let you
review and resolve warnings.

**Tested:** indirectly through enrichment and consolidation tests; no dedicated
review-service tests yet.

---

## Feedback loop

`lib/brain/feedback-loop.ts`

Two counters on the `memories` table:
- `retrieval_count` — how many times this memory appeared in a retrieval result
- `selection_count` — how many times it was in the top *k* (default 10) and had
  score ≥ 0.5

Plus a content-free event log in `brain_retrieval_events`:
- `(brain_id, memory_id, event_type, score, query_hash, created_at)`

The scorer reads these counters and computes a feedback signal:
`selection_count / max(retrieval_count, 1)`, scaled to [0, 1].

**No second multiplier** applied yet — the feedback signal votes at weight 0.10, but
it does not amplify future retrievals. Tracked as a post-2.0 tuning step.

**Tested:** 18 tests in `feedback-loop.test.ts`, covering counter increments, event
logging, and the feedback signal calculation.

---

## Token accounting

`lib/brain/tokens.ts`

`heuristic-bpe-v1`: `characters / 3.7`, calibrated against `gpt-4` token counts with
2.1% mean error over 50 test cases. Fast (no tiktoken call), deterministic, and
conservative (slightly over-estimates to avoid budget overruns).

The context engine uses this to pack memories into the token budget. A future
version may call `tiktoken` for exact counts when the budget is tight.

**Tested:** 9 tests in `tokens.test.ts`.

---

## Graph algorithms

`lib/brain/graph/algorithms.ts`

| Algorithm | What it does | Used by |
|-----------|--------------|---------|
| **PageRank** | Node importance via random walk with damping (α=0.85, 20 iterations) | Graph leg of retrieval, centrality signal in scorer |
| **Connected components** | Tarjan's algorithm, label each node with its component id | Graph metrics, consolidation |
| **Bridges** | Edges whose removal disconnects the graph | Graph metrics |
| **Label propagation** | Community detection (10 iterations) | `brain_related` MCP tool |
| **Dijkstra** | Shortest path between two entities | `brain_path` MCP tool |

Computed on-demand and cached in `brain_graph_metrics` (PageRank + component ids
only; paths are not cached).

**Tested:** 31 tests in `algorithms.test.ts`, covering small graphs, disconnected
graphs, self-loops, and known PageRank results.

---

## Consolidation (§30 / §31)

`lib/brain/consolidate/*`

Non-destructive merge of duplicate entities and reconciliation of naming conflicts.
Two modes:

- **Preview** (`apply: false`) — returns a plan: which entities would merge, what
  the canonical name would be, how many edges would be affected. **No writes.**
- **Apply** (`apply: true`) — executes the plan: updates `brain_entities`, rewrites
  edges to point at the canonical id, writes a review item, audits the operation.

Duplicate detection: edit distance ≤ 2 (Levenshtein) + same entity type.

**Scope:** `brain.consolidate`. Gated from agents by default.

**Status:** the `/api/brain/[id]/consolidate` route works and is covered by tests.
The MCP tool `brain_consolidate` calls it.

**Tested:** 23 integration tests in `lib/brain/graph/related-service.test.ts` and
consolidation unit tests (not in a dedicated file yet; coverage is in the
integration suite).

---

## Embeddings

`lib/brain/embedding/*`

Three providers: `NullEmbeddingProvider` (default), `OpenAIEmbeddingProvider`,
`VoyageAIEmbeddingProvider`. Selected by `BRAIN_EMBEDDING_PROVIDER` env var.

The null provider returns model `"none"`, dimensions `0`, and its `embed()` method
throws. The semantic retrieval leg checks the model and abstains when it's `"none"`,
so **embeddings are off by default** — no third-party inference, no API keys
required, retrieval still works via the other three legs.

To enable:
```env
BRAIN_EMBEDDING_PROVIDER=openai
OPENAI_API_KEY=sk-...
```

or:
```env
BRAIN_EMBEDDING_PROVIDER=voyageai
VOYAGEAI_API_KEY=...
```

**No local/self-hosted encoder** — the abstention design means you can run 2.0
without embeddings at all, so there's no pressure to bundle a 500 MB model or call a
local inference server. If you want semantic search, point at OpenAI or Voyage.

**Tested:** 12 tests in `embedding/*.test.ts`, all passing (null provider + the
abstention path in hybrid retrieval).

---

## Status and limits

**What works:**
- All 2.0 services are unit-tested and reachable through MCP.
- Hybrid retrieval abstains gracefully when embeddings are off (the default).
- The context engine packs memories into a token budget and explains its choices.
- Enrichment is idempotent and deterministic.
- Health snapshots, feedback counters, and the review queue write correctly.
- Consolidation preview and apply work; the plan is non-destructive.

**What doesn't work yet:**
- No web UI for any of this except consolidation preview — 2.0 is MCP-only.
- Review queue is write-only; no UI to resolve warnings.
- Provenance service is a stub (schema table not migrated).
- Feedback loop counters are recorded but not yet used to amplify future retrievals
  (no second multiplier).
- Import loses `enriched_hash`, `enriched_at`, `aliases`, `extractedBy`, and
  `extractionConfidence` from `memory_mentions` — see **Import non-idempotency** below.

**Current defaults:**
- Embeddings: **off** (`BRAIN_EMBEDDING_PROVIDER=none`). Semantic leg abstains;
  retrieval uses lexical + entity + graph only.
- Context budget: 6000 tokens.
- Retrieval candidates: 50 per query, 20 per leg.
- Recency decay: 90-day half-life.
- Quality gate: `importance < 0.3` or `confidence < 0.3` caps the score.

---

## Import non-idempotency

**BUG-2b** (from the final baseline report):

`lib/brain/import-service.ts` writes memories additively (no conflict clause), so
importing the same archive twice creates duplicates. Projects, entities, tags, and
relationships merge by natural key, but memories and memory links do not.

Additionally, the import path does **not** restore `enriched_hash`, `enriched_at`,
`aliases`, `extractedBy`, or `extractionConfidence` from `memory_mentions` — those
fields are in the export but ignored on import. Re-enrichment after import
recalculates them, but the original extractor attribution is lost.

Tracked as a known issue; not blocking 2.0 release.

---

**See also:** [Second Brain Overview](second-brain.md) ·
[Second Brain MCP](second-brain-mcp.md) · [Second Brain Architecture](second-brain-architecture.md)
