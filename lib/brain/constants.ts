import {
  brainEntityTypeEnum,
  memorySourceTypeEnum,
  memoryTypeEnum,
} from "@/lib/db/schema";

/**
 * Enum values + API scopes for the Second Brain, derived from the Drizzle pgEnums
 * so the zod schemas in the route handlers can never drift from the database.
 *
 * Passing an unvalidated string straight into a pgEnum comparison makes Postgres
 * raise "invalid input value for enum" — a 500 for what is really a 400. Every
 * enum-shaped input goes through these lists first.
 */

export const MEMORY_TYPES = memoryTypeEnum.enumValues;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export const MEMORY_SOURCE_TYPES = memorySourceTypeEnum.enumValues;
export type MemorySourceType = (typeof MEMORY_SOURCE_TYPES)[number];

export const BRAIN_ENTITY_TYPES = brainEntityTypeEnum.enumValues;
export type BrainEntityType = (typeof BRAIN_ENTITY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

export function isBrainEntityType(value: unknown): value is BrainEntityType {
  return typeof value === "string" && (BRAIN_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * Scopes a brain agent's API key may carry. Deliberately a separate namespace
 * from the storage scopes (`read`, `write`, `full`, …): `full` is documented as
 * "all storage API permissions", and every key that already exists in the wild
 * carrying it must NOT silently gain access to the owner's memories.
 */
export const BRAIN_API_SCOPES = [
  "brain.read",
  "brain.search",
  "brain.write",
  "brain.link",
  "brain.delete",
  "brain.export",
  "brain.import",
  "brain.consolidate",
] as const;
export type BrainApiScope = (typeof BRAIN_API_SCOPES)[number];

/**
 * Destructive and bulk scopes are never handed out by default (§8): delete,
 * export (bulk extraction), import (bulk write), consolidate (merges memories).
 */
export const DEFAULT_BRAIN_AGENT_SCOPES: BrainApiScope[] = [
  "brain.read",
  "brain.search",
  "brain.write",
  "brain.link",
];

/**
 * Scopes implied by a broader one. `brain.write` covers `brain.link` because
 * creating an edge is a write, and because every agent key issued before
 * `brain.link` existed would otherwise lose brain_link at the next deploy.
 * Nothing implies delete/export/import/consolidate.
 */
const BRAIN_SCOPE_IMPLIES: Partial<Record<BrainApiScope, readonly BrainApiScope[]>> = {
  "brain.write": ["brain.link"],
};

export function isBrainApiScope(value: unknown): value is BrainApiScope {
  return typeof value === "string" && (BRAIN_API_SCOPES as readonly string[]).includes(value);
}

export function normalizeBrainScopes(scopes: readonly string[]): BrainApiScope[] {
  return [...new Set(scopes.filter(isBrainApiScope))];
}

/**
 * True when `granted` covers `required`, honouring `brain.full` and the implication
 * table above. Used for both halves of the agent check — the API key's scopes and
 * the per-brain grant — so the two can never disagree.
 */
export function brainScopeSatisfied(
  granted: readonly string[],
  required: string
): boolean {
  if (granted.includes("brain.full")) return true;
  if (granted.includes(required)) return true;
  return granted.some((scope) =>
    (BRAIN_SCOPE_IMPLIES[scope as BrainApiScope] ?? []).includes(required as BrainApiScope)
  );
}

/** Every scope `granted` effectively confers, expanded through the implication table. */
export function expandBrainScopes(granted: readonly string[]): BrainApiScope[] {
  if (granted.includes("brain.full")) return [...BRAIN_API_SCOPES];
  const out = new Set<BrainApiScope>(normalizeBrainScopes(granted));
  for (const scope of granted) {
    for (const implied of BRAIN_SCOPE_IMPLIES[scope as BrainApiScope] ?? []) {
      out.add(implied);
    }
  }
  return [...out];
}

/** Page sizes — the hard ceilings the route handlers clamp to. */
export const MEMORY_PAGE_SIZE = 20;
export const MEMORY_PAGE_MAX = 100;
export const MEMORY_SEARCH_MAX = 50;

/** Normalized tag form: trimmed, collapsed whitespace, lowercased. */
export function normalizeTag(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

/** Dedupes and normalizes a tag list, dropping empties. */
export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map(normalizeTag).filter(Boolean))];
}
