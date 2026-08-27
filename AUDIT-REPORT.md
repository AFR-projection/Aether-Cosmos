# Second Brain 2.0 — Comprehensive Audit Report

Date: 2024
Version: 0.4.0

---

## EXECUTIVE SUMMARY

Second Brain 2.0 has a **solid intelligence foundation** but is still **passive** and **incomplete**. Core algorithms are in place (hybrid retrieval, scoring, graph, enrichment) but:

1. **Query understanding is minimal** — lexical matching is too literal
2. **Graph intelligence is not persistent** — derived edges are on-the-fly only
3. **Feedback loop is not active** — counters exist but are not applied
4. **Auto-maintenance does not exist** — the brain is not self-organizing

---

## PART 1: RETRIEVAL SYSTEM AUDIT

### ✅ What Already Exists (SOLID):

**Hybrid Retrieval Pipeline** (`lib/brain/retrieval/retrieve.ts`):
- 4 legs: lexical, entity, graph, semantic (optional)
- Proper abstention when signal unavailable
- Reciprocal Rank Fusion to merge results
- Strict tenant isolation (brainId filter in every query)
- Per-leg caps (60 lexical, 40 entity, 60 graph)
- Bounded graph walk (max 2 hops, 200 edges per hop)

**Scoring System** (`lib/brain/retrieval/score.ts`):
- Pure function, deterministic
- Weighted mean over normalized signals [0,1]
- Match signals (75%): lexical, semantic, entity, graph, related
- Quality signals (25%): importance, confidence, recency, reinforcement
- Validity multiplier (active=1, stale=0.85, superseded=0.4, retracted=0.15)
- Explainable: every signal contribution tracked

**Entity Resolution**:
- Query words extracted (lowercase, split, stopwords filtered)
- Entity matching via regex `~*` with word boundaries
- Alias support: `brainEntities.aliases` array matched
- POSIX pattern: `(^|[^[:alnum:]])(word1|word2)([^[:alnum:]]|$)`

### ❌ What is MISSING (ROOT CAUSE OF THE PROBLEM):

1. **Query Preprocessing is MINIMAL**:
   ```typescript
   // Current:
   query.toLowerCase().split(/[^\p{L}\p{N}]+/u)
     .filter(word => word.length >= 3 && !STOP_WORDS.has(word))
   
   // Problem:
   "Check user identity and communication preferences"
   → ["check", "user", "identity", "and", "communication", "preferences"]
   
   // Stopwords ("and") not filtered because STOP_WORDS is incomplete
   // "Check" treated as a keyword even though it is an imperative verb
   // Phrase "communication preferences" split into 2 separate words
   ```

2. **No Query Intent Understanding**:
   - No distinction between:
     - Content words: "identity", "preferences", "communication"
     - Function words: "check", "and"
     - Imperative verbs: "check", "show", "find"
   - No phrase detection
   - No term weighting (TF-IDF query side)

3. **No Query Expansion**:
   - Entity aliases matched ONLY in the entity leg
   - No lexical expansion (synonyms from brain vocabulary)
   - No stemming/lemmatization
   - Query "communication preference" does not match entity "comm pref" via lexical leg

4. **Lexical Leg is Too Literal**:
   ```typescript
   // Current: ftsMatchOn(memories.searchVector, query)
   // Uses: to_tsquery('simple', query)
   // Problem: "simple" config = no stemming, no language processing
   ```

5. **Entity Leg Returns Empty When**:
   - Query words do not exactly match entity name/alias
   - "communication" does not match "komunikasi" (no bilingual matching)

6. **Graph Leg Requires Seeds**:
   - Graph walk only from `seedMemoryIds` or lexical hits
   - If lexical leg returns 0 → no seeds → graph leg abstains

---

## PART 2: GRAPH INTELLIGENCE AUDIT

### ✅ What Already Exists:

**Derived Edge Computation** (`lib/brain/graph/relate.ts`):
- TF-IDF cosine similarity between memories
- Shared entity detection
- Shared tags detection  
- Project matching
- Sparseness control:
  - MIN_WEIGHT = 0.2
  - Top-K neighbors per node
  - Max degree ceiling
- **PURE FUNCTION** - deterministic, testable

**Graph Algorithms** (`lib/brain/graph/algorithms.ts`):
- PageRank (damping 0.85, 20 iterations)
- Connected components (Tarjan)
- Bridges detection
- Label propagation
- Dijkstra shortest path

**Explicit Links** (`memory_links` table):
- User/agent created
- sourceMemoryId → targetMemoryId or targetEntityId
- linkType: "relates_to", "contradicts", "supersedes", etc.
- brainId isolated

### ❌ What is MISSING (ROOT CAUSE OF SHALLOW `brain_related`):

> **CORRECTION (PHASE 2 audit)**: `brain_related` is not empty. `findRelatedMemories()`
> has a fallback to `retrieveMemories()` (Step 4), so lexical + entity overlap already
> produce results without an explicit link. What is truly missing: derived edges are not
> persistent, there is no label for origin/confidence/evidence, the query fallback is weak
> (seed title only), and `memory_links` is scanned without a LIMIT.

1. **Derived Edges are NOT SAVED**:
   ```typescript
   // Current:
   // lib/brain/graph-snapshot.ts calls relateMemories()
   // → computes TF-IDF edges
   // → returns them for the graph view only
   // → NOT written to memory_links

   // Problem:
   // brain_related() → getBrainRelatedMemories()
   // → Step 2/3 reads memory_links (explicit only)
   // → Step 4 fallback retrieval: results EXIST, but no provenance
   ```

2. **No Auto-Linking**:
   - A new memory is created → enrichment runs → entities extracted
   - But there is NO job to compute derived links
   - No trigger to auto-create relationships

3. **No Derived vs Explicit Distinction**:
   - `memory_links.linkType` is a free-form string
   - No field to mark "derived" vs "explicit"
   - No confidence/weight field
   - No provenance tracking

4. **Graph Service Limitations**:
   ```typescript
   // getBrainRelatedMemories() strategy:
   // 1. Direct links (memory_links) ✓
   // 2. Graph proximity (BFS over memory_links) ✓
   // 3. Semantic/entity overlap (via retrieval) ✓
   // 4. Shared project ✓
   
   // Problem: Step 1 & 2 return EMPTY when there are no explicit links
   // Step 3 & 4 are not strong enough when semantic is OFF
   ```

---

## PART 3: HEALTH SERVICE AUDIT

### ✅ What Already Exists:

**Comprehensive Metrics**:
- Structural: orphans, weak links, isolated clusters
- Quality: low confidence, unconfirmed, agent-created
- Temporal: stale memories (180 days default)
- Relationships: total links, entities, avg links per memory
- Contradictions: detected via `detectConflicts()` + `contradicts` links

**Smart Contradiction Detection**:
- Reads explicit `contradicts` links
- Runs consolidation service detector (word overlap, negation, conflicts)
- Deduplicates pairs
- Returns with severity HIGH

**Proper Counting**:
- All queries use proper SQL with `::int` casts
- Aggregates use `count(*)::int` 
- Fields accessed: `validityState`, `confirmationCount`, `lastAccessedAt`
- All fields EXIST in schema ✓

### ❌ ROOT CAUSE OF `brain_health` ERROR:

**UPDATE: Error already fixed in tools.ts** (return `null` instead of `undefined`)

The test now PASSES. The error was not from health-service.ts, but from MCP serialization:
```typescript
// Before:
queuedForReview: queued  // null serialized as undefined in JSON

// After:
queuedForReview: queued ?? null  // explicit null
```

**Remaining Issues**:

1. **No Proactive Health Monitoring**:
   - `brain_health` is only called manually
   - No scheduled job
   - No alerts

