/**
 * The brain export and the brain import, joined: does a memory come back as itself?
 *
 * Every other test in this suite exercises one half. `backup-account-export-brain.test.ts`
 * checks what the exporter writes; `backup-account-import-brain.test.ts` checks what the
 * importer does with lines it is handed. Neither one answers the question the owner of the
 * data actually asks — *the thing I downloaded, is it the thing I get back* — because
 * neither one carries a value across the seam.
 *
 * So this file does. Real `planBrainExport` over a fake source holding the shapes postgres-js
 * really hands us (`Date` for a timestamp, a nested object for `jsonb`, a JS array for
 * `text[]`), the plan's own bytes turned into the reader the importer expects, real
 * `importBrain` on the other side, and then column-by-column equality against what went in.
 *
 * Two properties are worth naming, because they are the ones a "restore gave me garbage"
 * report would come from:
 *
 *   - **Text survives the format.** A memory whose content holds a newline, a double quote, a
 *     backslash and non-Latin script is the ordinary case, not the adversarial one — notes get
 *     pasted into this app all day. The payload is NDJSON, so a raw newline that reached the
 *     bytes unescaped would not corrupt one row, it would desynchronise every row after it.
 *   - **The measuring pass and the streaming pass agree.** `plan.totalBytes` is committed to
 *     before a byte is produced, and the archive writer sizes its regions from it. The test
 *     streams the payload and counts.
 *
 * The second half of the file is a drift guard rather than a round trip: a `carry` column whose
 * database type produces a value canonical JSON cannot express — a timestamp, a `bytea`, a
 * vector — throws `RowJsonError` on the first page of the download, which is a Brain backup
 * that cannot be taken at all. That failure belongs in CI, not in a user's console.
 *
 * Design: docs/superpowers/specs/2026-09-03-per-user-backup-restore-design.md §6.3, §7.3, §11.
 */

import { describe, expect, it } from "vitest";

import { planBrainExport } from "@backup/account/application/export-brain";
import { importBrain } from "@backup/account/application/import-brain";
import {
  declaredBudget,
  type AfrReadable,
  type BrainImportSink,
} from "@backup/account/application/import-types";
import type { BrainExportSource } from "@backup/account/application/export-types";
import type { AfrSummary } from "@backup/account/domain/summary";
import { accountTables, type AccountTable } from "@backup/account/domain/tables";
import { realColumn } from "@backup/account/infrastructure/schema-map";

/** The restoring account. Every `owner` column must come back as this and nothing else. */
const OWNER = "11111111-1111-4111-8111-111111111111";

/** Import time, injected so the future-clamp is a fact rather than a race. */
const NOW = Date.UTC(2026, 8, 5, 12, 0, 0);
const WRITTEN = Date.UTC(2025, 2, 14, 9, 30, 0);
const EDITED = Date.UTC(2025, 2, 15, 8, 0, 0);
/** After `NOW`: clamped for a provenance column, kept for a validity window. */
const AHEAD = Date.UTC(2027, 0, 1, 0, 0, 0);

/** The archive's own names for the rows. Uuids, as the real exporter emits. */
const B1 = "b0000000-0000-4000-8000-000000000001";
const AG = "a0000000-0000-4000-8000-000000000001";
const PJ = "c0000000-0000-4000-8000-000000000001";
const E1 = "e0000000-0000-4000-8000-000000000001";
const E2 = "e0000000-0000-4000-8000-000000000002";
const M1 = "d0000000-0000-4000-8000-000000000001";
const M2 = "d0000000-0000-4000-8000-000000000002";
const V1 = "f0000000-0000-4000-8000-000000000001";
const T1 = "10000000-0000-4000-8000-000000000001";
const R1 = "20000000-0000-4000-8000-000000000001";
const L1 = "30000000-0000-4000-8000-000000000001";
const N1 = "40000000-0000-4000-8000-000000000001";
const I1 = "50000000-0000-4000-8000-000000000001";
const X1 = "60000000-0000-4000-8000-000000000001";

/**
 * A memory's content, holding every character class that has ever broken a line-oriented
 * format: a newline, a quote, a backslash, a tab, and scripts outside Latin-1.
 */
const CONTENT = 'Rapat 09.00 — bawa "laporan"\nBaris kedua\tC:\\Users\\afr ✅ 日本語 العربية';