2. **Review Queue is Write-Only**:
   - Findings written to `brain_review_items`
   - But no UI/tool to resolve them
   - No workflow to act on findings

---

## PART 4: ENRICHMENT AUDIT

### ✅ What Already Exists (EXCELLENT):

**Idempotent Enrichment** (`lib/brain/enrich/`):
- Hash-based: `sha256(title + content + type)`
- Skip if `enriched_hash` matches
- Deterministic extractor (6 rules, ranked)
- Writes to `memory_mentions` table
- Quality warnings to `brain_review_items`

**Entity Extraction Rules** (priority order):
1. Capitalized phrases (2-4 words)
2. Quoted strings
3. `@mentions`
4. `#tags`
5. Known entity names (from brain vocabulary)
6. Noun phrases (basic pattern)

**Evidence Tracking**:
- Span positions stored
- extractedBy: "deterministic-v1"
- extractionConfidence [0,1]

### ✅ What Already WORKS:

- Enrichment triggered on memory write ✓
- Idempotency prevents re-processing ✓
- No LLM calls ✓
- Test coverage 47 tests ✓

### ⚠️ Limitations (BY DESIGN):

1. **No Cross-Memory Analysis**:
   - Enrichment is per-memory only
   - Does not compute relationships with other memories
   - Does not trigger auto-linking

2. **Entity Detection is Language-Specific**:
   - Rules tuned for English/Indonesian mix
   - "communication preference" detected
   - "preferensi komunikasi" detected
   - But no bilingual synonym matching

---

## PART 5: FEEDBACK LOOP AUDIT

### ✅ What Already Exists:

**Counters on `memories` table**:
- `recallCount` - total retrievals
- `confirmationCount` - user/agent confirmations
- `lastRecalledAt` - timestamp

**Event Log** (`brain_retrieval_events`):
- `(brain_id, memory_id, event_type, score, query_hash, created_at)`
- Content-free (privacy)
- Query hash for grouping without storing query text

**Scoring Integration**:
```typescript
// score.ts: reinforcementScore()
raw = 0.35 * saturate(recalls, 20) + 0.65 * saturate(confirmations, 5)
decay = halfLifeDecay(daysSinceLastRecall, 90)
reinforcement = raw * decay
```

### ❌ What is MISSING (NOT ACTIVE):

1. **Counters are Not Incremented**:
   ```bash
   $ grep -r "recallCount\+\+" lib/brain/
   # NO RESULTS
   
   $ grep -r "UPDATE.*recall_count" lib/brain/
   # NO RESULTS
   ```

2. **No Feedback Recording**:
   - `brain_recall` does not record usage
   - `brain_context` does not record selection
   - `brain_read` does not increment counter

3. **Reinforcement Signal Abstains**:
   - recallCount = 0 for all memories
   - reinforcementScore() returns null
   - Weight 0.4 in quality pool NOT applied

---

## PART 6: MCP TOOLS AUDIT

### ✅ Tools That Exist (23 total):

**1.0 Surface (14 tools)**:
- brain_list_brains
- brain_recall
- brain_search
- brain_read
- brain_get_recent
- brain_get_memory_history
- brain_get_backlinks
- brain_list_projects
- brain_list_tags
- brain_remember
- brain_update
- brain_delete
- brain_link_memory
- brain_link

**2.0 Additions (9 tools)**:
- brain_context ← NEW, token-bounded
- brain_path ← shortest path
- brain_timeline ← temporal slice
- brain_related ← multi-signal relatedness
- brain_explain ← provenance
- brain_health ← diagnostics
- brain_consolidate ← entity merge
- brain_get_entity
- brain_get_related

### ✅ Error Handling:

Pattern in all tools:
```typescript
try {
  const grant = requireGrant(principal, brainId, scope);
  // ... operation ...
  await audit(grant.brainId, operation, metadata);
  return ok(result);
} catch (error) {
  return fail(error);  // BrainError → message, else INTERNAL
}
```

### ❌ Query Preprocessing is ABSENT:

```typescript
// brain_context tool:
async ({ brainId, task, tokenBudget, ... }) => {
  // Directly passes task to buildBrainContext()
  const context = await buildBrainContext(db, {
    brainId: grant.brainId,
    task,  // ← NO PREPROCESSING
    ...
  });
}

// Problem: "Check user identity and communication preferences"
// Not normalized, not expanded, goes straight to retrieval
```

---

## PART 7: SCHEMA AUDIT

### ✅ Tables (COMPLETE):

**Core**:
- `brains` ✓
- `memories` (with validity_state, confirmation_count, recall_count) ✓
- `memory_versions` ✓
- `memory_tags`, `memory_tag_map` ✓
- `brain_projects` ✓

**Graph**:
- `brain_entities` (with aliases array) ✓
- `brain_relationships` (entity→entity) ✓
- `memory_links` (memory→memory, memory→entity) ✓
- `memory_mentions` (with span positions) ✓

**Intelligence**:
- `brain_graph_metrics` (PageRank, components) ✓
- `brain_health_snapshots` ✓
- `brain_retrieval_events` ✓
- `brain_review_items` ✓

**Access**:
- `brain_agents` ✓
- `brain_access` ✓
- `brain_audit_logs` ✓

### ⚠️ Missing Fields (for INTELLIGENCE):

1. **`memory_links` lacks**:
   - `origin`: "explicit" | "derived" | "inferred"
   - `confidence`: real [0,1]
   - `weight`: real [0,1]
   - `evidence`: jsonb
   - `derivedBy`: text (algorithm version)
   - `validatedAt`: timestamp

2. **`memories` lacks**:
   - `tfidf_vector`: vector (for derived edges)
   - `semantic_vector`: vector (for semantic search)
   - Schema supports text but no vector column

### ✅ Indexes (GOOD):

- `memories_brain_keyset_idx` on (brain_id, created_at, id) ✓
- `memories_search_vector_idx` GIN on search_vector ✓
- `memories_brain_validity_idx` on (brain_id, validity_state) ✓
- `brain_entities` unique on (brain_id, name, type) ✓
- `memory_links` unique on (source, target, relationship_type) ✓

---

## PART 8: GAP ANALYSIS

### Critical Gaps:

1. **Query Understanding Layer is ABSENT**
   - Impact: Natural language queries fail
   - Fix: Implement preprocessing pipeline
   - Effort: Medium (2-3 days)

2. **Auto-Linking System is ABSENT**
   - Impact: `brain_related` has no persistent derived graph and no provenance
     (it still returns retrieval-based results — see the Problem C correction)
   - Fix: Background job + derived link storage
   - Effort: Large (5-7 days)

3. **Feedback Loop is NOT ACTIVE**
   - Impact: No learning from usage
   - Fix: Record retrieval events, apply reinforcement
   - Effort: Small (1-2 days)

4. **Self-Maintenance is ABSENT**
   - Impact: The brain does not self-organize
   - Fix: Scheduled maintenance worker
   - Effort: Large (7-10 days)

### Non-Critical Gaps:

5. **Semantic Search is OFF**
   - Impact: Limited (3 legs still work)
   - Fix: Optional local embeddings
   - Effort: Medium (risky, dependency heavy)

6. **Review Queue is Read-Only**
   - Impact: Warnings are not actionable
   - Fix: Resolution workflow + UI
   - Effort: Medium (3-4 days)

---

## PART 9: ROOT CAUSE ANALYSIS

### Problem A: `brain_health` INTERNAL Error

**Status**: ✅ FIXED

**Root Cause**: MCP JSON serialization
- `null` values serialized as `undefined`
- Test expected `null`, got `undefined`

**Fix Applied**:
```typescript
queuedForReview: queued ?? null  // explicit null
```

### Problem B: Natural Language Retrieval Fails