/** A `jsonb` column the way one really looks: nested, mixed, with a null inside it. */
const METADATA = {
  tags: ["rapat", "q3"],
  nested: { score: 1.5, ok: true, missing: null },
  list: [1, 2, 3],
};

const at = (ms: number) => new Date(ms);

/**
 * One account's brain, in the shapes the driver produces.
 *
 * Keyed by SQL table name and by SQL column name, which is what `BrainExportSource` promises
 * and what `drizzleBrainSource` really returns — `db.execute` gives back the row as Postgres
 * spells it, so a `timestamptz` arrives as a `Date` and a `jsonb` as a live object. Getting
 * those two right is the whole reason this fixture is hand-written rather than generated.
 */
const SOURCE_ROWS: Readonly<Record<string, readonly Record<string, unknown>[]>> = {
  brains: [
    {
      id: B1,
      name: "Kerja",
      description: "Catatan harian",
      status: "active",
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
  ],
  brain_agents: [
    {
      id: AG,
      name: "Asisten",
      description: null,
      type: "agent",
      status: "active",
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
  ],
  brain_projects: [
    {
      id: PJ,
      brain_id: B1,
      name: "Q3",
      description: null,
      status: "active",
      metadata: { owner: "afr" },
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
  ],
  brain_entities: [
    {
      id: E1,
      brain_id: B1,
      name: "Ada",
      type: "person",
      description: "rekan kerja",
      metadata: METADATA,
      aliases: ["Ada L.", "A."],
      mention_count: 2,
      first_seen_at: at(WRITTEN),
      last_seen_at: at(EDITED),
      extracted_by: "deterministic-v1",
      extraction_confidence: 0.42,
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
    {
      id: E2,
      brain_id: B1,
      name: "Jakarta",
      type: "place",
      description: null,
      metadata: null,
      aliases: null,
      mention_count: 0,
      first_seen_at: at(WRITTEN),
      last_seen_at: at(WRITTEN),
      extracted_by: null,
      extraction_confidence: null,
      created_at: at(WRITTEN),
      updated_at: at(WRITTEN),
    },
  ],
  memories: [
    {
      id: M1,
      brain_id: B1,
      type: "fact",
      title: 'Judul "penting" \\ draft',
      content: CONTENT,
      summary: null,
      importance: 0.75,
      confidence: 0.9,
      source_type: "user",
      source_id: "conversation:42",
      created_by_agent: AG,
      project_id: PJ,
      metadata: METADATA,
      version: 3,
      archived_at: null,
      // Provenance, and in the future: the importer clamps this one to import time.
      last_accessed_at: at(AHEAD),
      content_hash: "0".repeat(64),
      enriched_hash: "1".repeat(64),
      enrichment_status: "pending",
      enrichment_error: null,
      enriched_at: null,
      recall_count: 7,
      last_recalled_at: at(EDITED),
      confirmation_count: 1,
      last_confirmed_at: at(EDITED),
      valid_from: at(WRITTEN),
      // A validity window, and in the future: this one is kept as written.
      valid_until: at(AHEAD),
      validity_state: "active",
      superseded_by_id: M2,
      aliases: ["rapat q3"],
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
    {
      id: M2,
      brain_id: B1,
      type: "fact",
      title: "Pengganti",
      content: "isi asli",
      summary: "ringkas",
      importance: 0.5,
      confidence: 1,
      source_type: "user",
      source_id: null,
      created_by_agent: null,
      project_id: null,
      metadata: null,
      version: 1,
      archived_at: null,
      last_accessed_at: null,
      content_hash: "2".repeat(64),
      enriched_hash: null,
      enrichment_status: "pending",
      enrichment_error: null,
      enriched_at: null,
      recall_count: 0,
      last_recalled_at: null,
      confirmation_count: 0,
      last_confirmed_at: null,
      valid_from: at(WRITTEN),
      valid_until: null,
      validity_state: "active",
      superseded_by_id: null,
      aliases: null,
      created_at: at(EDITED),
      updated_at: at(EDITED),
    },
  ],
  memory_versions: [
    {
      id: V1,
      memory_id: M1,
      version_number: 2,
      title: "Judul lama",
      content: "isi versi lama",
      summary: null,
      changed_by_agent: AG,
      change_reason: "diperbaiki",
      metadata: { by: "afr" },
      created_at: at(EDITED),
    },
  ],
  memory_tags: [{ id: T1, brain_id: B1, name: "rapat", created_at: at(WRITTEN) }],
  memory_tag_map: [{ memory_id: M1, tag_id: T1 }],
  brain_relationships: [
    {
      id: R1,
      brain_id: B1,
      source_entity_id: E1,
      target_entity_id: E2,
      relationship_type: "located_in",
      confidence: 0.8,
      metadata: null,
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
  ],
  memory_links: [
    {
      id: L1,
      brain_id: B1,
      source_memory_id: M1,
      target_type: "memory",
      target_memory_id: M2,
      target_entity_id: null,
      link_type: "supersedes",
      metadata: { reason: "revisi" },
      created_by_agent: AG,
      created_at: at(EDITED),
    },
  ],
  memory_mentions: [
    {
      id: N1,
      brain_id: B1,
      memory_id: M1,
      entity_id: E1,
      field: "content",
      surface: "laporan",
      start_offset: 3,
      end_offset: 9,
      confidence: 1,
      extracted_by: "deterministic-v1",
      created_at: at(EDITED),
    },
  ],
  brain_review_items: [
    {
      id: I1,
      brain_id: B1,
      kind: "contradiction",
      status: "open",
      memory_id: M1,
      related_memory_id: M2,
      reason: "dua pernyataan berbeda",
      evidence: { pairs: [["a", "b"]] },
      priority: 0.5,
      resolved_at: null,
      created_at: at(EDITED),
      updated_at: at(EDITED),
    },
  ],
  brain_access: [
    {
      id: X1,
      brain_id: B1,
      principal_type: "agent",
      principal_id: AG,
      role: "viewer",
      scopes: ["read", "write"],
      created_at: at(WRITTEN),
      updated_at: at(EDITED),
    },
  ],
};

/* ── the seam: a plan on one side, a reader on the other ──────────────────── */

/** Every table's rows, read as many times as the exporter asks. */
const fakeSource: BrainExportSource = {
  async *rows(table: AccountTable) {
    for (const one of SOURCE_ROWS[table.name] ?? []) yield { ...one };
  },
};

/**
 * The plan, as the archive the importer reads.
 *
 * This is the only place the two halves are glued, and it does no work of its own beyond what
 * `writeArchive` and `readArchive` would: the INDEX is cut back into lines on its terminator,
 * the payload is streamed through unchanged, and the SUMMARY carries the counts the exporter
 * committed to. Anything this function *fixed up* would be a disagreement the real pair
 * would still have.
 */
function planAsReader(
  plan: Awaited<ReturnType<typeof planBrainExport>>,
  streamed: number[]
): AfrReadable {
  const summary: AfrSummary = {
    accountBackupId: "A".repeat(52),
    appVersion: "test",
    counts: plan.counts,
    schemaVersion: 29,
    sourceInstanceId: "round-trip",
    totalBytes: plan.totalBytes,
  };
  const text = plan.index.toString("utf8");
  const lines = text.length === 0 ? [] : text.slice(0, -1).split("\n");

  return {
    summary,
    async *indexLines() {
      let lineNumber = 0;
      for (const line of lines) {
        lineNumber += 1;
        yield { text: line, lineNumber, where: `index line ${lineNumber}` };
      }
    },
    async *readPayload() {
      for await (const piece of plan.payload()) {
        streamed.push(piece.byteLength);
        yield Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
      }
    },
  };
}

interface Inserted {
  table: string;
  rows: Record<string, unknown>[];
}

interface Relinked {
  table: string;
  column: string;
  pairs: { id: string; value: string }[];
}

function fakeSink() {
  const inserts: Inserted[] = [];
  const relinks: Relinked[] = [];
  const sink: BrainImportSink = {
    async hasDefaultBrain() {
      return false;
    },
    async insert(table, rows) {
      inserts.push({ table: table.name, rows: rows.map((one) => ({ ...one })) });
    },
    async relink(table, column, pairs) {
      relinks.push({ table: table.name, column, pairs: pairs.map((one) => ({ ...one })) });
    },
  };
  return { sink, inserts, relinks };
}

/** Export, then import, and hand back everything either half produced. */
async function roundTrip() {
  const plan = await planBrainExport(fakeSource);
  const streamed: number[] = [];
  const reader = planAsReader(plan, streamed);
  const { sink, inserts, relinks } = fakeSink();

  const report = await importBrain({
    reader,
    sink,
    mode: "merge",
    budget: declaredBudget(plan.totalBytes),
    ownerUserId: OWNER,
    now: NOW,
  });

  const bytes = streamed.reduce((sum, one) => sum + one, 0);
  return { plan, report, inserts, relinks, bytes };
}

/** The rows of one table, in the order the sink saw them. */
const of = (inserts: Inserted[], table: string): Record<string, unknown>[] =>
  inserts.filter((one) => one.table === table).flatMap((one) => one.rows);

/** How many rows the fixture holds, so a silently dropped row cannot pass. */
const FIXTURE_ROWS = Object.values(SOURCE_ROWS).reduce((sum, rows) => sum + rows.length, 0);

/** One round trip, shared: the halves are pure, so running them eight times proves nothing. */
let pending: ReturnType<typeof roundTrip> | null = null;
function once(): ReturnType<typeof roundTrip> {
  if (pending === null) pending = roundTrip();
  return pending;
}

/* ── what came back ───────────────────────────────────────────────────────── */

describe("export → import: nothing is quietly lost", () => {
  it("carries every row of every table", async () => {
    const { plan, report, inserts } = await once();

    expect(plan.counts.rows).toBe(FIXTURE_ROWS);
    expect(plan.counts.memories).toBe(2);
    expect(report.rows).toBe(FIXTURE_ROWS);
    expect(report.skipped).toBe(0);
    expect(inserts.flatMap((one) => one.rows)).toHaveLength(FIXTURE_ROWS);

    // Per table, because a total can hide one table's rows landing in another's INSERT.
    for (const [table, rows] of Object.entries(SOURCE_ROWS)) {
      expect(of(inserts, table), table).toHaveLength(rows.length);
    }
  });

  it("streams exactly the payload the measuring pass promised", async () => {
    const { plan, bytes } = await once();
    expect(bytes).toBe(plan.totalBytes);
  });

  it("names the tables in insert order, so a reference is never ahead of its target", async () => {
    const { inserts } = await once();
    const ranks = inserts.map(
      (one) => accountTables("brain").find((table) => table.name === one.table)?.rank ?? -1
    );
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe("export → import: a memory comes back as itself", () => {
  it("keeps text through NDJSON, newline and quote and script and all", async () => {
    const [m1] = of((await once()).inserts, "memories");

    expect(m1.content).toBe(CONTENT);
    expect(m1.title).toBe('Judul "penting" \\ draft');
    // Named separately: a raw newline in the payload would not corrupt this row, it would
    // shift every row after it by one line, and the failure would look like anything but this.
    expect(String(m1.content)).toContain("\n");
  });

  it("keeps numbers, jsonb, and arrays as the values they were", async () => {
    const [m1] = of((await once()).inserts, "memories");

    expect(m1.importance).toBe(0.75);
    expect(m1.confidence).toBe(0.9);
    expect(m1.version).toBe(3);
    expect(m1.recall_count).toBe(7);
    expect(m1.metadata).toEqual(METADATA);
    expect(m1.aliases).toEqual(["rapat q3"]);
    expect(m1.source_id).toBe("conversation:42");
    expect(m1.content_hash).toBe("0".repeat(64));
    expect(m1.enriched_hash).toBe("1".repeat(64));
    expect(m1.validity_state).toBe("active");
  });

  it("tells SQL NULL from a column the archive never carried", async () => {
    const [m1] = of((await once()).inserts, "memories");

    // Carried as null: the exporter wrote it, the importer inserts it.
    expect(m1.summary).toBeNull();
    expect(m1.enrichment_error).toBeNull();
    // Not carried: an absent timestamp is left out of the INSERT so the column's own DEFAULT
    // applies, which is what makes an archive from an older schema restorable at all.
    expect("archived_at" in m1).toBe(false);
    expect("enriched_at" in m1).toBe(false);
    expect("deleted_at" in m1).toBe(false);
  });

  it("keeps timestamps to the millisecond, and clamps only provenance", async () => {
    const [m1] = of((await once()).inserts, "memories");

    expect(m1.created_at).toEqual(new Date(WRITTEN));
    expect(m1.updated_at).toEqual(new Date(EDITED));
    expect(m1.valid_from).toEqual(new Date(WRITTEN));
    // A validity window may state the future — "true until January" is information.
    expect(m1.valid_until).toEqual(new Date(AHEAD));
    // Provenance may not: a row claiming to have been read next year sorts above everything
    // real, in every list, forever.
    expect(m1.last_accessed_at).toEqual(new Date(NOW));
  });
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("export → import: the graph is rebuilt, not trusted", () => {
  it("reissues every id and points every reference at the reissued one", async () => {
    const { inserts } = await once();
    const [brain] = of(inserts, "brains");
    const [agent] = of(inserts, "brain_agents");
    const [project] = of(inserts, "brain_projects");
    const [e1, e2] = of(inserts, "brain_entities");
    const [m1, m2] = of(inserts, "memories");
    const [version] = of(inserts, "memory_versions");
    const [tag] = of(inserts, "memory_tags");
    const [pair] = of(inserts, "memory_tag_map");
    const [relationship] = of(inserts, "brain_relationships");
    const [link] = of(inserts, "memory_links");
    const [mention] = of(inserts, "memory_mentions");
    const [review] = of(inserts, "brain_review_items");
    const [access] = of(inserts, "brain_access");

    // Not one id from the file survives. This is the property that stops an archive somebody
    // else wrote from attaching itself to rows it does not carry.
    const landedIds = inserts.flatMap((one) => one.rows).map((row) => row.id);
    for (const id of landedIds) {
      if (id === undefined) continue; // `memory_tag_map`, whose key is the pair itself.
      expect(String(id)).toMatch(UUID_RE);
      expect([B1, AG, PJ, E1, E2, M1, M2, V1, T1, R1, L1, N1, I1, X1]).not.toContain(id);
    }

    expect(m1.brain_id).toBe(brain.id);
    expect(m2.brain_id).toBe(brain.id);
    expect(m1.created_by_agent).toBe(agent.id);
    expect(m1.project_id).toBe(project.id);
    expect(version.memory_id).toBe(m1.id);
    expect(tag.brain_id).toBe(brain.id);
    expect(pair).toEqual({ memory_id: m1.id, tag_id: tag.id });
    expect(relationship.source_entity_id).toBe(e1.id);
    expect(relationship.target_entity_id).toBe(e2.id);
    expect(link.source_memory_id).toBe(m1.id);
    expect(link.target_memory_id).toBe(m2.id);
    expect(link.target_entity_id).toBeNull();
    expect(mention.memory_id).toBe(m1.id);
    expect(mention.entity_id).toBe(e1.id);
    expect(review.memory_id).toBe(m1.id);
    expect(review.related_memory_id).toBe(m2.id);
    expect(access.principal_id).toBe(agent.id);
  });

  it("fills the one self-reference in a second pass", async () => {
    const { inserts, relinks } = await once();
    const [m1, m2] = of(inserts, "memories");

    // NULL on the way in, because M2 is three lines further down the payload.
    expect(m1.superseded_by_id).toBeNull();
    expect(relinks).toEqual([
      { table: "memories", column: "superseded_by_id", pairs: [{ id: m1.id, value: m2.id }] },
    ]);
  });

  it("gives every owner column to the caller and lets the server decide the rest", async () => {
    const { inserts } = await once();
    const [brain] = of(inserts, "brains");
    const [m1] = of(inserts, "memories");
    const [review] = of(inserts, "brain_review_items");

    expect(brain.owner_user_id).toBe(OWNER);
    expect(m1.created_by).toBe(OWNER);
    // The first brain of an account that has none becomes the default; the flag is a
    // preference, and `brains_owner_default_unique` is the one unique a restore can collide with.
    expect(brain.is_default).toBe(true);
    // Rebuilt from the ids this restore issued, never the stale key the archive carried.
    expect(review.dedupe_key).toBe(`contradiction:${[m1.id, review.related_memory_id].sort().join(":")}`);
  });

  it("keeps the rest of each table's own values too", async () => {
    const { inserts } = await once();
    const [brain] = of(inserts, "brains");
    const [e1] = of(inserts, "brain_entities");
    const [version] = of(inserts, "memory_versions");
    const [mention] = of(inserts, "memory_mentions");
    const [review] = of(inserts, "brain_review_items");
    const [access] = of(inserts, "brain_access");

    expect(brain.name).toBe("Kerja");
    expect(brain.description).toBe("Catatan harian");
    expect(e1.aliases).toEqual(["Ada L.", "A."]);
    expect(e1.metadata).toEqual(METADATA);
    expect(e1.mention_count).toBe(2);
    expect(e1.extraction_confidence).toBe(0.42);
    expect(version.version_number).toBe(2);
    expect(version.content).toBe("isi versi lama");
    expect(mention.start_offset).toBe(3);
    expect(mention.end_offset).toBe(9);
    expect(mention.field).toBe("content");
    expect(review.evidence).toEqual({ pairs: [["a", "b"]] });
    expect(review.priority).toBe(0.5);
    expect(access.scopes).toEqual(["read", "write"]);
    expect(access.role).toBe("viewer");
  });
});

/* ── the drift guard: a column whose value has no JSON spelling ───────────── */

/**
 * The SQL types a `carry` column may have, and what the driver hands us for each.
 *
 * This is a decision list, not a convenience: `rowJsonBytes` refuses a `Date`, a `Buffer`, a
 * `bigint` and anything else JSON has no spelling for, and it refuses them by throwing — on the
 * first page of the first table, which is a Brain download that fails outright. Naming the safe
 * types here means a schema change that gives `memories` a `bytea` column and the descriptor a
 * `carry` rule for it fails in CI instead.
 *
 * A pgEnum is missing on purpose: its SQL type is the type's own name, so it cannot be listed,
 * and it always arrives as a string. It is recognised by its values below.
 */
const CARRIABLE_SQL: Readonly<Record<string, string>> = {
  text: "string",
  varchar: "string",
  char: "string",
  uuid: "string",
  boolean: "boolean",
  smallint: "number",
  integer: "number",
  real: "number",
  "double precision": "number",
  numeric: "string — postgres-js keeps the exact decimal rather than rounding it",
  json: "already JSON",
  jsonb: "already JSON",
};

/** `varchar(255)` → `varchar`, `text[]` → `text`, `numeric(3, 2)` → `numeric`. */
function baseType(sqlType: string): string {
  let name = sqlType.trim();
  while (name.endsWith("[]")) name = name.slice(0, -2).trim();
  const paren = name.indexOf("(");
  return (paren < 0 ? name : name.slice(0, paren)).trim();
}

/** An enum column: any spelling, always a string on the wire. */
function isEnumColumn(column: { enumValues?: readonly string[] | undefined }): boolean {
  return Array.isArray(column.enumValues) && column.enumValues.length > 0;
}

/** Every brain column with one rule, as `table.column`. */
function columnsRuled(rule: string): { at: string; table: string; column: string }[] {
  return accountTables("brain").flatMap((table) =>
    Object.entries(table.columns)
      .filter(([, one]) => one.rule === rule)
      .map(([column]) => ({ at: `${table.name}.${column}`, table: table.name, column }))
  );
}

describe("the descriptors cannot carry a value the payload has no spelling for", () => {
  it("gives every carried brain column a type canonical JSON can express", async () => {
    const rejected = columnsRuled("carry").flatMap((one) => {
      const column = realColumn(one.table, one.column);
      const sqlType = column.getSQLType();
      if (isEnumColumn(column)) return [];
      if (baseType(sqlType) in CARRIABLE_SQL) return [];
      return [`${one.at} is ${sqlType}`];
    });

    // A named failure rather than a bare boolean: the column and its type are the whole
    // diagnosis, and a `carry` on a timestamp is the mistake this is really watching for.
    expect(rejected).toEqual([]);
  });

  it("gives every brain time column a timestamp, so neither rule can drift onto the other", async () => {
    const wrong = columnsRuled("time").flatMap((one) => {
      const sqlType = realColumn(one.table, one.column).getSQLType();
      return baseType(sqlType).startsWith("timestamp") ? [] : [`${one.at} is ${sqlType}`];
    });

    expect(wrong).toEqual([]);
  });

  it("covers every brain table in the fixture above", async () => {
    // The round trip is only a guarantee about the tables it actually walks, so a table added
    // to the descriptor without a fixture row would otherwise be untested here and look tested.
    for (const table of accountTables("brain")) {
      expect(SOURCE_ROWS[table.name] ?? [], table.name).not.toHaveLength(0);
    }
  });
});