**Status**: ❌ NOT FIXED

**Root Cause**: Multi-layered

1. **Layer 1: Query Preprocessing is Minimal**
   ```
   Input: "Check user identity and communication preferences"
   Current: ["check", "user", "identity", "and", "communication", "preferences"]
   Should be: ["user", "identity", "communication", "preferences"]
              + detected phrase: "communication preferences"
              + intent: SEARCH (not imperative)
   ```

2. **Layer 2: Entity Leg Misses**
   - "communication preferences" does not match entity "comm pref"
   - No bilingual synonym matching
   - Aliases work ONLY if exact match

3. **Layer 3: Lexical Leg is Too Literal**
   - `to_tsquery('simple', query)` = no stemming
   - "communication" ≠ "komunikasi" in FTS
   - Query treated as phrase, not bag-of-words

4. **Layer 4: Graph Leg Has No Seeds**
   - Lexical returns 0 → no seeds for graph walk
   - Graph leg abstains

**Result**: All 4 legs return 0 candidates

### Problem C: `brain_related` Has No Derived Graph

**Status**: ❌ NOT FIXED

> **CORRECTION (PHASE 2 audit, 2026-08-23)**: an earlier draft of this section (and
> PART 2 / PART 9) claimed `brain_related` "returns empty unless the user manually
> creates links". That is **wrong**. `findRelatedMemories()` in
> `lib/brain/graph/related-service.ts` has a Step 4 that calls `retrieveMemories()`
> with the seed title, so lexical + entity overlap already produce results without
> any explicit link. The real defects are listed below.

**Root Cause**:

1. **Derived Edges are Not Persistent**:
   - `relateMemories()` computes TF-IDF / tag / entity / project edges
   - Used only in `graph-snapshot.ts` for the UI graph view
   - NOT written to `memory_links`, so nothing else can read them

2. **No Provenance on Relatedness**:
   - `RelatedMemory` is `{ id, title, type, score, reason, linkType?, hops? }`
   - No `origin` (explicit / derived / inferred), no `confidence`, no `evidence`
   - A caller cannot tell an asserted fact from an algorithmic guess

3. **Weak Fallback Query**:
   - Step 4 retrieves with `seed.title` only — a few words, no content, no tags
   - It also passes `projectId: seed.projectId`, which *narrows* to one project
   - Semantic leg abstains (no vector column), so recall rests on FTS + entities

4. **Unbounded Graph Scan**:
   - Step 3 selects **all** `memory_links` rows for the brain with no `LIMIT`
   - Same unbounded pattern in `health-service.ts` and `graph/path-service.ts`

**Result**: relatedness works, but it is shallow, unexplainable, and un-labelled

---

## PART 10: RECOMMENDATIONS

### PHASE 1: Fix Query Understanding (HIGH PRIORITY)

**Goal**: "Check user identity and communication preferences" finds relevant memories

**Tasks**:
1. Improve stopword list (bilingual)
2. Detect imperative verbs, filter them
3. Phrase detection (2-3 word collocations)
4. Term weighting (rare words count more)
5. Entity alias expansion in lexical leg
6. Query normalization (Unicode, punctuation)

**Impact**: Lexical + entity leg hit rate up 60%+

**Effort**: 2-3 days

**Risk**: Low (pure function, testable)

### PHASE 2: Implement Auto-Linking (HIGH PRIORITY)

**Goal**: `brain_related()` is not empty, graph intelligence is persistent

**Tasks**:
1. Add fields to `memory_links`:
   - `origin`: enum
   - `confidence`: real
   - `weight`: real
   - `evidence`: jsonb
2. Background job: compute derived links
   - Run after enrichment
   - Candidate retrieval (shared entities, FTS, TF-IDF)
   - Score candidates
   - Write derived links with confidence
3. Modify `brain_related` to read derived links
4. Pruning: max degree, min confidence

**Impact**: Graph becomes truly intelligent

**Effort**: 5-7 days

**Risk**: Medium (schema change, performance)

### PHASE 3: Activate Feedback Loop (MEDIUM PRIORITY)

**Goal**: The brain learns from usage

**Tasks**:
1. Record retrieval in `brain_recall`, `brain_context`
2. Increment `recallCount` on memory read
3. Write events to `brain_retrieval_events`
4. Apply reinforcement signal in scoring (already coded, just abstains)

**Impact**: Frequently-used memories rank higher

**Effort**: 1-2 days

**Risk**: Low (schema exists, code exists)

### PHASE 4: Build Self-Maintenance Worker (LOW PRIORITY)

**Goal**: The brain self-organizes

**Tasks**:
1. Scheduled job (hourly)
2. Tasks:
   - Run enrichment on pending memories
   - Recompute derived links (stale > 7 days)
   - Update PageRank scores
   - Detect duplicates → review queue
   - Archive stale low-value memories
   - Health check → alert
3. Policy-driven (observe/suggest/apply modes)

**Impact**: The brain stays healthy without manual intervention

**Effort**: 7-10 days

**Risk**: High (production worker, policy decisions)

---

## PART 11: IMPLEMENTATION PLAN

### DO FIRST (Week 1):

✅ PHASE 1: Query Understanding
- Low risk
- High impact
- No schema changes
- Pure functions, testable
- Fixes Problem B directly

### DO NEXT (Week 2-3):

⚠️ PHASE 2: Auto-Linking
- Medium risk
- High impact
- Schema migration required
- Fixes Problem C
- Enables true graph intelligence

### DO AFTER (Week 4):

✅ PHASE 3: Feedback Loop
- Low risk
- Medium impact
- No schema changes
- Quick win

### DO LAST (Month 2):

⚠️ PHASE 4: Self-Maintenance
- High risk
- Medium impact
- Complex policies
- Requires phases 1-3 stable first

---

## PART 12: DEFINITION OF DONE

### For Each Phase:

- [ ] Root cause addressed
- [ ] Implementation complete
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Full test suite green (1247+ passing)
- [ ] `tsc --noEmit` clean
- [ ] `eslint` clean
- [ ] Performance measured (no regression)
- [ ] Documentation updated
- [ ] Explainability maintained
- [ ] Tenant isolation verified
- [ ] No external LLM dependency
- [ ] Backward compatible

### For Query Understanding:

- [ ] "Check user identity and communication preferences" → candidates > 0
- [ ] Stopwords properly filtered (ID + EN)
- [ ] Phrase detection working
- [ ] Entity alias expansion in lexical
- [ ] Term weighting applied
- [ ] Imperatives filtered
- [ ] Tests for all query types

### For Auto-Linking:

- [ ] `memory_links` schema extended
- [ ] Derived links created on memory write
- [ ] Origin/confidence/weight tracked
- [ ] `brain_related` reads derived links
- [ ] Pruning prevents spaghetti
- [ ] No dangling edges
- [ ] Performance acceptable (<500ms for link creation)

### For Feedback Loop:

- [ ] recallCount incremented on read
- [ ] Events logged to brain_retrieval_events
- [ ] Reinforcement signal applied
- [ ] Tests verify counter increments
- [ ] Half-life decay working

---

## CONCLUSION

Second Brain 2.0 has the **right architecture** and **solid algorithms**, but it is still **passive**. 

**Core intelligence exists**:
- Hybrid retrieval ✓
- Multi-signal scoring ✓
- Graph algorithms ✓
- Enrichment ✓
- Health monitoring ✓

**What needs to be activated**:
- Query understanding ❌
- Auto-linking ❌
- Feedback loop ❌
- Self-maintenance ❌

**Next Step**: Implement PHASE 1 (Query Understanding) to fix Problem B.

After Phase 1, the agent will see significant improvement in retrieval quality without needing embeddings.

---

END OF AUDIT REPORT
